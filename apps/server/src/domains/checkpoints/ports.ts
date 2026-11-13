import type {
  ErrandNeededAnswer,
  ErrandNeededRequest,
  ErrandScreenAnswer,
  ErrandScreenRequest,
} from '@software-factory/contract'
import type { IssueId } from '../../kernel/ids.ts'
import type { Key } from '../../kernel/keys.ts'
import type { PortError, Result } from '../../kernel/result.ts'
import type { ArtifactId, ArtifactKind, Disposition, Format, Verdict } from './artifact.ts'
import type {
  DecisionForm,
  DecisionId,
  JudgeInput,
  JudgeVerdict,
  PolicyRule,
  Precedent,
  Settler,
  StepName,
} from './decision.ts'
import type { ErrandId } from './errand.ts'
import type { CheckRun, Host } from './request.ts'
import type { Page } from './page.ts'
import type { Recheck, RecheckCandidate, ReviewWait } from './recheck.ts'

/** A step on a Decision's way to an answer. `open`: it reached the owner. */
export const STEP_OUTCOMES = ['answered', 'passed', 'rejected', 'failed', 'open'] as const
export type StepOutcome = (typeof STEP_OUTCOMES)[number]

/**
 * `claimed`: the caller makes the call. `in_flight`: another caller's call is running, so the Decision is left alone.
 * `done`: the step has an outcome already. `retry_later`: the Judge's call failed, tries are left and the backoff has not
 * run out, so the Decision waits for it.
 */
export type StepClaim = 'claimed' | 'in_flight' | 'done' | 'retry_later'

export interface Step {
  step: StepName
  /** null while a call is in flight */
  outcome: StepOutcome | null
  at: Date | null
  detail: string | null
  /** the calls made for this step (the Judge's are tried again after a failure) */
  tries: number
}

/** A Decision as stored: the form, and what became of it. Its status is derived from these facts. */
export interface DecisionRecord {
  id: DecisionId
  key: Key
  issueId: IssueId
  repo: string
  attempt: number
  form: DecisionForm
  askedAt: Date
  askedBy: 'lead' | 'steward'
  /** the artifact under review when the lead raised it during that review; null otherwise */
  artifactId: ArtifactId | null
  answer: string | null
  settledBy: Settler | null
  /** what backs the answer: the policy rule's reason, the Judge's source, the default, "the owner" */
  source: string | null
  answeredAt: Date | null
  /** set when the Issue no longer waits for it (closed, cancelled): it leaves every list of open work */
  withdrawnAt: Date | null
  withdrawnReason: string | null
  worthAsking: boolean | null
  steps: Step[]
}

export type DecisionStatus = 'open' | 'answered' | 'withdrawn'

export const statusOf = (decision: Pick<DecisionRecord, 'answeredAt' | 'withdrawnAt'>): DecisionStatus =>
  decision.answeredAt ? 'answered' : decision.withdrawnAt ? 'withdrawn' : 'open'

export interface DecisionFilter {
  issueId?: IssueId
  status?: DecisionStatus
  worthAsking?: boolean
  limit: number
}

export interface ArtifactRecord {
  id: ArtifactId
  key: Key
  issueId: IssueId
  kind: ArtifactKind
  title: string
  format: Format
  author: 'lead' | 'factory'
  createdAt: Date
}

export interface RevisionRecord {
  artifactId: ArtifactId
  n: number
  /** where the blob is, as the blob store gave it back */
  blob: string
  sha256: string
  bytes: number
  note: string | null
  createdAt: Date
}

export interface AnnotationRecord {
  id: string
  key: Key
  artifactId: ArtifactId
  /** the revision the annotation was made on */
  revision: number
  quote: string
  path: string | null
  comment: string
  author: 'owner' | 'lead'
  at: Date
  /** when the owner last changed the comment; null while it is as first written */
  editedAt: Date | null
  /** the lead's answer: null until it gives one (the reply is replaced by a later one) */
  disposition: Disposition | null
  dispositionNote: string | null
  disposedAt: Date | null
}

export interface VerdictRecord {
  artifactId: ArtifactId
  revision: number
  verdict: Verdict
  note: string | null
  at: Date
}

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
}

export type ClosedKind = 'done' | 'not_needed' | 'expired' | 'superseded' | 'turned_away'
export type ClosedBy = 'owner' | 'check' | 'judge' | 'loop' | 'request'

/** `failing`: unsent after the attempts a healthy line needs; it is still tried, and the error says why. */
export type PageStatus = 'pending' | 'sent' | 'failing' | 'cancelled'

export interface PageRecord extends Page {
  plannedAt: Date
  attempts: number
  sentAt: Date | null
  error: string | null
  status: PageStatus
}

export type PageRun = { at: Date; ok: true } | { at: Date; ok: false; error: PortError; retryAt: Date }

/**
 * The checkpoints domain's tables, inside one transaction. A database failure throws and aborts the transaction; the
 * unit of work turns it into a `PortError`. Every insert answers false when its key is stored already.
 */
export interface CheckpointStore {
  insertDecision(
    decision: Omit<
      DecisionRecord,
      'steps' | 'answer' | 'settledBy' | 'source' | 'answeredAt' | 'withdrawnAt' | 'withdrawnReason' | 'worthAsking'
    >,
  ): Promise<boolean>
  /** a new form for an open Decision (id, key and askedAt stay): its step rows are cleared so it is settled afresh, and its artifact's title follows. False when it is answered or withdrawn. */
  amendDecision(id: DecisionId, form: DecisionForm): Promise<boolean>
  decision(id: DecisionId): Promise<DecisionRecord | null>
  /** the Decision with its row locked until the transaction ends: whoever settles it or plans its page reads it this way, so the two cannot pass each other */
  lockDecision(id: DecisionId): Promise<DecisionRecord | null>
  decisionByKey(key: Key): Promise<DecisionRecord | null>
  /** false when it is answered or withdrawn already */
  answerDecision(id: DecisionId, answer: { text: string; by: Settler; source: string; at: Date }): Promise<boolean>
  withdrawDecision(id: DecisionId, reason: string, at: Date): Promise<boolean>
  /** the flag on an answered Decision: `unchanged` when it already had that value, `unanswered` when it is not answered yet */
  setWorthAsking(id: DecisionId, worth: boolean): Promise<'set' | 'unchanged' | 'unanswered' | 'unknown'>
  decisions(filter: DecisionFilter): Promise<DecisionRecord[]>
  /** the open Decisions, oldest first */
  openDecisions(limit: number): Promise<DecisionRecord[]>
  /** answered Decisions that look like this question (the `to_tsquery` OR expression), the owner's own answers first */
  precedents(terms: string, input: { excluding: DecisionId; limit: number }): Promise<Precedent[]>
  /** takes the step for a call: `claimed` when this caller may make it (not done, not leased to another; a failed Judge call whose backoff ran out and has tries left is claimed again) */
  claimStep(id: DecisionId, step: StepName, now: Date, until: Date): Promise<StepClaim>
  finishStep(
    id: DecisionId,
    step: StepName,
    done: { outcome: Exclude<Step['outcome'], null>; detail: string | null; at: Date },
  ): Promise<void>
  /** a step with no call: true when this is the first time it is recorded */
  recordStep(
    id: DecisionId,
    step: StepName,
    done: { outcome: Exclude<Step['outcome'], null>; detail: string | null; at: Date },
  ): Promise<boolean>

  insertArtifact(artifact: ArtifactRecord): Promise<boolean>
  artifact(id: ArtifactId): Promise<ArtifactRecord | null>
  artifactByKey(key: Key): Promise<ArtifactRecord | null>
  artifacts(filter: { issueId?: IssueId; kind?: ArtifactKind; limit: number }): Promise<ArtifactRecord[]>
  insertRevision(revision: RevisionRecord & { key: Key }): Promise<boolean>
  revisions(id: ArtifactId): Promise<RevisionRecord[]>
  insertAnnotation(annotation: AnnotationRecord): Promise<boolean>
  annotationByKey(key: Key): Promise<AnnotationRecord | null>
  annotation(id: string): Promise<AnnotationRecord | null>
  /** true when the comment changed; the same comment again changes nothing. New words clear the lead's answer to the old ones. */
  editAnnotation(id: string, comment: string, key: Key, at: Date): Promise<boolean>
  /** true when a row was removed */
  deleteAnnotation(id: string): Promise<boolean>
  annotations(id: ArtifactId): Promise<AnnotationRecord[]>
  /** the lead's answer to an annotation, kept in place of an earlier one; true when it changed the row */
  disposeAnnotation(id: string, disposition: Disposition, note: string, at: Date): Promise<boolean>
  insertVerdict(verdict: VerdictRecord & { key: Key }): Promise<boolean>
  verdictByKey(key: Key): Promise<VerdictRecord | null>
  verdicts(id: ArtifactId): Promise<VerdictRecord[]>

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
  /** what the last run of an Errand's check came to: `fails` is the runs in a row that could not answer */
  recordCheck(id: ErrandId, run: { at: Date; note: string; fails: number }): Promise<boolean>
  /** the still-needed workflow looked and kept it */
  recordNeeded(id: ErrandId, run: { at: Date; note: string }): Promise<boolean>
  /** the open Errands the screen has not let through, oldest first, whose retry is due */
  unscreenedErrands(now: Date, limit: number): Promise<ErrandRecord[]>
  lockErrand(id: ErrandId): Promise<ErrandRecord | null>
  /** each of these is false when the Errand is done already */
  failErrandScreen(id: ErrandId, failed: { tries: number; retryAt: Date; note: string }): Promise<boolean>
  reachOwner(
    id: ErrandId,
    reached: { at: Date; by: 'rule' | 'judge' | 'failed'; note: string; tries: number },
  ): Promise<boolean>
  turnAwayErrand(id: ErrandId, away: { at: Date; by: 'rule' | 'judge'; reason: string }): Promise<boolean>

  /**
   * The checkpoints at the owner since `reachedBefore` or earlier: open Decisions whose `owner` step is `open`, open Errands
   * that reached him, oldest first, each with its last recheck; one rechecked since `reachedBefore` is left out.
   */
  recheckCandidates(input: { reachedBefore: Date; limit: number }): Promise<RecheckCandidate[]>
  /**
   * Concepts and Specs whose latest revision was handed over at `before` or earlier, with no verdict and no look at that
   * revision yet, oldest first.
   */
  staleReviews(input: { before: Date; limit: number }): Promise<ReviewWait[]>
  /** false when the checkpoint has a recheck at that version already */
  insertRecheck(recheck: Recheck): Promise<boolean>

  /** false when the page's key is stored already */
  planPage(page: Page, at: Date): Promise<boolean>
  /** a checkpoint settled: its unsent pages are never sent */
  cancelPages(checkpoint: string, at: Date): Promise<void>
  claimPages(input: { now: Date; until: Date; limit: number }): Promise<(Page & { attempts: number })[]>
  recordPage(key: Key, run: PageRun): Promise<void>
  pages(limit: number): Promise<PageRecord[]>
}

/** Where artifact revisions live: files under the factory's data directory, never in git. A blob is named by its content. */
export interface BlobStore {
  put(content: string): Promise<Result<{ path: string; sha256: string; bytes: number }>>
  get(path: string): Promise<Result<string>>
}

/** A project's standing policy: the rules its `project.yaml` holds. Package 3 owns the project; `main.ts` brings its adapter. */
export interface StandingPolicies {
  rulesFor(repo: string): Promise<Result<PolicyRule[]>>
}

/** The Judge: the `factory-ask` agw workflow, package 7's. The key is the Decision's, so a call asked again finds its run. */
export interface JudgePort {
  judge(input: JudgeInput, key: Key): Promise<Result<JudgeVerdict>>
}

/** The Errand screen: the `factory-errand` agw workflow. The key names the Errand and the try. */
export interface ErrandScreenPort {
  screen(request: ErrandScreenRequest, key: Key): Promise<Result<ErrandScreenAnswer>>
}

/** The still-needed look: the `factory-errand-needed` agw workflow. The key names the Errand and the day. */
export interface ErrandNeededPort {
  judge(request: ErrandNeededRequest, key: Key): Promise<Result<ErrandNeededAnswer>>
}

/** Runs an Errand's `check` command: one shell, a timeout, the output cut. Never throws; a command that could not run says so in the run. */
export interface CheckRunner {
  run(command: string): Promise<CheckRun>
}

/** The owner's line. One call, never inside a transaction. */
export interface Notifier {
  send(page: Page): Promise<Result<void>>
}
