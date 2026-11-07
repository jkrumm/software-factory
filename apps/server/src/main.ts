import { connect, ping } from './adapters/postgres/connection.ts'
import { agwJudge } from './adapters/agw-ask/judge.ts'
import { fileBlobStore } from './adapters/blobs/filesystem.ts'
import { fileStandingPolicies } from './adapters/checkpoints/policies.ts'
import { makeNotifier } from './adapters/ntfy/ntfy.ts'
import { postgresCheckpointStore } from './adapters/postgres/checkpoint-store.ts'
import { loadMigrations, migrate } from './adapters/postgres/migrate.ts'
import { acquireProcessLock } from './adapters/postgres/process-lock.ts'
import { postgresCapacityStore } from './adapters/postgres/capacity-store.ts'
import { postgresPlanningStore } from './adapters/postgres/planning-store.ts'
import { postgresLeadStore } from './adapters/leads/store.ts'
import { loadLeadSettings } from './adapters/leads/settings.ts'
import { postgresUnitOfWork } from './adapters/postgres/unit-of-work.ts'
import { postgresWorkStore } from './adapters/postgres/work-store.ts'
import { createApp } from './api/app.ts'
import { checkpointUses } from './app/checkpoints-uses.ts'
import { postgresIntakeStore } from './adapters/intake/store.ts'
import { loadIntakeEnv } from './adapters/intake/settings.ts'
import { composeIntake } from './compose-intake.ts'
import { composePlanning } from './compose-planning.ts'
import { fileIssue, recordIssueEvent } from './app/issues.ts'
import { loadCheckpointSettings } from './checkpoint-settings.ts'
import { systemClock } from './kernel/clock.ts'
import { systemIds } from './kernel/ids.ts'
import { composeLeads } from './compose-leads.ts'
import { healthOf, tickProblem } from './read/health.ts'
import { planningSettings } from './app/planning-settings.ts'
import { queueMovedAt } from './read/queue.ts'
import { readIssues } from './read/planning.ts'
import { loadSettings } from './settings.ts'

/** The API listens on loopback only; the tailnet listener for the Console comes with the Console. */
const HOSTNAME = '127.0.0.1'

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
    planning: postgresPlanningStore(tx),
    capacity: postgresCapacityStore(tx),
    reads: readIssues(tx),
    checkpoints: postgresCheckpointStore(tx),
    leads: postgresLeadStore(tx),
    intake: postgresIntakeStore(tx),
  }))
  const writes = { uow, clock: systemClock, ids: systemIds }
  const startedAt = new Date()
  const leadSettings = loadLeadSettings(process.env)
  // Planning and capacity own the projects and the claims; the leads, intake and the checkpoints take their ports.
  const planning = composePlanning({
    writes,
    settings: planningSettings(process.env, { repoRoots: leadSettings.repoRoots }),
  })
  const leads = composeLeads({
    sql,
    uow,
    clock: systemClock,
    ids: systemIds,
    settings: leadSettings,
    capacity: planning.leads,
  })
  const intake = await composeIntake({
    sql,
    uow,
    env: loadIntakeEnv(process.env),
    clock: systemClock,
    ids: systemIds,
    projects: planning.signals,
  })
  // The hook socket comes after the lock and the migrations: a second copy never reaches it.
  const socket = await leads.listen()
  const stopTick = leads.startLoop()
  // The planning and admission passes run on the leads' tick: one setting, one meaning.
  const stopPlanning = planning.startLoop(leadSettings.tickMs)

  const checkpointSettings = loadCheckpointSettings(process.env)
  const checkpoints = checkpointUses({
    ...writes,
    blobs: fileBlobStore(checkpointSettings.blobDir),
    consoleUrl: checkpointSettings.line.consoleUrl,
    notifier: makeNotifier(checkpointSettings.line),
    // The Judge's call is a thin one until package 7 brings the agw port. The standing policy is each project's `policy:`
    // in its `project.yaml`; a JSON file named by the environment overrides it, as an explicit stand-in.
    judge: agwJudge({ bin: checkpointSettings.agwBin }),
    policies: checkpointSettings.policyFile ? fileStandingPolicies(checkpointSettings.policyFile) : planning.policies,
  })
  // Settling and sending run on timers of their own, one pass of each at a time: a Judge call is an agent run that can take
  // minutes, and the owner's line must not wait for it. Package 7's tick takes both over; the leases make two callers safe.
  const every = (name: string, run: () => Promise<{ ok: boolean; error?: unknown }>) => {
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
      ? [every('settle', () => checkpoints.settle()), every('send', () => checkpoints.send())]
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
          queueMovedAt: (await queueMovedAt(sql))?.toISOString() ?? null,
          tickFailure: tickProblem({ tickMs: leadSettings.tickMs, now: new Date(), startedAt, tickAt }),
        })
      },
    },
    planning: planning.planning,
    capacity: planning.capacity,
    checkpoints,
    leads: leads.routes,
    leadsTick: settings.internalTestRoutes ? () => leads.tick() : undefined,
    internalTest: settings.internalTestRoutes
      ? { file: (input) => fileIssue(writes, input), record: (input) => recordIssueEvent(writes, input) }
      : undefined,
  }).listen({ hostname: HOSTNAME, port: settings.port })
  intake.start()
  console.log(`listening on http://${HOSTNAME}:${settings.port} (version ${settings.version})`)

  let stopping = false
  const stop = async (signal: string) => {
    if (stopping) return
    stopping = true
    console.log(`${signal}: stopping`)
    for (const timer of passTimers) clearInterval(timer)
    stopTick()
    stopPlanning()
    await app.stop()
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
