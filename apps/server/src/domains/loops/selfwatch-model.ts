/** The fourteen conditions the self-watch loop looks for; the kind is the first half of a finding's stable key. */
export const FINDING_KINDS = [
  'ci_red',
  'migration_clash',
  'wait_overdue',
  'lead_idle',
  'inert_regression',
  'heartbeat_stale',
  'process_growth',
  'swap_growth',
  'process_storm',
  'budget_breach',
  'load_over_ceiling',
  'slot_line',
  'gates_passed',
  'routes_slow',
] as const
export type FindingKind = (typeof FINDING_KINDS)[number]

/** One condition seen in a pass. */
export interface Finding {
  kind: FindingKind
  /** what the condition is about (a workflow, a migration number, an Issue and its wait): with the kind, the key */
  subject: string
  /** the repo the signal is filed on when it is not the watched one (a project's budget breach) */
  repo?: string
  /** carries the subject in words: intake fingerprints the title without digits and punctuation */
  title: string
  /** the evidence that identifies the condition: hashed, so it must not hold a clock */
  facts: string[]
  /** more to read for the lead (the time now, a count): never hashed */
  context: string[]
  reproduce: string
  /** the evidence block of a capacity finding (`overloadEvidence`): read when it is filed, never hashed */
  evidence?: string[]
}

export const subjectKeyOf = (finding: Pick<Finding, 'kind' | 'subject'>): string => `${finding.kind}:${finding.subject}`

/** One subject as the loop remembers it (`migrations/0998_selfwatch.sql`). */
export interface SelfwatchRow {
  subjectKey: string
  kind: FindingKind
  firstSeenAt: Date
  lastSeenAt: Date
  evidenceHash: string
  lastFiledAt: Date
  signalId: string | null
  clearedAt: Date | null
}

/** What one pass changes in the rows; `filed` are whole new values, filed only after intake took the signal. */
export interface SelfwatchChange {
  filed: SelfwatchRow[]
  touched: string[]
  cleared: string[]
  at: Date
}

/** One completed workflow run on the watched branch. */
export interface CiRun {
  id: string
  workflow: string
  sha: string
  conclusion: string
  url: string
  /** ISO */
  at: string
}

/** The migration files of a repo: what the default branch holds and what each ref adds to it. */
export interface MigrationSnapshot {
  base: string[]
  refs: { ref: string; added: string[] }[]
  /** refs in scope that went uncompared, past the per-pass limit */
  unchecked: string[]
}

/** A timer or dependency wait of an Issue, with the facts its exit is judged from. */
export interface WaitFact {
  issue: string
  title: string
  reason: 'timer' | 'dependency'
  /** the version that began the wait */
  since: number
  sinceAt: Date
  /** a timer's time, ISO */
  until: string | null
  /** a dependency's Issues, each with when it closed (null: still open) */
  after: { issue: string; closedAt: Date | null }[]
}

/** A working Issue whose lead has been quiet since `idleSince`. */
export interface IdleLead {
  issue: string
  title: string
  lead: string
  idleSince: Date
  /** its last turn ended with background work in flight: it waits for that, and is judged by the longer threshold */
  background: boolean
}

/** An Issue waiting on a regression, with what its ship deployed (null: no ship evidence is stored). */
export interface RegressionFact {
  issue: string
  title: string
  detail: string
  ship: { commits: string[]; paths: string[]; deploys: boolean } | null
}

/** `GET /health`'s heartbeat. */
export interface HeartbeatFact {
  ok: boolean
  reason: string | null
  tickAt: string | null
  queueMovedAt: string | null
}

/** One notable process of one minute (`host_process_samples`), as the growth rule reads it. */
export interface ProcessMinute {
  at: Date
  pid: number
  name: string
  class: string
  footprintMib: number
}

/** One minute of the host (`host_samples`), as the swap and process-count rules read it; null when not read. */
export interface HostMinute {
  at: Date
  swapUsedPct: number | null
  processes: number | null
}

/** One minute of the host's capacity facts (`host_samples`), as the overload conditions read it; null when not read. */
export interface CapacityMinute {
  at: Date
  load: number | null
  /** the load ceiling in force that minute */
  loadCeiling: number | null
  /** the leads that held a claim */
  leads: number | null
  /** the leads the enabled accounts may hold */
  seats: number | null
  memoryUsedPct: number | null
  swapUsedPct: number | null
  swapoutMbPer300s: number | null
  compressorMib: number | null
  pressureLevel: number | null
}

/** One minute of the test slots (`slot_shadow`): the base slots, the steps holding one and the callers waiting. */
export interface SlotMinute {
  at: Date
  liveSlots: number
  holders: number
  waiters: number
}

/** What `GET /health` also says: the server's own routes over the last window, measured in the process. */
export interface RouteLatency {
  /** the 95th percentile of the answer times (a request still unanswered counts at its age); null with no request */
  p95Ms: number | null
  samples: number
  windowMs: number
}

/** The queued Issues by the reason they stay queued, as the open `queue_intervals` say. */
export interface QueueReasonCount {
  kind: string
  count: number
  /** the start of the oldest open interval */
  since: Date
}

/** One line of `ps`: the process, its scheduling priority (`ps -o pri`), CPU share, resident size and command. */
export interface PsRow {
  pid: number
  pri: number
  pcpu: number
  rssMib: number
  command: string
}
