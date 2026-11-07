import { connect, ping } from './adapters/postgres/connection.ts'
import { loadMigrations, migrate } from './adapters/postgres/migrate.ts'
import { acquireProcessLock } from './adapters/postgres/process-lock.ts'
import { postgresUnitOfWork } from './adapters/postgres/unit-of-work.ts'
import { postgresWorkStore } from './adapters/postgres/work-store.ts'
import { GitCommits } from './adapters/quality/git.ts'
import { makefileProjects } from './adapters/quality/projects.ts'
import { MakeAndProbes } from './adapters/quality/proof.ts'
import { AgwReview } from './adapters/quality/review.ts'
import { postgresQualityStore } from './adapters/quality/store.ts'
import { stubLeadCheckout } from './adapters/quality/stubs.ts'
import { createApp } from './api/app.ts'
import { fileIssue, recordIssueEvent } from './app/issues.ts'
import { type OutboxDeps, runOutbox } from './app/outbox.ts'
import { showQuality } from './app/quality-read.ts'
import { reopenIssue } from './app/quality-reopen.ts'
import { shipIssue } from './app/quality-ship.ts'
import { checkWatches, DEFAULT_TIMING, startWatchPort } from './app/quality-watch.ts'
import { type Clock, systemClock } from './kernel/clock.ts'
import { systemIds } from './kernel/ids.ts'
import { ok } from './kernel/result.ts'
import { healthOf } from './read/health.ts'
import { loadSettings } from './settings.ts'

/** The API listens on loopback only; the tailnet listener for the Console comes with the Console. */
const HOSTNAME = '127.0.0.1'

type EffectPorts = OutboxDeps['ports']

/** Stands in for the port of another package (leads, 4) until it brings the real one: it did nothing, and says so by answering ok. */
const stubStartLead: EffectPorts['start_lead'] = async () => ok(undefined)
const stubNoteLead: EffectPorts['note_lead'] = async () => ok(undefined)
const stubFinalize: EffectPorts['finalize'] = async () => ok(undefined)

/** Runs `pass` every `ms`, never two at once: a fire while the last pass still runs is skipped. `stop` waits for the running pass. */
function every(ms: number, pass: () => Promise<void>): { stop(): Promise<void> } {
  let running: Promise<void> | undefined
  const timer = setInterval(() => {
    if (running) return
    running = pass()
      .catch((error: unknown) => console.error(`tick: ${String(error)}`))
      .finally(() => {
        running = undefined
      })
  }, ms)
  return {
    stop: async () => {
      clearInterval(timer)
      await running
    },
  }
}

/** A ship call waits for git and agw (up to REVIEW_TIMEOUT_MS) inside one request; Bun's own idle limit is 10 s, and 255 s is its maximum. */
const IDLE_TIMEOUT_S = 255

const fail = (message: string): never => {
  console.error(message)
  process.exit(1)
}

async function main(): Promise<void> {
  const settings = loadSettings(process.env)
  const sql = connect(settings.databaseUrl)

  // The process lock comes first: nothing, not even a migration, runs beside another server on this database.
  const lock = await acquireProcessLock(sql, {
    waitMs: settings.lockWaitMs,
    onLost: (reason) => fail(`lost the process lock (${reason}); exiting`),
  })
  if (!lock) {
    await sql.close()
    fail(`another server holds the process lock on this database (asked for ${settings.lockWaitMs} ms); exiting`)
    return
  }

  const applied = await migrate(sql, await loadMigrations())
  if (applied.length) console.log(`migrated: ${applied.join(', ')}`)

  // The composition: each domain's store on the transaction's connection, the ports the use cases get.
  const uow = postgresUnitOfWork(sql, (tx) => ({ work: postgresWorkStore(tx), quality: postgresQualityStore(tx) }))
  const clock: Clock =
    settings.clockOffsetMs === 0 ? systemClock : { now: () => new Date(Date.now() + settings.clockOffsetMs) }
  const writes = { uow, clock, ids: systemIds }
  const projects = makefileProjects({ windowMs: settings.quality.windowMs })
  const shipping = {
    ...writes,
    commits: new GitCommits(),
    review: new AgwReview({ bin: settings.agwBin }),
    checkout: stubLeadCheckout,
  }

  // The tick (the loops, package 4 or 7) brings the one that runs everything; until then this runs the outbox and the watches.
  const draining = new AbortController()
  const startedAt = clock.now()
  const ports: EffectPorts = {
    start_lead: stubStartLead,
    note_lead: stubNoteLead,
    finalize: stubFinalize,
    start_watch: startWatchPort({ uow, clock, projects }),
  }
  const outboxPass = async () => {
    const outbox = await runOutbox({ uow, clock, ports })
    if (!outbox.ok) console.error(`outbox: ${outbox.error.detail}`)
  }
  const watchPass = async () => {
    const watched = await checkWatches({
      uow,
      clock,
      ids: systemIds,
      projects,
      proof: new MakeAndProbes(),
      timing: { ...DEFAULT_TIMING, retryMs: settings.quality.retryMs },
      settledAt: new Date(startedAt.getTime() + settings.quality.settleMs),
      signal: draining.signal,
    })
    if (!watched.ok) console.error(`watches: ${watched.error.detail}`)
  }
  // Two loops, so a `make verify` of minutes never holds the outbox; each is skipped while its last pass still runs.
  const loops = settings.tickMs === null ? [] : [every(settings.tickMs, outboxPass), every(settings.tickMs, watchPass)]

  const app = createApp({
    health: {
      read: async () =>
        healthOf({ version: settings.version, databaseFailure: await ping(sql), tickAt: null, queueMovedAt: null }),
    },
    quality: {
      ship: (input) => shipIssue(shipping, input),
      reopen: (input) => reopenIssue(writes, input),
      show: (issueId) => showQuality({ uow }, issueId),
    },
    internalTest: settings.internalTestRoutes
      ? { file: (input) => fileIssue(writes, input), record: (input) => recordIssueEvent(writes, input) }
      : undefined,
  }).listen({ hostname: HOSTNAME, port: settings.port, idleTimeout: IDLE_TIMEOUT_S })
  console.log(`listening on http://${HOSTNAME}:${settings.port} (version ${settings.version})`)

  let stopping = false
  const stop = async (signal: string) => {
    if (stopping) return
    stopping = true
    console.log(`${signal}: stopping`)
    draining.abort()
    await app.stop()
    await Promise.all(loops.map((loop) => loop.stop()))
    await lock.release()
    await sql.close()
    process.exit(0)
  }
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.on(signal, () => {
      stop(signal).catch((error: unknown) => fail(`stop failed: ${String(error)}`))
    })
  }
}

main().catch((error: unknown) => fail(error instanceof Error ? error.message : String(error)))
