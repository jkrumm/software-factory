import { connect, ping } from './adapters/postgres/connection.ts'
import { loadMigrations, migrate } from './adapters/postgres/migrate.ts'
import { acquireProcessLock } from './adapters/postgres/process-lock.ts'
import { postgresCapacityStore } from './adapters/postgres/capacity-store.ts'
import { postgresPlanningStore } from './adapters/postgres/planning-store.ts'
import { postgresUnitOfWork } from './adapters/postgres/unit-of-work.ts'
import { postgresWorkStore } from './adapters/postgres/work-store.ts'
import { claudeAccountSource } from './adapters/planning/claude-accounts.ts'
import { gitProjectSource } from './adapters/planning/git-projects.ts'
import { hostReader } from './adapters/planning/host.ts'
import { createApp } from './api/app.ts'
import { admissionPass, queueView } from './app/capacity-admit.ts'
import { capacityState, refreshState } from './app/capacity-view.ts'
import { getQueueStates, setQueueState } from './app/capacity-queue.ts'
import { giveSlotBack, touchSlot } from './app/capacity-slots.ts'
import { fileIssue, recordIssueEvent } from './app/issues.ts'
import { addAfter, settleIssue, setPrio } from './app/planning-chain.ts'
import { planningPass } from './app/planning-pass.ts'
import { planningSettings } from './app/planning-settings.ts'
import { syncProjects } from './app/planning-sync.ts'
import { projectStates } from './app/planning-views.ts'
import { systemClock } from './kernel/clock.ts'
import { systemIds } from './kernel/ids.ts'
import { key } from './kernel/keys.ts'
import { readIssues } from './read/planning.ts'
import { healthOf } from './read/health.ts'
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
  }))
  const writes = { uow, clock: systemClock, ids: systemIds }

  // Planning and capacity (package 3): the ports are real adapters on this host.
  const planned = planningSettings(process.env)
  const sync = {
    ...writes,
    source: gitProjectSource({ roots: planned.repoRoots, timeoutMs: planned.gitTimeoutMs }),
  }
  const limits = {
    leadsPerAccount: planned.leadsPerAccount,
    loadCeiling: planned.loadCeiling,
    memoryCeilings: planned.memoryCeilings,
  }
  const capacity = {
    ...writes,
    limits,
    host: hostReader({ sysctlBin: planned.sysctlBin, minSampleMs: planned.memorySampleMs }),
    accounts: claudeAccountSource({ bin: planned.claudeAccountBin }),
  }

  const app = createApp({
    health: {
      read: async () =>
        healthOf({ version: settings.version, databaseFailure: await ping(sql), tickAt: null, queueMovedAt: null }),
    },
    planning: {
      projects: () => projectStates(writes),
      sync: (input) => syncProjects(sync, input),
      pass: (input) => planningPass(sync, input),
      settle: (input) => settleIssue(writes, input),
      after: (input) => addAfter(writes, input),
      prio: (input) =>
        setPrio(writes, {
          issue: input.issue,
          value: input.value,
          key: key('prio', input.key ?? systemIds.next('prio')),
        }),
    },
    capacity: {
      limits: { ...limits, slots: planned.slots },
      state: () => capacityState(capacity),
      refresh: () => refreshState(capacity),
      admit: () => admissionPass(capacity),
      queue: () => queueView(capacity),
      queueStates: () => getQueueStates(writes),
      setQueueState: (input) => setQueueState(writes, input),
      touchSlot: (input) => touchSlot({ ...writes, slots: planned.slots }, input),
      giveSlotBack: (id) => giveSlotBack(writes, id),
    },
    internalTest: settings.internalTestRoutes
      ? { file: (input) => fileIssue(writes, input), record: (input) => recordIssueEvent(writes, input) }
      : undefined,
  }).listen({ hostname: HOSTNAME, port: settings.port })
  console.log(`listening on http://${HOSTNAME}:${settings.port} (version ${settings.version})`)

  let stopping = false
  const stop = async (signal: string) => {
    if (stopping) return
    stopping = true
    console.log(`${signal}: stopping`)
    await app.stop()
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
