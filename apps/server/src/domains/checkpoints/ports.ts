import type { ImageAnchor, SpecPrecedent, SpecSource } from '@software-factory/contract'
import type { SpecOrigin } from './spec-screen.ts'
import type { IssueId } from '../../kernel/ids.ts'
import type { Key } from '../../kernel/keys.ts'
import type { PortError, Result } from '../../kernel/result.ts'
import type { ArtifactId, ArtifactKind, CollectionId, Disposition, Format, Verdict } from './artifact.ts'
import type { DecisionForm, DecisionId, Precedent, Answerer, StepName } from './decision.ts'
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
  settledBy: Answerer | null
  /** what backs the answer: the Judge's source, the default, "the owner" */
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
  /** null for a standalone artifact (`factory artifact new`): no Issue owns it */
  issueId: IssueId | null
  /** the project of a standalone artifact; null when an Issue owns it */
  repo?: string | null
  kind: ArtifactKind
  title: string
  format: Format
  author: 'lead' | 'factory'
  createdAt: Date
  /** when it was retired (hidden from the list, still readable); null while it is shown */
  retiredAt?: Date | null
  /** the collection it belongs to (at most one); null while it stands alone */
  collectionId?: CollectionId | null
  /** read by `artifacts()` only: whether the owning Issue is closed, and its repo; null for a standalone artifact, absent from every other read */
  issueClosed?: boolean | null
  issueRepo?: string | null
}

/** A named set of artifacts with one lead page; pinned, it leads the Artifacts screen. */
export interface CollectionRecord {
  id: CollectionId
  key: Key
  title: string
  /** the project it concerns, stored as a project name */
  repo: string
  /** the overview: one of its members; null until one is named */
  leadArtifactId: ArtifactId | null
  /** when the owner pinned it; null while it is not */
  pinnedAt: Date | null
  createdAt: Date
}

/** What a collection's card shows, read off its members. */
export interface CollectionStats {
  members: ArtifactId[]
  /** the newest of a member's creation, revision, comment, verdict; null with no member */
  lastChange: Date | null
  /** the owner's comments on its members that the lead has not answered */
  openComments: number
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
  /** which occurrence of the quote in the text (0-based) and the text around it; null when the comment was made without them */
  occurrence: number | null
  prefix: string | null
  suffix: string | null
  /** the picture it hangs on (its quote is then derived from it); null for a comment on text */
  image: ImageAnchor | null
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
  /** who gave it: the owner, the factory for him (the default after the wait, a Spec screen settle, a withdrawal), or his delegate */
  by: 'owner' | 'factory' | 'orchestrator'
  /** the owner's mark: did it need him; null while unmarked */
  neededMe: boolean | null
}

/** The Spec screen's look at one revision (`spec-screen.ts`); `outcome` null while a failed call waits for its retry. */
export interface SpecScreenRecord {
  artifactId: ArtifactId
  revision: number
  outcome: 'passed' | 'settled' | null
  by: 'rule' | 'judge' | 'failed' | null
  source: SpecSource
  note: string | null
  tries: number
  retryAt: Date | null
  at: Date
}

/** A Spec revision as the screen reads it: the artifact, the revision, where it came from, and what came before. */
export interface UnscreenedSpec {
  artifact: ArtifactRecord
  revision: RevisionRecord
  origin: SpecOrigin
  /** a verdict on this revision already: the screen has nothing left to decide */
  answered: boolean
  /** the verdicts on its earlier revisions, oldest first */
  earlier: Verdict[]
  screen: SpecScreenRecord | null
}

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
  /** a new form for an open Decision (id, key and askedAt stay): its step rows are cleared so it is answered afresh, and its artifact's title follows. False when it is answered or withdrawn. */
  amendDecision(id: DecisionId, form: DecisionForm): Promise<boolean>
  decision(id: DecisionId): Promise<DecisionRecord | null>
  /** the Decision with its row locked until the transaction ends: whoever answers it or plans its page reads it this way, so the two cannot pass each other */
  lockDecision(id: DecisionId): Promise<DecisionRecord | null>
  decisionByKey(key: Key): Promise<DecisionRecord | null>
  /** false when it is answered or withdrawn already */
  answerDecision(id: DecisionId, answer: { text: string; by: Answerer; source: string; at: Date }): Promise<boolean>
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
  /** newest first; a retired artifact is left out unless `retired` is set */
  artifacts(filter: {
    issueId?: IssueId
    kind?: ArtifactKind
    retired?: boolean
    limit: number
  }): Promise<ArtifactRecord[]>
  /** false when it was retired already */
  retireArtifact(artifact: ArtifactId, at: Date): Promise<boolean>
  /** false when it was not retired */
  restoreArtifact(artifact: ArtifactId): Promise<boolean>
  /** the Issue an artifact also concerns; false when it was linked already */
  linkArtifact(artifact: ArtifactId, issue: IssueId, at: Date): Promise<boolean>
  /** the Issues each artifact is linked to, oldest link first (an artifact with none has an empty list) */
  artifactLinks(ids: readonly ArtifactId[]): Promise<Map<ArtifactId, IssueId[]>>
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
  /** the owner's verdict in place of his delegate's on a revision: its mark is cleared; null when the revision has no delegate's verdict */
  replaceDelegatedVerdict(verdict: VerdictRecord): Promise<VerdictRecord | null>
  verdicts(id: ArtifactId): Promise<VerdictRecord[]>
  /** the owner's mark on the verdict of a revision: `unchanged` when it had that value, `no_verdict` when the revision has none */
  setNeededMe(
    id: ArtifactId,
    revision: number,
    needed: boolean,
    at: Date,
  ): Promise<'set' | 'unchanged' | 'no_verdict' | 'unknown'>

  /** the Spec revisions the screen has not decided, oldest first: the latest revision, no verdict, a retry that is due */
  unscreenedSpecs(now: Date, limit: number): Promise<{ artifact: ArtifactId; revision: number }[]>
  /** one Spec revision with what the screen reads, its row locked (`lock: false` for a read that writes nothing); null when it is not the latest Spec revision */
  lockSpecRevision(id: ArtifactId, revision: number, options?: { lock: boolean }): Promise<UnscreenedSpec | null>
  specScreen(id: ArtifactId, revision: number): Promise<SpecScreenRecord | null>
  /** writes the screen's look; false when the revision was decided already */
  recordSpecScreen(screen: SpecScreenRecord): Promise<boolean>
  /** the owner's newest marks on Specs, newest first: the screen's and triage's precedents */
  specPrecedents(limit: number): Promise<SpecPrecedent[]>

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

/** The collections of artifacts, inside one transaction (`CheckpointStore` holds the artifacts themselves). */
export interface CollectionStore {
  insertCollection(collection: CollectionRecord): Promise<boolean>
  collection(id: CollectionId): Promise<CollectionRecord | null>
  collectionByKey(key: Key): Promise<CollectionRecord | null>
  /** pinned first, then newest */
  collections(): Promise<CollectionRecord[]>
  updateCollection(id: CollectionId, change: { title?: string; leadArtifactId?: ArtifactId | null }): Promise<void>
  /** false when the pin was as asked already */
  setCollectionPin(id: CollectionId, at: Date | null): Promise<boolean>
  /** put an artifact in a collection, or take it out (null); only a free artifact, or one already there, is taken: false when it is in another */
  setArtifactCollection(
    artifact: ArtifactId,
    collection: CollectionId | null,
    from: CollectionId | null,
  ): Promise<boolean>
  collectionStats(ids: readonly CollectionId[]): Promise<Map<CollectionId, CollectionStats>>
}

/** Where artifact revisions live: files under the factory's data directory, never in git. A blob is named by its content. */
export interface BlobStore {
  put(content: string): Promise<Result<{ path: string; sha256: string; bytes: number }>>
  get(path: string): Promise<Result<string>>
}

/** The owner's line. One call, never inside a transaction. */
export interface Notifier {
  send(page: Page): Promise<Result<void>>
}
