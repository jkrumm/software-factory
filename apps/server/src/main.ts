import { connect, ping } from './adapters/postgres/connection.ts'
import { agwAmend } from './adapters/agw/amend.ts'
import { agwJudge } from './adapters/agw/judge.ts'
import { agwPort } from './adapters/agw/port.ts'
import { agwHygiene } from './adapters/agw/hygiene.ts'
import { agwQueue } from './adapters/agw/queue.ts'
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
import { apiForward, consoleHandler } from './api/console.ts'
import { loadConsoleSettings } from './console-settings.ts'
import { join } from 'node:path'
import { checkpointUses } from './app/checkpoints-uses.ts'
import { createLoopRunner, type LoopRunner, type LoopSpec } from './app/loops/runner.ts'
import { projectFileProjects } from './app/quality-projects.ts'
import { loadLoopSettings } from './app/loops/settings.ts'
import { frictionPass, frictionSummary } from './app/loops/friction.ts'
import { hygienePass, hygieneSummary } from './app/loops/hygiene.ts'
import { stewardPass, stewardSummary } from './app/loops/steward.ts'
import { queuePass, queueSummary } from './app/loops/queue.ts'
import { triagePass, triageSummary } from './app/loops/triage.ts'
import { FRICTION_WINDOW_DAYS } from './domains/loops/friction.ts'
import { DEFAULT_STEWARD_RULES } from './domains/loops/stall.ts'
import { composeRead } from './compose-read.ts'
import { postgresIntakeStore } from './adapters/intake/store.ts'
import { loadIntakeEnv } from './adapters/intake/settings.ts'
import { composeIssues } from './compose-issues.ts'
import { rootedRepos } from './adapters/git/repos.ts'
import { createHygieneChecker } from './adapters/hygiene/index.ts'
import { composeIntake } from './compose-intake.ts'
import { composePlanning } from './compose-planning.ts'
import { leadCheckoutOf } from './app/quality-checkout.ts'
import { showQuality } from './app/quality-read.ts'
import { reopenIssue } from './app/quality-reopen.ts'
import { shipIssue } from './app/quality-ship.ts'
import { checkWatches, DEFAULT_TIMING, startWatchPort } from './app/quality-watch.ts'
import { factoryDataDir, loadCheckpointSettings } from './checkpoint-settings.ts'
import { composeLeads } from './compose-leads.ts'
import { type Clock, systemClock } from './kernel/clock.ts'
import { err, ok, portError } from './kernel/result.ts'
import { systemIds } from './kernel/ids.ts'
import { healthOf, tickProblem } from './read/health.ts'
import { planningSettings } from './app/planning-settings.ts'
import { queueMovedAt } from './read/queue.ts'
import { queueReasonMap } from './api/read-models.ts'
import { readFriction } from './read/friction.ts'
import { readFrictionEvidence } from './read/friction-evidence.ts'
import { loopReads } from './read/loops.ts'
import { readIssues } from './read/planning.ts'
import { loadSettings } from './settings.ts'
import { createShutdown } from './shutdown.ts'

/** The API and the Console's listener both bind loopback only; `tailscale serve` publishes the Console's. */
const HOSTNAME = '127.0.0.1'

/** A ship call waits for git and agw (up to REVIEW_TIMEOUT_MS) inside one request; Bun's own idle limit is 10 s, and 255 s is its maximum. */
const IDLE_TIMEOUT_S = 255

/** A door source refused within this long is a health line; an older refusal has passed. */
const DOOR_LINES_RECENT_MS = 24 * 3_600_000

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
  // A test moves this clock to reach a date a real one would take 30 days to (settings refuse it outside test mode).
  const clock: Clock =
    settings.clockOffsetMs === 0 ? systemClock : { now: () => new Date(Date.now() + settings.clockOffsetMs) }
  if (settings.clockOffsetMs !== 0)
    console.warn(`TEST CLOCK: the write clock runs ${settings.clockOffsetMs} ms from real time (FACTORY_TEST_MODE=1)`)
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
  const repos = rootedRepos(leadSettings.repoRoots)
  const hygieneChecker = createHygieneChecker({ repos, workDir: factoryDataDir(process.env) })
  const projects = projectFileProjects({
    uow,
    fallback: makefileProjects({ windowMs: settings.quality.windowMs }),
  })
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
    {
      // Deterministic first (cycles, real blockers, the queue's shape, a budget); `factory-queue` only for an unclear order.
      name: 'queue',
      intervalMs: loopSettings.intervalMs.queue,
      onChange: true,
      run: async () => {
        const pass = await queuePass({
          uow,
          clock: writes.clock,
          workflow: agwQueue(agw),
          planning: writes,
          retryMs: loopSettings.retryMs,
          minGapMs: loopSettings.queueGapMs,
          changed: () => runner.changed('queue'),
        })
        if (!pass.ok) return pass
        said('queue', pass.value.problems)
        return ok(queueSummary(pass.value))
      },
    },
    {
      // Deterministic: the week's counts, one signal per pattern over its threshold. Due once a week, read from the table.
      name: 'friction',
      intervalMs: loopSettings.intervalMs.friction,
      onChange: false,
      run: async () => {
        const pass = await frictionPass({
          uow,
          clock: writes.clock,
          ids: systemIds,
          friction: (now) => readFriction(sql, { now, days: FRICTION_WINDOW_DAYS }),
          evidence: (now, keys) => readFrictionEvidence(sql, { now, days: FRICTION_WINDOW_DAYS }, keys),
          file: (body) => intake.api.file(body, 'agent'),
        })
        if (!pass.ok) return pass
        if (pass.value.due)
          said(
            'friction',
            pass.value.record.failed.map((f) => `${f.key}: ${f.reason}`),
          )
        return ok(frictionSummary(pass.value))
      },
    },
    {
      // Deterministic sweep of one project a tick (probes in a throwaway checkout), `factory-hygiene` over the documents it picks.
      name: 'hygiene',
      intervalMs: loopSettings.intervalMs.hygiene,
      onChange: false,
      run: async () => {
        const pass = await hygienePass({
          uow,
          clock: writes.clock,
          ids: systemIds,
          checker: hygieneChecker,
          workflow: agwHygiene(agw),
          file: (body) => intake.api.file(body, 'agent'),
          everyMs: loopSettings.hygieneEveryMs,
          retryMs: loopSettings.hygieneRetryMs,
          repos: loopSettings.hygieneRepos,
        })
        if (!pass.ok) return pass
        if (pass.value.due)
          said(
            'hygiene',
            pass.value.record.failed.map((f) => `${f.key}: ${f.reason}`),
          )
        return ok(hygieneSummary(pass.value))
      },
    },
  ]
  const runner: LoopRunner = createLoopRunner({ loops: specs, clock: systemClock })
  const leadsTick = loopSettings.intervalMs.leads

  const queueReasons = async () => {
    const view = await planning.capacity.queue()
    return view.ok ? queueReasonMap(view.value.queue) : null
  }
  const app = createApp({
    tokens: settings.tokens,
    intake: intake.api,
    health: {
      read: async () => {
        const tickAt = runner.lastOkAt('leads')
        const door = await intake
          .doorLines(DOOR_LINES_RECENT_MS)
          .catch((error: unknown) => [`the door's lines could not be read: ${String(error)}`])
        return healthOf({
          lines: door.map((text) => ({ source: 'door', text, since: null })),
          loops: runner.view().map((loop) => ({
            name: loop.name,
            ok: loop.lastError === null,
            lastOkAt: loop.lastOkAt,
            lastError: loop.lastError,
            intervalMs: loop.intervalMs,
          })),
          version: settings.version,
          databaseFailure: await ping(sql),
          tickAt: tickAt?.toISOString() ?? null,
          queueMovedAt: (await queueMovedAt(sql))?.toISOString() ?? null,
          tickFailure: tickProblem({ tickMs: leadsTick, now: new Date(), startedAt, tickAt }),
        })
      },
    },
    planning: planning.planning,
    issues: composeIssues({
      writes,
      filing: { ...writes, locate: (repo) => repos.locate(repo) },
      checkpoints,
    }),
    capacity: planning.capacity,
    quality: {
      ship: (input) => shipIssue(shipping, input),
      reopen: (input) => reopenIssue(writes, input),
      show: (issueId) => showQuality({ uow }, issueId),
    },
    checkpoints,
    leads: leads.routes,
    loops: runner,
    read: composeRead({
      sql,
      clock,
      env: process.env,
      doorLines: () => intake.doorLines(DOOR_LINES_RECENT_MS),
      loops: () => runner.view(),
      blockedStreak: loopSettings.blockedChecks,
      queueReasons,
    }),
    readModels: { sql, queueReasons },
  }).listen({ hostname: HOSTNAME, port: settings.port, idleTimeout: IDLE_TIMEOUT_S })
  console.log(`listening on http://${HOSTNAME}:${settings.port} (version ${settings.version})`)

  // The Console's listener: loopback too, published on the tailnet by the dotfiles-private serve row; the perimeter is the
  // tailnet ACL, there is no per-request identity. Only reads and the owner's five answer verbs (`WRITES` in console.ts) pass,
  // and the owner token is held by this closure alone. It starts whenever the Console is built. It binds before
  // the loops start, so a bad port or a taken one refuses the boot before any pass has run.
  const consoleSettings = loadConsoleSettings(process.env)
  const consoleBuilt = await Bun.file(join(consoleSettings.dir, 'index.html')).exists()
  const consoleServer = consoleBuilt
    ? Bun.serve({
        hostname: HOSTNAME,
        port: consoleSettings.port,
        idleTimeout: IDLE_TIMEOUT_S,
        fetch: consoleHandler({
          dir: consoleSettings.dir,
          forward: apiForward({
            handle: (request) => app.handle(request),
            origin: `http://${HOSTNAME}:${settings.port}`,
            ownerToken: settings.tokens.owner,
          }),
        }),
      })
    : null
  if (consoleServer) console.log(`console listening on http://${HOSTNAME}:${consoleServer.port}`)
  else console.log(`console not started: ${join(consoleSettings.dir, 'index.html')} is not built`)
  intake.start()
  runner.start()

  // Active connections are closed (`stop(true)`): an SSE stream never completes on its own, and without the flag Bun
  // waits for it, so the stop would never return and the process would keep the lock. The deadline ends the process
  // whatever step is stuck; the lock is let go before the pool closes, so a copy waiting for it boots as soon as the work is done.
  const stop = createShutdown({
    deadlineMs: settings.shutdownDeadlineMs,
    steps: [
      { name: 'draining', run: async () => draining.abort() },
      { name: 'console.stop', run: async () => void (await consoleServer?.stop(true)) },
      { name: 'server.stop', run: () => app.stop(true) },
      // A pass in an agw call is given a few seconds; its call is taken up again at the next boot under the same key.
      { name: 'loops.stop', run: () => runner.stop(10_000) },
      { name: 'hook socket.stop', run: () => socket.stop() },
      { name: 'intake.stop', run: () => intake.stop() },
      { name: 'lock.release', run: () => lock.release() },
      { name: 'database.close', run: () => sql.close() },
    ],
  })
  for (const signal of ['SIGTERM', 'SIGINT'] as const) process.on(signal, () => void stop(signal))
}

main().catch((error: unknown) => fail(error instanceof Error ? error.message : String(error)))
