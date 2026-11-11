import {
  type Anchor,
  anchorOf,
  type AnnotationInput,
  type ArtifactId,
  type ArtifactKind,
  readAnnotation,
  readComment,
  readSubmission,
  renderDecisionForm,
  type Verdict,
  VERDICTS,
  waitsForReview,
} from '../domains/checkpoints/artifact.ts'
import {
  type DecisionForm,
  type DecisionId,
  type MissingFields,
  readDecisionForm,
  type Settler,
} from '../domains/checkpoints/decision.ts'
import { type ErrandId, readErrand, refuseHostClass } from '../domains/checkpoints/errand.ts'
import { deepLink, reviewPage } from '../domains/checkpoints/page.ts'
import type {
  AnnotationRecord,
  ArtifactRecord,
  BlobStore,
  CheckpointStore,
  DecisionFilter,
  DecisionRecord,
  ErrandRecord,
  PageRecord,
  RevisionRecord,
  VerdictRecord,
} from '../domains/checkpoints/ports.ts'
import type { IssueEvent } from '../domains/work/events.ts'
import type { Issue } from '../domains/work/issue.ts'
import { replay } from '../domains/work/machine.ts'
import type { WorkStore } from '../domains/work/ports.ts'
import type { IssueId } from '../kernel/ids.ts'
import { key } from '../kernel/keys.ts'
import { err, ok, type PortError, type Result } from '../kernel/result.ts'
import { type IssueWriteError, recordIn, type Recorded, type WriteDeps } from './issues.ts'
import type { UnitOfWork } from './unit-of-work.ts'

export type CheckpointStores = { work: WorkStore; checkpoints: CheckpointStore }
export type CheckpointUow = UnitOfWork<CheckpointStores>

export interface CheckpointDeps extends WriteDeps {
  uow: CheckpointUow
  blobs: BlobStore
  /** the base of a checkpoint's deep link; a placeholder setting until the Console exists */
  consoleUrl: string
}

export type CheckpointError =
  | IssueWriteError
  | MissingFields
  /** the Issue's machine refused the event: the reason is the machine's own */
  | { kind: 'machine_refused'; detail: string }
  | { kind: 'invalid'; detail: string }
  | { kind: 'not_found'; what: string; id: string }
  | { kind: 'already_answered'; by: Settler; answer: string }

export type CheckpointResult<T> = Result<T, CheckpointError | PortError>

/** Where the Issue stands after a write, and the effects the write planned (a `note_lead` among them). */
export interface IssueMove {
  state: string
  waitReason: string | null
  version: number
  effects: { kind: string; key: string }[]
}

export const moveOf = (issue: Issue, effects: Recorded['effects'] = []): IssueMove => ({
  state: issue.state,
  waitReason: issue.wait?.reason ?? null,
  version: issue.version,
  effects: effects.map((effect) => ({ kind: effect.kind, key: effect.key })),
})

/** A short stable digest of text, for the part of a key that the text decides. */
export const digest = (text: string): string => new Bun.CryptoHasher('sha256').update(text).digest('hex').slice(0, 16)

export async function issueOf(work: WorkStore, id: IssueId): Promise<Issue | null> {
  const history = await work.history(id)
  return history ? replay(id, history) : null
}

/**
 * Whether the Issue waits right now for this checkpoint to be settled. A Decision the lead raised about an artifact under
 * review is waited for too: the review wait lists it.
 */
export const waitingOn = (issue: Issue, reason: 'decision' | 'review' | 'errand', checkpoint: string): boolean => {
  const { wait } = issue
  if (issue.state !== 'waiting' || !wait) return false
  if (reason === 'decision' && wait.reason === 'review') {
    return wait.decisions?.some((open) => open.id === checkpoint) ?? false
  }
  return wait.reason === reason && 'holds' in wait && wait.holds.id === checkpoint
}

/** An event the machine must apply: anything else (refused, ignored, replayed) is the caller's error, and rolls back. */
export function applied(recorded: Result<Recorded, IssueWriteError>, what: string): Result<Recorded, CheckpointError> {
  if (!recorded.ok) return recorded
  if (recorded.value.result === 'applied') return recorded
  return err({ kind: 'machine_refused', detail: recorded.value.event.detail ?? `${what} was ${recorded.value.result}` })
}

const notFound = (what: string, id: string): CheckpointError => ({ kind: 'not_found', what, id })

/** A Decision's artifact has the Decision's id: one record to link to. */
export const artifactOfDecision = (id: DecisionId): ArtifactId => id as string as ArtifactId

// ---------------------------------------------------------------------------------------------------------------------
// Decisions

/** A short digest of a form, whatever order its stored keys come back in: two forms are the same exactly when it is. */
export const formDigest = (form: DecisionForm): string =>
  digest(
    JSON.stringify([
      form.question,
      form.recommendation,
      form.checked,
      form.options.map((o) => [o.label, o.reversible, o.cost]),
      [form.noAnswer.consequence, form.noAnswer.default, form.noAnswer.waitMinutes],
    ]),
  )

export interface Asked {
  result: 'applied' | 'replayed' | 'amended'
  decision: DecisionRecord
  issue: IssueMove
}

/**
 * `factory issue ask`: the lead raises a Decision. A form with a missing field is refused with the field named and
 * nothing is stored. The form is rendered as the Decision artifact's revision 1 (blob first, outside the transaction),
 * then one transaction records `asked`, which makes the Issue wait, and the Decision. The same ask again is the same
 * Decision. A different form from the same asker while the Issue still waits on its open Decision amends that one
 * instead of raising another: the form is replaced, the new rendering is the artifact's next revision, and the steps and
 * unsent pages are cleared so the amended form is settled afresh. Settling it (policy, the Judge, the default, the owner)
 * is the pass's, not this call's.
 */
export async function askDecision(
  deps: CheckpointDeps,
  input: { issueId: IssueId; attempt: number; form: unknown; by?: 'lead' | 'steward'; salt?: string; call?: string },
): Promise<CheckpointResult<Asked>> {
  const read = readDecisionForm(input.form)
  if (!read.ok) return read
  const form = read.value
  const blob = await deps.blobs.put(renderDecisionForm(form))
  if (!blob.ok) return blob
  // The same ask again is the same Decision; a caller that asks about a new situation (the steward, a later stall) salts it.
  // A `call` names the call: the same one again is the same Decision, whatever its words.
  const hash = digest(
    input.call ? `call:${input.call}` : input.salt ? `${form.question}\n${input.salt}` : form.question,
  )

  return deps.uow.run(async ({ work, checkpoints }) => {
    const askKey = key('ask', input.issueId, input.attempt, hash)
    const existing = await checkpoints.decisionByKey(askKey)
    const issue = await issueOf(work, input.issueId)
    if (!issue) return err({ kind: 'unknown_issue', issueId: input.issueId })

    const by = input.by ?? 'lead'
    const open = (await checkpoints.decisions({ issueId: input.issueId, status: 'open', limit: 50 })).find(
      (candidate) =>
        candidate.askedBy === by && candidate.attempt === input.attempt && waitingOn(issue, 'decision', candidate.id),
    )
    if (open) {
      if (formDigest(open.form) === formDigest(form))
        return ok<Asked>({ result: 'replayed', decision: open, issue: moveOf(issue) })
      const at = deps.clock.now()
      const artifact = artifactOfDecision(open.id)
      const revisions = await checkpoints.revisions(artifact)
      const n = Math.max(0, ...revisions.map((revision) => revision.n)) + 1
      if (!(await checkpoints.amendDecision(open.id, form))) {
        return err({ kind: 'version_conflict', issueId: input.issueId, expected: issue.version })
      }
      await checkpoints.insertRevision({
        artifactId: artifact,
        n,
        key: key('revision', artifact, n),
        blob: blob.value.path,
        sha256: blob.value.sha256,
        bytes: blob.value.bytes,
        note: 'amended',
        createdAt: at,
      })
      await checkpoints.cancelPages(open.id, at)
      const amended = await checkpoints.decision(open.id)
      if (!amended) throw new Error(`decision ${open.id} vanished inside its own transaction`)
      return ok<Asked>({ result: 'amended', decision: amended, issue: moveOf(issue) })
    }
    if (existing) return ok<Asked>({ result: 'replayed', decision: existing, issue: moveOf(issue) })

    const id = deps.ids.next('decision')
    // A Decision raised while the Issue waits for a review is about the artifact under review.
    const underReview =
      issue.state === 'waiting' && issue.wait?.reason === 'review' ? (issue.wait.holds.id as ArtifactId) : null
    const event: IssueEvent<'asked'> = {
      kind: 'asked',
      payload: { attempt: input.attempt, decision: { id, summary: form.question.slice(0, 200) } },
      actor: by,
    }
    const recorded = applied(
      await recordIn(work, deps, {
        issueId: input.issueId,
        key: key('asked', input.issueId, input.attempt, hash),
        event,
      }),
      'asked',
    )
    if (!recorded.ok) return recorded
    const at = deps.clock.now()
    const stored = await checkpoints.insertDecision({
      id,
      key: askKey,
      issueId: input.issueId,
      repo: issue.repo,
      attempt: input.attempt,
      form,
      askedAt: at,
      askedBy: by,
      artifactId: underReview,
    })
    if (!stored) return err({ kind: 'version_conflict', issueId: input.issueId, expected: issue.version })
    const artifact = artifactOfDecision(id)
    await checkpoints.insertArtifact({
      id: artifact,
      key: key('artifact', askKey),
      issueId: input.issueId,
      kind: 'decision',
      title: form.question.slice(0, 200),
      format: 'markdown',
      author: 'factory',
      createdAt: at,
    })
    await checkpoints.insertRevision({
      artifactId: artifact,
      n: 1,
      key: key('revision', artifact, 1),
      blob: blob.value.path,
      sha256: blob.value.sha256,
      bytes: blob.value.bytes,
      note: null,
      createdAt: at,
    })
    const decision = await checkpoints.decision(id)
    if (!decision) throw new Error(`decision ${id} vanished inside its own transaction`)
    return ok<Asked>({
      result: 'applied',
      decision,
      issue: moveOf(recorded.value.issue, recorded.value.effects),
    })
  })
}

export interface Answering {
  decision: DecisionRecord
  text: string
  by: Settler
  /** what backs the answer */
  source: string
  /** what the lead is told beside the answer (the factory's own sentence); null for the owner's */
  note: string | null
}

export type AnswerOutcome =
  | { status: 'answered'; decision: DecisionRecord; recorded: Recorded }
  | { status: 'withdrawn'; decision: DecisionRecord }

/**
 * Settles a Decision inside a transaction the caller holds: the Issue must still wait for it, else the Decision is
 * withdrawn (the Issue closed or was cancelled) and nothing reaches a lead. Otherwise the answer is recorded as an
 * `answered` event by its settler, with the factory's own note before it when there is one, so the one `note_lead` that
 * ends the wait carries both. One answer per Decision: the first to commit wins, the others see `already_answered`.
 */
export async function answerIn(
  { work, checkpoints }: CheckpointStores,
  deps: WriteDeps,
  answering: Answering,
): Promise<Result<AnswerOutcome, CheckpointError>> {
  const at = deps.clock.now()
  const fresh = await checkpoints.lockDecision(answering.decision.id)
  if (!fresh) return err(notFound('Decision', answering.decision.id))
  if (fresh.answeredAt && fresh.settledBy && fresh.answer !== null) {
    return err({ kind: 'already_answered', by: fresh.settledBy, answer: fresh.answer })
  }
  const issue = await issueOf(work, fresh.issueId)
  if (!issue) return err({ kind: 'unknown_issue', issueId: fresh.issueId })
  if (fresh.withdrawnAt || !waitingOn(issue, 'decision', fresh.id)) {
    if (!fresh.withdrawnAt) await checkpoints.withdrawDecision(fresh.id, 'the Issue no longer waits for it', at)
    await checkpoints.cancelPages(fresh.id, at)
    const withdrawn = await checkpoints.decision(fresh.id)
    return ok({ status: 'withdrawn', decision: withdrawn ?? fresh })
  }

  const actor =
    answering.by === 'owner' || answering.by === 'orchestrator'
      ? answering.by
      : answering.by === 'judge'
        ? 'judge'
        : 'factory'
  if (answering.note) {
    const noted = applied(
      await recordIn(work, deps, {
        issueId: fresh.issueId,
        key: key('noted', 'answer', fresh.id),
        event: { kind: 'noted', payload: { text: answering.note }, actor },
      }),
      'noted',
    )
    if (!noted.ok) return noted
  }
  const recorded = applied(
    await recordIn(work, deps, {
      issueId: fresh.issueId,
      key: key('answered', fresh.id),
      event: { kind: 'answered', payload: { decision: fresh.id, answer: answering.text }, actor },
    }),
    'answered',
  )
  if (!recorded.ok) return recorded
  const stored = await checkpoints.answerDecision(fresh.id, {
    text: answering.text,
    by: answering.by,
    source: answering.source,
    at,
  })
  if (!stored) throw new Error(`decision ${fresh.id} was answered under its own transaction`)
  await checkpoints.cancelPages(fresh.id, at)
  const decision = await checkpoints.decision(fresh.id)
  return ok({ status: 'answered', decision: decision ?? fresh, recorded: recorded.value })
}

export interface Answered {
  decision: DecisionRecord
  /** null when the Decision was withdrawn: the Issue no longer waited for it */
  issue: IssueMove | null
}

/**
 * The owner answers a Decision (the last step of settling, or an early answer to one still open); the orchestrator may
 * answer for him, recorded as its own (`settled_by` and the event's actor).
 */
export function answerDecision(
  deps: CheckpointDeps,
  input: { decisionId: DecisionId; answer: unknown; by?: 'owner' | 'orchestrator' },
): Promise<CheckpointResult<Answered>> {
  const text = typeof input.answer === 'string' ? input.answer.trim() : ''
  if (text === '') {
    return Promise.resolve(err({ kind: 'missing_field', fields: ['answer'], detail: 'an answer needs: answer' }))
  }
  return deps.uow.run(async (stores) => {
    const decision = await stores.checkpoints.decision(input.decisionId)
    if (!decision) return err(notFound('Decision', input.decisionId))
    const by = input.by ?? 'owner'
    const outcome = await answerIn(stores, deps, { decision, text, by, source: `the ${by}`, note: null })
    if (!outcome.ok) return outcome
    if (outcome.value.status === 'withdrawn') return ok<Answered>({ decision: outcome.value.decision, issue: null })
    const { recorded } = outcome.value
    return ok<Answered>({ decision: outcome.value.decision, issue: moveOf(recorded.issue, recorded.effects) })
  })
}

/** The owner's flag on an answered Decision: it feeds the ledger and the Judge's precedent. */
export function markWorthAsking(
  deps: CheckpointDeps,
  input: { decisionId: DecisionId; worth: boolean },
): Promise<CheckpointResult<DecisionRecord>> {
  return deps.uow.run(async ({ checkpoints }) => {
    const set = await checkpoints.setWorthAsking(input.decisionId, input.worth)
    if (set === 'unknown') return err(notFound('Decision', input.decisionId))
    if (set === 'unanswered') {
      return err({ kind: 'invalid', detail: 'only an answered Decision can be marked: it is not answered yet' })
    }
    const decision = await checkpoints.decision(input.decisionId)
    if (!decision) throw new Error(`decision ${input.decisionId} vanished inside its own transaction`)
    return ok(decision)
  })
}

export function showDecision(deps: CheckpointDeps, id: DecisionId): Promise<CheckpointResult<DecisionRecord>> {
  return deps.uow.run(async ({ checkpoints }) => {
    const decision = await checkpoints.decision(id)
    return decision ? ok(decision) : err(notFound('Decision', id))
  })
}

/** The ledger: every Decision with its path to the answer and the worth-asking flag, newest first. */
export function ledger(deps: CheckpointDeps, filter: DecisionFilter): Promise<CheckpointResult<DecisionRecord[]>> {
  return deps.uow.run(async ({ checkpoints }) => ok(await checkpoints.decisions(filter)))
}

// ---------------------------------------------------------------------------------------------------------------------
// Artifacts

export interface ArtifactWritten {
  result: 'applied' | 'replayed'
  artifact: ArtifactRecord
  revisions: RevisionRecord[]
  /** null when no event touched the Issue (a Report, an annotation) */
  issue: IssueMove | null
}

const labelOf: Record<Verdict, string> = {
  looks_good: 'Looks good',
  with_notes: 'With notes',
  changes: 'Changes',
  no_longer_applies: 'No longer applies',
}

async function written(
  checkpoints: CheckpointStore,
  id: ArtifactId,
  result: ArtifactWritten['result'],
  issue: IssueMove | null,
): Promise<ArtifactWritten> {
  const artifact = await checkpoints.artifact(id)
  if (!artifact) throw new Error(`artifact ${id} vanished inside its own transaction`)
  return { result, artifact, revisions: await checkpoints.revisions(id), issue }
}

/**
 * `factory artifact submit`: the lead hands over a Concept, a Spec or a Report. A Concept or Spec records `submitted`,
 * which makes the Issue wait for the owner's verdict, and pages him once; a Report never waits and pages no one. The
 * same hand-over again is the same artifact.
 */
export async function submitArtifact(
  deps: CheckpointDeps,
  input: { issueId: IssueId; attempt: number; raw: unknown },
): Promise<CheckpointResult<ArtifactWritten>> {
  const read = readSubmission(input.raw)
  if (!read.ok) return read
  const submission = read.value
  const blob = await deps.blobs.put(submission.content)
  if (!blob.ok) return blob
  const submitKey = key(
    'submit',
    input.issueId,
    input.attempt,
    digest(`${submission.kind}\n${submission.title}\n${blob.value.sha256}`),
  )

  return deps.uow.run(async ({ work, checkpoints }) => {
    const issue = await issueOf(work, input.issueId)
    if (!issue) return err({ kind: 'unknown_issue', issueId: input.issueId })
    const existing = await checkpoints.artifactByKey(submitKey)
    if (existing) return ok(await written(checkpoints, existing.id, 'replayed', moveOf(issue)))

    const id = deps.ids.next('artifact')
    const at = deps.clock.now()
    let move: IssueMove | null = null
    if (waitsForReview(submission.kind)) {
      const recorded = applied(
        await recordIn(work, deps, {
          issueId: input.issueId,
          key: key('submitted', id, 1),
          event: {
            kind: 'submitted',
            payload: { attempt: input.attempt, artifact: { id, summary: submission.title } },
            actor: 'lead',
          },
        }),
        'submitted',
      )
      if (!recorded.ok) return recorded
      move = moveOf(recorded.value.issue, recorded.value.effects)
    }
    const stored = await checkpoints.insertArtifact({
      id,
      key: submitKey,
      issueId: input.issueId,
      kind: submission.kind,
      title: submission.title,
      format: submission.format,
      author: 'lead',
      createdAt: at,
    })
    if (!stored) return err({ kind: 'version_conflict', issueId: input.issueId, expected: issue.version })
    await checkpoints.insertRevision({
      artifactId: id,
      n: 1,
      key: key('revision', id, 1),
      blob: blob.value.path,
      sha256: blob.value.sha256,
      bytes: blob.value.bytes,
      note: null,
      createdAt: at,
    })
    if (waitsForReview(submission.kind)) {
      await checkpoints.planPage(
        reviewPage({
          issue: { id: issue.id, repo: issue.repo },
          link: deepLink(deps.consoleUrl, id),
          artifact: id,
          revision: 1,
          kind: submission.kind,
          title: submission.title,
        }),
        at,
      )
    }
    return ok(await written(checkpoints, id, 'applied', move))
  })
}

/**
 * `factory artifact revise`: a new revision after a verdict of Changes. A Concept or Spec is submitted again (the Issue
 * waits again, the owner is paged for this revision); a Report just gains a revision.
 */
export async function reviseArtifact(
  deps: CheckpointDeps,
  input: { artifactId: ArtifactId; attempt: number | null; content: unknown; note: string | null },
): Promise<CheckpointResult<ArtifactWritten>> {
  const content = typeof input.content === 'string' ? input.content : ''
  if (content.trim() === '') {
    return err({ kind: 'missing_field', fields: ['content'], detail: 'a revision needs: content' })
  }
  const blob = await deps.blobs.put(content)
  if (!blob.ok) return blob
  return deps.uow.run(async ({ work, checkpoints }) => {
    const artifact = await checkpoints.artifact(input.artifactId)
    if (!artifact) return err(notFound('artifact', input.artifactId))
    const issue = await issueOf(work, artifact.issueId)
    if (!issue) return err({ kind: 'unknown_issue', issueId: artifact.issueId })
    if (artifact.kind === 'decision') return err({ kind: 'invalid', detail: 'a Decision is not revised: ask again' })
    const revisions = await checkpoints.revisions(artifact.id)
    // The same content as the latest revision is the lead sending it again; going back to an older one is a new revision.
    if (revisions.at(-1)?.sha256 === blob.value.sha256) {
      return ok(await written(checkpoints, artifact.id, 'replayed', moveOf(issue)))
    }
    const n = (revisions.at(-1)?.n ?? 0) + 1
    let move: IssueMove | null = null
    if (waitsForReview(artifact.kind)) {
      if (input.attempt === null) {
        return err({
          kind: 'missing_field',
          fields: ['attempt'],
          detail: 'a revision of a Concept or Spec needs: attempt',
        })
      }
      const recorded = applied(
        await recordIn(work, deps, {
          issueId: artifact.issueId,
          key: key('submitted', artifact.id, n),
          event: {
            kind: 'submitted',
            payload: { attempt: input.attempt, artifact: { id: artifact.id, summary: artifact.title } },
            actor: 'lead',
          },
        }),
        'submitted',
      )
      if (!recorded.ok) return recorded
      move = moveOf(recorded.value.issue, recorded.value.effects)
    }
    const at = deps.clock.now()
    const stored = await checkpoints.insertRevision({
      artifactId: artifact.id,
      n,
      key: key('revise', artifact.id, n),
      blob: blob.value.path,
      sha256: blob.value.sha256,
      bytes: blob.value.bytes,
      note: input.note?.trim() || null,
      createdAt: at,
    })
    if (!stored) return err({ kind: 'version_conflict', issueId: artifact.issueId, expected: issue.version })
    if (waitsForReview(artifact.kind)) {
      await checkpoints.planPage(
        reviewPage({
          issue: { id: issue.id, repo: issue.repo },
          link: deepLink(deps.consoleUrl, artifact.id),
          artifact: artifact.id,
          revision: n,
          kind: artifact.kind,
          title: artifact.title,
        }),
        at,
      )
    }
    return ok(await written(checkpoints, artifact.id, 'applied', move))
  })
}

/** Anyone with the artifact open may annotate: the owner, or a lead answering a note. No event reaches the Issue. */
export function annotateArtifact(
  deps: CheckpointDeps,
  input: { artifactId: ArtifactId; revision: number | null; author: 'owner' | 'lead'; raw: unknown },
): Promise<CheckpointResult<ArtifactWritten>> {
  const read = readAnnotation(input.raw)
  if (!read.ok) return Promise.resolve(read)
  const annotation: AnnotationInput = read.value
  return deps.uow.run(async ({ checkpoints }) => {
    const artifact = await checkpoints.artifact(input.artifactId)
    if (!artifact) return err(notFound('artifact', input.artifactId))
    const revisions = await checkpoints.revisions(artifact.id)
    const revision = input.revision ?? revisions.at(-1)?.n ?? 0
    if (!revisions.some((candidate) => candidate.n === revision)) {
      return err({ kind: 'invalid', detail: `${artifact.id} has no revision ${revision}` })
    }
    const annotateKey = key(
      'annotate',
      artifact.id,
      revision,
      input.author,
      digest(`${annotation.quote}\n${annotation.comment}`),
    )
    if (await checkpoints.annotationByKey(annotateKey)) {
      return ok(await written(checkpoints, artifact.id, 'replayed', null))
    }
    await checkpoints.insertAnnotation({
      id: deps.ids.next('annotation'),
      key: annotateKey,
      artifactId: artifact.id,
      revision,
      quote: annotation.quote,
      path: annotation.path,
      comment: annotation.comment,
      author: input.author,
      at: deps.clock.now(),
      editedAt: null,
    })
    return ok(await written(checkpoints, artifact.id, 'applied', null))
  })
}

/** The owner changes the comment of an annotation (not its quote, path or revision). The same comment again is a replay. */
export function editAnnotation(
  deps: CheckpointDeps,
  input: { artifactId: ArtifactId; annotationId: string; raw: unknown },
): Promise<CheckpointResult<ArtifactWritten>> {
  const read = readComment(input.raw)
  if (!read.ok) return Promise.resolve(read)
  return deps.uow.run(async ({ checkpoints }) => {
    const artifact = await checkpoints.artifact(input.artifactId)
    if (!artifact) return err(notFound('artifact', input.artifactId))
    const annotation = await checkpoints.annotation(input.annotationId)
    if (!annotation || annotation.artifactId !== artifact.id) return err(notFound('annotation', input.annotationId))
    if (annotation.author !== 'owner') return err({ kind: 'invalid', detail: 'only the owner edits their own comment' })
    // The replay key follows the words, so the old text can be commented again as a new annotation.
    const editKey = key('annotate-edit', annotation.id, digest(read.value))
    const changed = await checkpoints.editAnnotation(annotation.id, read.value, editKey, deps.clock.now())
    return ok(await written(checkpoints, artifact.id, changed ? 'applied' : 'replayed', null))
  })
}

/** The owner removes an annotation. One that is already gone is a replay; one that belongs to another artifact is not found. */
export function deleteAnnotation(
  deps: CheckpointDeps,
  input: { artifactId: ArtifactId; annotationId: string },
): Promise<CheckpointResult<ArtifactWritten>> {
  return deps.uow.run(async ({ checkpoints }) => {
    const artifact = await checkpoints.artifact(input.artifactId)
    if (!artifact) return err(notFound('artifact', input.artifactId))
    const annotation = await checkpoints.annotation(input.annotationId)
    if (annotation && annotation.artifactId !== artifact.id) return err(notFound('annotation', input.annotationId))
    const removed = annotation ? await checkpoints.deleteAnnotation(annotation.id) : false
    return ok(await written(checkpoints, artifact.id, removed ? 'applied' : 'replayed', null))
  })
}

/**
 * The owner's verdict on the latest revision of an artifact. On a Concept or Spec the Issue is waiting for it: the
 * verdict is stored and `verdict_given` ends the wait, so the verdict reaches the lead as its next turn in one
 * `note_lead`, once. A note goes to the lead with it as the owner's own words. The first verdict on a revision stands; a
 * repeat is a replay. A Report may carry a verdict (a spike's) and wakes no one.
 */
export function giveVerdict(
  deps: CheckpointDeps,
  input: { artifactId: ArtifactId; verdict: unknown; note: string | null; revision: number | null },
): Promise<CheckpointResult<ArtifactWritten & { verdict: VerdictRecord }>> {
  const verdict = VERDICTS.find((candidate) => candidate === input.verdict)
  if (!verdict) {
    const field = `verdict (${VERDICTS.join(', ')})`
    return Promise.resolve(err({ kind: 'missing_field', fields: [field], detail: `a verdict needs: ${field}` }))
  }
  return deps.uow.run(async ({ work, checkpoints }) => {
    const artifact = await checkpoints.artifact(input.artifactId)
    if (!artifact) return err(notFound('artifact', input.artifactId))
    if (artifact.kind === 'decision') {
      return err({ kind: 'invalid', detail: 'a Decision is answered, not given a verdict' })
    }
    const revisions = await checkpoints.revisions(artifact.id)
    const latest = revisions.at(-1)?.n ?? 0
    const revision = input.revision ?? latest
    if (revision !== latest) {
      return err({
        kind: 'invalid',
        detail: `revision ${revision} is not the latest (${latest}): give the verdict on the latest`,
      })
    }
    const verdictKey = key('verdict', artifact.id, revision)
    const existing = await checkpoints.verdictByKey(verdictKey)
    const issue = await issueOf(work, artifact.issueId)
    if (!issue) return err({ kind: 'unknown_issue', issueId: artifact.issueId })
    if (existing) {
      return ok({ ...(await written(checkpoints, artifact.id, 'replayed', moveOf(issue))), verdict: existing })
    }

    const at = deps.clock.now()
    const note = input.note?.trim() || null
    const record: VerdictRecord = { artifactId: artifact.id, revision, verdict, note, at }
    await checkpoints.insertVerdict({ ...record, key: verdictKey })
    let move: IssueMove | null = null
    if (waitsForReview(artifact.kind) && waitingOn(issue, 'review', artifact.id)) {
      if (note || verdict === 'with_notes' || verdict === 'changes') {
        const text = `The owner's verdict on "${artifact.title}" (revision ${revision}): ${labelOf[verdict]}${note ? `. ${note}` : ''}. Read it with: factory artifact show ${artifact.id}`
        const noted = applied(
          await recordIn(work, deps, {
            issueId: artifact.issueId,
            key: key('noted', 'verdict', artifact.id, revision),
            event: { kind: 'noted', payload: { text }, actor: 'owner' },
          }),
          'noted',
        )
        if (!noted.ok) return noted
      }
      const recorded = applied(
        await recordIn(work, deps, {
          issueId: artifact.issueId,
          key: key('verdict_given', artifact.id, revision),
          event: { kind: 'verdict_given', payload: { artifact: artifact.id, verdict }, actor: 'owner' },
        }),
        'verdict_given',
      )
      if (!recorded.ok) return recorded
      move = moveOf(recorded.value.issue, recorded.value.effects)
    }
    await checkpoints.cancelPages(artifact.id, at)
    return ok({ ...(await written(checkpoints, artifact.id, 'applied', move)), verdict: record })
  })
}

export interface ArtifactDetail {
  artifact: ArtifactRecord
  revisions: RevisionRecord[]
  /** the revision shown, and its content */
  revision: number
  content: string
  /** every annotation, anchored or not in the revision shown; an unanchored one is the "Unanchored" group */
  annotations: { annotation: AnnotationRecord; anchor: Anchor }[]
  verdicts: VerdictRecord[]
}

/** An artifact with one revision's content and its annotations sorted into anchored and "Unanchored" by that content. */
export async function showArtifact(
  deps: CheckpointDeps,
  input: { artifactId: ArtifactId; revision: number | null },
): Promise<CheckpointResult<ArtifactDetail>> {
  const rows = await deps.uow.run(async ({ checkpoints }) => {
    const artifact = await checkpoints.artifact(input.artifactId)
    if (!artifact) return err(notFound('artifact', input.artifactId))
    return ok({
      artifact,
      revisions: await checkpoints.revisions(artifact.id),
      annotations: await checkpoints.annotations(artifact.id),
      verdicts: await checkpoints.verdicts(artifact.id),
    })
  })
  if (!rows.ok) return rows
  const { artifact, revisions, annotations, verdicts } = rows.value
  const shown = input.revision ?? revisions.at(-1)?.n ?? 0
  const revision = revisions.find((candidate) => candidate.n === shown)
  if (!revision) return err({ kind: 'invalid', detail: `${artifact.id} has no revision ${shown}` })
  const content = await deps.blobs.get(revision.blob)
  if (!content.ok) return content
  return ok({
    artifact,
    revisions,
    revision: revision.n,
    content: content.value,
    annotations: annotations.map((annotation) => ({
      annotation,
      anchor: anchorOf(content.value, artifact.format, annotation.quote),
    })),
    verdicts,
  })
}

export function listArtifacts(
  deps: CheckpointDeps,
  filter: { issueId?: IssueId; kind?: ArtifactKind; limit: number },
): Promise<CheckpointResult<ArtifactRecord[]>> {
  return deps.uow.run(async ({ checkpoints }) => ok(await checkpoints.artifacts(filter)))
}

// ---------------------------------------------------------------------------------------------------------------------
// Errands

export interface ErrandWritten {
  result: 'applied' | 'replayed'
  errand: ErrandRecord
  issue: IssueMove | null
}

/** `factory errand raise`: the lead needs the owner's hands. The Issue waits; the screen (`checkpoints-errands.ts`) decides whether it reaches the owner. */
export function raiseErrand(
  deps: CheckpointDeps,
  input: { issueId: IssueId; attempt: number; raw: unknown; call?: string },
): Promise<CheckpointResult<ErrandWritten>> {
  const read = readErrand(input.raw)
  if (!read.ok) return Promise.resolve(read)
  // `tried` is the gate's, never stored: the rule screen reads the stored detail as the ask, and what was run first is not.
  const { summary, detail } = read.value
  const hostDoes = refuseHostClass(read.value)
  if (hostDoes) return Promise.resolve(err({ kind: 'invalid', detail: hostDoes }))
  return deps.uow.run(async ({ work, checkpoints }) => {
    const issue = await issueOf(work, input.issueId)
    if (!issue) return err({ kind: 'unknown_issue', issueId: input.issueId })
    const errandKey = key('errand', input.issueId, input.attempt, digest(input.call ? `call:${input.call}` : summary))
    const existing = await checkpoints.errandByKey(errandKey)
    if (existing) return ok<ErrandWritten>({ result: 'replayed', errand: existing, issue: moveOf(issue) })

    const id = deps.ids.next('errand')
    const recorded = applied(
      await recordIn(work, deps, {
        issueId: input.issueId,
        key: key('errand_raised', id),
        event: {
          kind: 'errand_raised',
          payload: { attempt: input.attempt, errand: { id, summary } },
          actor: 'lead',
        },
      }),
      'errand_raised',
    )
    if (!recorded.ok) return recorded
    const at = deps.clock.now()
    const stored = await checkpoints.insertErrand({
      id,
      key: errandKey,
      issueId: input.issueId,
      attempt: input.attempt,
      summary,
      detail,
      raisedAt: at,
      doneAt: null,
      doneNote: null,
      reachedOwnerAt: null,
      screenTries: 0,
      screenRetryAt: null,
      screenBy: null,
      screenNote: null,
      turnedAwayAt: null,
    })
    if (!stored) return err({ kind: 'version_conflict', issueId: input.issueId, expected: issue.version })
    const errand = await checkpoints.errand(id)
    if (!errand) throw new Error(`errand ${id} vanished inside its own transaction`)
    return ok<ErrandWritten>({
      result: 'applied',
      errand,
      issue: moveOf(recorded.value.issue, recorded.value.effects),
    })
  })
}

/** The owner's hands did it: `errand_done` ends the wait and the lead hears it as its next turn. */
export function finishErrand(
  deps: CheckpointDeps,
  input: { errandId: ErrandId; note: string | null },
): Promise<CheckpointResult<ErrandWritten>> {
  return deps.uow.run(async ({ work, checkpoints }) => {
    const errand = await checkpoints.errand(input.errandId)
    if (!errand) return err(notFound('Errand', input.errandId))
    const issue = await issueOf(work, errand.issueId)
    if (!issue) return err({ kind: 'unknown_issue', issueId: errand.issueId })
    if (errand.doneAt) return ok<ErrandWritten>({ result: 'replayed', errand, issue: moveOf(issue) })

    const at = deps.clock.now()
    const note = input.note?.trim() || null
    let move: IssueMove | null = null
    if (waitingOn(issue, 'errand', errand.id)) {
      if (note) {
        const noted = applied(
          await recordIn(work, deps, {
            issueId: errand.issueId,
            key: key('noted', 'errand', errand.id),
            event: {
              kind: 'noted',
              payload: { text: `The owner did the Errand "${errand.summary}": ${note}` },
              actor: 'owner',
            },
          }),
          'noted',
        )
        if (!noted.ok) return noted
      }
      const recorded = applied(
        await recordIn(work, deps, {
          issueId: errand.issueId,
          key: key('errand_done', errand.id),
          event: { kind: 'errand_done', payload: { errand: errand.id }, actor: 'owner' },
        }),
        'errand_done',
      )
      if (!recorded.ok) return recorded
      move = moveOf(recorded.value.issue, recorded.value.effects)
    }
    await checkpoints.finishErrand(errand.id, at, note)
    await checkpoints.cancelPages(errand.id, at)
    const done = await checkpoints.errand(errand.id)
    if (!done) throw new Error(`errand ${errand.id} vanished inside its own transaction`)
    return ok<ErrandWritten>({ result: 'applied', errand: done, issue: move })
  })
}

export function listErrands(
  deps: CheckpointDeps,
  filter: { issueId?: IssueId; open?: boolean; limit: number },
): Promise<CheckpointResult<ErrandRecord[]>> {
  return deps.uow.run(async ({ checkpoints }) => ok(await checkpoints.errands(filter)))
}

export function listPages(deps: CheckpointDeps, limit: number): Promise<CheckpointResult<PageRecord[]>> {
  return deps.uow.run(async ({ checkpoints }) => ok(await checkpoints.pages(limit)))
}
