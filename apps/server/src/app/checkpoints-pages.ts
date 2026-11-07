import { PAGE_LEASE_MS, pageBackoffMs } from '../domains/checkpoints/page.ts'
import type { Notifier } from '../domains/checkpoints/ports.ts'
import type { Clock } from '../kernel/clock.ts'
import { ok, type PortError, type Result } from '../kernel/result.ts'
import { type CheckpointDeps, type CheckpointError } from './checkpoints.ts'
import { type SettleDeps, settleOpen, type Settled } from './checkpoints-settle.ts'

export interface PageDeps extends CheckpointDeps {
  notifier: Notifier
  clock: Clock
}

/** Most pages one pass sends. */
export const SEND_BATCH = 5

export interface PagesSent {
  sent: string[]
  failed: { key: string; error: string }[]
}

/**
 * The owner's line: claim the due pages and commit, call the notifier with no transaction open (the calls of one pass side
 * by side, so a dead ntfy costs one timeout), record each result in a new transaction. A failed send waits 30 s, doubling to
 * 5 min, and is tried again for as long as the checkpoint is open (a line that was down or not yet configured still reaches
 * the owner). A sent page is never sent again; a crash between a send and its record lets the
 * lease run out and the page goes again (at-least-once).
 */
export async function sendDuePages(
  deps: PageDeps,
  limit = SEND_BATCH,
): Promise<Result<PagesSent, CheckpointError | PortError>> {
  const now = deps.clock.now()
  const claimed = await deps.uow.run(async ({ checkpoints }) =>
    ok(await checkpoints.claimPages({ now, until: new Date(now.getTime() + PAGE_LEASE_MS), limit })),
  )
  if (!claimed.ok) return claimed

  const sends = await Promise.all(claimed.value.map(async (page) => ({ page, result: await deps.notifier.send(page) })))
  const report: PagesSent = { sent: [], failed: [] }
  for (const { page, result } of sends) {
    const at = deps.clock.now()
    const recorded = await deps.uow.run(async ({ checkpoints }) => {
      if (result.ok) {
        await checkpoints.recordPage(page.key, { at, ok: true })
        return ok(undefined)
      }
      await checkpoints.recordPage(page.key, {
        at,
        ok: false,
        error: result.error,
        retryAt: new Date(at.getTime() + pageBackoffMs(page.attempts)),
      })
      return ok(undefined)
    })
    if (!recorded.ok) return recorded
    if (result.ok) report.sent.push(page.key)
    else report.failed.push({ key: page.key, error: `${result.error.kind}: ${result.error.detail}` })
  }
  return ok(report)
}

export interface PassReport {
  decisions: Settled[]
  pages: PagesSent
}

/** Settle what can be settled, then send the pages that settling planned. One call for the loops' tick and the CLI. */
export async function runCheckpointPass(
  deps: SettleDeps & PageDeps,
): Promise<Result<PassReport, CheckpointError | PortError>> {
  const decisions = await settleOpen(deps)
  if (!decisions.ok) return decisions
  const pages = await sendDuePages(deps)
  if (!pages.ok) return pages
  return ok({ decisions: decisions.value, pages: pages.value })
}
