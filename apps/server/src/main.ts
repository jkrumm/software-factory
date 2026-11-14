import { connect } from './adapters/postgres/connection.ts'
import { agwAmend } from './adapters/agw/amend.ts'
import { agwErrandScreen } from './adapters/agw/errand.ts'
import { agwJudge } from './adapters/agw/judge.ts'
import { agwPort } from './adapters/agw/port.ts'
import { agwFixClasses } from './adapters/agw/fix-classes.ts'
import { agwDigest } from './adapters/agw/digest.ts'
import { agwErrandNeeded } from './adapters/agw/errand-needed.ts'
import { askQueueDir, queuedAsksIn } from './adapters/checkpoints/queued-asks.ts'
import { shellCheckRunner } from './adapters/shell/check-runner.ts'
import { agwHygiene } from './adapters/agw/hygiene.ts'
import { agwQueue } from './adapters/agw/queue.ts'
import { agwScreen } from './adapters/agw/screen.ts'
import { agwSettle, agwSteward } from './adapters/agw/steward.ts'
import { fileBlobStore } from './adapters/blobs/filesystem.ts'
import { fileStandingPolicies } from './adapters/checkpoints/policies.ts'
import { makeNotifier } from './adapters/ntfy/ntfy.ts'
import { postgresCheckpointStore } from './adapters/postgres/checkpoint-store.ts'
import { hostReader } from './adapters/planning/host.ts'
import { hostWatch } from './adapters/planning/host-watch.ts'
import { textRunner } from './adapters/planning/process.ts'
import { processTable, sharedCwds } from './adapters/planning/processes.ts'
import { hostSnapshot } from './adapters/planning/snapshot.ts'
import { postgresLoopStore } from './adapters/postgres/loop-store.ts'
import { postgresVisitStore } from './adapters/postgres/visit-store.ts'
import { postgresReviewStore } from './adapters/postgres/review-store.ts'
import { postgresDeskStore } from './adapters/postgres/desk-store.ts'
import { prReview } from './adapters/reviews/pr.ts'
import { askHumanPush } from './adapters/shell/ask-human.ts'
import { loadMigrations, migrate } from './adapters/postgres/migrate.ts'
import { acquireProcessLock } from './adapters/postgres/process-lock.ts'
import { postgresCapacityStore } from './adapters/postgres/capacity-store.ts'
import { postgresPlanningStore } from './adapters/postgres/planning-store.ts'
import { postgresLeadStore } from './adapters/leads/store.ts'
import { loadLeadSettings } from './adapters/leads/settings.ts'
import { postgresUnitOfWork } from './adapters/postgres/unit-of-work.ts'
import { postgresWorkStore } from './adapters/postgres/work-store.ts'
import { GitCommits } from './adapters/quality/git.ts'
import { githubCi } from './adapters/quality/ci.ts'
import { makefileProjects } from './adapters/quality/projects.ts'
import { MakeAndProbes } from './adapters/quality/proof.ts'
import { AgwReview } from './adapters/quality/review.ts'
import { postgresQualityStore } from './adapters/quality/store.ts'
import { createApp } from './api/app.ts'
import { apiForward, consoleHandler } from './api/console.ts'
import { loadConsoleSettings } from './console-settings.ts'
import { loadNeedsSettings } from './read/needs-settings.ts'
import { availableParallelism, loadavg } from 'node:os'
import { join } from 'node:path'
import { checkpointUses } from './app/checkpoints-uses.ts'
import { createLoopRunner, type LoopRunner, type LoopSpec } from './app/loops/runner.ts'
import { projectFileProjects } from './app/quality-projects.ts'
import { loadLoopSettings } from './app/loops/settings.ts'
import { frictionPass, frictionSummary } from './app/loops/friction.ts'
import { fixClassesPass, fixClassesSummary } from './app/loops/fix-classes.ts'
import { slotAimPass } from './app/capacity-aim.ts'
import { freshHostMemory, hostPass, hostSummary } from './app/loops/host.ts'
import { reaperPass, reaperSummary } from './app/loops/reaper.ts'
import { processKiller, reaperProcesses } from './adapters/planning/reaper-processes.ts'
import { hygienePass, hygieneSummary } from './app/loops/hygiene.ts'
import { selfwatchPass, selfwatchSummary } from './app/loops/selfwatch.ts'
import { ciLedgerPass } from './app/loops/ci-ledger.ts'
import { githubCiLedger, githubCiLive, githubCiRuns, githubCiTimes } from './adapters/selfwatch/github.ts'
import { gitMigrationFiles } from './adapters/selfwatch/git.ts'
import { SHARED_NUMBERS } from './adapters/postgres/migrate.ts'
import { MainCheckoutLines } from './app/loops/checkout-lines.ts'
import { gitMainCheckouts } from './adapters/quality/main-checkouts.ts'
import { stewardPass, stewardSummary } from './app/loops/steward.ts'
import { queuePass, queueSummary } from './app/loops/queue.ts'
import { digestPass, digestPassSummary } from './app/loops/digest.ts'
import { deskPass, deskSummary } from './app/loops/desk.ts'
import { errandsPass, errandsSummary } from './app/loops/errands.ts'
import { reviewsPass, reviewsSummary } from './app/loops/reviews.ts'
import { screenPass, screenSummary } from './app/loops/screen.ts'
import { triagePass, triageSummary } from './app/loops/triage.ts'
import { FRICTION_WINDOW_DAYS } from './domains/loops/friction.ts'
import { confirmedHeartbeat, DEFAULT_PROCESS_CAP } from './domains/loops/selfwatch.ts'
import { DEFAULT_STEWARD_RULES } from './domains/loops/stall.ts'
import { composeRead } from './compose-read.ts'
import { postgresIntakeStore } from './adapters/intake/store.ts'
import { loadIntakeEnv } from './adapters/intake/settings.ts'
import { composeIssues } from './compose-issues.ts'
import { rootedRepos } from './adapters/git/repos.ts'
import { createFixCommitReader } from './adapters/hygiene/fix-commits.ts'
import { createHygieneChecker } from './adapters/hygiene/index.ts'
import { fileRoles } from './adapters/leads/roles.ts'
import { composeIntake } from './compose-intake.ts'
import { loadUptimeEnv } from './adapters/uptime/settings.ts'
import { uptimePoller } from './adapters/uptime/poller.ts'
import { selfPaced } from './adapters/intake/schedule.ts'
import { composePlanning } from './compose-planning.ts'
import { leadCheckoutOf } from './app/quality-checkout.ts'
import { showQuality } from './app/quality-read.ts'
import { reopenIssue } from './app/quality-reopen.ts'
import { shipIssue } from './app/quality-ship.ts'
import { checkWatches, DEFAULT_TIMING, startWatchPort } from './app/quality-watch.ts'
import { factoryDataDir, loadCheckpointSettings } from './checkpoint-settings.ts'
import { storedChecks } from './app/leads-checks.ts'
import { composeLeads } from './compose-leads.ts'
import { loginErrands } from './app/login-errands.ts'
import { resumeRulesOf } from './app/leads-api-errors.ts'
import { type Clock, systemClock } from './kernel/clock.ts'
import { err, ok, portError } from './kernel/result.ts'
import { systemIds } from './kernel/ids.ts'
import { deployingSince } from './read/deploy-window.ts'
import { healthOf, judgeTick } from './read/health.ts'
import { startHealthProbe } from './read/health-probe.ts'
import { hostRule, planningSettings } from './app/planning-settings.ts'
import { postgresOpenIssues } from './read/open-issues.ts'
import { queueMovedAt } from './read/queue.ts'
import { queueReasonMap } from './api/read-models.ts'
import { readFriction } from './read/friction.ts'
import { readBudgetFacts, readIssueFates, readWindowFacts } from './read/throughput-loop.ts'
import { projectBudgets as readProjectBudgets, throughputPass, throughputSummary } from './app/loops/throughput.ts'
import { readFrictionEvidence } from './read/friction-evidence.ts'
import { loopReads } from './read/loops.ts'
import { readIssues } from './read/planning.ts'
import { loadSettings } from './settings.ts'
import { createShutdown } from './shutdown.ts'

/** The API and the Console's listener both bind loopback only; dotfiles-private's serve row publishes the Console's. */
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
    visits: postgresVisitStore(tx),
    reviews: postgresReviewStore(tx),
    desk: postgresDeskStore(tx),
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
  /** The one repo the self-watch loop watches: the factory itself. */
  const SELFWATCH_REPO = 'software-factory'
  const leadSettings = loadLeadSettings(process.env)
  const loopSettings = loadLoopSettings(process.env)
  // The one way to ask agw for a judgment: the Judge, the steward and triage all go through it.
  const agw = agwPort({ bin: settings.agwBin })
  const planningEnv = planningSettings(process.env, {
    repoRoots: leadSettings.repoRoots,
    repoAllow: leadSettings.repoAllow,
  })
  // Its own reader: the swapout rate of a minute sample counts from the last sample, not from an admission's reading.
  // One metered runner for every helper of the host loop: the CPU they take is the collector's cost, stored each minute.
  const hostRunner = textRunner(5_000)
  const lsofBin = process.env.FACTORY_LSOF_BIN ?? '/usr/sbin/lsof'
  const hostSamples = hostWatch({
    host: hostReader({ sysctlBin: planningEnv.sysctlBin, minSampleMs: 0 }),
    sysctlBin: planningEnv.sysctlBin,
    psBin: process.env.FACTORY_PS_BIN ?? '/bin/ps',
    topBin: process.env.FACTORY_TOP_BIN ?? '/usr/bin/top',
    vmStatBin: process.env.FACTORY_VM_STAT_BIN,
    runner: hostRunner,
  })
  const hostCwds = sharedCwds({ runner: hostRunner, lsofBin })
  const hostProcesses = processTable({
    rows: () => hostSamples.rows(),
    footprints: () => hostSamples.footprints(),
    lsofBin,
    cwds: hostCwds,
  })
  const hostClasses = hostSnapshot({
    top: () => hostSamples.topSnapshot(),
    cwds: hostCwds,
    runner: hostRunner,
    psBin: process.env.FACTORY_PS_BIN ?? '/bin/ps',
    launchctlBin: process.env.FACTORY_LAUNCHCTL_BIN ?? '/bin/launchctl',
    lsofBin,
    sysctlBin: planningEnv.sysctlBin,
    vmVolume: process.env.FACTORY_VM_VOLUME ?? '/System/Volumes/VM',
  })
  const hostMemory = freshHostMemory()
  const reaperProcessTable = reaperProcesses({
    psBin: process.env.FACTORY_PS_BIN ?? '/bin/ps',
    lsofBin: process.env.FACTORY_LSOF_BIN ?? '/usr/sbin/lsof',
  })
  const reaperKiller = processKiller({ psBin: process.env.FACTORY_PS_BIN ?? '/bin/ps' })
  // Planning and capacity own the projects and the claims; the leads, intake and the checkpoints take their ports.
  const roles = fileRoles(leadSettings.rolesFile)
  const planning = composePlanning({
    writes,
    roles,
    settings: planningEnv,
    longWaitMs: loadNeedsSettings(process.env).longWaitMs,
  })
  const checkout = leadCheckoutOf(uow)
  const repos = rootedRepos(leadSettings.repoRoots, leadSettings.repoAllow)
  const mainCheckoutLines = new MainCheckoutLines()
  const hygieneChecker = createHygieneChecker({ repos, workDir: factoryDataDir(process.env) })
  const projects = projectFileProjects({
    uow,
    fallback: makefileProjects({ windowMs: settings.quality.windowMs }),
  })
  const intakeEnv = loadIntakeEnv(process.env)
  const uptimeEnv = loadUptimeEnv(process.env)
  const uptime = uptimePoller({ clock, url: uptimeEnv.url, token: uptimeEnv.token })
  const intake = await composeIntake({
    sql,
    uow,
    env: intakeEnv,
    clock: systemClock,
    ids: systemIds,
    projects: planning.signals,
    triage: agwAmend(agw),
  })
  const checkpointSettings = loadCheckpointSettings(process.env)
  const checkpointDeps = {
    ...writes,
    blobs: fileBlobStore(checkpointSettings.blobDir),
    consoleUrl: checkpointSettings.line.consoleUrl,
    checks: shellCheckRunner(),
    queuedAsks: queuedAsksIn(askQueueDir(process.env)),
    notifier: makeNotifier(checkpointSettings.line),
    // The Judge asks `factory-ask` through the agw port. The standing policy is each project's `policy:` in its
    // `project.yaml`; a JSON file named by the environment overrides it, as an explicit stand-in.
    judge: agwJudge(agw),
    errandScreen: agwErrandScreen(agw),
    recheckAfterMs: loopSettings.recheckAfterMs,
    policies: checkpointSettings.policyFile ? fileStandingPolicies(checkpointSettings.policyFile) : planning.policies,
  }
  const checkpoints = checkpointUses(checkpointDeps)
  // One outbox runs every effect: the leads' tick, with quality's port for the Watch.
  const leads = composeLeads({
    sql,
    uow,
    clock: systemClock,
    ids: systemIds,
    settings: leadSettings,
    capacity: planning.leads,
    checks: storedChecks(uow),
    startWatch: startWatchPort({ uow, clock, projects, checkout }),
    github: intakeEnv.github,
    loginErrands: loginErrands(checkpoints),
  })
  // The hook socket comes after the lock and the migrations: a second copy never reaches it.
  const socket = await leads.listen()

  const ci = githubCi({ token: intakeEnv.github.token, apiUrl: intakeEnv.github.apiUrl })
  const shipping = {
    ...writes,
    commits: new GitCommits(),
    review: new AgwReview({ bin: settings.agwBin }),
    ci,
    projects,
    checkout,
  }
  const draining = new AbortController()

  // The loops: every recurring job of the server is one named loop on the runner, each with its interval
  // (`FACTORY_TICK_MS` the default), its trigger and its single-flight pass. Intake's pollers keep their own schedules.
  const watchSettledAt = new Date(startedAt.getTime() + settings.quality.settleMs)
  const ciLive = githubCiLive({
    locate: (repo) => repos.locate(repo),
    token: intakeEnv.github.token,
    apiUrl: intakeEnv.github.apiUrl,
  })
  const resumeRules = resumeRulesOf({
    delaysMs: leadSettings.resumeDelaysMs,
    staggerMs: leadSettings.resumeStaggerMs,
  })
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
      checks: shellCheckRunner(),
    },
    planning: writes,
    claimQueued: planning.claimQueued,
    claimStalled: planning.claimStalled,
    claimStallMs: loopSettings.claimStallMs,
    slots: () => uow.run(async ({ capacity }) => ok(await capacity.slots())),
    ciLive,
    rules: {
      ...DEFAULT_STEWARD_RULES,
      minStallMs: loopSettings.minStallMs,
      idleLeadMs: loopSettings.idleLeadMs,
      idleBackgroundMs: loopSettings.idleBackgroundMs,
    },
    retryMs: loopSettings.retryMs,
    settleTimeoutMs: loopSettings.settleTimeoutMs,
    blockedChecks: loopSettings.blockedChecks,
    checkouts: gitMainCheckouts(repos),
    findings: mainCheckoutLines,
    resume: resumeRules,
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
  const projectBudgets = () => readProjectBudgets(uow)

  /** set by the owner's button: the next desk pass runs as if he had just come back */
  let deskForced = false
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
        return ok(
          `spool ${t.replayed} lines, ${t.lost} lead(s) lost, outbox ${JSON.stringify(t.outbox)}, api errors ${JSON.stringify(t.apiErrors)}`,
        )
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
          proof: new MakeAndProbes({ ci }),
          timing: { ...DEFAULT_TIMING, retryMs: settings.quality.retryMs, recheckMs: settings.quality.recheckMs },
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
    {
      // Ten deterministic conditions (a project's `budgets:` breach among them, filed on that project's repo) (red CI, a migration number clash, an overdue wait, an idle lead, a
      // regression of inert paths, a stale heartbeat, a process growing without bound, swap growth, a process storm), filed once per subject as signals on the factory's own repo.
      name: 'selfwatch',
      intervalMs: loopSettings.intervalMs.selfwatch,
      onChange: false,
      run: async () => {
        const pass = await selfwatchPass({
          uow,
          clock: writes.clock,
          repo: SELFWATCH_REPO,
          branch: loopSettings.selfwatchBranch,
          graceMs: loopSettings.selfwatchGraceMs,
          idleLeadMs: loopSettings.idleLeadMs,
          idleBackgroundMs: loopSettings.idleBackgroundMs,
          slots: stewardDeps.slots,
          resume: resumeRules,
          ciLive,
          ci: githubCiRuns({
            locate: (repo) => repos.locate(repo),
            token: intakeEnv.github.token,
            apiUrl: intakeEnv.github.apiUrl,
          }),
          migrations: gitMigrationFiles(repos),
          sharedNumbers: SHARED_NUMBERS,
          processCap: DEFAULT_PROCESS_CAP,
          budgets: async (now) => readBudgetFacts(sql, { now, budgets: await projectBudgets() }),
          heartbeat: () =>
            confirmedHeartbeat(
              async () => (await readHealth()).heartbeat,
              (ms) => Bun.sleep(ms),
            ),
          file: (body) => intake.api.file(body, 'agent'),
        })
        if (!pass.ok) return pass
        said('selfwatch', [...pass.value.notes, ...pass.value.failed.map((f) => `${f.key}: ${f.reason}`)])
        // The CI ledger rides on this loop's interval: the runs of every followed project, kept per head for `read throughput`.
        const ledger = await ciLedgerPass({
          uow,
          clock: writes.clock,
          always: [SELFWATCH_REPO],
          ledger: githubCiLedger({
            locate: (repo) => repos.locate(repo),
            token: intakeEnv.github.token,
            apiUrl: intakeEnv.github.apiUrl,
          }),
        })
        const ledgerNotes = ledger.ok ? ledger.value.notes : [`ci ledger: ${ledger.error.kind}: ${ledger.error.detail}`]
        said('selfwatch', ledgerNotes)
        return ok(
          [
            selfwatchSummary(pass.value),
            ledger.ok ? `ci ledger ${ledger.value.runs} run(s) of ${ledger.value.repos} repo(s)` : null,
            ...ledgerNotes,
          ]
            .filter(Boolean)
            .join('; '),
        )
      },
    },
    {
      // Once a day, without a model: the costs of the last 7 days ranked, one improvement signal per project with its measured before, and the ledger reading the after 3 days past a ship (moved, or the finding comes back).
      name: 'throughput',
      intervalMs: loopSettings.intervalMs.throughput,
      onChange: false,
      run: async () => {
        const pass = await throughputPass({
          uow,
          clock: writes.clock,
          projects: async () =>
            (await projectBudgets()).map((b) => ({ project: b.project, repo: b.repo, peakMib: b.peakMib })),
          facts: (window, options) => readWindowFacts(sql, { ...window, ...options }),
          fates: (ids) => readIssueFates(sql, ids),
          file: (body) => intake.api.file(body, 'agent'),
        })
        if (!pass.ok) return pass
        said('throughput', [...pass.value.notes, ...pass.value.failed.map((f) => `${f.key}: ${f.reason}`)])
        return ok(throughputSummary(pass.value))
      },
    },
    {
      // The Judge looks at held signals: promote, dismiss or leave with a recommendation. Interval only: a newly held signal waits for the next pass.
      name: 'screen',
      intervalMs: loopSettings.intervalMs.screen,
      onChange: false,
      run: async () => {
        const pass = await screenPass({
          uow,
          clock: writes.clock,
          workflow: agwScreen(agw),
          openIssues: postgresOpenIssues(sql),
          projects: planning.signals,
          promote: intake.api.promote,
          dismiss: intake.api.dismiss,
        })
        if (!pass.ok) return pass
        said('screen', pass.value.problems)
        return ok(screenSummary(pass.value))
      },
    },
    {
      // Fix commits of every project's default branch, sorted by the rules and `factory-fix-classes`, stored for the Improve screen.
      name: 'fix-classes',
      intervalMs: loopSettings.intervalMs['fix-classes'],
      onChange: false,
      run: async () => {
        const pass = await fixClassesPass({
          uow,
          clock: writes.clock,
          reader: createFixCommitReader({ repos }),
          workflow: agwFixClasses(agw),
          repos: loopSettings.hygieneRepos,
        })
        if (!pass.ok) return pass
        said('fix-classes', pass.value.problems)
        return ok(fixClassesSummary(pass.value))
      },
    },
    {
      // One reading of the host a minute with its class snapshot, kept 14 days: the Live popover and `read throughput` draw it.
      name: 'host',
      intervalMs: loopSettings.intervalMs.host,
      onChange: false,
      run: async () => {
        const pass = await hostPass({
          uow,
          clock: writes.clock,
          sampler: hostSamples,
          processes: hostProcesses,
          snapshot: hostClasses,
          memory: hostMemory,
          self: { pid: process.pid, dirs: [process.cwd()] },
          facts: planning.capacityFacts,
        })
        if (!pass.ok) return pass
        // the slot aim moves on the sample just stored; its failure is said, never a failed host pass
        const aim = await slotAimPass({
          ...writes,
          mode: planningEnv.slotAim,
          slots: planningEnv.slots,
          slotsMax: planningEnv.slotsMax,
          cores: planningEnv.cores,
        })
        return ok(
          aim.ok
            ? `${hostSummary(pass.value)}; ${aim.value}`
            : `${hostSummary(pass.value)}; slot aim: ${aim.error.detail}`,
        )
      },
    },
    {
      // One `agw factory digest` call per project whose Issues changed: the summary the Console shows on Flow. Interval only.
      name: 'digest',
      intervalMs: loopSettings.intervalMs.digest,
      onChange: false,
      run: async () => {
        const pass = await digestPass({ uow, clock: writes.clock, workflow: agwDigest(agw) })
        if (!pass.ok) return pass
        said('digest', pass.value.problems)
        return ok(digestPassSummary(pass.value))
      },
    },
    {
      // The open requests for the owner's hands (no Issue): each one's check runs, the expired close, and one with no check is read
      // once a day by `factory-errand-needed`. Interval only: a new request waits for the next pass.
      name: 'errands',
      intervalMs: loopSettings.intervalMs.errands,
      onChange: false,
      run: async () => {
        const pass = await errandsPass({
          uow,
          clock: writes.clock,
          checks: shellCheckRunner(),
          needed: agwErrandNeeded(agw),
        })
        if (!pass.ok) return pass
        said('errands', pass.value.problems)
        return ok(errandsSummary(pass.value))
      },
    },
    {
      // The Issues that wait on someone else's review of a pull request: each pull request is read through gh or glab, and an
      // approval, a request for changes, a new review comment, a merge or a close wakes the lead.
      name: 'reviews',
      intervalMs: loopSettings.intervalMs.reviews,
      onChange: false,
      run: async () => {
        const pass = await reviewsPass({
          uow,
          clock: writes.clock,
          ids: writes.ids,
          port: prReview({ workGhConfigDir: loopSettings.ghConfigDirWork }),
        })
        if (!pass.ok) return pass
        said('reviews', pass.value.problems)
        return ok(reviewsSummary(pass.value))
      },
    },
    {
      // The desk pass over the open Errands, when the owner is back after two hours or more (his Console read starts it at
      // once; so does the MacBook answering after it was down, or his button) and every six hours: checks, a second screen,
      // and the MacBook commands pushed, every pending one when he is back, one while he is away. The loop asks every 15
      // minutes whether one is due.
      name: 'desk',
      intervalMs: loopSettings.intervalMs.desk,
      onChange: false,
      run: async () => {
        const force = deskForced
        deskForced = false
        const pass = await deskPass({
          settle: checkpointDeps,
          desk: uow,
          push: askHumanPush({
            bin: loopSettings.askHumanBin,
            home: process.env.HOME ?? '',
            host: loopSettings.askHumanHost,
          }),
          force,
        })
        if (!pass.ok) return pass
        said('desk', pass.value.problems)
        return ok(deskSummary(pass.value))
      },
    },
    {
      // Ends the processes of closed lead attempts (by session key and worktree, never by name): a browser a finished lead left
      // behind lives on under launchd otherwise.
      name: 'reaper',
      intervalMs: loopSettings.intervalMs.reaper,
      onChange: false,
      run: async () => {
        const pass = await reaperPass({
          uow,
          clock: writes.clock,
          processes: reaperProcessTable,
          killer: reaperKiller,
          graceMs: loopSettings.reaperGraceMs,
          dry: loopSettings.reaperDry,
          protect: [1, process.pid],
        })
        if (!pass.ok) return pass
        return ok(reaperSummary(pass.value))
      },
    },
  ]
  const runner: LoopRunner = createLoopRunner({
    loops: specs,
    clock: systemClock,
    passes: {
      load: async () => {
        const passes = await uow.run(async ({ loops }) => ok(await loops.passes()))
        if (!passes.ok) throw new Error(`${passes.error.kind}: ${passes.error.detail}`)
        return passes.value
      },
      record: async (name, at) => {
        const recorded = await uow.run(async ({ loops }) => ok(await loops.recordPass(name, at)))
        if (!recorded.ok) throw new Error(`${recorded.error.kind}: ${recorded.error.detail}`)
      },
    },
  })
  const leadsTick = loopSettings.intervalMs.leads
  /** a desk pass in flight is not started again: the dialogs it pushes are the ones he gets */
  const pushDesk = (): { started: boolean } => {
    if (runner.view().some((loop) => loop.name === 'desk' && loop.running)) return { started: false }
    deskForced = true
    void runner.runNow('desk')
    return { started: true }
  }
  const deskOnReturn = () => {
    if (!runner.view().some((loop) => loop.name === 'desk' && loop.running)) void runner.runNow('desk')
  }

  const queueReasons = async () => {
    const view = await planning.capacity.queue()
    return view.ok ? queueReasonMap(view.value.queue) : null
  }
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
  const dataDir = factoryDataDir(process.env)
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
    })
  }
  const app = createApp({
    tokens: settings.tokens,
    intake: intake.api,
    health: { read: readHealth },
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
      env: process.env,
      doorLines: () => intake.doorLines(DOOR_LINES_RECENT_MS),
      loops: () => runner.view(),
      blockedStreak: loopSettings.blockedChecks,
      mainCheckouts: () => mainCheckoutLines.current(),
      queueReasons,
      uptime: () => uptime.snapshot(),
    }),
    readModels: {
      sql,
      queueReasons,
      machine,
      ciTimes: githubCiTimes({
        locate: (repo) => repos.locate(repo),
        token: intakeEnv.github.token,
        apiUrl: intakeEnv.github.apiUrl,
      }),
      capacityConstants: {
        leadsPerAccount: planningEnv.leadsPerAccount,
        loadCeiling: hostRule(planningEnv).loadCeiling,
        loadRule: planningEnv.loadRule,
        loadPerCore: planningEnv.loadPerCore,
        processCap: planningEnv.processCap,
        cores: planningEnv.cores,
        slots: planningEnv.slots,
        slotsMax: planningEnv.slotsMax,
        slotExtraLoad: planningEnv.slotExtraLoad,
        slotAim: planningEnv.slotAim,
        seatsMaxBonus: planningEnv.seatsMaxBonus ?? 0,
        reaperGraceMs: loopSettings.reaperGraceMs,
        swapoutCeilingMb: planningEnv.memoryCeilings.swapoutMbPer300s,
        swapCeilingPct: planningEnv.memoryCeilings.swapUsedPct,
      },
      visits: uow,
      onReturn: deskOnReturn,
      longWaitMs: loadNeedsSettings(process.env).longWaitMs,
      host: { version: settings.version, startedAt, top: () => hostSamples.top() },
    },
  }).listen({ hostname: HOSTNAME, port: settings.port, idleTimeout: IDLE_TIMEOUT_S })
  console.log(`listening on http://${HOSTNAME}:${settings.port} (version ${settings.version})`)
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
  // tailnet ACL, there is no per-request identity. Only reads and the owner's nine answer verbs (`WRITES` in console.ts) pass,
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
  const stopUptime = uptime.enabled
    ? selfPaced('uptime', uptimeEnv.everyMs, () => uptime.pass(), { firstMs: 1_000 })
    : null
  await runner.start()

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
      { name: 'uptime.stop', run: async () => void (await stopUptime?.()) },
      { name: 'lock.release', run: () => lock.release() },
      { name: 'health.probe.stop', run: async () => healthProbe.stop() },
      { name: 'database.close', run: () => sql.close() },
    ],
  })
  stopNow = stop
  if (stopRequested !== null) void stop(stopRequested)
}

main().catch((error: unknown) => fail(error instanceof Error ? error.message : String(error)))
