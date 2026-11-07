import { connect, ping } from './adapters/postgres/connection.ts'
import { loadMigrations, migrate } from './adapters/postgres/migrate.ts'
import { acquireProcessLock } from './adapters/postgres/process-lock.ts'
import { createApp } from './api/app.ts'
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

  const app = createApp({
    health: {
      read: async () =>
        healthOf({ version: settings.version, databaseFailure: await ping(sql), tickAt: null, queueMovedAt: null }),
    },
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
