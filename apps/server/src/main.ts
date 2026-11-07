import { connect, ping } from './adapters/postgres/connection.ts'
import { agwJudge } from './adapters/agw-ask/judge.ts'
import { fileBlobStore } from './adapters/blobs/filesystem.ts'
import { fileStandingPolicies, stubStandingPolicies } from './adapters/checkpoints/policies.ts'
import { makeNotifier } from './adapters/ntfy/ntfy.ts'
import { postgresCheckpointStore } from './adapters/postgres/checkpoint-store.ts'
import { loadMigrations, migrate } from './adapters/postgres/migrate.ts'
import { acquireProcessLock } from './adapters/postgres/process-lock.ts'
import { postgresUnitOfWork } from './adapters/postgres/unit-of-work.ts'
import { postgresWorkStore } from './adapters/postgres/work-store.ts'
import { createApp } from './api/app.ts'
import { checkpointUses } from './app/checkpoints-uses.ts'
import { fileIssue, recordIssueEvent } from './app/issues.ts'
import { loadCheckpointSettings } from './checkpoint-settings.ts'
import { systemClock } from './kernel/clock.ts'
import { systemIds } from './kernel/ids.ts'
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
    checkpoints: postgresCheckpointStore(tx),
  }))
  const writes = { uow, clock: systemClock, ids: systemIds }

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
  let passing = false
  const pass = async () => {
    if (passing) return
    passing = true
    try {
      const result = await checkpoints.pass()
      if (!result.ok) console.error(`checkpoints: the pass failed: ${JSON.stringify(result.error)}`)
    } finally {
      passing = false
    }
  }
  const passTimer =
    checkpointSettings.passMs > 0 ? setInterval(() => void pass(), checkpointSettings.passMs) : undefined

  const app = createApp({
    health: {
      read: async () =>
        healthOf({ version: settings.version, databaseFailure: await ping(sql), tickAt: null, queueMovedAt: null }),
    },
    checkpoints,
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
    clearInterval(passTimer)
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
