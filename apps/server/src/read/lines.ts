import { createHash } from 'node:crypto'
import type { LoopView, ReadAccountQuota, ReadHealthLine } from '@software-factory/contract'
import type { SQL } from 'bun'
import * as z from 'zod'
import type { MainCheckoutLine } from '../domains/loops/checkout.ts'
import { LINE_TEXT_MAX } from './asks.ts'
import { loopReads } from './loops.ts'
import { cut, fallbackWords } from './plain.ts'
import { issueNumberOf, loadBriefs } from './sessions.ts'

/** Where the health lines come from besides the database: the door's lines and the loop runner, both held by the composition. */
export interface LineSources {
  doorLines: () => Promise<string[]>
  loops: () => LoopView[]
  /** a watch whose checkout stays blocked this many checks in a row is a line */
  blockedStreak: number
  /** the main checkouts the steward found off their branch or dirty while a lead was live */
  mainCheckouts: () => MainCheckoutLine[]
  /** the MacBook's ssh alias is set (`FACTORY_ASK_HUMAN_HOST`): the desk pass can tell that he is back after a push found it down */
  macbookProbe: boolean
  /** a command that came back unsuccessful this many times is not pushed again (`MAX_RUN_TRIES`, passed in: `read/` imports no domain code) */
  maxRunTries: number
}

const shortHash = (text: string): string => createHash('sha256').update(text).digest('hex').slice(0, 12)

const line = (input: {
  id: string
  kind: string
  text: string
  since?: string | null
  repo?: string | null
  visible?: boolean
}): ReadHealthLine => {
  const words = fallbackWords(input.text, 'health')
  return {
    id: input.id,
    kind: input.kind,
    short: words.short,
    summary: words.summary,
    text: cut(input.text, LINE_TEXT_MAX),
    since: input.since ?? null,
    repo: input.repo ?? null,
    visible: input.visible ?? false,
  }
}

/**
 * What needs a look and is not a question for the owner: a door line (a refused or silent source, an unrouted monitor), an
 * account stopped at its limit, a loop whose last pass failed, a watch whose checkout stays blocked, a repo's main checkout off its branch or dirty under a live lead, a working Issue whose lead has no agent in its terminal (`lead-no-agent`, an open row of `lead_losses`). Derived at read.
 */
export async function readHealthLines(
  sql: SQL,
  input: { now: Date; accounts: readonly ReadAccountQuota[]; sources: LineSources },
): Promise<ReadHealthLine[]> {
  const { now, sources } = input
  const lines: ReadHealthLine[] = []
  const door = await sources
    .doorLines()
    .catch((error: unknown) => [
      `The door's lines could not be read: ${error instanceof Error ? error.message : String(error)}`,
    ])
  for (const text of door) lines.push(line({ id: `door:${shortHash(text)}`, kind: 'door', text }))
  for (const account of input.accounts) {
    const until = account.exhaustedUntil
    if (until && Date.parse(until) > now.getTime()) {
      lines.push(
        line({
          id: `account:${account.account}`,
          kind: 'account',
          text: `Account ${account.account} is at its usage limit until ${until.slice(0, 16)}Z`,
        }),
      )
    }
  }
  for (const loop of sources.loops()) {
    if (!loop.lastError) continue
    lines.push(
      line({
        id: `loop:${loop.name}`,
        kind: 'loop',
        since: loop.lastStartedAt,
        text: `The ${loop.name} loop failed on its last pass: ${loop.lastError}`,
      }),
    )
  }
  const blocked = await loopReads(sql).blockedCheckouts(sources.blockedStreak, 50)
  const briefs = await loadBriefs(
    sql,
    blocked.map((b) => b.issue),
  )
  for (const watch of blocked) {
    const brief = briefs.get(watch.issue)
    lines.push(
      line({
        id: `checkout:${watch.issue}:${watch.watch}`,
        kind: 'checkout',
        since: watch.since.toISOString(),
        repo: brief?.repo ?? null,
        visible: brief?.visible ?? false,
        text: `The checkout for the watch of Issue ${issueNumberOf(watch.issue)} stays blocked after ${watch.checks} checks`,
      }),
    )
  }
  // A working Issue whose lead has no agent in its terminal (a host restart brought it back as a shell): it holds its repo's claim and nobody works.
  const stranded = await sql`
    SELECT l.issue_id, l.at FROM factory.lead_losses l JOIN factory.issues i ON i.id = l.issue_id
    WHERE l.closed_at IS NULL AND i.state = 'working' ORDER BY l.at`
  const strandedBriefs = await loadBriefs(
    sql,
    (stranded as { issue_id: string }[]).map((row) => row.issue_id),
  )
  for (const row of stranded as { issue_id: string; at: Date }[]) {
    const brief = strandedBriefs.get(row.issue_id)
    lines.push(
      line({
        id: `lead-no-agent:${row.issue_id}`,
        kind: 'lead-no-agent',
        since: new Date(row.at).toISOString(),
        repo: brief?.repo ?? null,
        visible: brief?.visible ?? false,
        text: `The lead of Issue ${issueNumberOf(row.issue_id)} has no agent in its terminal since ${new Date(row.at).toISOString().slice(0, 16)}Z; its session is being started again`,
      }),
    )
  }
  const checkouts = sources.mainCheckouts()
  const checkoutBriefs = await loadBriefs(
    sql,
    checkouts.flatMap((found) => found.issues.slice(0, 1)),
  )
  for (const found of checkouts) {
    const brief = found.issues[0] ? checkoutBriefs.get(found.issues[0]) : undefined
    lines.push(
      line({
        id: `main-checkout:${found.repo}`,
        kind: 'main-checkout',
        since: found.since.toISOString(),
        repo: found.repo,
        visible: brief?.visible ?? false,
        text: found.text,
      }),
    )
  }
  const waiting = sources.macbookProbe ? 0 : await macbookErrandsOpen(sql, sources.maxRunTries)
  if (waiting > 0) {
    lines.push(
      line({
        id: 'macbook-probe',
        kind: 'macbook-probe',
        text: `The MacBook return probe is off (FACTORY_ASK_HUMAN_HOST is not set in the host's settings file) while ${waiting} Errand${waiting === 1 ? '' : 's'} with a MacBook command wait: a push that found it unreachable is retried only at his Console visit, his button or the 6-hour pass`,
      }),
    )
  }
  return lines
}

/**
 * Open Errands at the owner that the desk pass pushes to his MacBook when it knows he is back (`pushQueue`): a command, host
 * `macbook`, need `secret` or `hands` (an approval is run on the mini, a place only on his button), no run going and fewer
 * than `maxRunTries` failed ones.
 */
async function macbookErrandsOpen(sql: SQL, maxRunTries: number): Promise<number> {
  const [row] = await sql`
    SELECT count(*)::int AS n
    FROM factory.errands e LEFT JOIN factory.issues i ON i.id = e.issue_id
    WHERE e.done_at IS NULL AND e.reached_owner_at IS NOT NULL AND e.command IS NOT NULL AND e.host = 'macbook'
      AND e.need IN ('secret', 'hands') AND (e.run_status IS NULL OR e.run_status NOT IN ('running', 'done')) AND e.run_attempts < ${maxRunTries}
      AND (e.issue_id IS NULL OR i.state <> 'closed')`
  return z.object({ n: z.number().int() }).parse(row).n
}
