import { chmodSync, mkdirSync, rmSync } from 'node:fs'
import { dirname } from 'node:path'
import { SQL } from 'bun'
import { systemClock } from './clock.ts'
import { loadConfig } from './config.ts'
import { acquireSingleton, migrate } from './db.ts'
import { TickMonitor } from './health.ts'
import { serve, serveHooks } from './http.ts'
import { DEFAULT_START_BUDGET_MS, HerdrRunner } from './runner.ts'
import { SpoolReplayer } from './spool.ts'
import { DEFAULT_LEASE_MS, startTicker, TICK_INTERVAL_MS } from './tick.ts'
import { gitProbe, HerdrCli, startWitness } from './witness.ts'

/** Longest a shutdown may take: one in-flight start is bounded by the start budget; the plist ExitTimeOut is longer. */
const SHUTDOWN_BACKSTOP_MS = DEFAULT_START_BUDGET_MS + 30_000

const config = loadConfig(process.env)

// The runner depends on two files of the dotfiles checkout: a server that cannot start anything must not call itself up.
for (const file of [config.pretrustBin, config.accountsFile]) {
  if (!(await Bun.file(file).exists())) {
    console.error(`${file} does not exist; exiting`)
    process.exit(1)
  }
}

// The factory role may hold 10 connections: the pool (one of them kept for the one-process lock) leaves room for a psql.
const sql = new SQL({ url: config.databaseUrl, max: 8 })

// One process: a second copy finds the lock taken and leaves before it touches anything.
const singleton = await acquireSingleton(sql, {
  onLost: (reason) => {
    // launchd restarts the process, which takes the lock again (or finds another copy holding it).
    console.error(`lost the database lock: ${reason}; exiting`)
    process.exit(1)
  },
})
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
const server = serve({
  sql,
  clock,
  port: config.port,
  version: config.version,
  token: config.token,
  monitor,
  repoRoots: config.repoRoots,
})

// The hooks' socket: the owner's directory (mode 0700) and the socket (0600) are the credential. A stale file from a
// crashed run is ours to remove: the database lock above is held, so no other copy is listening on it.
mkdirSync(dirname(config.hookSocket), { recursive: true, mode: 0o700 })
rmSync(config.hookSocket, { force: true })
// Bound under a restrictive umask, so the socket is never there with wider permissions, not even for a moment.
const umask = process.umask(0o177)
let hooks: ReturnType<typeof serveHooks>
try {
  hooks = serveHooks({ sql, clock, token: config.token, socketPath: config.hookSocket })
} finally {
  process.umask(umask)
}
chmodSync(config.hookSocket, 0o600)

const spool = new SpoolReplayer({ sql, dir: config.spoolDir, now: () => clock.now() })
const ticker = startTicker(
  { sql, runner, clock, retryBudgetMs: config.retryBudgetMs, spool },
  TICK_INTERVAL_MS,
  monitor,
)
const witnessLoop = startWitness({ sql, herdr: new HerdrCli({ bin: config.herdrBin }), clock, probe: gitProbe })
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
    await hooks.stop()
    await ticker.stop()
    await witnessLoop.stop()
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
