import { connect, ping } from './adapters/postgres/connection.ts'
import { agwJudge } from './adapters/agw-ask/judge.ts'
import { fileBlobStore } from './adapters/blobs/filesystem.ts'
import { fileStandingPolicies, stubStandingPolicies } from './adapters/checkpoints/policies.ts'
import { makeNotifier } from './adapters/ntfy/ntfy.ts'
import { postgresCheckpointStore } from './adapters/postgres/checkpoint-store.ts'
import { loadMigrations, migrate } from './adapters/postgres/migrate.ts'
import { acquireProcessLock } from './adapters/postgres/process-lock.ts'
import { postgresLeadStore } from './adapters/leads/store.ts'
import { loadLeadSettings } from './adapters/leads/settings.ts'
import { postgresUnitOfWork } from './adapters/postgres/unit-of-work.ts'
import { postgresWorkStore } from './adapters/postgres/work-store.ts'
import { GitCommits } from './adapters/quality/git.ts'
import { makefileProjects } from './adapters/quality/projects.ts'
import { MakeAndProbes } from './adapters/quality/proof.ts'
import { AgwReview } from './adapters/quality/review.ts'
import { postgresQualityStore } from './adapters/quality/store.ts'
import { createApp } from './api/app.ts'
import { checkpointUses } from './app/checkpoints-uses.ts'
import { postgresIntakeStore } from './adapters/intake/store.ts'
import { loadIntakeEnv } from './adapters/intake/settings.ts'
import { composeIntake } from './compose-intake.ts'
import { fileIssue, recordIssueEvent } from './app/issues.ts'
import { leadCheckoutOf } from './app/quality-checkout.ts'
import { showQuality } from './app/quality-read.ts'
import { reopenIssue } from './app/quality-reopen.ts'
import { shipIssue } from './app/quality-ship.ts'
import { checkWatches, DEFAULT_TIMING, startWatchPort } from './app/quality-watch.ts'
import { loadCheckpointSettings } from './checkpoint-settings.ts'
import { composeLeads } from './compose-leads.ts'
import { type Clock, systemClock } from './kernel/clock.ts'
import { systemIds } from './kernel/ids.ts'
import { healthOf, tickProblem } from './read/health.ts'
import { loadSettings } from './settings.ts'

/** The API listens on loopback only; the tailnet listener for the Console comes with the Console. */
const HOSTNAME = '127.0.0.1'

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
  const uow = postgresUnitOfWork(sql, (tx) => ({
    work: postgresWorkStore(tx),
    checkpoints: postgresCheckpointStore(tx),
    leads: postgresLeadStore(tx),
    quality: postgresQualityStore(tx),
    intake: postgresIntakeStore(tx),
  }))
  const intake = await composeIntake({ sql, uow, env: loadIntakeEnv(process.env), clock: systemClock, ids: systemIds })
  // The scenarios move this clock to reach a date a real one would take 30 days to; the leads' own keep the system's.
  const clock: Clock =
    settings.clockOffsetMs === 0 ? systemClock : { now: () => new Date(Date.now() + settings.clockOffsetMs) }
  const writes = { uow, clock, ids: systemIds }
  const startedAt = new Date()
  const leadSettings = loadLeadSettings(process.env)
  const checkout = leadCheckoutOf(uow)
  const projects = makefileProjects({ windowMs: settings.quality.windowMs })
  // One outbox runs every effect: the leads' tick, with quality's port for the Watch.
  const leads = composeLeads({
    sql,
    uow,
    clock: systemClock,
    ids: systemIds,
    settings: leadSettings,
    startWatch: startWatchPort({ uow, clock, projects, checkout }),
  })
  // The hook socket comes after the lock and the migrations: a second copy never reaches it.
  const socket = await leads.listen()
  const stopTick = leads.startLoop()

  // The Watch's checks run on a loop of their own, so a `make verify` of minutes never holds the leads' tick. It runs on the
  // leads' interval (FACTORY_TICK_MS, 0 off), one pass at a time.
  const shipping = {
    ...writes,
    commits: new GitCommits(),
    review: new AgwReview({ bin: settings.agwBin }),
    checkout,
  }
  const draining = new AbortController()
  const watchLoop =
    leadSettings.tickMs === 0
      ? undefined
      : every(leadSettings.tickMs, async () => {
          const watched = await checkWatches({
            ...writes,
            projects,
            checkout,
            proof: new MakeAndProbes(),
            timing: { ...DEFAULT_TIMING, retryMs: settings.quality.retryMs },
            settledAt: new Date(startedAt.getTime() + settings.quality.settleMs),
            signal: draining.signal,
          })
          if (!watched.ok) console.error(`watches: ${watched.error.detail}`)
        })

  const checkpointSettings = loadCheckpointSettings(process.env)
  const checkpoints = checkpointUses({
    ...writes,
    blobs: fileBlobStore(checkpointSettings.blobDir),
    consoleUrl: checkpointSettings.line.consoleUrl,
    notifier: makeNotifier(checkpointSettings.line),
    // The Judge's call is a thin one until package 7 brings the agw port; the project's standing policy is package 3's.
    judge: agwJudge({ bin: checkpointSettings.agwBin }),
    policies: checkpointSettings.policyFile
      ? fileStandingPolicies(checkpointSettings.policyFile)
      : stubStandingPolicies,
  })
  // Settling and sending run on timers of their own, one pass of each at a time: a Judge call is an agent run that can take
  // minutes, and the owner's line must not wait for it. Package 7's tick takes both over; the leases make two callers safe.
  const everyPass = (name: string, run: () => Promise<{ ok: boolean; error?: unknown }>) => {
    let running = false
    return setInterval(() => {
      if (running) return
      running = true
      run()
        .then((result) => {
          if (!result.ok) console.error(`checkpoints: the ${name} pass failed: ${JSON.stringify(result.error)}`)
        })
        .catch((error: unknown) => console.error(`checkpoints: the ${name} pass threw: ${String(error)}`))
        .finally(() => {
          running = false
        })
    }, checkpointSettings.passMs)
  }
  const passTimers =
    checkpointSettings.passMs > 0
      ? [everyPass('settle', () => checkpoints.settle()), everyPass('send', () => checkpoints.send())]
      : []

  const app = createApp({
    intake: intake.api,
    health: {
      read: async () => {
        const tickAt = leads.lastTickAt()
        return healthOf({
          version: settings.version,
          databaseFailure: await ping(sql),
          tickAt: tickAt?.toISOString() ?? null,
          queueMovedAt: null,
          tickFailure: tickProblem({ tickMs: leadSettings.tickMs, now: new Date(), startedAt, tickAt }),
        })
      },
    },
    quality: {
      ship: (input) => shipIssue(shipping, input),
      reopen: (input) => reopenIssue(writes, input),
      show: (issueId) => showQuality({ uow }, issueId),
    },
    checkpoints,
    leads: leads.routes,
    leadsTick: settings.internalTestRoutes ? () => leads.tick() : undefined,
    internalTest: settings.internalTestRoutes
      ? { file: (input) => fileIssue(writes, input), record: (input) => recordIssueEvent(writes, input) }
      : undefined,
  }).listen({ hostname: HOSTNAME, port: settings.port, idleTimeout: IDLE_TIMEOUT_S })
  intake.start()
  console.log(`listening on http://${HOSTNAME}:${settings.port} (version ${settings.version})`)

  let stopping = false
  const stop = async (signal: string) => {
    if (stopping) return
    stopping = true
    console.log(`${signal}: stopping`)
    for (const timer of passTimers) clearInterval(timer)
    stopTick()
    draining.abort()
    await app.stop()
    await watchLoop?.stop()
    await socket.stop()
    await intake.stop()
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
