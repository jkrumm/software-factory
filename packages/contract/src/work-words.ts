import * as z from 'zod'

/**
 * Where work stands, in the five words every surface shares (`docs/language.md` "Where work stands"). A word is a view
 * over the stored state, the wait reason and the queue reason, never a stored value: `workOf` is the one function that
 * puts an open Issue under exactly one word, so `running + paused + ready + held + checking` is the number of open Issues
 * whichever surface counts them. Plan rows not yet filed are Planned and are not Issues: they are never part of it.
 */
export const WORK_WORDS = ['running', 'paused', 'ready', 'held', 'checking'] as const
export type WorkWord = (typeof WORK_WORDS)[number]

/** The two groups the words add up to: started (a lead began) and not started. `checking` is its own small count. */
export const WORK_GROUPS = { started: ['running', 'paused'], notStarted: ['ready', 'held'] } as const

/** Paused, by who or what it waits for: the owner, a clock, another Issue, or a stall nobody asked for. */
export const PAUSED_SPLITS = ['you', 'timer', 'issue', 'stalled'] as const
export type PausedSplit = (typeof PAUSED_SPLITS)[number]

/** Ready, by the one limit that holds it: room in the allowance, the host, the repo's claims, the account's window. */
export const READY_LIMITS = ['seat', 'host', 'repo', 'account'] as const
export type ReadyLimit = (typeof READY_LIMITS)[number]

/** Held, by what keeps it from starting whatever the capacity: another Issue, a red line, a drain, a Spec, its own setup. */
export const HELD_SPLITS = ['issue', 'line', 'drain', 'spec', 'settling'] as const
export type HeldSplit = (typeof HELD_SPLITS)[number]

const PAUSED_BY_WAIT: Readonly<Record<string, PausedSplit>> = {
  decision: 'you',
  review: 'you',
  errand: 'you',
  timer: 'timer',
  dependency: 'issue',
  external: 'issue',
  paused: 'you',
}

const READY_BY_QUEUE: Readonly<Record<string, ReadyLimit>> = {
  load: 'host',
  memory: 'host',
  boot: 'host',
  doctor: 'host',
  claim: 'repo',
  lane: 'repo',
  cap: 'repo',
  window: 'account',
}

const HELD_BY_QUEUE: Readonly<Record<string, HeldSplit>> = {
  chain: 'issue',
  line: 'line',
  drain: 'drain',
  spec: 'spec',
  finalizing: 'settling',
  unknown_project: 'settling',
}

/** What `workOf` needs of an Issue: its stored state, its wait while it waits, its queue reason while it is queued. */
export interface WorkInput {
  state: string
  /** the wait of a `waiting` Issue */
  waitReason?: string | null
  /** the kind of the queue reason of a `queued` Issue; null or absent: nothing but room in the allowance keeps it out */
  queueKind?: string | null
}

export type Work =
  | { word: 'running'; split: null }
  | { word: 'checking'; split: null }
  | { word: 'paused'; split: PausedSplit }
  | { word: 'ready'; split: ReadyLimit }
  | { word: 'held'; split: HeldSplit }

/**
 * The word an open Issue stands under, and its split; null for a closed one. `settling` is Held (it cannot start until
 * triage settles it); a queued Issue is Held when its queue reason is one capacity cannot lift, else Ready with the limit
 * that binds it (`seat` when nothing but room in the allowance does). A stall (`wall`, `unreported`, `blocked`, `lead_gone`,
 * `regressed`) is a Paused split of its own.
 */
export function workOf(input: WorkInput): Work | null {
  switch (input.state) {
    case 'working':
      return { word: 'running', split: null }
    case 'watching':
      return { word: 'checking', split: null }
    case 'waiting':
      return { word: 'paused', split: PAUSED_BY_WAIT[input.waitReason ?? ''] ?? 'stalled' }
    case 'settling':
      return { word: 'held', split: 'settling' }
    case 'queued': {
      const kind = input.queueKind ?? null
      if (kind === null) return { word: 'ready', split: 'seat' }
      const held = HELD_BY_QUEUE[kind]
      if (held) return { word: 'held', split: held }
      return { word: 'ready', split: READY_BY_QUEUE[kind] ?? 'seat' }
    }
    default:
      return null
  }
}

const splitCounts = <T extends string>(keys: readonly T[]) =>
  z.strictObject(Object.fromEntries(keys.map((key) => [key, z.number().int().min(0)])) as Record<T, z.ZodNumber>)

/** The five counts of a set of open Issues, and the split of the three that have one. They add up to the Issues. */
export const WorkCounts = z
  .strictObject({
    /** a lead works now: the Issues in the `working` state */
    running: z.number().int().min(0),
    /** started, held by a named wait */
    paused: z.number().int().min(0),
    /** not started, held only by capacity */
    ready: z.number().int().min(0),
    /** not started, cannot start whatever the capacity */
    held: z.number().int().min(0),
    /** shipped, its check pending */
    checking: z.number().int().min(0),
    split: z.strictObject({
      paused: splitCounts(PAUSED_SPLITS),
      ready: splitCounts(READY_LIMITS),
      held: splitCounts(HELD_SPLITS),
    }),
  })
  .meta({ id: 'WorkCounts' })
export type WorkCounts = z.infer<typeof WorkCounts>

const zeros = <T extends string>(keys: readonly T[]): Record<T, number> =>
  Object.fromEntries(keys.map((key) => [key, 0])) as Record<T, number>

export const emptyWorkCounts = (): WorkCounts => ({
  running: 0,
  paused: 0,
  ready: 0,
  held: 0,
  checking: 0,
  split: { paused: zeros(PAUSED_SPLITS), ready: zeros(READY_LIMITS), held: zeros(HELD_SPLITS) },
})

/** Adds one Issue's `Work` to `counts` in place; a closed one (null) is part of none. */
export function addWork(counts: WorkCounts, work: Work | null): void {
  if (!work) return
  counts[work.word]++
  if (work.word === 'paused') counts.split.paused[work.split]++
  else if (work.word === 'ready') counts.split.ready[work.split]++
  else if (work.word === 'held') counts.split.held[work.split]++
}

/** The counts of a set of Issues; the open Issues are the sum of the five (`openOfWork`). */
export function workCountsOf(issues: Iterable<WorkInput>): WorkCounts {
  const counts = emptyWorkCounts()
  for (const issue of issues) addWork(counts, workOf(issue))
  return counts
}

/** Two counts added: a project's counts into the factory's, or the hidden work projects into one. */
export function sumWorkCounts(a: WorkCounts, b: WorkCounts): WorkCounts {
  const sum = emptyWorkCounts()
  for (const word of WORK_WORDS) sum[word] = a[word] + b[word]
  for (const key of PAUSED_SPLITS) sum.split.paused[key] = a.split.paused[key] + b.split.paused[key]
  for (const key of READY_LIMITS) sum.split.ready[key] = a.split.ready[key] + b.split.ready[key]
  for (const key of HELD_SPLITS) sum.split.held[key] = a.split.held[key] + b.split.held[key]
  return sum
}

/** The open Issues the counts hold: Running + Paused + Ready + Held + Checking. */
export const openOfWork = (counts: Pick<WorkCounts, WorkWord>): number =>
  counts.running + counts.paused + counts.ready + counts.held + counts.checking

/** The stored states each word counts (the trend is by state: Ready and Held share `queued`, so it shows their sum, "not started"). */
export const WORK_TREND_STATES = {
  running: ['working'],
  paused: ['waiting'],
  notStarted: ['settling', 'queued'],
  checking: ['watching'],
} as const
export const WORK_TREND_KEYS = ['running', 'paused', 'notStarted', 'checking'] as const
export type WorkTrendKey = (typeof WORK_TREND_KEYS)[number]

/** The trend series a stored state is counted in; null for `closed`. */
export const workTrendOfState = (state: string): WorkTrendKey | null =>
  WORK_TREND_KEYS.find((key) => (WORK_TREND_STATES[key] as readonly string[]).includes(state)) ?? null
