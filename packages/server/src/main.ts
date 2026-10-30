import { SQL } from 'bun'
import { systemClock } from './clock.ts'
import { loadConfig } from './config.ts'
import { acquireSingleton, migrate } from './db.ts'
import { TickMonitor } from './health.ts'
import { serve } from './http.ts'
import { DEFAULT_START_BUDGET_MS, HerdrRunner } from './runner.ts'
import { DEFAULT_LEASE_MS, startTicker, TICK_INTERVAL_MS } from './tick.ts'

/** Longest a shutdown may take: one in-flight start is bounded by the start budget; the plist ExitTimeOut is longer. */
const SHUTDOWN_BACKSTOP_MS = DEFAULT_START_BUDGET_MS + 30_000

const config = loadConfig(process.env)
const sql = new SQL(config.databaseUrl)

// One process: a second copy finds the lock taken and leaves before it touches anything.
const singleton = await acquireSingleton(sql)
if (!singleton) {
  console.error('another factory server holds the database lock; exiting')
  await sql.close()
  process.exit(1)
}
await migrate(sql)

const clock = systemClock
const runner = new HerdrRunner({
  bin: config.herdrBin,
  clock,
  pretrustBin: config.pretrustBin,
  accountsFile: config.accountsFile,
})
// A pass that runs a start may outlast several intervals; one past its lease is wedged.
const monitor = new TickMonitor(clock, TICK_INTERVAL_MS, DEFAULT_LEASE_MS)
// Bind first: a port that is taken must fail the boot before the ticker claims anything.
const server = serve({ sql, clock, port: config.port, version: config.version, token: config.token, monitor })
const ticker = startTicker({ sql, runner, clock, retryBudgetMs: config.retryBudgetMs }, TICK_INTERVAL_MS, monitor)
console.log(`listening on ${server.url} (version ${config.version})`)

let stopping = false
async function shutdown(signal: string): Promise<void> {
  if (stopping) return
  stopping = true
  console.log(`${signal}: stopping`)
  setTimeout(() => {
    console.error('shutdown took too long, exiting')
    process.exit(1)
  }, SHUTDOWN_BACKSTOP_MS).unref()
  try {
    // Stop taking requests, let the tick in flight record its result, only then release the lock and close the pool.
    await server.stop()
    await ticker.stop()
    await singleton?.release()
    await sql.close()
    process.exit(0)
  } catch (error) {
    console.error('shutdown failed', error)
    process.exit(1)
  }
}

process.on('SIGTERM', () => void shutdown('SIGTERM'))
process.on('SIGINT', () => void shutdown('SIGINT'))
