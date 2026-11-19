// The history files (docs/accounts.md §History): the sample log `samples-YYYY-MM.jsonl` (append-only, one file a month)
// and the reset ledger `resets.jsonl`, both under historyDir(). The records and the replay are history.ts.
import { appendFileSync, mkdirSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { type Sample, RULE_VERSION, observedReset } from './policy.ts'
import {
  type ResetEntry,
  type SampleLine,
  lineOf,
  parseSampleLine,
  replayAccount,
  replayResets,
  sampleChanged,
} from './history.ts'
import { historyDir } from './paths.ts'

/** Where one account's history is written, and how the line learns the mode in force (asked only when a line is written). */
export interface HistoryTarget {
  dir?: string
  mode?: (id: string) => string | null
}

export const sampleLogPath = (dir: string, ts: number) =>
  join(dir, `samples-${new Date(ts).toISOString().slice(0, 7)}.jsonl`)
export const ledgerPath = (dir: string) => join(dir, 'resets.jsonl')

const append = (path: string, lines: object[]) => {
  mkdirSync(join(path, '..'), { recursive: true })
  appendFileSync(path, lines.map((l) => `${JSON.stringify(l)}\n`).join(''))
}

const readJsonl = (path: string): unknown[] => {
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch {
    return []
  }
  return text.split('\n').flatMap((l) => {
    if (!l.trim()) return []
    try {
      return [JSON.parse(l)]
    } catch {
      return [] // a torn last line of a crashed writer: the log goes on
    }
  })
}

const logFiles = (dir: string): string[] => {
  try {
    return readdirSync(dir)
      .filter((n) => /^samples-\d{4}-\d{2}\.jsonl$/.test(n))
      .sort()
  } catch {
    return []
  }
}

/** Sample lines in time order, of one account or all; `sinceMs` skips the monthly files that end before it. */
export function readSampleLines(dir = historyDir(), o: { id?: string; sinceMs?: number } = {}): SampleLine[] {
  const since = o.sinceMs === undefined ? '' : `samples-${new Date(o.sinceMs).toISOString().slice(0, 7)}.jsonl`
  return logFiles(dir)
    .filter((n) => n >= since)
    .flatMap((n) => readJsonl(join(dir, n)))
    .map(parseSampleLine)
    .filter((l): l is SampleLine => l !== null && (o.id === undefined || l.id === o.id))
    .sort((a, b) => a.ts - b.ts)
}

const isEntry = (v: unknown): v is ResetEntry => {
  const r = v as ResetEntry | null
  return !!r && typeof r === 'object' && typeof r.id === 'string' && typeof r.key === 'string' && Number.isFinite(r.at)
}

/** The ledger, oldest reset first; a key written twice (two writers at one reset) counts once, the first line. */
export function readLedger(dir = historyDir(), id?: string): ResetEntry[] {
  const seen = new Set<string>()
  return readJsonl(ledgerPath(dir))
    .filter(isEntry)
    .filter((e) => (id === undefined || e.id === id) && !seen.has(e.key) && !!seen.add(e.key))
    .sort((a, b) => a.at - b.at)
}

/** Appends the resets the sample log holds and the ledger lacks (one line per week and account); returns them. */
export function syncLedger(dir = historyDir(), ids?: string[]): ResetEntry[] {
  const have = new Set(readLedger(dir).map((e) => e.key))
  const fresh = replayResets(readSampleLines(dir).filter((l) => !ids || ids.includes(l.id))).filter(
    (e) => !have.has(e.key),
  )
  if (fresh.length) append(ledgerPath(dir), fresh)
  return fresh
}

/**
 * Writes the history of one sample write: a line when a percent or a reset time of a limit changed, and the ledger line
 * when the change is a reset. The state the reset ended goes in first when the log has none of the account yet (the
 * first write after the history was switched on). A record, never a gate: the caller catches what this throws.
 */
export function recordHistory(
  id: string,
  before: Sample | null,
  after: Sample,
  nowMs: number,
  t: HistoryTarget = {},
): void {
  if (before && !sampleChanged(before, after)) return
  const dir = t.dir ?? historyDir()
  const ctx = { mode: t.mode?.(id) ?? null, rule: RULE_VERSION }
  const reset = before !== null && observedReset(before, after)
  const line = lineOf(id, before, after, nowMs, ctx)
  const prior =
    reset && before && readSampleLines(dir, { id, sinceMs: nowMs - 40 * 86400_000 }).length === 0
      ? [lineOf(id, null, before, nowMs, ctx)]
      : []
  for (const l of [...prior, line]) append(sampleLogPath(dir, l.ts), [l])
  if (reset) syncLedger(dir, [id])
}

/** One account's history for `status`: its lines since last month and its ledger; the week still running is replayAccount's. */
export function loadHistory(id: string, nowMs: number, dir = historyDir()) {
  const lines = readSampleLines(dir, { id, sinceMs: nowMs - 40 * 86400_000 })
  return { lines, week: replayAccount(id, lines).week, resets: readLedger(dir, id) }
}

/** Adds sample lines to the log (each into its month's file) unless the account already has a line at that time; then syncs the ledger. */
export function importLines(
  dir: string,
  lines: SampleLine[],
): { added: number; duplicates: number; resets: ResetEntry[] } {
  const known = new Set(readSampleLines(dir).map((l) => `${l.id}|${l.ts}`))
  const fresh = lines.filter((l) => !known.has(`${l.id}|${l.ts}`) && !!known.add(`${l.id}|${l.ts}`))
  const byFile = Map.groupBy(fresh, (l) => sampleLogPath(dir, l.ts))
  for (const [path, group] of byFile) append(path, group)
  const resets = fresh.length ? syncLedger(dir, [...new Set(fresh.map((l) => l.id))]) : []
  return { added: fresh.length, duplicates: lines.length - fresh.length, resets }
}
