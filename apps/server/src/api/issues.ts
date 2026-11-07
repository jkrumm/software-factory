import {
  CancelBody,
  DecisionReply,
  IssueAnswerBody,
  LeadVerbAnswer,
  NewIssueAnswer,
  NewIssueBody,
  NoteAnswer,
  NoteBody,
  SessionNoteBody,
} from '@software-factory/contract'
import { Elysia } from 'elysia'
import * as z from 'zod'
import type { Answered } from '../app/checkpoints.ts'
import type { IssueAnswerError } from '../app/issue-answer.ts'
import type { NewIssueError, NewIssueInput, NewIssued } from '../app/issue-new.ts'
import type { NoteInput, NoteOutcome, SessionNoteError } from '../app/issue-owner.ts'
import { took } from '../app/issue-owner.ts'
import type { Written } from './written.ts'
import { err, portError, type PortError, type Result } from '../kernel/result.ts'
import type { IssueId } from '../kernel/ids.ts'
import { callerOf } from './auth.ts'
import { decisionView, failed as checkpointFailure } from './checkpoints.ts'
import { errorResponses } from './errors.ts'
import { issueRef } from './issue-ref.ts'
import { failure, issueMove, verbResponse, writeFailure } from './written.ts'

/** The owner's Issue verbs and the session note, bound in `main.ts`. */
export interface IssueApi {
  file(input: NewIssueInput): Promise<Result<NewIssued, NewIssueError | PortError>>
  cancel(input: { issueId: IssueId; reason: string; call?: string | undefined }): Promise<Written>
  note(input: NoteInput): Promise<Result<NoteOutcome, NoteError>>
  answer(input: {
    issueId: IssueId
    answer: string
    decision?: string | undefined
  }): Promise<Result<Answered, IssueAnswerError | PortError>>
  sessionNote(input: {
    session: string
    text: string
    actor: 'owner' | 'factory'
    call?: string | undefined
  }): Promise<Result<NoteOutcome, SessionNoteError | PortError>>
}

type NoteError = Parameters<typeof writeFailure>[0]

const gone = async () => err(portError('gone', 'the Issue verbs are not wired into this server'))
const unwired: IssueApi = { file: gone, cancel: gone, note: gone, answer: gone, sessionNote: gone }

const unknownIssue = (text: string): Response =>
  Response.json(failure(`no Issue ${text}`, 'not_found'), { status: 404 })

/** The error of a filing as the HTTP answer: 422 for what the request names wrongly, 409 for what the state refuses. */
function fileFailure(error: NewIssueError | PortError): Response {
  switch (error.kind) {
    case 'repo_outside_roots':
      return Response.json(failure(error.detail, 'repo_outside_roots'), { status: 422 })
    case 'unknown_issue': {
      const named = 'issue' in error ? error.issue : error.issueId
      return Response.json(failure(`after: no Issue ${named}`, 'unknown_after'), { status: 422 })
    }
    case 'issue_closed':
      return Response.json(failure(`after: ${error.issue} is closed: nothing can wait for it`, 'after_closed'), {
        status: 422,
      })
    case 'cycle':
    case 'wrong_state':
    case 'unknown_project':
    case 'refused':
    case 'version_conflict':
    case 'key_taken':
    case 'filing_refused': {
      const out = 'detail' in error ? error.detail : error.kind
      return Response.json(failure(out, error.kind === 'version_conflict' ? 'version_conflict' : 'refused'), {
        status: 409,
      })
    }
    default:
      return Response.json(failure(`the database: ${error.detail}`, 'unavailable'), { status: 503 })
  }
}

function noteResponse(result: Result<NoteOutcome, NoteError | PortError>): Response {
  if (!result.ok) {
    const out = writeFailure(result.error)
    return Response.json(out.body, { status: out.status })
  }
  const { noted, woken } = result.value
  if (noted.result === 'refused') {
    return Response.json(failure(noted.event.detail ?? 'the Issue refused the note', 'refused'), { status: 409 })
  }
  const wokenDetail = woken && !took(woken) ? (woken.event.detail ?? 'the Issue did not wake') : null
  return Response.json(
    NoteAnswer.parse({
      noted: took(noted),
      woken: woken !== null && took(woken),
      detail: took(noted) ? wokenDetail : (noted.event.detail ?? 'the Issue ignored the note'),
      issue: issueMove(woken ?? noted),
    }),
  )
}

function answerFailure(error: IssueAnswerError | PortError): Response {
  switch (error.kind) {
    case 'no_open_decision':
      return Response.json(failure(`${error.issueId} has no open Decision`, 'no_open_decision'), { status: 409 })
    case 'ambiguous':
      return Response.json(
        failure(`${error.issueId} has ${error.decisions.length} open Decisions: name one with decision`, 'ambiguous', {
          decisions: error.decisions,
        }),
        { status: 409 },
      )
    default:
      return checkpointFailure(error)
  }
}

const Params = z.object({ id: z.string() })

/**
 * `issue new|cancel|note|answer` (the owner's) and `session note` (a lead's session, typed by the owner or an agent).
 * The owner's verbs take an Issue as `issue_12` or `12`.
 */
export const issueRoutes = (wired: IssueApi | undefined) => {
  const api = wired ?? unwired
  return new Elysia()
    .post(
      '/issues',
      async ({ body }) => {
        const after: IssueId[] = []
        for (const text of body.after ?? []) {
          const id = issueRef(text)
          if (!id) return Response.json(failure(`after: no Issue ${text}`, 'unknown_after'), { status: 422 })
          after.push(id)
        }
        const filed = await api.file({
          repo: body.repo,
          title: body.title,
          facts: body.facts,
          text: body.text,
          key: body.key,
          source: body.source ?? 'request',
          after,
        })
        if (!filed.ok) return fileFailure(filed.error)
        return Response.json(
          NewIssueAnswer.parse({
            issue: filed.value.issue.id,
            state: filed.value.issue.state,
            filed: filed.value.filed,
          }),
        )
      },
      {
        body: NewIssueBody,
        response: { 200: NewIssueAnswer, ...errorResponses(400, 409, 422, 503) },
        detail: {
          operationId: 'issue.new',
          summary: 'the owner files an Issue: a repo, a title, optional text, facts and Issues it waits for',
        },
      },
    )
    .post(
      '/issues/:id/cancel',
      async ({ params, body }) => {
        const issueId = issueRef(params.id)
        if (!issueId) return unknownIssue(params.id)
        return verbResponse(await api.cancel({ issueId, reason: body.reason, call: body.call }))
      },
      {
        params: Params,
        body: CancelBody,
        response: { 200: LeadVerbAnswer, ...errorResponses(400, 404, 409, 422, 503) },
        detail: {
          operationId: 'issue.cancel',
          summary: 'the owner ends an Issue; its lead, worktree and claim are finalized',
        },
      },
    )
    .post(
      '/issues/:id/note',
      async ({ params, body }) => {
        const issueId = issueRef(params.id)
        if (!issueId) return unknownIssue(params.id)
        return noteResponse(
          await api.note({ issueId, text: body.text, actor: 'owner', wake: body.wake, call: body.call }),
        )
      },
      {
        params: Params,
        body: NoteBody,
        response: { 200: NoteAnswer, ...errorResponses(400, 404, 409, 422, 503) },
        detail: {
          operationId: 'issue.note',
          summary:
            "the owner's note for the lead, which hears it as a note; with wake, a wait the owner may end is ended too",
          'x-cli': { args: ['text'] },
        },
      },
    )
    .post(
      '/issues/:id/answer',
      async ({ params, body }) => {
        const issueId = issueRef(params.id)
        if (!issueId) return unknownIssue(params.id)
        const answered = await api.answer({ issueId, answer: body.answer, decision: body.decision })
        if (!answered.ok) return answerFailure(answered.error)
        return Response.json(
          DecisionReply.parse({ decision: decisionView(answered.value.decision), issue: answered.value.issue }),
        )
      },
      {
        params: Params,
        body: IssueAnswerBody,
        response: { 200: DecisionReply, ...errorResponses(400, 404, 409, 422, 503) },
        detail: {
          operationId: 'issue.answer',
          summary: "the owner answers the Issue's open Decision (name it with decision when several are open)",
          'x-cli': { args: ['answer'] },
        },
      },
    )
    .post(
      '/v1/sessions/:session/note',
      async ({ params, body, request }) => {
        const sent = await api.sessionNote({
          session: params.session,
          text: body.text,
          actor: callerOf(request) === 'owner' ? 'owner' : 'factory',
          call: body.call ?? body.id,
        })
        if (!sent.ok && sent.error.kind === 'no_session') {
          return Response.json(failure(`no session ${params.session}`, 'not_found'), { status: 404 })
        }
        return noteResponse(sent as Result<NoteOutcome, NoteError | PortError>)
      },
      {
        params: z.object({ session: z.string() }),
        body: SessionNoteBody,
        response: { 200: NoteAnswer, ...errorResponses(400, 404, 409, 422, 503) },
        detail: {
          operationId: 'session.note',
          summary: "a note typed to a lead's current session; an agent's note reaches the lead fenced as data",
          'x-cli': { args: ['text'] },
        },
      },
    )
}
