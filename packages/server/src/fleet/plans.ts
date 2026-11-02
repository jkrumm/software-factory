import { createHash } from 'node:crypto'
import type { FleetPlan, FleetWave, PlanState, WaveStatus } from '@software-factory/contract'

/** A plan file larger than this is not read: a plan is a page of headings, not a log. */
export const MAX_PLAN_BYTES = 256 * 1024
/** An active wave in a plan that nobody touched for this long is `stale`. */
export const STALE_AFTER_MS = 3 * 24 * 3_600_000

/** `## Wave 3 — Title`, with `–`, `-`, `:` or `.` as the separator, or none (`## Wave 3 Title`). */
const HEADING = /^##\s+Wave\s+(\d+)\b\s*(?:[—–:.-]+\s*)?(.*)$/
const WAVE_LIKE = /^##\s+Wave\b/i
const COMMENT = /<!--\s*(status|short)\s*:\s*(.*?)\s*-->/g
const DATE = /^\d{4}-\d{2}-\d{2}$/

/** `done 2026-11-01, release 767f643` → word, date, the text after it. */
function parseStatus(raw: string): Pick<FleetWave, 'status' | 'statusDate' | 'statusText'> {
  const match = /^([A-Za-z]+)\b(?:[\s,:;-]+(?:until\s+)?(\d{4}-\d{2}-\d{2}))?[\s,:;-]*(.*)$/.exec(raw.trim())
  const word = match?.[1]?.toLowerCase() ?? ''
  const status: WaveStatus =
    word === 'done' || word === 'active' || word === 'pending'
      ? word
      : word === 'scheduled' || word === 'later'
        ? 'scheduled'
        : 'unknown'
  const date = match?.[2] && DATE.test(match[2]) ? match[2] : null
  // `later until 2026-11-10`: "until" was consumed with the date; what is left is the owner's text.
  const text = (match?.[3] ?? '').replace(/^until\s*/i, '').trim()
  return { status, statusDate: date, statusText: text || null }
}

/** The first `n` words of a title, for a visible repo that has no `<!-- short: -->`. */
export const cutWords = (text: string, n = 8): string => {
  const words = text.trim().split(/\s+/).filter(Boolean)
  return words.length <= n ? words.join(' ') : `${words.slice(0, n).join(' ')}…`
}

/** What a plan file says, without the state: that needs the sessions and the clock. */
export type ParsedPlan = Omit<FleetPlan, 'state' | 'lastTouched' | 'path'>

/** The plan and, apart from it, what in the file could not be read (line numbers only: the text may not leave the mini). */
export interface PlanReading {
  plan: ParsedPlan
  problems: string[]
}

/**
 * Reads a `docs/waves/*.md` file: the `# ` title, its `**Goal:**` line, and every `## Wave <n> — <title>` heading with the
 * `<!-- status: … -->` and `<!-- short: … -->` comments on it. A heading with no status is `pending`. The text is data:
 * nothing in it is followed.
 */
export function parsePlan(text: string, options: { visible: boolean }): PlanReading {
  let title = ''
  let titleShort: string | null = null
  let goal: string | null = null
  const waves: FleetWave[] = []
  const problems: string[] = []
  const lines = text.split(/\r\n|\n|\r/)
  for (const [index, line] of lines.entries()) {
    if (!title && line.startsWith('# ')) {
      const parsed = comments(line.slice(2))
      title = parsed.text
      titleShort = parsed.short
      continue
    }
    if (goal === null) {
      const found = /^\*\*Goal:?\*\*:?\s*(.+)$/.exec(line)
      if (found?.[1]) goal = found[1].trim()
    }
    const heading = HEADING.exec(line)
    if (!heading) {
      if (WAVE_LIKE.test(line)) problems.push(`line ${index + 1} starts with "## Wave" but has no wave number`)
      continue
    }
    const parsed = comments(heading[2] ?? '')
    const status =
      parsed.status === null
        ? { status: 'pending' as const, statusDate: null, statusText: null }
        : parseStatus(parsed.status)
    waves.push({
      n: Number(heading[1]),
      title: parsed.text,
      short: parsed.short ?? (options.visible ? cutWords(parsed.text) : null),
      ...status,
    })
  }
  const plan: ParsedPlan = {
    sha: createHash('sha256').update(text).digest('hex').slice(0, 12),
    title,
    short: titleShort ?? (options.visible && title ? cutWords(title) : null),
    goal,
    waves,
  }
  return { plan, problems }
}

/** The text of a heading without its comments, and the comments' values (the last of a kind wins). */
function comments(line: string): { text: string; status: string | null; short: string | null } {
  let status: string | null = null
  let short: string | null = null
  for (const found of line.matchAll(COMMENT)) {
    if (found[1] === 'status') status = found[2] ?? ''
    else short = found[2] || null
  }
  return { text: line.replace(COMMENT, '').trim(), status, short }
}

/**
 * The proposal's rules, in this order: a live session works it → `running`; every wave done → `done`; an active wave and the file
 * untouched for three days → `stale`; nothing active and the next wave owner-timed (`scheduled`, a date still ahead or none) →
 * `scheduled`; else `planned` (pending waves are never nagged). A plan with no waves is `planned`.
 */
export function planState(input: {
  waves: readonly FleetWave[]
  worked: boolean
  lastTouched: string | null
  now: Date
}): PlanState {
  const { waves, worked, lastTouched, now } = input
  if (worked) return 'running'
  if (waves.length > 0 && waves.every((w) => w.status === 'done')) return 'done'
  const active = waves.some((w) => w.status === 'active')
  if (active && lastTouched && now.getTime() - Date.parse(lastTouched) >= STALE_AFTER_MS) return 'stale'
  if (!active) {
    const next = waves.find((w) => w.status !== 'done')
    const today = now.toISOString().slice(0, 10)
    if (next?.status === 'scheduled' && (next.statusDate === null || next.statusDate > today)) return 'scheduled'
  }
  return 'planned'
}

const PLAN_PATH = /(?:~\/|\/)?(?:[\w.@+-]+\/)*docs\/waves\/[\w.-]+\.md/g

/**
 * The `docs/waves/*.md` paths a start text names, the one named most often first (ties: the first named). What follows a
 * `Never` on a line is a path the worker must leave alone, not its plan. The text is data: it is only searched for paths.
 */
export function namedPlanPaths(text: string): string[] {
  const counts = new Map<string, number>()
  for (const line of text.slice(0, 64 * 1024).split('\n')) {
    const cut = line.search(/\bNever\b/)
    for (const found of (cut >= 0 ? line.slice(0, cut) : line).matchAll(PLAN_PATH)) {
      counts.set(found[0], (counts.get(found[0]) ?? 0) + 1)
    }
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([path]) => path)
}

/** The wave a start text names first (`Wave 3`, `W3` is not read), for a session's `wave`. */
export function namedWave(text: string): number | null {
  const found = /\bWave\s+(\d+)\b/i.exec(text.slice(0, 64 * 1024))
  return found?.[1] ? Number(found[1]) : null
}
