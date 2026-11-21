import { REVIEWER_CHEAP_ROLE, REVIEWER_ROLE } from '@software-factory/contract'
import { connect } from './adapters/postgres/connection.ts'
import { agwAmend } from './adapters/agw/amend.ts'
import { agwPort } from './adapters/agw/port.ts'
import { askQueueDir, queuedAsksIn } from './adapters/checkpoints/queued-asks.ts'
import { shellCheckRunner } from './adapters/shell/check-runner.ts'
import { fileBlobStore } from './adapters/blobs/filesystem.ts'
import { makeNotifier } from './adapters/ntfy/ntfy.ts'
import { ledgerQuotaReader } from './adapters/planning/accounts-source.ts'
import { askHumanVerbs } from './adapters/shell/ask-human.ts'
import { loadMigrations, migrate } from './adapters/postgres/migrate.ts'
import { acquireProcessLock } from './adapters/postgres/process-lock.ts'
import { loadLeadSettings } from './adapters/leads/settings.ts'
import { GitCommits } from './adapters/quality/git.ts'
import { githubCi } from './adapters/quality/ci.ts'
import { makefileProjects } from './adapters/quality/projects.ts'
import { MakeAndProbes } from './adapters/quality/proof.ts'
import { AgwReview } from './adapters/quality/review.ts'
import { createApp } from './api/app.ts'
import { apiForward, consoleHandler } from './api/console.ts'
import { loadConsoleSettings } from './console-settings.ts'
import { loadNeedsSettings } from './read/needs-settings.ts'
import { availableParallelism, loadavg } from 'node:os'
import { join } from 'node:path'
import { APPROVED_RUN_HANG_GUARD_MS } from './app/checkpoints-approve.ts'
import { MAX_RUN_TRIES } from './app/checkpoints-errands.ts'
import { checkpointUses } from './app/checkpoints-uses.ts'
import { projectFileProjects } from './app/quality-projects.ts'
import { loadLoopSettings } from './app/loops/settings.ts'
import { reaperProcesses } from './adapters/planning/reaper-processes.ts'
import { githubCiTimes } from './adapters/selfwatch/github.ts'
import { routeTimer } from './api/route-timer.ts'
import { MainCheckoutLines } from './app/loops/checkout-lines.ts'
import { composeRead } from './compose-read.ts'
import { loadIntakeEnv } from './adapters/intake/settings.ts'
import { composeIssues } from './compose-issues.ts'
import { rootedRepos } from './adapters/git/repos.ts'
import { createDoctorReader } from './adapters/doctor/index.ts'
import { reapHygieneDir } from './adapters/hygiene/checkout.ts'
import { fileRoles } from './adapters/leads/roles.ts'
import { composeIntake } from './compose-intake.ts'
import { loadUptimeEnv } from './adapters/uptime/settings.ts'
import { uptimePoller } from './adapters/uptime/poller.ts'
import { otelExporter } from './adapters/otel/exporter.ts'
import { loadOtelEnv } from './adapters/otel/settings.ts'
import { readCapacityGauges } from './read/capacity-gauges.ts'
import { selfPaced } from './adapters/intake/schedule.ts'
import type { SignalFiler } from './app/capacity-slots.ts'
import { composePlanning } from './compose-planning.ts'
import { leadCheckoutOf } from './app/quality-checkout.ts'
import { showQuality } from './app/quality-read.ts'
import { reopenIssue } from './app/quality-reopen.ts'
import { shipIssue } from './app/quality-ship.ts'
import { startWatchPort } from './app/quality-watch.ts'
import { factoryDataDir, loadCheckpointSettings } from './checkpoint-settings.ts'
import { storedChecks } from './app/leads-checks.ts'
import { composeLeads, lightReaders } from './compose-leads.ts'
import { plannedSeatTable } from './app/leads-seat-table.ts'
import { loginErrands } from './app/login-errands.ts'
import { type Clock, systemClock } from './kernel/clock.ts'
import type { Environment } from './kernel/env.ts'
import { freshFor } from './kernel/fresh-for.ts'
import { ok } from './kernel/result.ts'
import { type IssueId, systemIds } from './kernel/ids.ts'
import { deployingSince } from './read/deploy-window.ts'
import { healthOf, judgeTick } from './read/health.ts'
import { startHealthProbe } from './read/health-probe.ts'
import { hostRule, planningSettings } from './app/planning-settings.ts'
import { queueMovedAt } from './read/queue.ts'
import { queueReasonMap } from './api/read-models.ts'
import { loadEpoch } from './adapters/throughput-epoch.ts'
import { loadSettings } from './settings.ts'
import { composeLoops } from './compose-loops.ts'
import { composeUow } from './compose-store.ts'
import { createShutdown, SHUTDOWN_DEADLINE_MS } from './shutdown.ts'

/** The API and the Console's listener both bind loopback only; dotfiles-private's serve row publishes the Console's. */
const HOSTNAME = '127.0.0.1'

/** A ship call waits for git and agw (up to REVIEW_TIMEOUT_MS, then THREADS_TIMEOUT_MS for the ledger's threads) inside one request; Bun's own idle limit is 10 s, and 255 s is its maximum. */
const IDLE_TIMEOUT_S = 255

/** How long a stop waits for the passes in flight (the loops, the intake pollers, the uptime push) before it goes on. */
const PASS_GRACE_MS = 10_000

/** A door source refused within this long is a health line; an older refusal has passed. */
const DOOR_LINES_RECENT_MS = 24 * 3_600_000

/** The queue view the read routes share is reused this long (`queueReasons`): the queue loop moves it every 10 s. */
const QUEUE_REASONS_FRESH_MS = 5_000

const fail = (message: string): never => {
  console.error(message)
  process.exit(1)
}

async function main(env: Environment): Promise<void> {
  const settings = loadSettings(env)
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

  const lockedAtS = process.uptime()
  const applied = await migrate(sql, await loadMigrations())
  if (applied.length) console.log(`migrated: ${applied.join(', ')}`)
  const migratedAtS = process.uptime()

  // The composition: each domain's store on the transaction's connection, the ports the use cases get.
  const uow = composeUow(sql)
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
  /** Times the server's own routes: the heartbeat's `routeP95Ms` reads the figure. */
  const routes = routeTimer()
  const leadSettings = loadLeadSettings(env, { agentToken: settings.tokens.agent, port: settings.port })
  const loopSettings = loadLoopSettings(env)
  // The one way to ask agw for a judgment: every workflow in `WORKFLOWS` goes through it.
  const agw = agwPort({ bin: settings.agwBin })
  // The counting epoch: a missing or bad `config/throughput.json` stops the start, so no read quietly counts everything.
  const epoch = loadEpoch(settings.throughputFile)
  const needsSettings = loadNeedsSettings(env)
  const planningEnv = planningSettings(env, {
    repoRoots: leadSettings.repoRoots,
    repoAllow: leadSettings.repoAllow,
  })
  const reaperProcessTable = reaperProcesses({ psBin: planningEnv.psBin, lsofBin: planningEnv.lsofBin })
  // Planning and capacity own the projects and the claims; the leads, intake and the checkpoints take their ports.
  const roles = fileRoles(leadSettings.rolesFile)
  const light = lightReaders(sql, systemClock)
  // The planned seat is what the lead's start would choose now: the `lead` row, or the `light` row when the light rule names the Issue.
  const seatTable = plannedSeatTable({ roles, light })
  // The two reviewer rows as the table stands: the seat a review's record names, and the words beside the Improve numbers.
  const reviewerRows = async () => {
    const [cheap, reviewer] = await Promise.all([roles.role(REVIEWER_CHEAP_ROLE), roles.role(REVIEWER_ROLE)])
    return cheap.ok && reviewer.ok ? { cheap: cheap.value, reviewer: reviewer.value } : null
  }
  // One reader for admission and hygiene: a reading one took is the other's, and a project's doctor runs once at a time.
  const doctor = createDoctorReader({ now: () => writes.clock.now() })
  const disagreementSignals: { file?: SignalFiler } = {}
  const planning = composePlanning({
    writes,
    roles,
    settings: planningEnv,
    longWaitMs: needsSettings.longWaitMs,
    doctor,
    signals: disagreementSignals,
  })
  const checkout = leadCheckoutOf(uow)
  const repos = rootedRepos(leadSettings.repoRoots, leadSettings.repoAllow)
  const mainCheckoutLines = new MainCheckoutLines()
  // the checkouts a killed pass left: no pass of this process exists yet, so they go (in the background)
  void reapHygieneDir(factoryDataDir(env, { home: leadSettings.home }))
  const projects = projectFileProjects({
    uow,
    fallback: makefileProjects({ windowMs: settings.quality.windowMs }),
  })
  const intakeEnv = loadIntakeEnv(env, { home: leadSettings.home })
  const uptimeEnv = loadUptimeEnv(env)
  const uptime = uptimePoller({ clock, url: uptimeEnv.url, token: uptimeEnv.token })
  // The capacity figures to ClickStack, beside the host and CI series; off without FACTORY_OTEL_ENDPOINT. Its own pass: a push
  // that fails is one log line and touches no loop.
  const otelEnv = loadOtelEnv(env)
  const otel = otelExporter({
    clock,
    endpoint: otelEnv.endpoint,
    key: otelEnv.key,
    version: settings.version,
    seatCaps: { perAccount: planningEnv.leadsPerAccount, byAccount: Object.fromEntries(planningEnv.accountLeads) },
    read: () => readCapacityGauges(sql, { now: clock.now(), windowMs: otelEnv.windowMs }),
  })
  const intake = await composeIntake({
    sql,
    uow,
    env: intakeEnv,
    clock: systemClock,
    ids: systemIds,
    projects: planning.signals,
    triage: agwAmend(agw),
  })
  disagreementSignals.file = (body) => intake.api.file(body, 'agent')
  const checkpointSettings = loadCheckpointSettings(env, { home: leadSettings.home })
  const checkpointDeps = {
    ...writes,
    blobs: fileBlobStore(checkpointSettings.blobDir),
    consoleUrl: checkpointSettings.line.consoleUrl,
    checks: shellCheckRunner(),
    // an approved Errand's command runs here, on the mini: a hang guard, never a budget (a release takes minutes)
    commands: shellCheckRunner(undefined, APPROVED_RUN_HANG_GUARD_MS),
    queuedAsks: queuedAsksIn(askQueueDir(env, { home: leadSettings.home })),
    notifier: makeNotifier(checkpointSettings.line),
    // The Judge, the Errand screen and the Spec screen are workflows of the one agw port.
    agw,
    // an Errand that is exactly a report or a pull of the MacBook's fixed verbs runs through them, with no dialog
    macbook: askHumanVerbs({ host: loopSettings.askHumanHost }),
    recheckAfterMs: loopSettings.recheckAfterMs,
  }
  const checkpoints = checkpointUses(checkpointDeps)
  // One outbox runs every effect: the leads' tick, with quality's port for the Watch.
  const readProcesses = async () =>
    (await reaperProcessTable.read())?.map(({ pid, ppid, session }) => ({ pid, ppid, session })) ?? null
  const leads = composeLeads({
    light,
    sql,
    uow,
    clock: systemClock,
    ids: systemIds,
    settings: leadSettings,
    capacity: planning.leads,
    checks: storedChecks(uow, { workGhConfigDir: loopSettings.ghConfigDirWork }),
    startWatch: startWatchPort({ uow, clock, projects, checkout }),
    github: intakeEnv.github,
    loginErrands: loginErrands(checkpoints),
    host: {
      // One read answers a minute of passes (never longer than the threshold itself): `ps -E` and a host-wide `lsof` are too much for every tick of a lead that stays a candidate.
      processes: freshFor(Math.min(60_000, leadSettings.quiesceAfterMs), readProcesses),
      // A lead held at the wall is looked at as it is now: a tool started a few seconds ago must show, which a minute-old read would hide.
      processTable: readProcesses,
      slotCwds: async () => {
        const rows = await uow.run(async ({ capacity }) => ok(await capacity.slots()))
        // A table that cannot be read says nothing of the slots: nothing is dormant on it.
        if (!rows.ok) throw new Error(rows.error.detail)
        return rows.value.flatMap((row) => (row.slot !== null && row.cwd ? [row.cwd] : []))
      },
    },
  })
  // The hook socket comes after the lock and the migrations: a second copy never reaches it.
  const socket = await leads.listen()

  const ci = githubCi({ token: intakeEnv.github.token, apiUrl: intakeEnv.github.apiUrl })
  const draining = new AbortController()
  const shipping = {
    ...writes,
    commits: new GitCommits(),
    review: new AgwReview({ bin: settings.agwBin }),
    ci,
    projects,
    checkout,
    reviewerRows,
    proof: new MakeAndProbes({ ci }),
    signal: draining.signal,
    alertsDown: async (issueId: IssueId) => {
      const read = await uow.run(async ({ intake }) => ok(await intake.subjectsOfIssue(issueId)))
      // an alert that cannot be read is not down: the gate never refuses on it
      return read.ok ? read.value.filter((row) => row.upAt === null).map((row) => row.subject) : []
    },
  }

  const dataDir = factoryDataDir(env, { home: leadSettings.home })
  const { runner, pushDesk, deskOnReturn, hostTop } = composeLoops({
    sql,
    uow,
    clock,
    runnerClock: systemClock,
    ids: systemIds,
    settings,
    loopSettings,
    leadSettings,
    planningEnv,
    agw,
    planning,
    leads,
    intake,
    github: intakeEnv.github,
    checkpoints,
    checkpointDeps,
    checkpointSettings,
    repos,
    projects,
    checkout,
    ci,
    draining: draining.signal,
    epoch,
    doctor,
    mainCheckoutLines,
    dataDir,
    startedAt,
    reaperProcesses: reaperProcessTable,
    heartbeat: async () => (await readHealth()).heartbeat,
  })
  const leadsTick = loopSettings.intervalMs.leads

  // Every read route asks for this, and the view behind it spawns `sysctl` a few times and may poll the account picker:
  // on a loaded host that made `/v1/projects` and its siblings answer in seconds (2026-11-17).
  // A few seconds old is fresh enough for the word on a queued Issue; concurrent requests share one run.
  const queueReasons = freshFor(QUEUE_REASONS_FRESH_MS, async () => {
    const view = await planning.capacity.queue()
    return view.ok ? queueReasonMap(view.value.queue) : null
  })
  const machine = async () => {
    const state = await planning.capacity.state()
    if (!state.ok) return null
    const { limits } = planning.capacity
    return {
      load: state.value.host.load,
      loadCeiling: limits.loadCeiling,
      memory: state.value.host.memory,
      memoryCeilings: limits.memoryCeilings,
    }
  }
  // The same health `GET /health` answers: the self-watch loop reads its heartbeat from here. Nothing in it waits for the
  // database: the probe reads it in the background, and a request is answered from what the probe and the runner hold.
  const healthProbe = startHealthProbe({
    everyMs: settings.healthProbeMs,
    now: () => new Date(),
    read: async () => {
      await sql`SELECT 1`
      const door = await intake
        .doorLines(DOOR_LINES_RECENT_MS)
        .catch((error: unknown) => [`the door's lines could not be read: ${String(error)}`])
      return { queueMovedAt: (await queueMovedAt(sql))?.toISOString() ?? null, doorLines: door }
    },
  })
  const readHealth = async () => {
    const tickAt = runner.lastOkAt('leads')
    const probed = healthProbe.snapshot()
    const tick = judgeTick({
      tickMs: leadsTick,
      now: new Date(),
      startedAt,
      tickAt,
      deployingSince: deployingSince(dataDir),
      tickError: runner.view().find((loop) => loop.name === 'leads')?.lastError ?? null,
      load: loadavg()[0] ?? null,
      cores: availableParallelism(),
      ...(loopSettings.heartbeatStaleMs === null ? {} : { limitMs: loopSettings.heartbeatStaleMs }),
    })
    return healthOf({
      lines: probed.doorLines.map((text) => ({ source: 'door', text, since: null })),
      loops: runner.view().map((loop) => ({
        name: loop.name,
        ok: loop.lastError === null,
        lastOkAt: loop.lastOkAt,
        lastPassAt: loop.lastPassAt,
        lastError: loop.lastError,
        intervalMs: loop.intervalMs,
      })),
      version: settings.version,
      databaseFailure: probed.databaseFailure,
      tickAt: tickAt?.toISOString() ?? null,
      queueMovedAt: probed.queueMovedAt,
      tickFailure: tick.failure,
      notice: tick.notice,
      routes: routes.snapshot(),
    })
  }
  const app = createApp({
    tokens: settings.tokens,
    intake: intake.api,
    health: { read: readHealth },
    routes,
    planning: planning.planning,
    issues: composeIssues({
      writes,
      filing: {
        ...writes,
        locate: (repo) => repos.locate(repo),
        roles,
        blobs: fileBlobStore(checkpointSettings.blobDir),
        consoleUrl: checkpointSettings.line.consoleUrl,
      },
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
    loops: Object.assign(runner, { pushDesk }),
    read: composeRead({
      sql,
      clock,
      env,
      doorLines: () => intake.doorLines(DOOR_LINES_RECENT_MS),
      loops: () => runner.view(),
      blockedStreak: loopSettings.blockedChecks,
      mainCheckouts: () => mainCheckoutLines.current(),
      macbookProbe: loopSettings.askHumanHost !== null,
      maxRunTries: MAX_RUN_TRIES,
      queueReasons,
      seatTable,
      uptime: () => uptime.snapshot(),
    }),
    readModels: {
      sql,
      dataDir,
      epoch,
      // the owner's Herdr groups, the file the Herdr app reads (`make herdr-app-setup` in dotfiles links it here)
      projectGroupsFile: settings.projectGroupsFile,
      tenantBudget: { project: planningEnv.tenantProject, budgetMib: planningEnv.tenantBudgetMib },
      cores: planningEnv.cores,
      queueReasons,
      seatTable,
      reviewerRows,
      quotaAtReset: ledgerQuotaReader(),
      machine,
      ciTimes: githubCiTimes({
        locate: (repo) => repos.locate(repo),
        token: intakeEnv.github.token,
        apiUrl: intakeEnv.github.apiUrl,
      }),
      capacityConstants: {
        leadsPerAccount: planningEnv.leadsPerAccount,
        accountLeads: Object.fromEntries(planningEnv.accountLeads),
        loadCeiling: hostRule(planningEnv).loadCeiling,
        loadPerCore: planningEnv.loadPerCore,
        processCap: planningEnv.processCap,
        cores: planningEnv.cores,
        slots: planningEnv.slots,
        slotsMax: planningEnv.slotsMax,
        slotExtraLoad: planningEnv.slotExtraLoad,
        seatsMaxBonus: planningEnv.seatsMaxBonus ?? 0,
        reaperGraceMs: loopSettings.reaperGraceMs,
        swapoutCeilingMb: planningEnv.memoryCeilings.swapoutMbPer300s,
        swapCeilingPct: planningEnv.memoryCeilings.swapUsedPct,
      },
      visits: uow,
      onReturn: deskOnReturn,
      longWaitMs: needsSettings.longWaitMs,
      host: { version: settings.version, startedAt, top: hostTop },
    },
  }).listen({ hostname: HOSTNAME, port: settings.port, idleTimeout: IDLE_TIMEOUT_S })
  // Where a restart's seconds go after the process exists (`scripts/deploy.sh` prints the whole of it as `started_s`): the lock
  // wait (the old process still holding it), the migrations, the rest of the composition, all counted from the process start.
  const bootS = (seconds: number) => seconds.toFixed(1)
  console.log(
    `listening on http://${HOSTNAME}:${settings.port} (version ${settings.version}; boot ${bootS(process.uptime())}s: ` +
      `lock ${bootS(lockedAtS)}s, migrations ${bootS(migratedAtS - lockedAtS)}s, rest ${bootS(process.uptime() - migratedAtS)}s)`,
  )
  // From here /health answers, and `/health` is quick (it waits for nothing), so a stop can arrive before the steps below
  // exist: it is kept and run as soon as they do, never left to the default signal action (exit 143, the lock and the pool unclosed).
  let stopRequested: string | null = null
  let stopNow: ((signal: string) => Promise<void>) | null = null
  for (const signal of ['SIGTERM', 'SIGINT'] as const)
    process.on(signal, () => {
      if (stopNow) void stopNow(signal)
      else stopRequested = signal
    })

  // The Console's listener: loopback too, published on the tailnet by the dotfiles-private serve row; the perimeter is the
  // tailnet ACL, there is no per-request identity. Only reads and the owner's fifteen verbs (eleven answers, pin and unpin, an account's mode set and clear) (`WRITES` in console.ts) pass,
  // and the owner token is held by this closure alone. It starts whenever the Console is built. It binds before
  // the loops start, so a bad port or a taken one refuses the boot before any pass has run.
  const consoleSettings = loadConsoleSettings(env)
  const consoleBuilt = await Bun.file(join(consoleSettings.dir, 'index.html')).exists()
  const consoleServer = consoleBuilt
    ? Bun.serve({
        hostname: HOSTNAME,
        port: consoleSettings.port,
        idleTimeout: IDLE_TIMEOUT_S,
        fetch: consoleHandler({
          dir: consoleSettings.dir,
          imageHosts: consoleSettings.imageHosts,
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
  const stopUptime = uptime.enabled
    ? selfPaced('uptime', uptimeEnv.everyMs, () => uptime.pass(), { firstMs: 1_000 })
    : null
  const stopOtel = otel.enabled ? selfPaced('otel', otelEnv.everyMs, () => otel.pass(), { firstMs: 15_000 }) : null
  await runner.start()

  // Active connections are closed (`stop(true)`): an SSE stream never completes on its own, and without the flag Bun
  // waits for it, so the stop would never return and the process would keep the lock. The deadline ends the process
  // whatever step is stuck; the lock is let go before the pool closes, so a copy waiting for it boots as soon as the work is done.
  const stop = createShutdown({
    deadlineMs: SHUTDOWN_DEADLINE_MS,
    steps: [
      { name: 'draining', run: async () => draining.abort() },
      { name: 'console.stop', run: async () => void (await consoleServer?.stop(true)) },
      { name: 'server.stop', run: () => app.stop(true) },
      // The loops, the intake pollers and the uptime push wait for their pass in flight side by side, one grace for all of them
      // (a restart measured them one after the other: 10 s of loops, then 17 s of a GitHub pass). A pass in an agw call is
      // taken up again at the next boot under the same key; one cut off is named, so the next `stopped in …` line says who held it.
      {
        name: 'passes.stop',
        run: async () => {
          await Promise.all([
            runner.stop(PASS_GRACE_MS),
            intake.stop(PASS_GRACE_MS),
            stopUptime?.(PASS_GRACE_MS),
            stopOtel?.(PASS_GRACE_MS),
          ])
          const cut = runner
            .view()
            .filter((loop) => loop.running)
            .map((loop) => loop.name)
          if (cut.length) console.log(`stop: still running after ${PASS_GRACE_MS / 1000}s: ${cut.join(', ')}`)
        },
      },
      { name: 'hook socket.stop', run: () => socket.stop() },
      { name: 'lock.release', run: () => lock.release() },
      { name: 'health.probe.stop', run: async () => healthProbe.stop() },
      { name: 'database.close', run: () => sql.close() },
    ],
  })
  stopNow = stop
  if (stopRequested !== null) void stop(stopRequested)
}

main(Bun.env).catch((error: unknown) => fail(error instanceof Error ? error.message : String(error)))
