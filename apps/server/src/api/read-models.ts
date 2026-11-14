import {
  CapacityLoopModel,
  DaysQuery,
  DEFAULT_DAYS,
  DEFAULT_HOURS,
  ErrorBody,
  FindingClassesModel,
  FixCommitsModel,
  FlowModel,
  FrictionModel,
  type HostProcess,
  HostHistoryModel,
  HoursQuery,
  KpiModel,
  MachineModel,
  RetroModel,
  ThroughputModel,
  SinceModel,
  NeedsModel,
  ChainModel,
  ProjectDigestsModel,
  type QueueReason as QueueReasonSchema,
} from '@software-factory/contract'
import type { SQL } from 'bun'
import { Elysia } from 'elysia'
import type * as z from 'zod'
import type { UnitOfWork } from '../app/unit-of-work.ts'
import { registerVisit, type VisitStore } from '../app/visit.ts'
import type { CiTimes } from '../domains/loops/ports.ts'
import { findingClasses } from '../app/loops/finding-classes.ts'
import { type CapacityConstants, readCapacityLoop } from '../read/capacity-loop.ts'
import { readChain } from '../read/chain.ts'
import { readProjectDigests } from '../read/digests.ts'
import { type QueueReasons, readFlow } from '../read/flow.ts'
import { readFixCommits } from '../read/fix-commits.ts'
import { readFriction } from '../read/friction.ts'
import { readHostSamples } from '../read/host.ts'
import { readKpis } from '../read/kpis.ts'
import { readRetro } from '../read/retro.ts'
import { readThroughput } from '../read/throughput.ts'
import { loopReads } from '../read/loops.ts'
import { needsModel, readNeeds } from '../read/needs.ts'
import { readSince, storedSince } from '../read/since.ts'
import { callerOf } from './auth.ts'
import { errorResponses } from './errors.ts'
import type { Caller } from './policy.ts'

/** What the read models read from: the database, and the reasons the capacity use case gives queued Issues. */
export interface ReadModelDeps {
  sql: SQL
  /** why each queued Issue stays queued; absent or failing, the Flow screen shows the Issues without a reason */
  queueReasons?: () => Promise<QueueReasons | null>
  /** the host's load and memory with the admission ceilings; null when the capacity use case cannot read them */
  machine?: () => Promise<Omit<MachineModel, 'at'> | null>
  /** the server's version and start time with the host's busiest processes; absent, `GET /v1/host` is 503 */
  host?: {
    version: string
    startedAt: Date
    top: () => Promise<{ topByCpu: HostProcess[]; topByMemory: HostProcess[] }>
  }
  /** the owner's visit marker; absent, `GET /v1/since` moves nothing and reads from the stored start */
  visits?: UnitOfWork<{ visits: VisitStore }>
  /** the owner's read began a new visit after two hours or more away: the desk pass starts at once (never awaited, never throws) */
  onReturn?: () => void
  /** the duration of a repo's finished CI runs; absent, `GET /v1/retro` has check figures only */
  ciTimes?: CiTimes
  /** the settings in force the capacity loop tunes; absent, `GET /v1/capacity-loop` is 503 */
  capacityConstants?: CapacityConstants
  /** the data directory `scripts/deploy.sh` writes `deploys.log` into; absent, `GET /v1/throughput` has no deploys */
  dataDir?: string
  now?: () => Date
  /** how long a timed wait with Issues behind it must last to reach Needs you; absent, the default (`FACTORY_LONG_WAIT_MS`) */
  longWaitMs?: number
}

/** `QueueReason` of the contract from the capacity use case's entries (`main.ts` binds it). */
export const queueReasonMap = (
  entries: readonly {
    issue: string
    reason: { kind: z.infer<typeof QueueReasonSchema>['kind']; message: string; opensAt: Date | null } | null
  }[],
): QueueReasons =>
  new Map(
    entries.flatMap((entry) =>
      entry.reason
        ? [[entry.issue, { ...entry.reason, opensAt: entry.reason.opensAt?.toISOString() ?? null }] as const]
        : [],
    ),
  )

const unavailable = Response.json(
  ErrorBody.parse({ error: 'the read models are not wired in this process', code: 'unavailable' }),
  { status: 503 },
)

const noMachine = () =>
  Response.json(ErrorBody.parse({ error: 'the host cannot be read in this process', code: 'unavailable' }), {
    status: 503,
  })

const noHost = () =>
  Response.json(ErrorBody.parse({ error: 'the host history is not wired in this process', code: 'unavailable' }), {
    status: 503,
  })

/**
 * The Console's computed screens, all `GET /v1/*`: what waits on the owner, the Issues by state, the chain, the KPIs and
 * the friction. `caller` says who is reading; the read token gets work-repo text replaced. Unbound (the OpenAPI document
 * alone), the routes answer 503.
 */
export const readModelRoutes = (deps: ReadModelDeps | undefined, caller: (request: Request) => Caller = callerOf) => {
  const now = () => (deps?.now ?? (() => new Date()))()
  const days = (query: { days?: string | undefined }) => (query.days === undefined ? DEFAULT_DAYS : Number(query.days))
  return new Elysia({ prefix: '/v1' })
    .get(
      '/needs',
      async ({ request }) => {
        if (!deps) return unavailable
        const needs = await readNeeds(deps.sql, now(), { longWaitMs: deps.longWaitMs })
        return Response.json(NeedsModel.parse(needsModel(needs, { redact: caller(request) === 'read' })))
      },
      {
        response: { 200: NeedsModel, ...errorResponses(503) },
        detail: {
          operationId: 'read.needs',
          summary:
            'everything that waits on the owner: open Decisions, artifacts awaiting a verdict, open Errands and held signals, newest first within a kind',
        },
      },
    )
    .get(
      '/flow',
      async ({ request }) => {
        if (!deps) return unavailable
        const queue = await deps.queueReasons?.().catch(() => null)
        const redact = caller(request) === 'read'
        return Response.json(
          FlowModel.parse(await readFlow(deps.sql, { now: now(), queue: queue ?? undefined, redact })),
        )
      },
      {
        response: { 200: FlowModel, ...errorResponses(503) },
        detail: {
          operationId: 'read.flow',
          summary:
            'the Issues by state (settling, queued, working, waiting, watching), what closed in the last day, counts per project and the queue state per scope',
        },
      },
    )
    .get(
      '/projects/digests',
      async ({ request }) => {
        if (!deps) return unavailable
        const redact = caller(request) === 'read'
        return Response.json(ProjectDigestsModel.parse(await readProjectDigests(deps.sql, { now: now(), redact })))
      },
      {
        response: { 200: ProjectDigestsModel, ...errorResponses(503) },
        detail: {
          operationId: 'read.project-digests',
          summary:
            "each project's newest digest (headline, shipped, next and risks bullets citing Issues, themes) made every few hours by agw's factory digest, for projects with an Issue open or closed in the last 7 days, with counts (done in 7 days, working, queued, waiting) read from the Issues now; the read token gets the counts of a work project and no words",
        },
      },
    )
    .get(
      '/machine',
      async () => {
        if (!deps) return unavailable
        const machine = await deps.machine?.().catch(() => null)
        if (!machine) return noMachine()
        return Response.json(MachineModel.parse({ at: now().toISOString(), ...machine }))
      },
      {
        response: { 200: MachineModel, ...errorResponses(503) },
        detail: {
          operationId: 'read.machine',
          summary:
            "the host's 1-minute load and swap use with the ceilings above which no new lead is admitted; a reading that failed is null",
        },
      },
    )
    .get(
      '/host',
      async () => {
        if (!deps) return unavailable
        if (!deps.host) return noHost()
        const at = now()
        const [samples, top] = await Promise.all([readHostSamples(deps.sql, at), deps.host.top()])
        return Response.json(
          HostHistoryModel.parse({
            at: at.toISOString(),
            version: deps.host.version,
            startedAt: deps.host.startedAt.toISOString(),
            samples,
            ...top,
          }),
        )
      },
      {
        response: { 200: HostHistoryModel, ...errorResponses(503) },
        detail: {
          operationId: 'read.host',
          summary:
            "the host over the last 24 hours as one-minute samples (load, memory and swap use, a failed reading null), its top 8 processes by cpu and by resident memory, and the server's version and start time",
        },
      },
    )
    .get(
      '/since',
      async ({ request }) => {
        if (!deps) return unavailable
        const at = now()
        const who = caller(request)
        if (who === 'owner' && deps.visits) {
          const visit = await registerVisit(deps.visits, at)
          if (!visit.ok) throw new Error(`the visit marker could not be stored: ${visit.error.detail}`)
          // his return is an event: the desk pass starts now, not at the loop's next tick
          if (visit.value.returned) deps.onReturn?.()
          return Response.json(
            SinceModel.parse(await readSince(deps.sql, { now: at, since: visit.value.since, redact: false })),
          )
        }
        const since = await storedSince(deps.sql, at)
        return Response.json(SinceModel.parse(await readSince(deps.sql, { now: at, since, redact: who === 'read' })))
      },
      {
        response: { 200: SinceModel, ...errorResponses(503) },
        detail: {
          operationId: 'read.since',
          summary:
            "what happened since the owner was last here: shipped with verification, regressed, dropped, settled by the Judge, screened off, filed by origin and incidents opened, each counted once with the newest 8. The owner's read moves the visit marker (a new visit after 30 quiet minutes); every other caller reads from the stored start and writes nothing",
        },
      },
    )
    .get(
      '/chain',
      async ({ request }) => {
        if (!deps) return unavailable
        return Response.json(ChainModel.parse(await readChain(deps.sql, now(), { redact: caller(request) === 'read' })))
      },
      {
        response: { 200: ChainModel, ...errorResponses(503) },
        detail: {
          operationId: 'read.chain',
          summary:
            'the dependency chain across projects: open Issues and plan rows not yet filed as nodes, after edges, and what blocks each queued Issue now',
        },
      },
    )
    .get(
      '/kpis',
      async ({ query }) => {
        if (!deps) return unavailable
        return Response.json(KpiModel.parse(await readKpis(deps.sql, { now: now(), days: days(query) })))
      },
      {
        query: DaysQuery,
        response: { 200: KpiModel, ...errorResponses(400, 422, 503) },
        detail: {
          operationId: 'read.kpis',
          summary:
            'the KPI table over the last days (1 to 90, default 7), each with its value, sample size, target, whether it is measured, and what exactly was counted',
        },
      },
    )
    .get(
      '/retro',
      async ({ query, request }) => {
        if (!deps) return unavailable
        const redact = caller(request) === 'read'
        return Response.json(
          RetroModel.parse(
            await readRetro(deps.sql, {
              now: now(),
              days: days(query),
              redact,
              capacityConstants: deps.capacityConstants,
              ...(deps.ciTimes ? { ciTimes: deps.ciTimes } : {}),
            }),
          ),
        )
      },
      {
        query: DaysQuery,
        response: { 200: RetroModel, ...errorResponses(400, 422, 503) },
        detail: {
          operationId: 'read.retro',
          summary:
            'what the weekly retro reads from the database over the last days (1 to 90, default 7): the KPI table with its history, the friction counts, the lead sessions with their transcript paths, samples of Issues worth reading and the ledger of the earlier retro signals, the capacity loop’s figures with the one setting to change; `factory retro` adds the transcript pass',
        },
      },
    )
    .get(
      '/friction',
      async ({ query }) => {
        if (!deps) return unavailable
        return Response.json(FrictionModel.parse(await readFriction(deps.sql, { now: now(), days: days(query) })))
      },
      {
        query: DaysQuery,
        response: { 200: FrictionModel, ...errorResponses(400, 422, 503) },
        detail: {
          operationId: 'read.friction',
          summary:
            'counted waste over the last days (1 to 90, default 7): avoidable touches, refusals, stalls, lost leads, undelivered notes, unreviewed ships, regressions, who settled Decisions, held signals',
        },
      },
    )
    .get(
      '/capacity-loop',
      async ({ query }) => {
        if (!deps?.capacityConstants) return unavailable
        return Response.json(
          CapacityLoopModel.parse(
            await readCapacityLoop(deps.sql, { now: now(), days: days(query), constants: deps.capacityConstants }),
          ),
        )
      },
      {
        query: DaysQuery,
        response: { 200: CapacityLoopModel, ...errorResponses(400, 422, 503) },
        detail: {
          operationId: 'read.capacity-loop',
          summary:
            'what the capacity loop did over the last days (1 to 90, default 7): Issues closed, idle seat-hours with work queued, minutes over the load ceiling, test-slot wait, the steps and repos that take most memory, processes the reaper ended, and the settings in force that tune it',
        },
      },
    )
    .get(
      '/throughput',
      async ({ query }) => {
        if (!deps) return unavailable
        const hours = query.hours === undefined ? DEFAULT_HOURS : Number(query.hours)
        return Response.json(
          ThroughputModel.parse(await readThroughput(deps.sql, { now: now(), hours, dataDir: deps.dataDir })),
        )
      },
      {
        query: HoursQuery,
        response: { 200: ThroughputModel, ...errorResponses(400, 422, 503) },
        detail: {
          operationId: 'read.throughput',
          summary:
            'where the host memory and CPU went over the last hours (1 to 336, default 24): footprint, peak and CPU by process class, by repo and by tenant, the host signals (pressure, load, idle CPU, compressor, swap) and the notable processes',
        },
      },
    )
    .get(
      '/finding-classes',
      async () => {
        if (!deps) return unavailable
        return Response.json(FindingClassesModel.parse(await findingClasses(loopReads(deps.sql), now())))
      },
      {
        response: { 200: FindingClassesModel, ...errorResponses(503) },
        detail: {
          operationId: 'read.finding-classes',
          summary:
            'the kinds of finding the friction and hygiene loops file, each open, on probation or held for mostly dropped or cancelled Issues, with its counts and when a held class is asked again',
        },
      },
    )
    .get(
      '/fix-commits',
      async () => {
        if (!deps) return unavailable
        return Response.json(FixCommitsModel.parse(await readFixCommits(deps.sql, { now: now() })))
      },
      {
        response: { 200: FixCommitsModel, ...errorResponses(503) },
        detail: {
          operationId: 'read.fix-commits',
          summary:
            'fix commits of the projects by class over the last four weeks, the newest week first (week i is the 7 days ending i weeks ago), with what each class means',
        },
      },
    )
}
