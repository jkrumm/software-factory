import type {
  ApiErrorPorts,
  LeadStore,
  Claims,
  Checks,
  MergeGuard,
  Repos,
  Roles,
  Seats,
  Terminals,
  Transcripts,
  Windows,
  Worktrees,
  LeadBranches,
  QuiescePorts,
} from '../domains/leads/ports.ts'
import type { QualityStore } from '../domains/quality/store.ts'
import type { Issue } from '../domains/work/issue.ts'
import { replay, type AppliedRecord } from '../domains/work/machine.ts'
import type { WorkStore } from '../domains/work/ports.ts'
import type { Clock } from '../kernel/clock.ts'
import { portError, type PortError } from '../kernel/result.ts'
import type { IssueWriteError } from './issues.ts'
import type { IdSource, IssueId } from '../kernel/ids.ts'
import type { UnitOfWork } from './unit-of-work.ts'

/** The stores the leads' use cases use in one transaction: the Issue's events, the lead's own tables, and (read only) what the Issue shipped. */
export type LeadsUow = UnitOfWork<{ work: WorkStore; leads: LeadStore; quality: QualityStore }>

/** Everything the leads' use cases need; `main.ts` composes it, the scenarios and tests bring fakes of the ports. */
export interface LeadDeps {
  uow: LeadsUow
  clock: Clock
  ids: IdSource
  terminals: Terminals
  worktrees: Worktrees
  branches: LeadBranches
  repos: Repos
  /** the project's check tiers, for the brief */
  checks: Checks
  /** whether the repo has `make merge-guard`, for the brief */
  mergeGuard: MergeGuard
  roles: Roles
  /** capacity's: the account, the claim, the window (package 3) */
  seats: Seats
  claims: Claims
  windows: Windows
  transcripts: Transcripts
  /** a start that has not worked after this long is a lead gone */
  startBudgetMs: number
  /** a note that waited this long for the lead's turn to end is typed into its working turn */
  forceNoteAfterMs: number
  /** a terminal lost this soon after the lead started or last spoke is not yet called gone */
  graceMs: number
  /** the API-error path's ports; unset, a turn that ended on an API error is neither found nor answered */
  apiErrors?: ApiErrorPorts
  /** quiescing of waiting leads; unset, no lead is dormant */
  quiesce?: QuiescePorts
  /** the host's process table, read fresh (never cached); null when it cannot be read. Unset, no lead is held at the wall (`holdWalledLeads`), whatever quiescing is set to */
  processTable?: QuiescePorts['processes']
  /** whether triage's `small` starts on the light seat now (the tripwire, `read/kpis-seats.ts`); unset or failing, it does not */
  lightGate?: () => Promise<boolean>
  /** the hygiene classes whose Issues start on the standard lead now (`judgeClassSeat`, `read/finding-seats.ts`); unset or failing, none */
  lightClassesOut?: () => Promise<ReadonlySet<string>>
  /** whether the cheap reviewer row takes every non-deep review (`domains/leads/reviewer.ts`'s tripwire); unset: the starting share */
  reviewerTakesAll?: () => Promise<boolean>
  /** waits its turn before a note or nudge is typed into a lead: after a server start, one per 10 s; unset, no wait */
  typePace?: () => Promise<void>
}

/** The Issue and its applied events, or null when there is no such Issue. */
export async function loadIssue(
  work: WorkStore,
  id: IssueId,
): Promise<{ issue: Issue; history: AppliedRecord[] } | null> {
  const history = await work.history(id)
  return history ? { issue: replay(id, history), history } : null
}

/**
 * A write that did not land, as the outbox reads it: the Issue moved under us (try again), or the database is gone;
 * anything else is a key the caller built wrong, which is a bug that must show.
 */
export function toPortError(error: IssueWriteError | PortError): PortError {
  if (!('kind' in error)) return portError('gone', 'unknown write error')
  switch (error.kind) {
    case 'timeout':
    case 'gone':
    case 'refused':
    case 'unreadable':
      return error
    case 'version_conflict':
      return portError('timeout', `Issue ${error.issueId} moved under the write; trying again`)
    case 'unknown_issue':
      return portError('gone', `no Issue ${error.issueId}`)
    case 'key_taken':
      throw new Error(`a key was built wrong: ${error.key} is ${error.detail}`)
    case 'filing_refused':
      throw new Error(`a filing was refused: ${error.detail}`)
  }
}
