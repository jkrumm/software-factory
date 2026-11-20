/** The twelve conditions the self-watch loop looks for; the kind is the first half of a finding's stable key. */
export const FINDING_KINDS = [
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
] as const
export type FindingKind = (typeof FINDING_KINDS)[number]

/** One condition seen in a pass. */
export interface Finding {
  kind: FindingKind
  /** what the condition is about (a workflow, a migration number, an Issue and its wait): with the kind, the key */
  subject: string
  /** the repo the signal is filed on when it is not the watched one (a project's budget breach) */
  repo?: string
  /** carries the subject in words for the lead; intake matches it by the kind and subject, never by the title */
  title: string
  /** the evidence that identifies the condition: hashed, so it must not hold a clock */
  facts: string[]
  /** more to read for the lead (the time now, a count): never hashed */
  context: string[]
  reproduce: string
  /** the evidence block of a capacity finding (`overloadEvidence`): read when it is filed, never hashed */
  evidence?: string[]
  /** the number the condition is filed against, when it has one (MiB, percent, milliseconds): never hashed, read again once the Issue closed */
  figure?: number
}

export const subjectKeyOf = (finding: Pick<Finding, 'kind' | 'subject'>): string => `${finding.kind}:${finding.subject}`

/** One subject as the loop remembers it: the newest row of its key in `loop_findings`. */
export interface SelfwatchRow {
  /** the Issue the signal opened or reached; null when intake took it as a repeat of an Issue closed lately (no Issue carries it) */
  issueId: string | null
  repo: string
  figure: number | null
  subjectKey: string
  /** a kind this build no longer files stays a string, so its row is read and cleared, never a failed parse */
  kind: string
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
  /** the repo whose lead or step owns the process; null for a process no repo owns */
  repo: string | null
  issue: number | null
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
  /** the aim's target that minute: the base callers were granted against when it is below `liveSlots` */
  aimSlots: number
  holders: number
  waiters: number
}

/** What `GET /health` also says: the server's own routes over the last window, measured in the process. */
export interface RouteLatency {
  /** the 95th percentile of the answer times (a request still unanswered counts at its age); null with no request */
  p95Ms: number | null
  samples: number
  windowMs: number
  /** the slowest answers in the window, slowest first, with the route each was; absent where the figure is not timed per route */
  slowest?: { route: string; ms: number }[]
}

/** The queued Issues by the reason they stay queued, as the open `queue_intervals` say. */
export interface QueueReasonCount {
  kind: string
  count: number
  /** the start of the oldest open interval */
  since: Date
}

/** The CPU of one class and repo over the host minutes since a time (`host_class_samples`), `cpuMs` summed over them. */
export interface ClassCpu {
  class: string
  repo: string | null
  cpuMs: number
}

/** The host's own CPU split over the window (the `top` header of each host minute, averaged): what every process, short-lived or not, and the kernel took. */
export interface HostCpuSplit {
  samples: number
  idlePct: number
  userPct: number
  sysPct: number
}

/**
 * What `classCpu` read: the groups, the number of host minutes with CPU figures in the window (the divisor of a core count; the first snapshot after a restart has none) and the
 * host's CPU split over the same window, null when no host minute carried one.
 */
export interface ClassCpuWindow {
  minutes: number
  rows: ClassCpu[]
  host: HostCpuSplit | null
}

/** One line of `ps`: the process, its scheduling priority (`ps -o pri`), CPU share, resident size and command. */
export interface PsRow {
  pid: number
  pri: number
  pcpu: number
  rssMib: number
  command: string
}
