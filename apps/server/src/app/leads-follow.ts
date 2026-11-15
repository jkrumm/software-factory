import type { LeadAttempt } from '../domains/leads/ports.ts'
import type { Issue } from '../domains/work/issue.ts'
import { leadKey, tabName } from '../domains/leads/names.ts'
import { deriveSession } from '../domains/leads/session.ts'
import { issueNumber } from '../kernel/ids.ts'
import { key } from '../kernel/keys.ts'
import { ok } from '../kernel/result.ts'
import { type LeadDeps, loadIssue } from './leads.ts'
import { HOST_RESTARTED, reviveAndTell } from './leads-note.ts'
import { leadGone } from './leads-start.ts'

/** The most wall-clock a pass spends naming tabs; what is left retries next pass, and gone-detection is never cut. */
export const NAME_TABS_BUDGET_MS = 15_000

/** The most wall-clock a pass spends starting sessions again over shells (each start is paced); what is left waits for the next pass. */
export const REVIVE_BUDGET_MS = 60_000

/**
 * Finds the leads whose terminal is gone: each started lead of a `working` Issue is looked up in herdr-core by its key,
 * and one with no running terminal, past the grace (from the later of its start and its last hook event), is a lead
 * gone. A core that does not answer says nothing, never "gone". The lost terminal is also a fact of the session's
 * hook stream (`pane_gone`), so its derived state reads `gone`. A terminal that lives but runs no agent (a host restart
 * brings every kept terminal back as a login shell, and its session read `gone` or `idle` from events older than the
 * restart) is a lead lost the same way, yet revivable: past the grace the loss is recorded (the health line and the friction
 * count read it) and the session starts again with `--resume`; the third failed start takes the lost path. The same look names the tab of each lead that runs,
 * whatever its Issue waits for (`nameTab`: the app adopts a tab after the start, so the start cannot). Returns how many
 * leads were found gone.
 */
export async function followLeads(deps: LeadDeps, signal?: AbortSignal): Promise<number> {
  const followed = await deps.uow.run(async ({ work, leads }) => {
    const out: {
      row: LeadAttempt
      since: Date | null
      session: string | null
      issue: Issue
      title: string
      working: boolean
    }[] = []
    for (const row of await leads.followed()) {
      const loaded = await loadIssue(work, row.issueId)
      if (!loaded || loaded.issue.state === 'closed' || loaded.issue.attempt !== row.attempt) continue
      const view = deriveSession(await leads.hookFacts(leadKey(row.issueId, row.attempt)))
      out.push({
        row,
        since: view.lastEventAt ?? row.startedAt,
        session: view.claudeSession,
        issue: loaded.issue,
        title: loaded.issue.title,
        working: loaded.issue.state === 'working',
      })
    }
    return ok({
      rows: out,
      open: new Set((await leads.openLosses()).map((loss) => leadKey(loss.issueId, loss.attempt))),
    })
  })
  if (!followed.ok) return 0
  const { rows, open } = followed.value
  // The lookups only read, so they run together: serial, a loaded host's slow `hc` calls add up past the heartbeat's limit.
  const lookups = await Promise.all(rows.map(({ row }) => deps.terminals.find(leadKey(row.issueId, row.attempt))))
  const namingStart = deps.clock.now().getTime()
  let revivedAny = false
  let lost = 0
  for (const [index, { row, since, session, issue, title, working }] of rows.entries()) {
    const name = leadKey(row.issueId, row.attempt)
    const found = lookups[index]
    if (!found?.ok) continue
    // The label marks a tab the factory made; the name comes from the title, so a lead started before the label carried it is named too.
    for (const { live, tab, tabName: made } of found.value) {
      if (!live || !tab || !made) continue
      if (signal?.aborted || deps.clock.now().getTime() - namingStart >= NAME_TABS_BUDGET_MS) continue
      await deps.terminals.nameTab({ tab, name: tabName(title) })
    }
    // A dormant lead has no process by design: its wake starts the session again, and a failed start takes the lost path.
    if (!working || row.dormantAt) continue
    const running = found.value.filter((terminal) => terminal.live)
    if (running.some((terminal) => terminal.agent)) {
      // Its agent runs again (revived, or started by hand): the loss, if one was open, is over.
      if (open.has(name)) {
        await deps.uow.run(async ({ leads }) => {
          await leads.markAgentFound(row.issueId, row.attempt, deps.clock.now())
          return ok(undefined)
        })
      }
      continue
    }
    const quiet = deps.clock.now().getTime() - Math.max(row.startedAt?.getTime() ?? 0, since?.getTime() ?? 0)
    if (quiet < deps.graceMs) continue
    if (running.length > 0) {
      // The first start of a pass always runs; a later one only while the pass has time left.
      if (revivedAny && deps.clock.now().getTime() - namingStart >= REVIVE_BUDGET_MS) continue
      revivedAny = true
      await reviveShell(deps, { row, name, session, issue, open: open.has(name) })
      continue
    }
    const at = deps.clock.now()
    const recorded = await deps.uow.run(async ({ leads }) => {
      await leads.appendHook({
        issue: row.issueId,
        attempt: row.attempt,
        session: name,
        fact: { key: key(name, 'pane_gone'), kind: 'pane_gone', at, payload: {} },
        receivedAt: at,
      })
      return ok(undefined)
    })
    if (!recorded.ok) continue
    const gone = await leadGone(deps, row.issueId, row.attempt, 'its terminal was lost')
    if (gone.ok) lost++
  }
  return lost
}

/** A lead whose terminal runs a shell: the loss is recorded once, and the session starts again over it, told the host restarted. */
async function reviveShell(
  deps: LeadDeps,
  input: { row: LeadAttempt; name: string; session: string | null; issue: Issue; open: boolean },
): Promise<void> {
  const { row, name, session, issue, open } = input
  if (!open) {
    await deps.uow.run(async ({ leads }) => {
      await leads.markAgentLost(row.issueId, row.attempt, deps.clock.now())
      return ok(undefined)
    })
  }
  // A failure is counted by the start itself: the third one, or one a retry cannot fix, takes the lost path.
  await reviveAndTell(deps, {
    issue: row.issueId,
    attempt: row.attempt,
    name,
    text: `Factory, Issue ${issueNumber(row.issueId)}: ${HOST_RESTARTED}`,
    dormant: { session, worktree: row.worktreePath, repoPath: row.repoPath, account: row.account, issue },
  })
}
