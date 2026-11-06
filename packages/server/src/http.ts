import { createHash, timingSafeEqual } from 'node:crypto'
import {
  AccountList,
  AskList,
  DoorRoute,
  DoorRouteInput,
  DoorRouteKey,
  DoorRouteList,
  DoorUnroutedList,
  EventAck,
  Fleet,
  Health,
  HealthList,
  IntakeAck,
  IntakeInput,
  Issue,
  IssueAnswerAck,
  IssueAnswerBody,
  IssueCards,
  IssueDetail,
  IssueId,
  IssueEvidenceAck,
  IssueEvidenceInput,
  IssueFactsRead,
  IssueInput,
  IssueList,
  IssueNoteAck,
  IssueNoteBody,
  IssueOwnerInput,
  IssuePrioAck,
  IssuePrioBody,
  IssueResumeInput,
  IsoTime,
  IssueVerb,
  IssueVerbAck,
  IssueVerbBody,
  IssueView,
  Project,
  NotificationList,
  Notification,
  Overview,
  ProjectList,
  ProjectName,
  ProjectSyncResult,
  Prompt,
  Quota,
  QuotaList,
  QueueView,
  type RoleTable,
  Session,
  SessionCard,
  SessionCards,
  SessionList,
  Slot,
  SlotRelease,
  ErrorBody,
  Spawn,
  SpawnList,
  Status,
  StopCheck,
} from '@software-factory/contract'
import type { SQL } from 'bun'
import { z } from 'zod'
import type { AdmissionLimits } from './admission.ts'
import { latestReadings, recordReading, toQuota } from './capacity.ts'
import type { Clock } from './clock.ts'
import { type FleetBuilder, readSnapshot } from './fleet/index.ts'
import { type Commits, GitCommits } from './issues/commits.ts'
import type { Review } from './issues/review.ts'
import { createIssue } from './issues/create.ts'
import { enqueue } from './issues/inbox.ts'
import { intakeAlert, listRoutes, listUnrouted, removeRoute, setRoute } from './issues/intake.ts'
import { listFacts, kpis } from './issues/facts.ts'
import { getIssueView } from './issues/follow.ts'
import { getIssue, listIssues } from './issues/read.ts'
import { resumeArchived } from './issues/resume.ts'
import { fileAnswer, fileEvidence, fileNote, filePrio, fileVerb, GATED_VERBS } from './issues/verbs.ts'
import { answerNow } from './issues/worker.ts'
import { getNotification, listNotifications, sendNow } from './notify/outbox.ts'
import { NullNotifier, type Notifier } from './notify/port.ts'
import { getProject, listable, listProjects } from './projects/store.ts'
import type { ProjectSync } from './projects/sync.ts'
import { QuotaError, type QuotaPoller } from './quota.ts'
import { MAX_LIMIT, DEFAULT_LIMIT, NotReady, Reader, type ReadDeps } from './read/index.ts'
import { streamHandler, type StreamDeps } from './read/stream.ts'
import { getQueue, setQueue } from './queue.ts'
import { recordPrompt } from './prompts.ts'
import { stopCheck } from './rules.ts'
import {
  AccountName,
  EventInput,
  NoteInput,
  QueueInput,
  QuotaInput,
  SlotId,
  SlotInput,
  SpawnInput,
  StopCheckInput,
  WaitInput,
} from './schemas.ts'
import { buildStatus } from './status.ts'
import { declareWait, getSession, listSessions, recordEvent } from './sessions.ts'
import { heartbeat, type TickMonitor } from './health.ts'
import { RepoRefused, resolveRepo } from './repos.ts'
import { releaseSlot, touchSlot } from './slots.ts'
import { cancelSpawn, createSpawn, getSpawn, listSpawns, requeueSpawn } from './spawns.ts'

export interface AppDeps {
  sql: SQL
  clock: Clock
  /** what `/health` reports: the release sha in production */
  version: string
  /** the bearer token every route except `GET /health` requires */
  token: string
  /** what the ticker reports; `/health` is unhealthy when it goes quiet */
  monitor: TickMonitor
  /** the directories a spawn's repo must be inside */
  repoRoots: readonly string[]
  /** the role table: a spawn's role must be in it, and it gives the spawn's tier and effort */
  roles: RoleTable
  /** reads the account picker on demand (`POST /quota/refresh`) */
  quota: QuotaPoller
  /** reads the projects' manifests on demand (`POST /projects/sync`) */
  projects: Pick<ProjectSync, 'syncNow'>
  /** `FACTORY_ALERT_LEADS`: `factory status` says why an alert Issue starts no lead */
  alertLeads?: boolean
  /** the lead cap for admission of a spawn; the default without */
  admission?: AdmissionLimits
  /** the owner's line, for `POST /notifications/test`; without it the line is off */
  notifier?: Notifier
  /** `FACTORY_NOTIFY_TARGET`: `off` is said in the answer to a test */
  notifyTarget?: string
  /** reads the commits a `ship` or a `close` names; git on the host unless a test says otherwise */
  commits?: Commits
  /** review v4's router and coverage (`agw review`), asked by `ship`; main always brings it, a test without one is not asked */
  review?: Review
  /** builds the fleet model on demand (`POST /fleet/refresh`); without it that route is 503 */
  fleet?: Pick<FleetBuilder, 'refreshNow'>
  /** the read API (`/v1`): whether a place is IuRoot's (`Places.isVisible`), the transcript counter, and the stream's timing for a test */
  read?: Pick<ReadDeps, 'isVisible' | 'insights'> & Pick<StreamDeps, 'pollMs' | 'keepaliveMs' | 'sleep'>
}

/** Largest request body the server reads. */
export const MAX_BODY_BYTES = 64 * 1024

/** A `ship` waits for a `git fetch` and for agw's review reads (minutes on a long range), and `project sync` for all the fetches: Bun's own default is ten seconds of silence, its maximum 255. */
const IDLE_TIMEOUT_S = 240
/** Bun applies it on a unix socket too, with the same ten-second default, though its types leave it out of the socket's options. */
const idle = { idleTimeout: IDLE_TIMEOUT_S } as object

const json = (body: unknown, status = 200, headers?: Record<string, string>): Response =>
  Response.json(body, { status, headers })

/** The body goes through the contract's schema on its way out: a server that drifts from it fails here, not in a client. */
const respond = <S extends z.ZodType>(schema: S, body: z.input<S>, status = 200): Response =>
  json(schema.parse(body), status)

class BadRequest extends Error {}

/** A refusal with its own status, decided before any handler runs. */
class Refusal extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly headers?: Record<string, string>,
  ) {
    super(message)
  }
}

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]'])

/** DNS rebinding sends the victim's browser to a loopback address under an attacker's name: only loopback names pass. */
function assertLoopbackHost(req: Request): void {
  const host = req.headers.get('host')?.toLowerCase()
  const name = host?.startsWith('[') ? host.slice(0, host.indexOf(']') + 1) : host?.split(':')[0]
  if (!name || !LOOPBACK_HOSTS.has(name)) throw new Refusal('host is not loopback', 421)
}

const digest = (value: string) => createHash('sha256').update(value).digest()

function assertBearer(req: Request, token: string): void {
  const match = /^Bearer (.+)$/i.exec(req.headers.get('authorization') ?? '')
  // Equal-length digests keep the comparison constant-time whatever the caller sent.
  if (!match?.[1] || !timingSafeEqual(digest(match[1]), digest(token))) {
    throw new Refusal('missing or wrong bearer token', 401, { 'www-authenticate': 'Bearer' })
  }
}

/** A cross-origin form or `fetch` can send `text/plain` without a preflight; JSON it cannot. */
function assertJsonContentType(req: Request): void {
  if (req.method === 'GET' || req.method === 'HEAD') return
  const type = req.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase()
  if (type !== 'application/json') throw new Refusal('content-type must be application/json', 415)
}

/** The body as text, never more than the cap: `Content-Length` is checked first, and the stream is counted for the rest. */
async function readBody(req: Request): Promise<string> {
  const declared = Number(req.headers.get('content-length'))
  if (declared > MAX_BODY_BYTES) throw new Refusal(`body is larger than ${MAX_BODY_BYTES} bytes`, 413)
  const chunks: Uint8Array[] = []
  let size = 0
  if (req.body) {
    for await (const chunk of req.body) {
      size += chunk.byteLength
      if (size > MAX_BODY_BYTES) throw new Refusal(`body is larger than ${MAX_BODY_BYTES} bytes`, 413)
      chunks.push(chunk)
    }
  }
  return Buffer.concat(chunks).toString('utf8')
}

async function parseBody<S extends z.ZodType>(req: Request, schema: S): Promise<z.output<S>> {
  const text = await readBody(req)
  let body: unknown
  try {
    body = JSON.parse(text)
  } catch {
    throw new BadRequest('body is not valid JSON')
  }
  const parsed = schema.safeParse(body)
  if (!parsed.success) throw new BadRequest(z.prettifyError(parsed.error))
  return parsed.data
}

function parseParam<S extends z.ZodType>(schema: S, value: string): z.output<S> {
  const parsed = schema.safeParse(value)
  if (!parsed.success) throw new BadRequest(z.prettifyError(parsed.error))
  return parsed.data
}

/**
 * Every route goes through here: a loopback Host, then (unless `open`) the bearer token, then a JSON content type for
 * anything that sends a body. The handler runs only after all three.
 */
function guarded<R extends Request>(
  token: string,
  handler: (req: R) => Promise<Response>,
  options: { open?: boolean } = {},
): (req: R) => Promise<Response> {
  return async (req) => {
    try {
      assertLoopbackHost(req)
      if (!options.open) assertBearer(req, token)
      assertJsonContentType(req)
      return await handler(req)
    } catch (error) {
      return failure(error)
    }
  }
}

function failure(error: unknown): Response {
  if (error instanceof Refusal) return json({ error: error.message }, error.status, error.headers)
  if (error instanceof BadRequest) return json({ error: error.message }, 400)
  console.error(error)
  return json({ error: 'internal error' }, 500)
}

/** `POST /sessions/:id/wait`: declares or closes a wait, answers with the session. */
const waitHandler =
  (sql: SQL, clock: Clock) =>
  async (req: Bun.BunRequest<'/sessions/:id/wait'>): Promise<Response> => {
    const wait = await parseBody(req, WaitInput)
    const now = clock.now()
    if (!(await declareWait(sql, req.params.id, wait, now))) return json({ error: 'unknown session' }, 404)
    const session = await getSession(sql, req.params.id, now)
    return session ? respond(Session, session) : json({ error: 'unknown session' }, 404)
  }

/** `POST /sessions/:id/note`: records the text under its id; the tick types it when the session is at its prompt. */
const noteHandler =
  (sql: SQL, clock: Clock) =>
  async (req: Bun.BunRequest<'/sessions/:id/note'>): Promise<Response> => {
    const note = await parseBody(req, NoteInput)
    const now = clock.now()
    if (!(await getSession(sql, req.params.id, now))) return json({ error: 'unknown session' }, 404)
    const { prompt, created } = await recordPrompt(
      sql,
      { id: note.id, session: req.params.id, source: 'note', text: note.text },
      now,
    )
    // A repeated id answers with the stored prompt; another session's is not for this caller to read.
    if (prompt.session !== req.params.id) return json({ error: 'that prompt id belongs to another session' }, 409)
    return respond(Prompt, prompt, created ? 201 : 200)
  }

/** `POST /sessions/:id/stop-check`: the `Stop` hook asks whether the session may end its turn. */
const stopCheckHandler =
  (sql: SQL, clock: Clock) =>
  async (req: Bun.BunRequest<'/sessions/:id/stop-check'>): Promise<Response> => {
    const input = await parseBody(req, StopCheckInput)
    return respond(StopCheck, await stopCheck(sql, req.params.id, input, clock.now()))
  }

/** The project of a queue request, as a spawn's repo is: a real directory inside the allowed roots. */
const resolveProject = (project: string, repoRoots: readonly string[]): Promise<string> =>
  resolveRepo(project, repoRoots).catch((error) => {
    throw error instanceof RepoRefused ? new Refusal(error.message, 422) : error
  })

/** The answer for a key that already has a spawn: the row, or `key_spent` when its agent is gone. */
const replay = (spawn: Spawn): Response =>
  spawn.status === 'ended' || spawn.status === 'cancelled'
    ? respond(
        ErrorBody,
        {
          error: `spawn key ${spawn.key} is spent: its agent ${spawn.status === 'cancelled' ? 'never started (cancelled)' : 'ended'}; create again under another key`,
          code: 'key_spent',
          spawn,
        },
        409,
      )
    : respond(Spawn, spawn)

/**
 * `POST /spawns`, on the port with the token and on the socket without it: the same body, the same validation and the same
 * repo-roots check, so a pane that can reach the socket asks for no more than a holder of the token.
 */
const spawnHandler =
  (sql: SQL, clock: Clock, roles: RoleTable, repoRoots: readonly string[], admission?: AdmissionLimits) =>
  async (req: Request): Promise<Response> => {
    const input = await parseBody(req, SpawnInput)
    // A replay of a known key answers with the row it made, whatever the role table says now. A spent key (its agent is
    // gone) answers 409 `key_spent` with that row: it is never revived, so a replayed old create starts nothing.
    const known = await getSpawn(sql, input.key, clock.now())
    if (known) return replay(known)
    const entry = roles.get(input.role)
    if (!entry) throw new Refusal(`unknown role ${input.role} (${[...roles.keys()].join(', ')})`, 422)
    // The policy decides before anything is stored; the row keeps the resolved path.
    const repo = await resolveProject(input.repo, repoRoots)
    const space = input.space === undefined ? repo : await resolveProject(input.space, repoRoots)
    // The space is found again by the directory of its panes, which is the repo: a space that does not contain it would
    // make a second space on the next start.
    if (space !== repo && !repo.startsWith(space.endsWith('/') ? space : `${space}/`)) {
      throw new Refusal(`space ${space} must contain the repo ${repo}`, 422)
    }
    const { spawn, created } = await createSpawn(
      sql,
      {
        ...input,
        repo,
        space,
        newSpace: input.new_space,
        tier: entry.tier,
        effort: entry.effort,
      },
      clock.now(),
      admission,
    )
    return created ? respond(Spawn, spawn, 201) : replay(spawn)
  }

/**
 * `POST /spawns/:key/cancel`, on the port and on the socket (a pane's script cancels what it asked for): a queued or waiting spawn
 * becomes `cancelled`, the same call again answers the same row; one that was claimed is 409 `not_cancellable` carrying
 * the spawn row (`spawn.status`), so a caller reads the state from the body, not from the message.
 */
const spawnCancelHandler = (sql: SQL, clock: Clock) => async (req: Bun.BunRequest<'/spawns/:key/cancel'>) => {
  const result = await cancelSpawn(sql, req.params.key, clock.now())
  if ('spawn' in result) return respond(Spawn, result.spawn)
  if (result.problem === 'unknown') return json({ error: 'unknown spawn' }, 404)
  return respond(
    ErrorBody,
    {
      error: `spawn ${req.params.key} is ${result.current.status}: only a queued or waiting spawn can be cancelled`,
      code: 'not_cancellable',
      spawn: result.current,
    },
    409,
  )
}

/** `GET /spawns/:key`. */
const spawnGetHandler = (sql: SQL, clock: Clock) => async (req: Bun.BunRequest<'/spawns/:key'>) => {
  const spawn = await getSpawn(sql, req.params.key, clock.now())
  return spawn ? respond(Spawn, spawn) : json({ error: 'unknown spawn' }, 404)
}

/** `GET /sessions/:id`. */
const sessionGetHandler = (sql: SQL, clock: Clock) => async (req: Bun.BunRequest<'/sessions/:id'>) => {
  const session = await getSession(sql, req.params.id, clock.now())
  return session ? respond(Session, session) : json({ error: 'unknown session' }, 404)
}

/**
 * `POST /issues`, on the port and on the socket, like a spawn: the first create of a `(source, source_key)` is 201, a replay
 * 200 with the stored row, closed or not (its `after` is not looked at again). A repo outside the roots, an alert in IuRoot and an
 * `after` naming an unknown or closed Issue are 422, nothing stored.
 */
const issueCreateHandler =
  (sql: SQL, clock: Clock, repoRoots: readonly string[]) =>
  async (req: Request): Promise<Response> => {
    const { source, source_key: sourceKey, repo, title, facts, after } = await parseBody(req, IssueInput)
    const { issue, created } = await createIssue(
      sql,
      { source, sourceKey, repo, title, facts, ...(after ? { after } : {}) },
      { repoRoots, now: clock.now() },
    ).catch((error) => {
      throw error instanceof RepoRefused ? new Refusal(error.message, 422) : error
    })
    return respond(Issue, issue, created ? 201 : 200)
  }

/** `GET /issues`: newest first, without facts. */
const issueListHandler = (sql: SQL) => async () => respond(IssueList, { issues: await listIssues(sql) })

/** `GET /issues/facts?since=<iso>`: one row per attempt of the Issues filed since, and the KPIs over them; a malformed `since` is 400. */
const issueFactsHandler = (sql: SQL) => async (req: Request) => {
  const raw = new URL(req.url).searchParams.get('since')
  if (raw !== null && !IsoTime.safeParse(raw).success) throw new BadRequest('since must be an ISO 8601 time')
  const input = raw === null ? {} : { since: new Date(raw) }
  const [rows, kpi] = await Promise.all([listFacts(sql, input), kpis(sql, input)])
  return respond(IssueFactsRead, { rows, kpi })
}

/** `GET /issues/:id`. */
const issueGetHandler = (sql: SQL) => async (req: Bun.BunRequest<'/issues/:id'>) => {
  const issue = await getIssue(sql, parseParam(IssueId, req.params.id))
  return issue ? respond(Issue, issue) : json({ error: 'unknown issue' }, 404)
}

/** `GET /issues/:id/timeline`: the Issue, its story from `issue_events` and the inbox, oldest first, its evidence and its questions. */
const issueTimelineHandler = (sql: SQL) => async (req: Bun.BunRequest<'/issues/:id/timeline'>) => {
  const view = await getIssueView(sql, parseParam(IssueId, req.params.id))
  return view ? respond(IssueView, view) : json({ error: 'unknown issue' }, 404)
}

/**
 * `POST /issues/:id/note`, on the token API only: the owner's text for the Issue's lead. One inbox row keyed `<issue>:note:<call id>`; the
 * same call again is 200 `duplicate`, the first 201. The lead is typed it through the session notes of §3, an Issue with none running keeps
 * it for the next brief. Not on the socket: a pane that can type into a session already has `session note`, and what a brief carries
 * is the owner's.
 */
const issueNoteHandler =
  (sql: SQL, clock: Clock) =>
  async (req: Bun.BunRequest<'/issues/:id/note'>): Promise<Response> => {
    const issueId = parseParam(IssueId, req.params.id)
    const body = await parseBody(req, IssueNoteBody)
    const filed = await fileNote(sql, { issueId, body, now: clock.now() })
    if (!filed.ok) {
      return filed.problem === 'unknown_issue'
        ? json({ error: 'unknown issue' }, 404)
        : json({ error: 'the Issue is closed: reopen it first' }, 409)
    }
    const ack = { issue: issueId, key: filed.key, duplicate: filed.duplicate, state: filed.state }
    return respond(IssueNoteAck, ack, filed.duplicate ? 200 : 201)
  }

/**
 * `POST /issues/:id/prio {value, id?}`, on the token API only, like a note: the owner's order among an Issue's project-mates. One
 * inbox row keyed `<issue>:prio:<call id>`; the same call again is 200 `duplicate`, the first 201. A closed Issue is 409.
 */
const issuePrioHandler =
  (sql: SQL, clock: Clock) =>
  async (req: Bun.BunRequest<'/issues/:id/prio'>): Promise<Response> => {
    const issueId = parseParam(IssueId, req.params.id)
    const body = await parseBody(req, IssuePrioBody)
    const filed = await filePrio(sql, { issueId, body, now: clock.now() })
    if (!filed.ok) {
      return filed.problem === 'unknown_issue'
        ? json({ error: 'unknown issue' }, 404)
        : json({ error: 'the Issue is closed: reopen it first' }, 409)
    }
    const ack = { issue: issueId, key: filed.key, duplicate: filed.duplicate, state: filed.state }
    return respond(IssuePrioAck, ack, filed.duplicate ? 200 : 201)
  }

/**
 * `POST /issues/:id/answer`, on the token API only: the owner's answer to an open question. One inbox row keyed
 * `<issue>:answer:<call id>`; the same call again is 200 `duplicate`, the first 201. It is not on the socket, because a pane
 * (a lead among them) has no token and must not be able to answer its own question.
 */
const issueAnswerHandler =
  (sql: SQL, clock: Clock) =>
  async (req: Bun.BunRequest<'/issues/:id/answer'>): Promise<Response> => {
    const issueId = parseParam(IssueId, req.params.id)
    const body = await parseBody(req, IssueAnswerBody)
    const filed = await fileAnswer(sql, { issueId, body, now: clock.now() })
    if (!filed.ok) {
      return filed.problem === 'unknown_issue'
        ? json({ error: 'unknown issue' }, 404)
        : json({ error: 'this Issue has no open question' }, 409)
    }
    const ack = { issue: issueId, key: filed.key, duplicate: filed.duplicate, state: filed.state }
    return respond(IssueAnswerAck, ack, filed.duplicate ? 200 : 201)
  }

/** `GET /notifications[?pending=1]`: newest first. */
const notificationListHandler = (sql: SQL) => async (req: Request) => {
  const pending = new URL(req.url).searchParams.get('pending') === '1'
  return respond(NotificationList, { notifications: await listNotifications(sql, { pending }) })
}

/**
 * `POST /notifications/test`: one line through the live path, the outbox and the notifier, and the answer says whether it arrived.
 * 200 with the row as it stands: `sent`, or `pending` with the error of the first try (the tick goes on retrying it).
 */
const notificationTestHandler = (sql: SQL, clock: Clock, notifier: Notifier, target: string) => async () => {
  const now = clock.now()
  const key = `notify:test:${now.getTime()}:${crypto.randomUUID().slice(0, 8)}`
  const note = target === 'off' ? 'notifications are off (FACTORY_NOTIFY_TARGET=off)' : null
  const sent = await sendNow(
    sql,
    { key, kind: 'test', issueId: null, text: "Factory test: the owner's line works." },
    { notifier, now: () => clock.now(), note },
  )
  const row = await getNotification(sql, key)
  // A result that could not be recorded leaves the row pending with no error of its own: the cause is the caller's to see.
  return row
    ? respond(Notification, { ...row, error: row.error ?? sent.error })
    : json({ error: 'the test message is gone' }, 500)
}

/**
 * `POST /issues/:id/:verb`, on the port and on the socket: a lead reports with one of its verbs. One inbox row keyed
 * `<issue>:<verb>:<call id>`; the same call again is 200 `duplicate`, the first 201. A `session` must work this Issue (409).
 */
const issueVerbHandler =
  (sql: SQL, clock: Clock, commits: Commits, review: Review | undefined, options: { requireSession: boolean }) =>
  async (req: Bun.BunRequest<'/issues/:id/:verb'>): Promise<Response> => {
    const issueId = parseParam(IssueId, req.params.id)
    // The owner's `answer` is no verb of a lead: the token API serves it on its own route, and here it is no route at all.
    if (req.params.verb === 'answer') return json({ error: 'not found' }, 404)
    const verb = parseParam(IssueVerb, req.params.verb)
    const body = await parseBody(req, IssueVerbBody[verb])
    const filed = await fileVerb(sql, { issueId, verb, body, now: clock.now(), commits, review, ...options })
    if (!filed.ok) {
      return filed.problem === 'unknown_issue'
        ? json({ error: 'unknown issue' }, 404)
        : json({ error: 'that session does not work this Issue' }, 409)
    }
    // A verb the evidence decides is answered here, by the lifecycle, so a refusal reaches the lead as a failed call.
    const answer = GATED_VERBS.includes(verb)
      ? await answerNow(sql, { issueId, key: filed.key, now: () => clock.now() })
      : undefined
    if (answer?.result === 'refused') return json({ error: answer.detail, code: 'refused' }, 409)
    const ack = {
      issue: issueId,
      verb,
      key: filed.key,
      duplicate: filed.duplicate,
      state: filed.state,
      result: answer?.result ?? null,
      detail: answer?.detail ?? null,
    }
    return respond(IssueVerbAck, ack, filed.duplicate ? 200 : 201)
  }

/** `POST /issues/:id/evidence`: what a lead proves, by the same rules as a verb. A repeated call is 200 and the first row stands. */
const issueEvidenceHandler =
  (sql: SQL, clock: Clock, options: { requireSession: boolean }) =>
  async (req: Bun.BunRequest<'/issues/:id/evidence'>): Promise<Response> => {
    const issueId = parseParam(IssueId, req.params.id)
    const body = await parseBody(req, IssueEvidenceInput)
    const filed = await fileEvidence(sql, { issueId, body, now: clock.now(), ...options })
    if (!filed.ok) {
      if (filed.problem === 'unknown_issue') return json({ error: 'unknown issue' }, 404)
      if (filed.problem === 'closed') return json({ error: 'the Issue is closed' }, 409)
      return json({ error: 'that session does not work this Issue' }, 409)
    }
    const ack = {
      issue: issueId,
      kind: body.kind,
      key: filed.key,
      duplicate: filed.duplicate,
      at: filed.at.toISOString(),
    }
    return respond(IssueEvidenceAck, ack, filed.duplicate ? 200 : 201)
  }

/**
 * The owner's own moves. `POST /issues/:id/reopen`: the same fault, within 30 days of closing, and the only way a closed Issue moves.
 * `POST /issues/:id/stop`: closes an Issue as dropped from any open state, one with no lead too, and finalizes it like every close;
 * port only, because a session has no business ending an Issue it may not even work. The lifecycle decides: a refusal (an Issue
 * the event does not apply to, a window that has passed) is the caller's answer, and the same `--id` again gets the same one.
 */
const issueOwnerHandler =
  (sql: SQL, clock: Clock, kind: 'reopen' | 'stop') =>
  async (req: Bun.BunRequest<'/issues/:id/reopen' | '/issues/:id/stop'>): Promise<Response> => {
    const issueId = parseParam(IssueId, req.params.id)
    const { id, reason } = await parseBody(req, IssueOwnerInput)
    const issue = await getIssue(sql, issueId)
    if (!issue) return json({ error: 'unknown issue' }, 404)
    const key = `${kind}:${issueId}:${id ?? crypto.randomUUID()}`
    const { duplicate } = await enqueue(sql, { issueId, key, kind, at: clock.now(), payload: { reason } })
    // The key is the caller's choice, and the inbox takes any: a row of something else under it is no earlier call of this one.
    if (duplicate) {
      const [row] =
        await sql`SELECT 1 FROM factory.issue_inbox WHERE key = ${key} AND kind = ${kind} AND issue_id = ${issueId}`
      if (!row) return json({ error: 'the id is taken by another event: use another --id', code: 'refused' }, 409)
    }
    const answer = await answerNow(sql, { issueId, key, now: () => clock.now() })
    if (answer?.result === 'refused') return json({ error: answer.detail, code: 'refused' }, 409)
    // Not answered yet: the row is filed and the tick has it. 202, and the Issue as it stands.
    return respond(Issue, (await getIssue(sql, issueId)) ?? issue, answer ? 200 : 202)
  }

/** `POST /issues/:id/resume`: a spawn that forks an attempt's archived session. */
const issueResumeHandler =
  (sql: SQL, clock: Clock, roles: RoleTable, repoRoots: readonly string[]) =>
  async (req: Bun.BunRequest<'/issues/:id/resume'>): Promise<Response> => {
    const issueId = parseParam(IssueId, req.params.id)
    const { id, attempt } = await parseBody(req, IssueResumeInput)
    const resumed = await resumeArchived(sql, { issueId, id, attempt, roles, repoRoots, now: clock.now() }).catch(
      (error) => {
        throw error instanceof RepoRefused ? new Refusal(error.message, 422) : error
      },
    )
    if (resumed.ok) return respond(Spawn, resumed.spawn, 201)
    return resumed.problem === 'unknown_issue'
      ? json({ error: 'unknown issue' }, 404)
      : json({ error: 'that attempt has no archived session' }, 409)
  }

/** `GET /projects`: every project, by name. */
const projectListHandler = (sql: SQL, clock: Clock) => async () =>
  respond(ProjectList, { projects: await listProjects(sql, clock.now()) })

/** `GET /projects/:name`. */
const projectGetHandler = (sql: SQL, clock: Clock) => async (req: Bun.BunRequest<'/projects/:name'>) => {
  const project = await getProject(sql, parseParam(ProjectName, req.params.name), clock.now())
  return project && listable(project) ? respond(Project, project) : json({ error: 'unknown project' }, 404)
}

/** A refused repo is the caller's 422, with the reason; anything else is the server's. */
const asRefusal = (error: unknown): never => {
  throw error instanceof RepoRefused ? new Refusal(error.message, 422) : error
}

/**
 * `POST /intake`, on the socket only: the door files one alert (docs/design.md §11). The repo is the registry's, so a refusal
 * here (a route that now points outside the roots, or into IuRoot) is a 422 that files nothing.
 */
const intakeHandler =
  (sql: SQL, clock: Clock, repoRoots: readonly string[]) =>
  async (req: Request): Promise<Response> => {
    const input = await parseBody(req, IntakeInput)
    const { status, ack } = await intakeAlert(sql, input, { repoRoots, now: clock.now() }).catch(asRefusal)
    return respond(IntakeAck, ack, status)
  }

/** `PUT|DELETE|GET /door/routes` and `GET /door/unrouted`: the registry the owner keeps, on the token API. */
const doorHandlers = (sql: SQL, clock: Clock, repoRoots: readonly string[]) => ({
  routes: {
    GET: async () => respond(DoorRouteList, { routes: await listRoutes(sql) }),
    PUT: async (req: Request) => {
      const input = await parseBody(req, DoorRouteInput)
      return respond(DoorRoute, await setRoute(sql, input, { repoRoots, now: clock.now() }).catch(asRefusal))
    },
    DELETE: async (req: Request) => {
      const removed = await removeRoute(sql, await parseBody(req, DoorRouteKey))
      return removed ? respond(DoorRoute, removed) : json({ error: 'unknown route' }, 404)
    },
  },
  unrouted: { GET: async () => respond(DoorUnroutedList, { unrouted: await listUnrouted(sql) }) },
})

/**
 * `GET /fleet`: the stored snapshot, never a build. 503 before the first one (the builder runs on the tick, 30 s). **Token API only,
 * never on the socket**: the model holds the text of IuRoot's repos and sessions, and what a pane reads goes to its model; no
 * filter over free text can be made tight, so the whole route stays behind the token.
 */
const fleetGetHandler = (sql: SQL) => async () => {
  const snapshot = await readSnapshot(sql)
  if (!snapshot) return json({ error: 'the fleet model is not built yet', code: 'not_ready' }, 503)
  return respond(Fleet, snapshot)
}

/** `POST /fleet/refresh`: a build now, answered with its model. */
const fleetRefreshHandler = (fleet: AppDeps['fleet']) => async () => {
  if (!fleet) return json({ error: 'the fleet builder is not running', code: 'not_ready' }, 503)
  try {
    return respond(Fleet, await fleet.refreshNow())
  } catch (error) {
    console.error('fleet refresh failed', error)
    return json({ error: 'the fleet model could not be built; see the server log', code: 'build_failed' }, 503)
  }
}

/** `?limit=` of a list: a whole number from 1 to `MAX_LIMIT`. */
function limitParam(raw: string | null): number {
  if (raw === null) return DEFAULT_LIMIT
  const limit = Number(raw)
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
    throw new BadRequest(`limit must be a whole number from 1 to ${MAX_LIMIT}`)
  }
  return limit
}

/** The read API's handlers, `GET /v1/...` (docs/design.md §11 "The read API"): the token API only, never on the socket. */
const readHandlers = (reader: Reader) => {
  const notReady = (error: unknown): Response => {
    if (error instanceof NotReady) return json({ error: error.message, code: 'not_ready' }, 503)
    throw error
  }
  return {
    overview: async () => reader.overview().then((body) => respond(Overview, body), notReady),
    issues: async (req: Request) => {
      const params = new URL(req.url).searchParams
      const scope = params.get('state') ?? 'open'
      if (scope !== 'open' && scope !== 'closed' && scope !== 'all')
        throw new BadRequest('state must be open, closed or all')
      return respond(IssueCards, { issues: await reader.issues({ scope, limit: limitParam(params.get('limit')) }) })
    },
    issue: async (req: Bun.BunRequest<'/v1/issues/:id'>) => {
      const detail = await reader.issue(parseParam(IssueId, req.params.id))
      return detail ? respond(IssueDetail, detail) : json({ error: 'unknown issue' }, 404)
    },
    sessions: async (req: Request) => {
      const params = new URL(req.url).searchParams
      const rawIssue = params.get('issue')
      const issue = rawIssue === null ? undefined : parseParam(IssueId, rawIssue)
      const role = params.get('role') ?? undefined
      const live = params.get('live') === '1'
      return respond(SessionCards, { sessions: await reader.sessions({ issue, role, live }) })
    },
    session: async (req: Bun.BunRequest<'/v1/sessions/:id'>) => {
      const card = await reader.session(req.params.id)
      return card ? respond(SessionCard, card) : json({ error: 'unknown session' }, 404)
    },
    asks: async () =>
      reader.lists().then((l) => respond(AskList, { asks: l.asks, humanQueue: l.humanQueue }), notReady),
    health: async () => reader.lists().then((l) => respond(HealthList, { health: l.health }), notReady),
    accounts: async () => respond(AccountList, { accounts: await reader.accounts() }),
  }
}

/** `GET /queue[?project=<path>]`. */
const queueGetHandler = (sql: SQL, repoRoots: readonly string[]) => async (req: Request) => {
  const project = new URL(req.url).searchParams.get('project')
  return respond(QueueView, await getQueue(sql, project === null ? null : await resolveProject(project, repoRoots)))
}

/** `PUT /slots/:id` asks for a test slot or renews the one held; `DELETE` gives it back. */
const slotHandlers = (sql: SQL, clock: Clock, slots: number) => ({
  PUT: async (req: Bun.BunRequest<'/slots/:id'>) => {
    const id = parseParam(SlotId, req.params.id)
    const { name } = await parseBody(req, SlotInput)
    return respond(Slot, await touchSlot(sql, { id, name, slots }, clock.now()))
  },
  DELETE: async (req: Bun.BunRequest<'/slots/:id'>) =>
    respond(SlotRelease, { released: await releaseSlot(sql, parseParam(SlotId, req.params.id)) }),
})

/** The route table for `Bun.serve`. */
export function routes(
  {
    sql,
    clock,
    version,
    token,
    monitor,
    repoRoots,
    roles,
    quota,
    projects,
    alertLeads,
    admission,
    notifier = new NullNotifier(),
    notifyTarget = 'off',
    commits = new GitCommits(),
    review,
    fleet,
    read: readOptions,
  }: AppDeps,
  /** what only a running server can do: take a connection out of its idle timer (the stream) */
  runtime: { noTimeout?: (req: Request) => void } = {},
) {
  const route = <R extends Request>(handler: (req: R) => Promise<Response>) => guarded(token, handler)
  const door = doorHandlers(sql, clock, repoRoots)
  const reader = new Reader({ sql, clock, ...readOptions })
  const read = readHandlers(reader)
  const stream = streamHandler({ sql, clock, reader, ...readOptions }, runtime.noTimeout ?? (() => {}))
  return {
    '/health': {
      GET: guarded(
        token,
        async () => {
          await sql`SELECT 1`
          const snapshot = monitor.snapshot()
          const health = {
            version,
            ...snapshot,
            heartbeat: await heartbeat(sql, clock.now(), snapshot.tick.lastSuccessAt),
          }
          return respond(Health, health, health.status === 'ok' ? 200 : 503)
        },
        { open: true },
      ),
    },
    '/events': {
      POST: route(async (req: Request) => {
        const { duplicate } = await recordEvent(sql, await parseBody(req, EventInput))
        return respond(EventAck, { duplicate }, duplicate ? 200 : 201)
      }),
    },
    '/sessions': {
      GET: route(async (req: Request) => {
        const all = new URL(req.url).searchParams.get('all') === '1'
        return respond(SessionList, { sessions: await listSessions(sql, clock.now(), { all }) })
      }),
    },
    '/sessions/:id': {
      GET: route(sessionGetHandler(sql, clock)),
    },
    '/sessions/:id/wait': { POST: route(waitHandler(sql, clock)) },
    '/sessions/:id/note': { POST: route(noteHandler(sql, clock)) },
    '/status': {
      GET: route(async () => respond(Status, await buildStatus(sql, clock.now(), { alertLeads }))),
    },
    '/fleet': { GET: route(fleetGetHandler(sql)) },
    '/fleet/refresh': { POST: route(fleetRefreshHandler(fleet)) },
    '/v1/overview': { GET: route(read.overview) },
    '/v1/issues': { GET: route(read.issues) },
    '/v1/issues/:id': { GET: route(read.issue) },
    '/v1/sessions': { GET: route(read.sessions) },
    '/v1/sessions/:id': { GET: route(read.session) },
    '/v1/asks': { GET: route(read.asks) },
    '/v1/health': { GET: route(read.health) },
    '/v1/accounts': { GET: route(read.accounts) },
    '/v1/stream': { GET: route(stream) },
    '/spawns': {
      GET: route(async () => respond(SpawnList, { spawns: await listSpawns(sql, clock.now()) })),
      POST: route(spawnHandler(sql, clock, roles, repoRoots, admission)),
    },
    '/spawns/:key': {
      GET: route(spawnGetHandler(sql, clock)),
    },
    '/spawns/:key/cancel': { POST: route(spawnCancelHandler(sql, clock)) },
    '/spawns/:key/requeue': {
      POST: route(async (req: Bun.BunRequest<'/spawns/:key/requeue'>) => {
        const result = await requeueSpawn(sql, req.params.key, clock.now())
        if ('spawn' in result) return respond(Spawn, result.spawn)
        if (result.problem === 'unknown') return json({ error: 'unknown spawn' }, 404)
        return json({ error: `spawn is ${result.status}; only a failed spawn can be re-queued` }, 409)
      }),
    },
    '/issues': {
      GET: route(issueListHandler(sql)),
      POST: route(issueCreateHandler(sql, clock, repoRoots)),
    },
    '/issues/facts': { GET: route(issueFactsHandler(sql)) },
    '/issues/:id': { GET: route(issueGetHandler(sql)) },
    '/issues/:id/timeline': { GET: route(issueTimelineHandler(sql)) },
    '/issues/:id/note': { POST: route(issueNoteHandler(sql, clock)) },
    '/issues/:id/prio': { POST: route(issuePrioHandler(sql, clock)) },
    '/issues/:id/answer': { POST: route(issueAnswerHandler(sql, clock)) },
    '/issues/:id/evidence': { POST: route(issueEvidenceHandler(sql, clock, { requireSession: false })) },
    '/issues/:id/reopen': { POST: route(issueOwnerHandler(sql, clock, 'reopen')) },
    '/issues/:id/stop': { POST: route(issueOwnerHandler(sql, clock, 'stop')) },
    '/issues/:id/resume': { POST: route(issueResumeHandler(sql, clock, roles, repoRoots)) },
    '/issues/:id/:verb': { POST: route(issueVerbHandler(sql, clock, commits, review, { requireSession: false })) },
    '/notifications': { GET: route(notificationListHandler(sql)) },
    '/notifications/test': { POST: route(notificationTestHandler(sql, clock, notifier, notifyTarget)) },
    '/projects': { GET: route(projectListHandler(sql, clock)) },
    '/projects/sync': { POST: route(async () => respond(ProjectSyncResult, await projects.syncNow())) },
    '/projects/:name': { GET: route(projectGetHandler(sql, clock)) },
    '/door/routes': { GET: route(door.routes.GET), PUT: route(door.routes.PUT), DELETE: route(door.routes.DELETE) },
    '/door/unrouted': { GET: route(door.unrouted.GET) },
    '/quota': {
      GET: route(async () => {
        const now = clock.now()
        return respond(QuotaList, { quota: (await latestReadings(sql)).map((r) => toQuota(r, now)) })
      }),
    },
    '/quota/refresh': {
      POST: route(async () => {
        await quota.poll().catch((error) => {
          throw error instanceof QuotaError ? new Refusal(error.message, 502) : error
        })
        const now = clock.now()
        return respond(QuotaList, { quota: (await latestReadings(sql)).map((r) => toQuota(r, now)) })
      }),
    },
    // A reading by hand, for tests and operators; the next poll of the picker supersedes it.
    '/quota/accounts/:account': {
      PUT: route(async (req: Bun.BunRequest<'/quota/accounts/:account'>) => {
        const account = parseParam(AccountName, req.params.account)
        const now = clock.now()
        await recordReading(sql, { account, ...(await parseBody(req, QuotaInput)) }, now)
        const stored = (await latestReadings(sql)).find((r) => r.account === account)
        return stored ? respond(Quota, toQuota(stored, now)) : json({ error: 'reading not stored' }, 500)
      }),
    },
    '/queue': {
      GET: route(queueGetHandler(sql, repoRoots)),
      PUT: route(async (req: Request) => {
        const { state, project } = await parseBody(req, QueueInput)
        const scope = project === undefined ? null : await resolveProject(project, repoRoots)
        return respond(QueueView, await setQueue(sql, scope, state, clock.now()))
      }),
    },
  } as const
}

/** The methods each route pattern answers, as a matcher for the paths `fetch` receives. */
function allowedMethods(table: Record<string, object>): (pathname: string) => string[] {
  const patterns = Object.entries(table).map(([pattern, handlers]) => ({
    regex: new RegExp(`^${pattern.replace(/:[^/]+/g, '[^/]+')}$`),
    methods: Object.keys(handlers),
  }))
  return (pathname) => patterns.find((p) => p.regex.test(pathname))?.methods ?? []
}

export function serve(deps: AppDeps & { port: number }) {
  // The stream is quiet between keepalives: Bun's idle timer would cut it, so its handler takes its connection out of the timer.
  const table = routes(deps, { noTimeout: (req) => server.timeout(req, 0) })
  const allowed = allowedMethods(table)
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: deps.port,
    idleTimeout: IDLE_TIMEOUT_S,
    routes: table,
    // Bun routes per method: a known path with another method lands here, and must not read as "no such resource".
    fetch: (req) => {
      const methods = allowed(new URL(req.url).pathname)
      if (methods.length === 0) return json({ error: 'not found' }, 404)
      return json({ error: 'method not allowed' }, 405, { allow: methods.join(', ') })
    },
    error: failure,
  })
  return server
}

/**
 * The sessions' way in: a unix socket in the owner's directory. It serves `POST /events`, `POST /sessions/:id/wait|note|stop-check`,
 * `PUT|DELETE /slots/:id` (the test-slot semaphore), `POST /spawns` and `POST /issues` (a pane starting or filing work: the same
 * body, validation and repo-roots check as the port), the reads a spawner needs to follow what it started (`GET /spawns/:key`,
 * `GET /sessions/:id`, `GET /queue`) the Issue reads (`GET /issues[/:id]`, `GET /issues/:id/timeline`, `GET /issues/facts`), a lead's verbs and evidence (`POST /issues/:id/:verb|evidence`), `POST /issues/:id/reopen|resume`, the project reads (`GET /projects[/:name]`), and `POST /intake` (the door's alerts), and nothing else. A session has no token (the runner keeps secrets out of the panes), and the socket's mode 0600
 * is what only the owner's processes can pass.
 */
export function serveHooks(deps: {
  sql: SQL
  clock: Clock
  token: string
  socketPath: string
  repoRoots: readonly string[]
  roles: RoleTable
  slots: number
  commits?: Commits
  review?: Review
  admission?: AdmissionLimits
}) {
  const commits = deps.commits ?? new GitCommits()
  const open = { open: true }
  const viaSocket = <R extends Request>(handler: (req: R) => Promise<Response>) => guarded(deps.token, handler, open)
  const slot = slotHandlers(deps.sql, deps.clock, deps.slots)
  return Bun.serve({
    unix: deps.socketPath,
    ...idle,
    routes: {
      '/events': {
        POST: viaSocket(async (req: Request) => {
          const { duplicate } = await recordEvent(deps.sql, await parseBody(req, EventInput))
          return respond(EventAck, { duplicate }, duplicate ? 200 : 201)
        }),
      },
      '/sessions/:id': { GET: viaSocket(sessionGetHandler(deps.sql, deps.clock)) },
      '/sessions/:id/wait': { POST: viaSocket(waitHandler(deps.sql, deps.clock)) },
      '/sessions/:id/note': { POST: viaSocket(noteHandler(deps.sql, deps.clock)) },
      '/sessions/:id/stop-check': { POST: viaSocket(stopCheckHandler(deps.sql, deps.clock)) },
      '/slots/:id': { PUT: viaSocket(slot.PUT), DELETE: viaSocket(slot.DELETE) },
      '/spawns': { POST: viaSocket(spawnHandler(deps.sql, deps.clock, deps.roles, deps.repoRoots, deps.admission)) },
      '/spawns/:key': { GET: viaSocket(spawnGetHandler(deps.sql, deps.clock)) },
      '/spawns/:key/cancel': { POST: viaSocket(spawnCancelHandler(deps.sql, deps.clock)) },
      '/queue': { GET: viaSocket(queueGetHandler(deps.sql, deps.repoRoots)) },
      '/issues': {
        GET: viaSocket(issueListHandler(deps.sql)),
        POST: viaSocket(issueCreateHandler(deps.sql, deps.clock, deps.repoRoots)),
      },
      '/issues/facts': { GET: viaSocket(issueFactsHandler(deps.sql)) },
      '/issues/:id': { GET: viaSocket(issueGetHandler(deps.sql)) },
      '/issues/:id/timeline': { GET: viaSocket(issueTimelineHandler(deps.sql)) },
      '/issues/:id/evidence': { POST: viaSocket(issueEvidenceHandler(deps.sql, deps.clock, { requireSession: true })) },
      '/issues/:id/reopen': { POST: viaSocket(issueOwnerHandler(deps.sql, deps.clock, 'reopen')) },
      '/issues/:id/resume': {
        POST: viaSocket(issueResumeHandler(deps.sql, deps.clock, deps.roles, deps.repoRoots)),
      },
      '/issues/:id/:verb': {
        POST: viaSocket(issueVerbHandler(deps.sql, deps.clock, commits, deps.review, { requireSession: true })),
      },
      '/projects': { GET: viaSocket(projectListHandler(deps.sql, deps.clock)) },
      '/projects/:name': { GET: viaSocket(projectGetHandler(deps.sql, deps.clock)) },
      // Not here, on purpose: `/fleet`, `/fleet/refresh` and all of `/v1`. The model holds IuRoot's text and what a pane reads goes to its model.
      // The door's alerts. The door is a same-user process on this socket like a pane (SF11): it holds no token and no database
      // credential, but it can call every route here, `POST /issues` and `POST /spawns` among them.
      '/intake': { POST: viaSocket(intakeHandler(deps.sql, deps.clock, deps.repoRoots)) },
    },
    fetch: () => json({ error: 'not found' }, 404),
    error: failure,
  })
}
