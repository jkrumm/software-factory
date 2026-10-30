import { SQL } from 'bun'
import { systemClock } from './clock.ts'
import { loadConfig } from './config.ts'
import { migrate } from './db.ts'
import { serve } from './http.ts'
import { HerdrRunner } from './runner.ts'
import { startTicker } from './tick.ts'

/** Longest a shutdown may take: one in-flight start is bounded by `worstCaseMs` (about 75 s); the plist ExitTimeOut is longer. */
const SHUTDOWN_BACKSTOP_MS = 90_000

const config = loadConfig(process.env)
const sql = new SQL(config.databaseUrl)
await migrate(sql)

const clock = systemClock
const runner = new HerdrRunner({ bin: config.herdrBin, clock })
// Bind first: a port that is taken must fail the boot before the ticker claims anything.
const server = serve({ sql, clock, port: config.port, version: config.version })
const ticker = startTicker({ sql, runner, clock })
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
    // Stop taking requests, let the tick in flight record its result, only then close the pool.
    await server.stop()
    await ticker.stop()
    await sql.close()
    process.exit(0)
  } catch (error) {
    console.error('shutdown failed', error)
    process.exit(1)
  }
}

process.on('SIGTERM', () => void shutdown('SIGTERM'))
process.on('SIGINT', () => void shutdown('SIGINT'))
