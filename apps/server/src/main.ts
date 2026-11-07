import { connect, ping } from './adapters/postgres/connection.ts'
import { agwAmend } from './adapters/agw/amend.ts'
import { agwJudge } from './adapters/agw/judge.ts'
import { agwPort } from './adapters/agw/port.ts'
import { agwSettle, agwSteward } from './adapters/agw/steward.ts'
import { fileBlobStore } from './adapters/blobs/filesystem.ts'
import { fileStandingPolicies } from './adapters/checkpoints/policies.ts'
import { makeNotifier } from './adapters/ntfy/ntfy.ts'
import { postgresCheckpointStore } from './adapters/postgres/checkpoint-store.ts'
import { postgresLoopStore } from './adapters/postgres/loop-store.ts'
import { loadMigrations, migrate } from './adapters/postgres/migrate.ts'
import { acquireProcessLock } from './adapters/postgres/process-lock.ts'
import { postgresCapacityStore } from './adapters/postgres/capacity-store.ts'
import { postgresPlanningStore } from './adapters/postgres/planning-store.ts'
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
import { createLoopRunner, type LoopRunner, type LoopSpec } from './app/loops/runner.ts'
import { loadLoopSettings } from './app/loops/settings.ts'
import { stewardPass, stewardSummary } from './app/loops/steward.ts'
import { triagePass, triageSummary } from './app/loops/triage.ts'
import { DEFAULT_STEWARD_RULES } from './domains/loops/stall.ts'
import { postgresIntakeStore } from './adapters/intake/store.ts'
import { loadIntakeEnv } from './adapters/intake/settings.ts'
import { composeIntake } from './compose-intake.ts'
import { composePlanning } from './compose-planning.ts'
import { fileIssue, recordIssueEvent } from './app/issues.ts'
import { leadCheckoutOf } from './app/quality-checkout.ts'
import { showQuality } from './app/quality-read.ts'
import { reopenIssue } from './app/quality-reopen.ts'
import { shipIssue } from './app/quality-ship.ts'
import { checkWatches, DEFAULT_TIMING, startWatchPort } from './app/quality-watch.ts'
import { loadCheckpointSettings } from './checkpoint-settings.ts'
import { composeLeads } from './compose-leads.ts'
import { type Clock, systemClock } from './kernel/clock.ts'
import { err, ok, portError } from './kernel/result.ts'
import { systemIds } from './kernel/ids.ts'
import { healthOf, tickProblem } from './read/health.ts'
import { planningSettings } from './app/planning-settings.ts'
import { queueMovedAt } from './read/queue.ts'
import { loopReads } from './read/loops.ts'
import { readIssues } from './read/planning.ts'
import { loadSettings } from './settings.ts'

/** The API listens on loopback only; the tailnet listener for the Console comes with the Console. */
const HOSTNAME = '127.0.0.1'

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
    planning: postgresPlanningStore(tx),
    capacity: postgresCapacityStore(tx),
    reads: readIssues(tx),
    checkpoints: postgresCheckpointStore(tx),
    leads: postgresLeadStore(tx),
    quality: postgresQualityStore(tx),
    intake: postgresIntakeStore(tx),
    loops: postgresLoopStore(tx),
    loopReads: loopReads(tx),
  }))
  // The scenarios move this clock to reach a date a real one would take 30 days to; the leads' own keep the system's.
  const clock: Clock =
    settings.clockOffsetMs === 0 ? systemClock : { now: () => new Date(Date.now() + settings.clockOffsetMs) }
  const writes = { uow, clock, ids: systemIds }
  // No call of an earlier process is running: an open call to agw is taken up again under its own key (agw hands back its run).
  const lapsed = await uow.run(async ({ loops }) => ok(await loops.lapseOpen(new Date())))
  if (lapsed.ok && lapsed.value > 0)
    console.log(`loops: ${lapsed.value} agw call(s) of an earlier process will be taken up again`)
  const startedAt = new Date()
  const leadSettings = loadLeadSettings(process.env)
  const loopSettings = loadLoopSettings(process.env)
  // The one way to ask agw for a judgment: the Judge, the steward and triage all go through it.
  const agw = agwPort({ bin: settings.agwBin })
  // Planning and capacity own the projects and the claims; the leads, intake and the checkpoints take their ports.
  const planning = composePlanning({
    writes,
    settings: planningSettings(process.env, { repoRoots: leadSettings.repoRoots }),
  })
  const checkout = leadCheckoutOf(uow)
  const projects = makefileProjects({ windowMs: settings.quality.windowMs })
  const intake = await composeIntake({
    sql,
    uow,
    env: loadIntakeEnv(process.env),
    clock: systemClock,
    ids: systemIds,
    projects: planning.signals,
    triage: agwAmend(agw),
  })
  // One outbox runs every effect: the leads' tick, with quality's port for the Watch.
  const leads = composeLeads({
    sql,
    uow,
    clock: systemClock,
    ids: systemIds,
    settings: leadSettings,
    capacity: planning.leads,
    startWatch: startWatchPort({ uow, clock, projects, checkout }),
  })
  // The hook socket comes after the lock and the migrations: a second copy never reaches it.
  const socket = await leads.listen()

  const shipping = {
    ...writes,
    commits: new GitCommits(),
    review: new AgwReview({ bin: settings.agwBin }),
    checkout,
  }
  const draining = new AbortController()

  const checkpointSettings = loadCheckpointSettings(process.env)
  const checkpoints = checkpointUses({
    ...writes,
    blobs: fileBlobStore(checkpointSettings.blobDir),
    consoleUrl: checkpointSettings.line.consoleUrl,
    notifier: makeNotifier(checkpointSettings.line),
    // The Judge asks `factory-ask` through the agw port. The standing policy is each project's `policy:` in its
    // `project.yaml`; a JSON file named by the environment overrides it, as an explicit stand-in.
    judge: agwJudge(agw),
    policies: checkpointSettings.policyFile ? fileStandingPolicies(checkpointSettings.policyFile) : planning.policies,
  })
  // The loops: every recurring job of the server is one named loop on the runner, each with its interval
  // (`FACTORY_TICK_MS` the default), its trigger and its single-flight pass. Intake's pollers keep their own schedules.
  const watchSettledAt = new Date(startedAt.getTime() + settings.quality.settleMs)
  const stewardDeps = {
    ...writes,
    uow,
    workflow: agwSteward(agw),
    seats: planning.leads.seats,
    windows: planning.leads.windows,
    checkpoints: {
      ...writes,
      blobs: fileBlobStore(checkpointSettings.blobDir),
      consoleUrl: checkpointSettings.line.consoleUrl,
    },
    planning: writes,
    rules: { ...DEFAULT_STEWARD_RULES, minStallMs: loopSettings.minStallMs },
    retryMs: loopSettings.retryMs,
    settleTimeoutMs: loopSettings.settleTimeoutMs,
    blockedChecks: loopSettings.blockedChecks,
  }
  const lines = new Map<string, string>()
  /** A problem that stands is said once, not on every pass. */
  const said = (loop: string, problems: readonly string[]) => {
    const text = problems.join('\n')
    if (text !== (lines.get(loop) ?? '') && text) console.error(`${loop} loop: ${text}`)
    lines.set(loop, text)
  }
  const passOf = async (run: () => Promise<{ ok: boolean; error?: unknown }>, what: string) => {
    const result = await run()
    return result.ok ? ok(`${what} ran`) : err(portError('refused', JSON.stringify(result.error)))
  }
  const specs: LoopSpec[] = [
    {
      name: 'leads',
      intervalMs: loopSettings.intervalMs.leads,
      onChange: true,
      // A worktree made or removed takes minutes and must not hold the next pass back.
      maxPasses: 4,
      run: async () => {
        const ticked = await leads.tick()
        if (!ticked.ok) return ticked
        const t = ticked.value
        return ok(`spool ${t.replayed} lines, ${t.lost} lead(s) lost, outbox ${JSON.stringify(t.outbox)}`)
      },
    },
    {
      name: 'planning',
      intervalMs: loopSettings.intervalMs.planning,
      onChange: true,
      run: async () => {
        const problems = await planning.pass()
        said('planning', problems)
        return ok(
          problems.length
            ? `${problems.length} problem(s): ${problems.slice(0, 3).join(' | ')}`
            : 'planned and admitted',
        )
      },
    },
    {
      // The Watch's checks run on a loop of their own, so a `make verify` of minutes never holds the leads' tick.
      name: 'watch',
      intervalMs: loopSettings.intervalMs.watch,
      onChange: false,
      run: async () => {
        const watched = await checkWatches({
          ...writes,
          projects,
          checkout,
          proof: new MakeAndProbes(),
          timing: { ...DEFAULT_TIMING, retryMs: settings.quality.retryMs },
          settledAt: watchSettledAt,
          signal: draining.signal,
        })
        return watched.ok
          ? ok(`checked ${watched.value.checked}, passed ${watched.value.passed}, regressed ${watched.value.regressed}`)
          : watched
      },
    },
    {
      name: 'settle',
      intervalMs: loopSettings.intervalMs.settle,
      onChange: true,
      run: () => passOf(() => checkpoints.settle(), 'the settle pass'),
    },
    {
      name: 'send',
      intervalMs: loopSettings.intervalMs.send,
      onChange: true,
      run: () => passOf(() => checkpoints.send(), 'the send pass'),
    },
    {
      name: 'steward',
      intervalMs: loopSettings.intervalMs.steward,
      onChange: true,
      run: async () => {
        const pass = await stewardPass({ ...stewardDeps, changed: () => runner.changed('steward') })
        if (!pass.ok) return pass
        said('steward', pass.value.problems)
        return ok(stewardSummary(pass.value))
      },
    },
    {
      name: 'triage',
      intervalMs: loopSettings.intervalMs.triage,
      onChange: true,
      run: async () => {
        const pass = await triagePass({
          ...writes,
          uow,
          workflow: agwSettle(agw),
          planning: writes,
          retryMs: loopSettings.retryMs,
          changed: () => runner.changed('triage'),
        })
        if (!pass.ok) return pass
        said('triage', pass.value.problems)
        return ok(triageSummary(pass.value))
      },
    },
  ]
  const runner: LoopRunner = createLoopRunner({ loops: specs, clock: systemClock })
  const leadsTick = loopSettings.intervalMs.leads

  const app = createApp({
    intake: intake.api,
    health: {
      read: async () => {
        const tickAt = runner.lastOkAt('leads')
        return healthOf({
          version: settings.version,
          databaseFailure: await ping(sql),
          tickAt: tickAt?.toISOString() ?? null,
          queueMovedAt: (await queueMovedAt(sql))?.toISOString() ?? null,
          tickFailure: tickProblem({ tickMs: leadsTick, now: new Date(), startedAt, tickAt }),
        })
      },
    },
    planning: planning.planning,
    capacity: planning.capacity,
    quality: {
      ship: (input) => shipIssue(shipping, input),
      reopen: (input) => reopenIssue(writes, input),
      show: (issueId) => showQuality({ uow }, issueId),
    },
    checkpoints,
    leads: leads.routes,
    loops: runner,
    leadsTick: settings.internalTestRoutes ? () => leads.tick() : undefined,
    internalTest: settings.internalTestRoutes
      ? { file: (input) => fileIssue(writes, input), record: (input) => recordIssueEvent(writes, input) }
      : undefined,
  }).listen({ hostname: HOSTNAME, port: settings.port, idleTimeout: IDLE_TIMEOUT_S })
  intake.start()
  runner.start()
  console.log(`listening on http://${HOSTNAME}:${settings.port} (version ${settings.version})`)

  let stopping = false
  const stop = async (signal: string) => {
    if (stopping) return
    stopping = true
    console.log(`${signal}: stopping`)
    draining.abort()
    await app.stop()
    // A pass in an agw call is given a few seconds; its call is taken up again at the next boot under the same key.
    await runner.stop(10_000)
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
