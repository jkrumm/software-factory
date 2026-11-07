import { createHash } from 'node:crypto'
import type { LoopView, ReadAccountQuota, ReadHealthLine } from '@software-factory/contract'
import type { SQL } from 'bun'
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
 * account stopped at its limit, a loop whose last pass failed, a watch whose checkout stays blocked. Derived at read.
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
  return lines
}
