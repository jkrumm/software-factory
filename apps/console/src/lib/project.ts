import type { HygieneFindingRow, HygieneProbeRow, PlanRowView, ProjectIndexRow } from '@software-factory/contract'
import type { Tone } from '@/components/kit/tone'

/** The pure logic of the project screens: words, tones and sums. The reads are `lib/api.ts`, the screens `routes/projects.*`. */

export const PROBE_WORDS: Record<HygieneProbeRow['status'], string> = {
  clean: 'Clean',
  found: 'Found',
  failed: 'Failed',
  skipped: 'Skipped',
  never: 'Not run',
}

/** A probe that found something is a warning, one that could not run is bad; a skipped or unrun one is quiet. */
export const PROBE_TONES: Record<HygieneProbeRow['status'], Tone> = {
  clean: 'good',
  found: 'warn',
  failed: 'bad',
  skipped: 'neutral',
  never: 'neutral',
}

export const FINDING_WORDS: Record<HygieneFindingRow['status'], string> = {
  filed: 'Filed',
  left_out: 'Left out',
  refused: 'Refused',
  not_filed: 'Not filed',
}

export const FINDING_TONES: Record<HygieneFindingRow['status'], Tone> = {
  filed: 'accent',
  left_out: 'neutral',
  refused: 'bad',
  not_filed: 'neutral',
}

export const FINDING_WHY: Record<HygieneFindingRow['status'], string> = {
  filed: 'A signal was filed for it; it became an Issue or joined one.',
  left_out:
    "The pass's cap, or a finding class held for mostly dropped Issues, kept it out. The next pass finds it again.",
  refused: 'Intake refused the signal.',
  not_filed: 'The pass raised it and filed nothing.',
}

/** How a pass ended in one word, and the tone of that word. */
export const PASS_WORDS = { answered: 'Judged', failed: 'Judgment failed', skipped: 'Judgment skipped' } as const
export const PASS_TONES: Record<keyof typeof PASS_WORDS, Tone> = {
  answered: 'good',
  failed: 'bad',
  skipped: 'neutral',
}

/** The plan's rows by state, and the share that is done. A project with no plan has `total` 0. */
export interface PlanSummary {
  total: number
  done: number
  open: number
  filable: number
  waiting: number
  /** whole percent of the rows that are done; null with no rows */
  percent: number | null
}

export function planSummary(rows: readonly Pick<PlanRowView, 'state'>[]): PlanSummary {
  const count = (state: PlanRowView['state']) => rows.filter((row) => row.state === state).length
  const done = count('done')
  return {
    total: rows.length,
    done,
    open: count('open'),
    filable: count('filable'),
    waiting: count('waiting'),
    percent: rows.length === 0 ? null : Math.round((done / rows.length) * 100),
  }
}

const NEXT_ORDER: Record<PlanRowView['state'], number> = { open: 0, filable: 1, waiting: 2, done: 3 }

/** The rows that are not done, the ones in flight first, then the ones that may file now, then the waiting ones; each group in plan order. */
export function nextRows<Row extends Pick<PlanRowView, 'state'>>(rows: readonly Row[]): Row[] {
  return rows
    .map((row, index) => ({ row, index }))
    .filter(({ row }) => row.state !== 'done')
    .sort((a, b) => NEXT_ORDER[a.row.state] - NEXT_ORDER[b.row.state] || a.index - b.index)
    .map(({ row }) => row)
}

/** `Mon`..`Sun` of the seven days that end at `at`, oldest first (local time). */
export function dayLabels(at: string): string[] {
  const end = new Date(at).getTime()
  return Array.from({ length: 7 }, (_, i) =>
    new Date(end - (6 - i) * 86_400_000).toLocaleDateString([], { weekday: 'short' }),
  )
}

/** One line on a project's hygiene for its card: when it was last swept and what it found. */
export function hygieneLine(
  hygiene: ProjectIndexRow['hygiene'],
  now: number,
  ageWords: (ms: number) => string,
): string {
  if (hygiene.lastPassAt === null) return 'Never swept'
  const age = ageWords(now - new Date(hygiene.lastPassAt).getTime())
  return hygiene.findings === 0
    ? `Clean ${age}`
    : `${hygiene.findings} finding${hygiene.findings === 1 ? '' : 's'}, ${age}`
}

/** The lanes as words: `apple 1 (18 GiB)`. */
export function laneWords(lanes: Record<string, { leads: number; memoryMib: number | null }>): string[] {
  return Object.entries(lanes).map(([name, lane]) => {
    const memory = lane.memoryMib === null ? '' : ` (${Math.round((lane.memoryMib / 1024) * 10) / 10} GiB each)`
    return `${name}: ${lane.leads} at once${memory}`
  })
}

/** The project's own address, one place for the path so a chip and a palette row agree. */
export const projectPath = (name: string): string => `/projects/${encodeURIComponent(name)}`
