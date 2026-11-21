import type {
  HygieneFindingRow,
  HygieneFixRow,
  HygieneLifecycleRow,
  HygieneProbeRow,
  PlanRowView,
  ProjectHygieneModel,
  ProjectIndexRow,
  ProjectPageModel,
  ProjectPlanModel,
} from '@software-factory/contract'
import type { Tone } from '@/components/kit/tone'
import { ageWords } from '@/lib/age'

/** The pure logic of the project screens: words, tones and sums. The reads are `lib/api.ts`, the screens `routes/projects.*`. */

export const PROBE_WORDS: Record<HygieneProbeRow['status'], string> = {
  clean: 'Clean',
  found: 'Found',
  failed: 'Could not run',
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
  tracked: 'On an Issue',
  reopened: 'Reopened',
  kept: 'Left to you',
  left_out: 'Left out',
  refused: 'Refused',
  not_filed: 'Not filed',
}

export const FINDING_TONES: Record<HygieneFindingRow['status'], Tone> = {
  filed: 'accent',
  tracked: 'neutral',
  reopened: 'warn',
  kept: 'bad',
  left_out: 'neutral',
  refused: 'bad',
  not_filed: 'neutral',
}

export const FINDING_WHY: Record<HygieneFindingRow['status'], string> = {
  filed: 'A signal was filed for it; it became an Issue or joined one.',
  tracked: 'An Issue of this finding is open already, so the pass filed nothing.',
  reopened: 'Its Issue had closed done and the probe is red again: the Issue was opened again, no second one filed.',
  kept: 'It is red again after its Issue was reopened twice. A person decides; no Issue is filed.',
  left_out:
    "The pass's cap, or a finder muted for mostly dropped Issues, kept it out. The next pass finds it again.",
  refused: 'Intake refused the signal.',
  not_filed: 'The pass raised it and filed nothing.',
}

/** How the Issue a finding filed stands, in the words of an Issue's end. */
export const ISSUE_STATE_WORDS: Record<NonNullable<HygieneFindingRow['issueState']>, string> = {
  open: 'Open',
  done: 'Done',
  healed: 'Healed',
  dropped: 'Dropped',
  cancelled: 'Cancelled',
}

/** What the pass did to a finding already filed. */
export const ACTION_WORDS: Record<HygieneLifecycleRow['action'], string> = {
  healed: 'Healed',
  noted: 'Told the lead',
  reopened: 'Reopened',
  kept: 'Left to you',
}

export const ACTION_TONES: Record<HygieneLifecycleRow['action'], Tone> = {
  healed: 'good',
  noted: 'neutral',
  reopened: 'warn',
  kept: 'bad',
}

/** What a scripted fix did, in the words the Hygiene tab shows (no state words of an Issue: `scripts/vocabulary.ts`). */
export const FIX_WORDS: Record<HygieneFixRow['outcome'], string> = {
  fixed: 'Fixed by script',
  failed: 'Failed, a lead has it',
  skipped: 'Does not apply',
  deferred: 'Held until the next pass',
}

export const FIX_TONES: Record<HygieneFixRow['outcome'], Tone> = {
  fixed: 'good',
  failed: 'bad',
  skipped: 'neutral',
  deferred: 'warn',
}

/** The catalogue's words: whether a probe runs by default, when, and at what cost. */
export const ENABLED_WORDS: Record<HygieneProbeRow['catalogue']['enabled'], string> = {
  on: 'On',
  auto: 'When detected',
  'opt-in': 'Opt in',
}
export const COST_WORDS: Record<HygieneProbeRow['catalogue']['cost'], string> = {
  file: 'reads files',
  tool: 'runs a tool',
  make: 'runs make',
  agent: 'one agent call',
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

/** A Flow card's repo text is the project's name, or its path when the name was taken by another directory. */
export const ownsCard = (project: { name: string; repo: string }, repo: string): boolean =>
  repo === project.name || repo === project.repo || repo.startsWith(`${project.repo}/`)

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
  hygiene: Pick<ProjectIndexRow['hygiene'], 'lastPassAt' | 'outcome' | 'findings'>,
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

/** How many Issues of one kind the first screen lists before the rest sit behind a count. */
export const FIRST_SCREEN_ROWS = 5

/** The first rows of a list and how many are left behind a count. */
export function firstRows<Row>(rows: readonly Row[], cap: number = FIRST_SCREEN_ROWS): { shown: Row[]; more: number } {
  return { shown: rows.slice(0, cap), more: Math.max(0, rows.length - cap) }
}

/** A plan row that no Issue is on yet: the rows the first screen names as what comes next (an open row is an Issue already listed). */
export const upcomingRows = <Row extends Pick<PlanRowView, 'state'>>(rows: readonly Row[]): Row[] =>
  nextRows(rows).filter((row) => row.state === 'filable' || row.state === 'waiting')

/** One answer of the health band: a lamp tone, a label, a sentence and the tab that has the detail. */
export interface HealthCell {
  key: 'production' | 'checks' | 'files'
  label: string
  tone: Tone
  text: string
  tab: 'shipped' | 'hygiene' | 'setup'
}

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`

/**
 * Whether the project is healthy, in three answers: production (open incidents, regressions, what is in Watch), the checks
 * (the hygiene probes that found or failed) and the project's files (a `project.yaml` or a plan that does not parse). A
 * read that has not arrived says so in neutral, never green.
 */
export function healthOf({
  page,
  hygiene,
  plan,
  now,
}: {
  page: Pick<ProjectPageModel, 'production' | 'projectError' | 'source' | 'syncedAt'>
  hygiene: Pick<ProjectHygieneModel, 'probes' | 'lastPass'> | undefined
  plan: Pick<ProjectPlanModel, 'error'> | undefined
  now: number
}): HealthCell[] {
  const { production } = page
  const openIncidents = production.incidents.filter((incident) => incident.open).length
  const watching = production.watching.length
  const productionCell: HealthCell = (() => {
    const base = { key: 'production', label: 'Production', tab: 'shipped' } as const
    const inWatch = watching === 0 ? '' : `, ${watching} checking in its Watch`
    if (openIncidents > 0) return { ...base, tone: 'bad', text: `${plural(openIncidents, 'incident')} open${inWatch}` }
    if (production.regressions.length > 0) {
      return {
        ...base,
        tone: 'warn',
        text: `${plural(production.regressions.length, 'regression')} in 7 days${inWatch}`,
      }
    }
    return { ...base, tone: 'good', text: `No incident or regression in 7 days${inWatch}` }
  })()

  const checksCell: HealthCell = (() => {
    const base = { key: 'checks', label: 'Checks', tab: 'hygiene' } as const
    if (!hygiene) return { ...base, tone: 'neutral', text: 'The hygiene report did not load. Reload the page.' }
    if (!hygiene.lastPass) return { ...base, tone: 'neutral', text: 'No hygiene pass has swept this project yet' }
    const red = hygiene.probes.filter((probe) => probe.status === 'failed')
    const found = hygiene.probes.filter((probe) => probe.status === 'found')
    const swept = `swept ${ageWords(Math.max(0, now - Date.parse(hygiene.lastPass.at)))}`
    if (red.length > 0) return { ...base, tone: 'bad', text: `${plural(red.length, 'probe')} failed to run, ${swept}` }
    if (found.length > 0)
      return { ...base, tone: 'warn', text: `${plural(found.length, 'probe')} found something, ${swept}` }
    return { ...base, tone: 'good', text: `Every probe clean, ${swept}` }
  })()

  const filesCell: HealthCell = (() => {
    const base = { key: 'files', label: 'Project files', tab: 'setup' } as const
    if (page.projectError)
      return { ...base, tone: 'bad', text: 'The project.yaml does not parse; the setup is the last valid one' }
    if (plan?.error)
      return { ...base, tone: 'bad', text: 'The plan does not parse; its rows are the last valid plan’s' }
    if (page.source === 'defaults') return { ...base, tone: 'neutral', text: 'No project.yaml: the defaults apply' }
    const read = page.syncedAt ? `read ${ageWords(Math.max(0, now - Date.parse(page.syncedAt)))}` : 'not read yet'
    return { ...base, tone: 'good', text: `project.yaml ${read}` }
  })()

  return [productionCell, checksCell, filesCell]
}
