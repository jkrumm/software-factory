import type { ClassOutcome } from './classes.ts'

/**
 * The one ledger of what a loop filed (`factory.loop_findings`, `migrations/1061_loop_ledger.sql`): the Issue a finding
 * opened, the number it was filed against (its figure) and, once the Issue closed, what that number did. Pure rules; the
 * pass reads and writes through `LoopStore` and `LoopReads`.
 */

const LEDGER_LOOPS = ['friction', 'hygiene', 'selfwatch', 'throughput'] as const
export type LedgerLoop = (typeof LEDGER_LOOPS)[number]

/** What the figure did after the Issue closed; a finding with no verdict yet has not been read again. */
export type Verdict = 'moved' | 'flat' | 'worse' | 'unmeasured'

/**
 * Better, flat or worse against `before`, down being better. A count (friction's patterns, hygiene's items) is exact: any
 * fall moved. A measured figure (the throughput loop's minutes and MiB) is noisy: a change of under `share` of `before` is flat.
 */
export function movedDown(before: number, after: number, share = 0): 'moved' | 'flat' | 'worse' {
  const change = before === 0 ? (after === 0 ? 0 : 1) : (after - before) / Math.abs(before)
  if (change === 0 || Math.abs(change) < share) return 'flat'
  return change < 0 ? 'moved' : 'worse'
}

/** One Issue a loop's finding opened that has closed, with the figure it was filed against and its verdict (null: not read yet). */
export interface ClosedFinding {
  issue: string
  loop: LedgerLoop
  repo: string
  key: string
  figure: number | null
  verdict: Verdict | null
  outcome: ClassOutcome
  filedAt: Date
  closedAt: Date
}

/** A verdict to store: the figure read again (null: none was read) and the verdict it gives. */
export interface Judged {
  issue: string
  verdict: Verdict
  measured: number | null
}

/**
 * The verdicts due: a closed Issue with none yet is `unmeasured` when it ended as noise (dropped, cancelled) or its finding
 * kept no figure; otherwise `read` gives the figure now (`null`: the finding's source says nothing, `undefined`: it could not
 * be read, the Issue waits for the next pass) and the verdict is `movedDown` of the two. An Issue closed `healed` was fixed by
 * the loop itself: its figure is read the same way.
 */
export function judgeClosed(
  rows: readonly ClosedFinding[],
  read: (row: ClosedFinding) => number | null | undefined,
): Judged[] {
  const judged: Judged[] = []
  for (const row of rows) {
    if (row.verdict !== null) continue
    if (row.outcome === 'dropped' || row.outcome === 'cancelled' || row.figure === null) {
      judged.push({ issue: row.issue, verdict: 'unmeasured', measured: null })
      continue
    }
    const now = read(row)
    if (now === undefined) continue
    judged.push(
      now === null
        ? { issue: row.issue, verdict: 'unmeasured', measured: null }
        : { issue: row.issue, verdict: movedDown(row.figure, now), measured: now },
    )
  }
  return judged
}

const num = (value: number): string => {
  const text = value.toFixed(2)
  return text.includes('.') ? text.replace(/\.?0+$/, '') : text
}

/**
 * What a finding says when its key was filed before and that Issue closed: the Issue, the figure it was filed against, the
 * figure now, and what the earlier one did. Null for a key with no closed Issue. `previous` carries any verdict judged this pass.
 */
export function lastTime(previous: ClosedFinding | undefined, now: number | null): string | null {
  if (!previous) return null
  const was = previous.figure === null ? 'no figure' : `figure ${num(previous.figure)}`
  const closed = previous.outcome === 'done' || previous.outcome === 'healed' ? '' : `, closed ${previous.outcome}`
  const verdict = previous.verdict === null ? '' : ` (${previous.verdict})`
  return `Last time: Issue ${previous.issue} at ${was}, now ${now === null ? 'no figure' : num(now)}${closed}${verdict}.`
}

/** The newest closed Issue of each key. */
export function newestByKey(rows: readonly ClosedFinding[]): Map<string, ClosedFinding> {
  const newest = new Map<string, ClosedFinding>()
  for (const row of rows) {
    const seen = newest.get(row.key)
    if (
      !seen ||
      row.filedAt > seen.filedAt ||
      (row.filedAt.getTime() === seen.filedAt.getTime() && row.issue > seen.issue)
    )
      newest.set(row.key, row)
  }
  return newest
}
