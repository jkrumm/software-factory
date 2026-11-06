import { chmodSync, mkdirSync, rmSync } from 'node:fs'
import { dirname } from 'node:path'
import { loadRoleTable } from '@software-factory/contract'
import { SQL } from 'bun'
import { systemClock } from './clock.ts'
import { loadConfig } from './config.ts'
import { Digest } from './fleet/digest.ts'
import { Places } from './fleet/place.ts'
import { AskHumanQueue, FleetBuilder, HcTerminals } from './fleet/index.ts'
import { acquireSingleton, migrate } from './db.ts'
import { TickMonitor } from './health.ts'
import { serve, serveHooks } from './http.ts'
import { FileTranscripts } from './issues/archive.ts'
import { AgwClassifier, Classification } from './issues/classify.ts'
import { AgwReview } from './issues/review.ts'
import { finalizePorts } from './issues/finalize.ts'
import { holdPorts, MakeAndProbes, VERIFY_SETTLE_MS } from './issues/hold.ts'
import { AgwAskJudge, AskJudgement } from './issues/judge.ts'
import { leadPorts } from './issues/lead.ts'
import { WorktreeMaker } from './issues/leadtree.ts'
import { OffTick } from './issues/offtick.ts'
import { GitWorktrees } from './issues/worktree.ts'
import { makeNotifier } from './notify/index.ts'
import { ProjectSync } from './projects/sync.ts'
import { ClaudeAccountSource, QuotaPoller } from './quota.ts'
import { HcClient } from './hc.ts'
import { HcEvents } from './hc-events.ts'
import { HcRunner } from './hc-runner.ts'
import { claudeProjectsDir, DEFAULT_START_BUDGET_MS } from './runner.ts'
import { Spaces } from './spaces.ts'
import { SpoolReplayer } from './spool.ts'
import { DEFAULT_LEASE_MS, startTicker, TICK_INTERVAL_MS } from './tick.ts'
import { gitProbe, startWitness } from './witness.ts'

/** Longest a shutdown may take: one in-flight start is bounded by the start budget; the plist ExitTimeOut is longer. */
const SHUTDOWN_BACKSTOP_MS = DEFAULT_START_BUDGET_MS + 30_000

const config = loadConfig(process.env)

// The runner and the quota source depend on files of the dotfiles checkout, and every spawn on the role table: a
// server that cannot start anything must not call itself up.
for (const file of [config.pretrustBin, config.accountsFile, config.claudeAccountBin]) {
  if (!(await Bun.file(file).exists())) {
    console.error(`${file} does not exist; exiting`)
    process.exit(1)
  }
}

const roles = await loadRoleTable(config.rolesFile).catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
})

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
const notifier = makeNotifier(config)
const quota = new QuotaPoller({ sql, clock, source: new ClaudeAccountSource({ bin: config.claudeAccountBin }) })
const projects = new ProjectSync({ sql, roots: config.repoRoots, now: () => clock.now(), fetch: true })
const hcClient = new HcClient({ bin: config.hcBin, session: config.hcSession })
const askHuman = new AskHumanQueue(config.askHumanBin)
const hcTerminals = new HcTerminals(hcClient)
const fleet = new FleetBuilder({
  sql,
  now: () => clock.now(),
  roots: config.repoRoots,
  visibleRoots: config.visibleRoots,
  home: process.env.HOME ?? '',
  hc: hcTerminals,
  queue: askHuman,
  digest:
    config.fleetDigestEveryMs === null
      ? undefined
      : new Digest({ sql, now: () => clock.now(), bin: config.agwBin, everyMs: config.fleetDigestEveryMs }),
  alertLeads: config.alertLeads,
})
// IuRoot's items are only ever counted in the morning message: the same places the digest's scope uses.
const visible = async (): Promise<(path: string) => boolean> => {
  const places = await Places.of({
    visibleRoots: config.visibleRoots,
    configured: config.repoRoots,
    home: process.env.HOME ?? '',
  })
  return (path) => places.isVisible(path)
}
const runner = new HcRunner({
  bin: config.hcBin,
  session: config.hcSession,
  clock,
  pretrustBin: config.pretrustBin,
  accountsFile: config.accountsFile,
})
const spaces = new Spaces({ file: config.spacesFile, roots: config.repoRoots, runner, now: () => clock.now() })
// A pass that runs a start may outlast several intervals; one past its lease is wedged.
// Review v4's router and coverage, asked by `ship`: agw owns both judgments, the factory only reads them.
const review = new AgwReview({ bin: config.agwBin })
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
  roles,
  quota,
  projects,
  alertLeads: config.alertLeads,
  admission: config.admission,
  notifier,
  notifyTarget: config.notifyTarget,
  review,
  fleet,
  read: { isVisible: await visible() },
})

// The hooks' socket: the owner's directory (mode 0700) and the socket (0600) are the credential. A stale file from a
// crashed run is ours to remove: the database lock above is held, so no other copy is listening on it.
mkdirSync(dirname(config.hookSocket), { recursive: true, mode: 0o700 })
rmSync(config.hookSocket, { force: true })
// Bound under a restrictive umask, so the socket is never there with wider permissions, not even for a moment.
const umask = process.umask(0o177)
let hooks: ReturnType<typeof serveHooks>
try {
  hooks = serveHooks({
    sql,
    clock,
    token: config.token,
    socketPath: config.hookSocket,
    repoRoots: config.repoRoots,
    roles,
    slots: config.slots,
    review,
    admission: config.admission,
  })
} finally {
  process.umask(umask)
}
chmodSync(config.hookSocket, 0o600)

const spool = new SpoolReplayer({ sql, dir: config.spoolDir, now: () => clock.now() })
const worktrees = new GitWorktrees()
const leadWorktrees = new WorktreeMaker({
  sql,
  worktrees,
  now: () => clock.now(),
  retryBudgetMs: config.retryBudgetMs,
})
const offTick = new OffTick({ now: () => clock.now().getTime() })
const proof = new MakeAndProbes()
const issuePorts = {
  ...leadPorts({ sql, clock, roles, repoRoots: config.repoRoots }),
  ...holdPorts({
    sql,
    clock,
    proof,
    offTick,
    settledAt: new Date(clock.now().getTime() + VERIFY_SETTLE_MS),
  }),
  ...finalizePorts({
    sql,
    clock,
    runner,
    worktrees,
    transcripts: new FileTranscripts(),
    archiveDir: config.archiveDir,
    projectsDir: (account) => claudeProjectsDir({ accountsFile: config.accountsFile }, account),
    making: (issueId) => leadWorktrees.busy(issueId),
    offTick,
  }),
}
const classification = new Classification({
  sql,
  classifier: new AgwClassifier({ bin: config.agwBin }),
  roles,
  now: () => clock.now(),
})
// `FACTORY_ASK_JUDGE=off`: no judge, so every ask and spent escalation goes to the owner at once, as before.
const judgement = new AskJudgement({
  sql,
  now: () => clock.now(),
  judge: config.askJudge ? new AgwAskJudge({ bin: config.agwBin }) : undefined,
  visible,
})
const ticker = startTicker(
  {
    sql,
    runner,
    clock,
    retryBudgetMs: config.retryBudgetMs,
    spool,
    quota,
    projects,
    issuePorts,
    steward: { verify: { proof, offTick } },
    classification,
    judgement,
    leadWorktrees,
    fleet,
    admission: config.admission,
    spaces,
    alertLeads: config.alertLeads,
    notify: { notifier, target: config.notifyTarget, digestAt: config.digestAt, digestTz: config.digestTz, visible },
  },
  TICK_INTERVAL_MS,
  monitor,
)
const events = new HcEvents({ client: hcClient })
events.start()
const witnessLoop = startWitness({ sql, runner: events, clock, probe: gitProbe })
console.log(`listening on ${server.url.href} (version ${config.version})`)

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
    await fleet.settled()
    await spaces.settled()
    await leadWorktrees.stop(15_000)
    await offTick.stop(15_000)
    await witnessLoop.stop()
    await events.stop()
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
