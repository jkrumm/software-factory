import type { IssueId } from '../../kernel/ids.ts'
import type { Key } from '../../kernel/keys.ts'
import type { Result } from '../../kernel/result.ts'
import type { RunStatus } from '../../kernel/run.ts'
import type { ErrandId } from './errand.ts'
import type { Need } from './need.ts'
import type { CheckRun, Host } from './request.ts'
import type { MacbookVerb } from './need.ts'

export interface ErrandRecord {
  id: ErrandId
  key: Key
  /** null for a standalone Errand: a request nobody's Issue raised (`request.ts`) */
  issueId: IssueId | null
  attempt: number | null
  summary: string
  detail: string | null
  raisedAt: Date
  doneAt: Date | null
  doneNote: string | null
  /** when the screen let it through to the owner; null while held, and for good once turned away */
  reachedOwnerAt: Date | null
  /** failed screen calls so far, and when the next is due */
  screenTries: number
  screenRetryAt: Date | null
  screenBy: 'rule' | 'judge' | 'failed' | null
  screenNote: string | null
  turnedAwayAt: Date | null
  /** a standalone Errand: who asked, the command to run, the check that exits 0 while it is needed, where the hands must be, its expiry, its request key */
  source: string | null
  command: string | null
  checkCommand: string | null
  host: Host | null
  expiresAt: Date | null
  requestKey: string | null
  /** how it ended, and who ended it; null while open and for Errands closed before these were kept */
  closedKind: ClosedKind | null
  closedBy: ClosedBy | null
  /** the last run of the check, what it said, and the runs in a row that could not answer */
  checkAt: Date | null
  checkNote: string | null
  checkFails: number
  /** the last look of the still-needed workflow */
  neededAt: Date | null
  /** the last pushed run that came back unsuccessful, and how many have (`run.ts`); the output as its first and last lines */
  runAttempts: number
  runStatus: RunStatus | null
  runExit: number | null
  runAt: Date | null
  runHead: string | null
  runTail: string | null
  /** the last time the desk pass pushed its command to the MacBook */
  pushedAt: Date | null
  /** what it needs from the owner, set when it reached him; null for an Errand that reached him before `need` existed */
  need: Need | null
  /** when the owner pressed Approve: the server ran (or is running) its command on the mini */
  approvedAt: Date | null
  /** what makes it the same need as another (`domains/errands/match.ts`); null for an Errand raised before it existed */
  matchKey: string | null
}

/** An Issue that waits on an Errand another Issue (or a request) raised first: its command, check, need key or ask was the same. */
export interface ErrandJoin {
  errandId: ErrandId
  issueId: IssueId
  attempt: number
  joinedAt: Date
  /** the key of the raise that joined: a repeat of that call finds this join */
  key: Key
}

export type ClosedKind = 'done' | 'not_needed' | 'expired' | 'superseded' | 'turned_away' | 'turned_back'
export type ClosedBy = 'owner' | 'orchestrator' | 'check' | 'judge' | 'loop' | 'request'

/**
 * The errands domain's tables, inside one transaction. A database failure throws and aborts the transaction; the unit of
 * work turns it into a `PortError`. Every insert answers false when its key is stored already.
 */
export interface ErrandStore {
  insertErrand(errand: ErrandRecord): Promise<boolean>
  errand(id: ErrandId): Promise<ErrandRecord | null>
  errandByKey(key: Key): Promise<ErrandRecord | null>
  errands(filter: { issueId?: IssueId; open?: boolean; limit: number }): Promise<ErrandRecord[]>
  /** false when it is done already; `how` defaults to the owner's hands */
  finishErrand(id: ErrandId, at: Date, note: string | null, how?: { kind: ClosedKind; by: ClosedBy }): Promise<boolean>
  /** closes the open Errands that hold this request key as superseded; their ids */
  supersedeRequests(requestKey: string, by: ErrandId, at: Date): Promise<ErrandId[]>
  /** the standalone Errands that are open or were closed at `closedSince` or later, oldest first */
  requests(input: { closedSince: Date; limit: number }): Promise<ErrandRecord[]>
  /**
   * a run of the Errand's command that left it open, and what it came to (`done`: it exited 0 and the check still says it is needed;
   * only the unsuccessful ones count in `runAttempts`); false when it is done already
   */
  recordRun(
    id: ErrandId,
    run: { at: Date; status: RunStatus; exit: number | null; head: string; tail: string },
  ): Promise<boolean>
  /** an approved run that succeeded but left the Errand open (its check still says it is needed): the `running` mark goes */
  clearRun(id: ErrandId): Promise<boolean>
  /** what the last run of an Errand's check came to: `fails` is the runs in a row that could not answer */
  recordCheck(id: ErrandId, run: { at: Date; note: string; fails: number }): Promise<boolean>
  /** the still-needed workflow looked and kept it */
  recordNeeded(id: ErrandId, run: { at: Date; note: string }): Promise<boolean>
  /** the desk pass pushed the Errand's command to the MacBook; false when it is done already */
  recordPush(id: ErrandId, at: Date): Promise<boolean>
  /** every open Errand, an Issue's and a request, oldest first */
  openErrands(limit: number): Promise<ErrandRecord[]>
  /** the open Errands the screen has not let through, oldest first, whose retry is due */
  unscreenedErrands(now: Date, limit: number): Promise<ErrandRecord[]>
  lockErrand(id: ErrandId): Promise<ErrandRecord | null>
  /** each of these is false when the Errand is done already */
  failErrandScreen(id: ErrandId, failed: { tries: number; retryAt: Date; note: string }): Promise<boolean>
  reachOwner(
    id: ErrandId,
    reached: { at: Date; by: 'rule' | 'judge' | 'failed'; note: string; tries: number; need: Need },
  ): Promise<boolean>
  /** the open Errands that reached the owner before `need` existed (or were stored without one), oldest first */
  needlessErrands(limit: number): Promise<ErrandRecord[]>
  /** stores what an Errand that has none needs; false when it has one or is done */
  setNeed(id: ErrandId, need: Need): Promise<boolean>
  /** the open Errand that has this command, this check or this match key, oldest first (a `null` matches nothing); one that was turned away, or whose raising Issue is closed, is not open */
  openMatching(input: {
    command: string | null
    check: string | null
    matchKey: string | null
  }): Promise<ErrandRecord | null>
  /** the latest turn-back, by the owner or the orchestrator, of an Errand with this match key at or after `since`: when, and his note (the same need is not raised again for a while) */
  declinedMatch(matchKey: string, since: Date): Promise<{ at: Date; note: string } | null>
  /** the Errand an earlier raise under this key joined, open or closed */
  joinedErrand(key: Key): Promise<ErrandRecord | null>
  /** an Issue waits on this Errand too; false when it does already */
  joinErrand(join: ErrandJoin): Promise<boolean>
  /** the Issues that joined it, oldest first */
  joinsOf(id: ErrandId): Promise<ErrandJoin[]>
  /** the owner approved: its command is running on the mini now (status `running`, attempts unchanged); false when it is done, or another run is going (one that began within `staleBefore` or later) */
  startApprovedRun(id: ErrandId, at: Date, staleBefore: Date): Promise<boolean>
  turnAwayErrand(id: ErrandId, away: { at: Date; by: 'rule' | 'judge'; reason: string }): Promise<boolean>
  /** an Errand a rule refused when it was raised or requested: only counted (the part `errands_refused_by_rule_share` of the Errand KPI) */
  insertErrandRefusal(refusal: { at: Date; rule: string; source: string | null }): Promise<void>
}

/** Runs an Errand's `check` command: one shell, a timeout, the output cut. Never throws; a command that could not run says so in the run. */
export interface CheckRunner {
  run(command: string): Promise<CheckRun>
}

/** Pushes a request's command to the MacBook as a dialog the owner answers (`ask-human.sh push <errand>`): one call, never inside a transaction. The answer closes the Errand on its own. */
export interface PushPort {
  push(errand: ErrandId): Promise<Result<{ exit: number }>>
  /** whether the MacBook answers the ask-human ssh probe: one call, never inside a transaction */
  probe(): Promise<boolean>
}

/**
 * The MacBook's dotfiles sync verb over the dedicated ssh key (no arguments, nothing typed): fast-forwards its dotfiles from
 * the public repo and runs the make targets the pulled range touched. Exit 0 level or converged, 1 refused (dirty tree, not
 * master, diverged) or a target failed, 126 the MacBook's gate predates the verb, 255 unreachable.
 */
export interface SyncPort {
  sync(): Promise<Result<{ exit: number; output: string }>>
}

/**
 * A fixed verb of the MacBook's gate over the dedicated ssh key (`<verb> [<name>]` as its forced command reads it, `need.ts`): `dotfiles-sync`,
 * `report <name>` (one read-only command of the MacBook's registry, exit 0 when it ran, whatever it said) and `repo-pull <name>`
 * (`git pull --ff-only` of one checkout under `~/SourceRoot`). Exit 126: the gate refuses the verb (unknown, or an older gate),
 * 255: the MacBook is unreachable. One call, never inside a transaction.
 */
export interface MacbookVerbPort {
  run(verb: MacbookVerb, options?: { timeoutMs?: number }): Promise<Result<{ exit: number; output: string }>>
}

/** The desk pass's own record: when it last ran, when the owner last came back, and whether the MacBook last answered. */
export interface DeskStore {
  lastPassAt(): Promise<Date | null>
  recordPass(at: Date): Promise<void>
  /** the latest sign of his return: a Console read after a long absence, or the MacBook answering after it was down */
  returnedAt(): Promise<Date | null>
  /** whether the MacBook answered last; null before the first push or probe */
  macbookUp(): Promise<boolean | null>
  /** `backAt`: the MacBook answered after it was unreachable, which counts as his return */
  setMacbook(up: boolean, backAt: Date | null): Promise<void>
}
