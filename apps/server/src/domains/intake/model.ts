import type { Signal, SignalAck } from '@software-factory/contract'
import type { IssueId } from '../../kernel/ids.ts'

/**
 * What a source adds to the envelope when the thing it reports has a life: a monitor that goes down and comes up, a
 * GitHub issue, a failing check. `down` and `up` are one episode of the subject; `event` is a one-off that the
 * envelope's fingerprint dedups. The facts are the source's numbers, stored with the signal.
 */
export interface Alert {
  /** the monitor, `<owner>/<repo>#<n>`, `<owner>/<repo>:<check>`, the job's label, `<system>:<rule>` */
  subject: string
  /** the source's own id of this event: the same event sent twice is one effect */
  event: string
  status: 'down' | 'up' | 'event'
  facts: unknown
}

/** One input: the envelope, and the alert detail when the source has one. */
export interface Received {
  signal: Signal
  alert: Alert | null
}

/** What `receive` answered, `docs/language.md` Triage. `detail` says why. */
/**
 * What a loop (friction, hygiene, selfwatch, throughput) says its finding is about. With the signal's repo it is the
 * finding's key: intake matches a loop's signal by that key alone, never by its words or the triage workflow.
 */
export interface LoopFinding {
  loop: 'friction' | 'hygiene' | 'selfwatch' | 'throughput'
  /** the kind of finding (a pattern group, a probe, a selfwatch kind, a KPI) */
  class: string
  /** what it is about inside its class (a pattern key, a probe key, a subject) */
  subject: string
  /**
   * How long after its Issue closed a repeat of this finding is dropped instead of filed anew. Absent: intake's
   * fingerprint window, counted from when the Issue was filed.
   */
  repeatWindowMs?: number
}

export interface Triaged {
  outcome: SignalAck['outcome']
  detail: SignalAck['detail']
  issue: IssueId | null
  signal: string | null
  reason: string | null
}

/** One `heal:` rule of a project: a `down` of the source waits `graceMs` for its `up`, after the runbook. */
export interface HealRule {
  /** `<source>.down` */
  when: string
  graceMs: number
  runbook: 'make restart' | null
  max: number
}

/** What a repo's project says about itself to the intake, from its `project.yaml`. */
export interface RepoSignals {
  repo: string
  /** a work repo hears the owner only (NL18) */
  work: boolean
  /** the host named in its project.yaml */
  host: string | null
  /** the automatic sources its `signals:` lists (`github`, `checks`, `launchd`); the door's sources come with a route */
  sources: readonly string[]
  github: { label: string; author: string | null; since: string | null; checks: boolean } | null
  launchd: readonly string[]
  heal: readonly HealRule[]
}

/** An Issue that is not closed, as far as matching a new signal against it needs. */
export interface OpenIssue {
  id: IssueId
  title: string
  kind: string
  state: string
}

/** An Issue closed recently, with how it closed: what a restated ask is checked against ("already covered"). */
export interface ClosedIssue {
  id: IssueId
  title: string
  outcome: string
  reason: string | null
  closedAt: Date
}
