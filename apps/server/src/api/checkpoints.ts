import {
  AnnotateBody,
  AnswerBody,
  ArtifactDetail,
  ArtifactList,
  ArtifactReply,
  AskBody,
  AskReply,
  DecisionList,
  DecisionReply,
  DecisionView,
  EditAnnotationBody,
  ErrandBody,
  ErrandDoneBody,
  ErrandList,
  ErrandReply,
  ErrorBody,
  ISSUE_ID_META,
  PageList,
  PassReply,
  ReviseBody,
  SubmitBody,
  VerdictBody,
  WorthBody,
} from '@software-factory/contract'
import { Elysia } from 'elysia'
import * as z from 'zod'
import type { CheckpointError } from '../app/checkpoints.ts'
import type { CheckpointUses } from '../app/checkpoints-uses.ts'
import { ARTIFACT_KINDS, type ArtifactId } from '../domains/checkpoints/artifact.ts'
import { defaultAt } from '../domains/checkpoints/decision.ts'
import {
  type AnnotationRecord,
  type ArtifactRecord,
  type DecisionRecord,
  type ErrandRecord,
  type PageRecord,
  type RevisionRecord,
  statusOf,
  type VerdictRecord,
} from '../domains/checkpoints/ports.ts'
import { idOf } from '../kernel/ids.ts'
import type { PortError } from '../kernel/result.ts'
import { ownerActorOf } from './auth.ts'
import { type ErrorStatus, errorResponses } from './errors.ts'
import { issueRef } from './issue-ref.ts'

const iso = (at: Date): string => at.toISOString()

const judgeOf = (d: DecisionRecord): DecisionView['judge'] => {
  const step = d.steps.find((candidate) => candidate.step === 'judge')
  return step ? { outcome: step.outcome, detail: step.detail, at: step.at ? iso(step.at) : null } : null
}

export const decisionView = (d: DecisionRecord): DecisionView => ({
  id: d.id,
  issueId: d.issueId,
  repo: d.repo,
  attempt: d.attempt,
  question: d.form.question,
  recommendation: d.form.recommendation,
  checked: d.form.checked,
  options: d.form.options,
  noAnswer: d.form.noAnswer,
  askedAt: iso(d.askedAt),
  defaultAt: defaultAt(d.form, d.askedAt)?.toISOString() ?? null,
  status: statusOf(d),
  answer: d.answer,
  settledBy: d.settledBy,
  source: d.source,
  answeredAt: d.answeredAt ? iso(d.answeredAt) : null,
  withdrawnReason: d.withdrawnReason,
  worthAsking: d.worthAsking,
  path: d.steps.map(({ step, outcome, at, detail }) => ({ step, outcome, at: at ? iso(at) : null, detail })),
  judge: judgeOf(d),
})

const summaryOf = (artifact: ArtifactRecord, revisions: readonly RevisionRecord[]) => ({
  id: artifact.id,
  issueId: artifact.issueId,
  kind: artifact.kind,
  title: artifact.title,
  format: artifact.format,
  author: artifact.author,
  createdAt: iso(artifact.createdAt),
  revisions: revisions.map((r) => ({
    n: r.n,
    sha256: r.sha256,
    bytes: r.bytes,
    note: r.note,
    createdAt: iso(r.createdAt),
  })),
})

const verdictView = (v: VerdictRecord) => ({
  revision: v.revision,
  verdict: v.verdict,
  note: v.note,
  at: iso(v.at),
})

const annotationView = (a: AnnotationRecord) => ({
  id: a.id,
  revision: a.revision,
  quote: a.quote,
  path: a.path,
  comment: a.comment,
  author: a.author,
  at: iso(a.at),
  editedAt: a.editedAt ? iso(a.editedAt) : null,
})

const errandView = (e: ErrandRecord) => ({
  id: e.id,
  issueId: e.issueId,
  attempt: e.attempt,
  summary: e.summary,
  detail: e.detail,
  raisedAt: iso(e.raisedAt),
  doneAt: e.doneAt ? iso(e.doneAt) : null,
  doneNote: e.doneNote,
  reachedOwner: e.reachedOwnerAt !== null,
  turnedAway: e.turnedAwayAt !== null,
  screenNote: e.screenNote,
})

const pageView = (p: PageRecord) => ({
  key: p.key,
  kind: p.kind,
  checkpoint: p.checkpoint,
  issueId: p.issueId,
  title: p.title,
  body: p.body,
  link: p.link,
  plannedAt: iso(p.plannedAt),
  attempts: p.attempts,
  sentAt: p.sentAt ? iso(p.sentAt) : null,
  error: p.error,
  status: p.status,
})

const failure = (status: number, error: string, code: string, details?: Record<string, unknown>): Response =>
  Response.json(ErrorBody.parse({ error, code, ...(details ? { details } : {}) }), { status })

/** The error of a use case as the HTTP answer: 404 for what is not there, 409 for what the state refuses, 422 for the lead's form. */
export function failed(error: CheckpointError | PortError): Response {
  switch (error.kind) {
    case 'missing_field':
      return failure(422, error.detail, 'missing_field', { fields: error.fields })
    case 'invalid':
      return failure(422, error.detail, 'invalid_request')
    case 'not_found':
      return failure(404, `no ${error.what} ${error.id}`, 'not_found')
    case 'unknown_issue':
      return failure(404, `no Issue ${error.issueId}`, 'not_found')
    case 'already_answered':
      return failure(409, `answered already by ${error.by}: ${error.answer}`, 'already_answered')
    case 'machine_refused':
      return failure(409, error.detail, 'refused')
    case 'filing_refused':
      return failure(409, error.detail, 'refused')
    case 'version_conflict':
      return failure(409, `Issue ${error.issueId} moved past version ${error.expected}; try again`, 'version_conflict')
    case 'key_taken':
      return failure(409, `key ${error.key} is ${error.detail}`, 'key_taken')
    default:
      return failure(503, `the database or a port: ${error.detail}`, 'unavailable')
  }
}

/** The success of a route plus every refusal it can answer, all `ErrorBody`: the CLI prints a refused form's fields from them. */
const RESPONSES = (ok: z.ZodType, ...codes: ErrorStatus[]) => ({
  200: ok,
  ...errorResponses(...codes),
})

const Id = z.object({ id: z.string() })
const AnnotationIds = z.object({ id: z.string(), annotationId: z.string() })
const unknownId = (what: string, id: string): Response => failure(404, `no ${what} ${id}`, 'not_found')

/**
 * The checkpoints routes. The lead's verbs (`issue ask`, `artifact submit`, `errand raise`) and the owner's (`decision
 * answer`, `artifact verdict`, `errand done`) share the contract; `policy.ts` says who may call which.
 */
export const checkpointRoutes = (uses: CheckpointUses) =>
  new Elysia({ prefix: '/v1' })
    // -- Decisions ---------------------------------------------------------------------------------------------------
    .post(
      '/issues/:id/ask',
      async ({ params, body }) => {
        const issueId = issueRef(params.id)
        if (!issueId) return unknownId('Issue', params.id)
        const { attempt, ...form } = body
        const result = await uses.ask({ issueId, attempt, form })
        if (!result.ok) return failed(result.error)
        return Response.json(
          AskReply.parse({
            result: result.value.result,
            decision: decisionView(result.value.decision),
            issue: result.value.issue,
          }),
        )
      },
      {
        params: Id,
        body: AskBody,
        response: RESPONSES(AskReply, 400, 404, 409, 422, 503),
        detail: {
          operationId: 'issue.ask',
          summary:
            "the lead raises a Decision: a form with the recommendation, what was checked, each option's cost and whether it is reversible, and what happens with no answer",
        },
      },
    )
    .get(
      '/decisions',
      async ({ query }) => {
        const issueId = query.issue ? issueRef(query.issue) : undefined
        if (issueId === null) return unknownId('Issue', query.issue ?? '')
        const result = await uses.decisions({
          ...(issueId ? { issueId } : {}),
          ...(query.status ? { status: query.status } : {}),
          ...(query.worth ? { worthAsking: query.worth === 'yes' } : {}),
          limit: query.limit ?? 50,
        })
        if (!result.ok) return failed(result.error)
        return Response.json(DecisionList.parse({ decisions: result.value.map(decisionView) }))
      },
      {
        query: z.object({
          issue: z.string().meta(ISSUE_ID_META).optional(),
          status: z.enum(['open', 'answered', 'withdrawn']).optional(),
          worth: z.enum(['yes', 'no']).optional(),
          limit: z.coerce.number().int().min(1).max(500).optional(),
        }),
        response: RESPONSES(DecisionList, 400, 404, 422, 503),
        detail: {
          operationId: 'decision.list',
          summary: 'the ledger: every Decision with its path to the answer and the worth-asking flag',
        },
      },
    )
    .get(
      '/decisions/:id',
      async ({ params }) => {
        const id = idOf('decision', params.id)
        if (!id) return unknownId('Decision', params.id)
        const result = await uses.decision(id)
        if (!result.ok) return failed(result.error)
        return Response.json(DecisionView.parse(decisionView(result.value)))
      },
      {
        params: Id,
        response: RESPONSES(DecisionView, 404, 503),
        detail: { operationId: 'decision.show', summary: 'one Decision with the path to its answer' },
      },
    )
    .post(
      '/decisions/:id/answer',
      async ({ params, body, request }) => {
        const id = idOf('decision', params.id)
        if (!id) return unknownId('Decision', params.id)
        const result = await uses.answer({ decisionId: id, answer: body.answer, by: ownerActorOf(request) })
        if (!result.ok) return failed(result.error)
        return Response.json(
          DecisionReply.parse({ decision: decisionView(result.value.decision), issue: result.value.issue }),
        )
      },
      {
        params: Id,
        body: AnswerBody,
        response: RESPONSES(DecisionReply, 400, 404, 409, 422, 503),
        detail: {
          operationId: 'decision.answer',
          summary: "the owner's answer to a Decision",
          'x-cli': { args: ['answer'] },
        },
      },
    )
    .post(
      '/decisions/:id/worth-asking',
      async ({ params, body }) => {
        const id = idOf('decision', params.id)
        if (!id) return unknownId('Decision', params.id)
        const result = await uses.worthAsking({ decisionId: id, worth: body.worth })
        if (!result.ok) return failed(result.error)
        return Response.json(DecisionReply.parse({ decision: decisionView(result.value), issue: null }))
      },
      {
        params: Id,
        body: WorthBody,
        response: RESPONSES(DecisionReply, 400, 404, 409, 422, 503),
        detail: {
          operationId: 'decision.worth-asking',
          summary: "the owner's flag on an answered Decision: was it worth asking him",
        },
      },
    )
    // -- Artifacts ---------------------------------------------------------------------------------------------------
    .post(
      '/issues/:id/artifacts',
      async ({ params, body }) => {
        const issueId = issueRef(params.id)
        if (!issueId) return unknownId('Issue', params.id)
        const { attempt, ...raw } = body
        const result = await uses.submit({ issueId, attempt, raw })
        if (!result.ok) return failed(result.error)
        const { artifact, revisions, issue } = result.value
        return Response.json(
          ArtifactReply.parse({
            result: result.value.result,
            artifact: summaryOf(artifact, revisions),
            verdict: null,
            issue,
          }),
        )
      },
      {
        params: Id,
        body: SubmitBody,
        response: RESPONSES(ArtifactReply, 400, 404, 409, 422, 503),
        detail: {
          operationId: 'artifact.submit',
          summary:
            'the lead hands over a Concept or Spec (the Issue waits for the verdict) or a Report (it never waits)',
        },
      },
    )
    .get(
      '/artifacts',
      async ({ query }) => {
        const issueId = query.issue ? issueRef(query.issue) : undefined
        if (issueId === null) return unknownId('Issue', query.issue ?? '')
        const result = await uses.artifacts({
          ...(issueId ? { issueId } : {}),
          ...(query.kind ? { kind: query.kind } : {}),
          limit: query.limit ?? 50,
        })
        if (!result.ok) return failed(result.error)
        // The list shows each artifact without its revisions' detail; `artifact show` has them.
        return Response.json(ArtifactList.parse({ artifacts: result.value.map((a) => summaryOf(a, [])) }))
      },
      {
        query: z.object({
          issue: z.string().meta(ISSUE_ID_META).optional(),
          kind: z.enum(ARTIFACT_KINDS).optional(),
          limit: z.coerce.number().int().min(1).max(500).optional(),
        }),
        response: RESPONSES(ArtifactList, 400, 404, 422, 503),
        detail: { operationId: 'artifact.list', summary: 'artifacts, newest first' },
      },
    )
    .get(
      '/artifacts/:id',
      async ({ params, query }) => {
        const id = idOf('artifact', params.id) ?? idOf('decision', params.id)
        if (!id) return unknownId('artifact', params.id)
        const result = await uses.artifact({ artifactId: id as string as ArtifactId, revision: query.revision ?? null })
        if (!result.ok) return failed(result.error)
        const detail = result.value
        return Response.json(
          ArtifactDetail.parse({
            artifact: summaryOf(detail.artifact, detail.revisions),
            revision: detail.revision,
            content: detail.content,
            annotations: detail.annotations
              .filter((a) => a.anchor === 'anchored')
              .map((a) => annotationView(a.annotation)),
            unanchored: detail.annotations
              .filter((a) => a.anchor === 'unanchored')
              .map((a) => annotationView(a.annotation)),
            verdicts: detail.verdicts.map(verdictView),
          }),
        )
      },
      {
        params: Id,
        query: z.object({ revision: z.coerce.number().int().min(1).optional() }),
        response: RESPONSES(ArtifactDetail, 400, 404, 422, 503),
        detail: {
          operationId: 'artifact.show',
          summary: 'an artifact with one revision, its annotations (and the Unanchored ones) and verdicts',
        },
      },
    )
    .post(
      '/artifacts/:id/revisions',
      async ({ params, body }) => {
        const id = idOf('artifact', params.id)
        if (!id) return unknownId('artifact', params.id)
        const result = await uses.revise({
          artifactId: id,
          attempt: body.attempt ?? null,
          content: body.content,
          note: body.note ?? null,
        })
        if (!result.ok) return failed(result.error)
        const { artifact, revisions, issue } = result.value
        return Response.json(
          ArtifactReply.parse({
            result: result.value.result,
            artifact: summaryOf(artifact, revisions),
            verdict: null,
            issue,
          }),
        )
      },
      {
        params: Id,
        body: ReviseBody,
        response: RESPONSES(ArtifactReply, 400, 404, 409, 422, 503),
        detail: { operationId: 'artifact.revise', summary: 'the lead adds a revision after a verdict of Changes' },
      },
    )
    .post(
      '/artifacts/:id/annotations',
      async ({ params, body }) => {
        const id = idOf('artifact', params.id) ?? idOf('decision', params.id)
        if (!id) return unknownId('artifact', params.id)
        const result = await uses.annotate({
          artifactId: id as string as ArtifactId,
          revision: body.revision ?? null,
          author: body.author,
          raw: { quote: body.quote, path: body.path, comment: body.comment },
        })
        if (!result.ok) return failed(result.error)
        const { artifact, revisions, issue } = result.value
        return Response.json(
          ArtifactReply.parse({
            result: result.value.result,
            artifact: summaryOf(artifact, revisions),
            verdict: null,
            issue,
          }),
        )
      },
      {
        params: Id,
        body: AnnotateBody,
        response: RESPONSES(ArtifactReply, 400, 404, 409, 422, 503),
        detail: { operationId: 'artifact.annotate', summary: 'a comment anchored by a quote and a path' },
      },
    )
    .patch(
      '/artifacts/:id/annotations/:annotationId',
      async ({ params, body }) => {
        const id = idOf('artifact', params.id) ?? idOf('decision', params.id)
        if (!id) return unknownId('artifact', params.id)
        const result = await uses.editAnnotation({
          artifactId: id as string as ArtifactId,
          annotationId: params.annotationId,
          raw: body,
        })
        if (!result.ok) return failed(result.error)
        const { artifact, revisions, issue } = result.value
        return Response.json(
          ArtifactReply.parse({
            result: result.value.result,
            artifact: summaryOf(artifact, revisions),
            verdict: null,
            issue,
          }),
        )
      },
      {
        params: AnnotationIds,
        body: EditAnnotationBody,
        response: RESPONSES(ArtifactReply, 400, 404, 422, 503),
        detail: { operationId: 'artifact.annotation-edit', summary: "the owner changes an annotation's comment" },
      },
    )
    .delete(
      '/artifacts/:id/annotations/:annotationId',
      async ({ params }) => {
        const id = idOf('artifact', params.id) ?? idOf('decision', params.id)
        if (!id) return unknownId('artifact', params.id)
        const result = await uses.deleteAnnotation({
          artifactId: id as string as ArtifactId,
          annotationId: params.annotationId,
        })
        if (!result.ok) return failed(result.error)
        const { artifact, revisions, issue } = result.value
        return Response.json(
          ArtifactReply.parse({
            result: result.value.result,
            artifact: summaryOf(artifact, revisions),
            verdict: null,
            issue,
          }),
        )
      },
      {
        params: AnnotationIds,
        response: RESPONSES(ArtifactReply, 400, 404, 503),
        detail: { operationId: 'artifact.annotation-delete', summary: 'the owner deletes an annotation' },
      },
    )
    .post(
      '/artifacts/:id/verdict',
      async ({ params, body }) => {
        const id = idOf('artifact', params.id)
        if (!id) return unknownId('artifact', params.id)
        const result = await uses.verdict({
          artifactId: id,
          verdict: body.verdict,
          note: body.note ?? null,
          revision: body.revision ?? null,
        })
        if (!result.ok) return failed(result.error)
        const { artifact, revisions, issue, verdict } = result.value
        return Response.json(
          ArtifactReply.parse({
            result: result.value.result,
            artifact: summaryOf(artifact, revisions),
            verdict: verdictView(verdict),
            issue,
          }),
        )
      },
      {
        params: Id,
        body: VerdictBody,
        response: RESPONSES(ArtifactReply, 400, 404, 409, 422, 503),
        detail: {
          operationId: 'artifact.verdict',
          summary:
            "the owner's verdict: looks_good, with_notes, changes or no_longer_applies; it reaches the lead as its next turn",
        },
      },
    )
    // -- Errands -----------------------------------------------------------------------------------------------------
    .post(
      '/issues/:id/errands',
      async ({ params, body }) => {
        const issueId = issueRef(params.id)
        if (!issueId) return unknownId('Issue', params.id)
        const { attempt, ...raw } = body
        const result = await uses.raiseErrand({ issueId, attempt, raw })
        if (!result.ok) return failed(result.error)
        return Response.json(
          ErrandReply.parse({
            result: result.value.result,
            errand: errandView(result.value.errand),
            issue: result.value.issue,
          }),
        )
      },
      {
        params: Id,
        body: ErrandBody,
        response: RESPONSES(ErrandReply, 400, 404, 409, 422, 503),
        detail: {
          operationId: 'errand.raise',
          summary: "the lead needs the owner's hands: a portal step, a device run, a prompt",
        },
      },
    )
    .get(
      '/errands',
      async ({ query }) => {
        const issueId = query.issue ? issueRef(query.issue) : undefined
        if (issueId === null) return unknownId('Issue', query.issue ?? '')
        const result = await uses.errands({
          ...(issueId ? { issueId } : {}),
          ...(query.open ? { open: query.open === 'yes' } : {}),
          limit: query.limit ?? 50,
        })
        if (!result.ok) return failed(result.error)
        return Response.json(ErrandList.parse({ errands: result.value.map(errandView) }))
      },
      {
        query: z.object({
          issue: z.string().meta(ISSUE_ID_META).optional(),
          open: z.enum(['yes', 'no']).optional(),
          limit: z.coerce.number().int().min(1).max(500).optional(),
        }),
        response: RESPONSES(ErrandList, 400, 404, 422, 503),
        detail: { operationId: 'errand.list', summary: 'Errands, newest first' },
      },
    )
    .post(
      '/errands/:id/done',
      async ({ params, body }) => {
        const id = idOf('errand', params.id)
        if (!id) return unknownId('Errand', params.id)
        const result = await uses.finishErrand({ errandId: id, note: body.note ?? null })
        if (!result.ok) return failed(result.error)
        return Response.json(
          ErrandReply.parse({
            result: result.value.result,
            errand: errandView(result.value.errand),
            issue: result.value.issue,
          }),
        )
      },
      {
        params: Id,
        body: ErrandDoneBody,
        response: RESPONSES(ErrandReply, 400, 404, 409, 422, 503),
        detail: { operationId: 'errand.done', summary: 'the owner did it: the lead hears it as its next turn' },
      },
    )
    // -- The owner's line and the pass -------------------------------------------------------------------------------
    .get(
      '/pages',
      async ({ query }) => {
        const result = await uses.pages(query.limit ?? 50)
        if (!result.ok) return failed(result.error)
        return Response.json(PageList.parse({ pages: result.value.map(pageView) }))
      },
      {
        query: z.object({ limit: z.coerce.number().int().min(1).max(500).optional() }),
        response: RESPONSES(PageList, 400, 422, 503),
        detail: {
          operationId: 'page.list',
          summary: "what is on the owner's line: checkpoints only, with whether each was sent",
        },
      },
    )
    .post(
      '/checkpoints/pass',
      async () => {
        const result = await uses.pass()
        if (!result.ok) return failed(result.error)
        return Response.json(PassReply.parse(result.value))
      },
      {
        response: RESPONSES(PassReply, 503),
        detail: {
          operationId: 'checkpoint.pass',
          summary:
            'one pass now: settle the open Decisions (policy, Judge, default, owner), then send the pages that planned',
        },
      },
    )

/** Use cases that answer nothing: for the OpenAPI document alone (the CLI generator, the contract tests). */
export const documentOnlyUses: CheckpointUses = new Proxy({} as CheckpointUses, {
  get: () => () => Promise.reject(new Error('the checkpoints use cases are not wired in this app')),
})
