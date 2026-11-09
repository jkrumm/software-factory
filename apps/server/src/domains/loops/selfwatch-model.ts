/** The six conditions the self-watch loop looks for; the kind is the first half of a finding's stable key. */
export const FINDING_KINDS = [
  'ci_red',
  'migration_clash',
  'wait_overdue',
  'lead_idle',
  'inert_regression',
  'heartbeat_stale',
] as const
export type FindingKind = (typeof FINDING_KINDS)[number]

/** One condition seen in a pass. */
export interface Finding {
  kind: FindingKind
  /** what the condition is about (a workflow, a migration number, an Issue and its wait): with the kind, the key */
  subject: string
  /** carries the subject in words: intake fingerprints the title without digits and punctuation */
  title: string
  /** the evidence that identifies the condition: hashed, so it must not hold a clock */
  facts: string[]
  /** more to read for the lead (the time now, a count): never hashed */
  context: string[]
  reproduce: string
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
