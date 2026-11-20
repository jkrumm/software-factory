import type { SQL } from 'bun'
import type { agwPort } from './adapters/agw/port.ts'
import { fileBlobStore } from './adapters/blobs/filesystem.ts'
import type { rootedRepos } from './adapters/git/repos.ts'
import { createFixCommitReader } from './adapters/hygiene/fix-commits.ts'
import { createHygieneChecker } from './adapters/hygiene/index.ts'
import type { LeadSettings } from './adapters/leads/settings.ts'
import { SHARED_NUMBERS } from './adapters/postgres/migrate.ts'
import { ledgerQuotaReader } from './adapters/planning/accounts-source.ts'
import { readCapComment } from './adapters/planning/cap-comments.ts'
import { duSizer } from './adapters/planning/worktree-sizer.ts'
import { hostReader } from './adapters/planning/host.ts'
import { hostWatch } from './adapters/planning/host-watch.ts'
import { textRunner } from './adapters/planning/process.ts'
import { processTable, sharedCwds } from './adapters/planning/processes.ts'
import { processKiller, type reaperProcesses } from './adapters/planning/reaper-processes.ts'
import { hostSnapshot } from './adapters/planning/snapshot.ts'
import { prReview } from './adapters/reviews/pr.ts'
import { githubCiLedger, githubCiLive, githubCiRuns } from './adapters/selfwatch/github.ts'
import { gitMigrationFiles } from './adapters/selfwatch/git.ts'
import { hostOverload } from './adapters/selfwatch/overload.ts'
import { shellCheckRunner } from './adapters/shell/check-runner.ts'
import { askHumanPush, askHumanSync } from './adapters/shell/ask-human.ts'
import type { githubCi } from './adapters/quality/ci.ts'
import { gitMainCheckouts } from './adapters/quality/main-checkouts.ts'
import { MakeAndProbes } from './adapters/quality/proof.ts'
import type { loadEpoch } from './adapters/throughput-epoch.ts'
import type { routeTimer } from './api/route-timer.ts'
import { slotAimPass } from './app/capacity-aim.ts'
import { endRequest, tellCheckBroken } from './app/checkpoints-errands.ts'
import type { SettleDeps } from './app/checkpoints-settle.ts'
import type { checkpointUses } from './app/checkpoints-uses.ts'
import { resumeRulesOf } from './app/leads-api-errors.ts'
import { ciLedgerLoop } from './app/loops/ci-ledger.ts'
import type { MainCheckoutLines } from './app/loops/checkout-lines.ts'
import { deskLoop, hasUnpushed } from './app/loops/desk.ts'
import { digestLoop } from './app/loops/digest.ts'
import { errandsLoop } from './app/loops/errands.ts'
import { fixClassesLoop } from './app/loops/fix-classes.ts'
import { frictionLoop, RETRO_SUBJECT } from './app/loops/friction.ts'
import { freshHostMemory, hostLoop } from './app/loops/host.ts'
import { hygieneLoop } from './app/loops/hygiene.ts'
import { queueLoop } from './app/loops/queue.ts'
import { reaperLoop } from './app/loops/reaper.ts'
import { reviewsLoop } from './app/loops/reviews.ts'
import {
  createLoopRunner,
  createSaid,
  type LoopRunner,
  type LoopSpec,
  type LoopWiring,
  passLoop,
} from './app/loops/runner.ts'
import { screenLoop } from './app/loops/screen.ts'
import { selfwatchLoop } from './app/loops/selfwatch.ts'
import type { LoopSettings } from './app/loops/settings.ts'
import { stewardLoop } from './app/loops/steward.ts'
import { projectBudgets as readProjectBudgets, throughputLoop } from './app/loops/throughput.ts'
import { triageLoop } from './app/loops/triage.ts'
import type { planningSettings } from './app/planning-settings.ts'
import { hostRule } from './app/planning-settings.ts'
import type { projectFileProjects } from './app/quality-projects.ts'
import { checkWatches, DEFAULT_TIMING } from './app/quality-watch.ts'
import type { loadCheckpointSettings } from './checkpoint-settings.ts'
import type { composeIntake } from './compose-intake.ts'
import type { composeLeads } from './compose-leads.ts'
import type { composePlanning } from './compose-planning.ts'
import type { ServerUow } from './compose-store.ts'
import { FRICTION_WINDOW_DAYS } from './domains/loops/friction.ts'
import { confirmedHeartbeat, DEFAULT_PROCESS_CAP } from './domains/loops/selfwatch.ts'
import { DEFAULT_STEWARD_RULES } from './domains/loops/stall.ts'
import type { Clock } from './kernel/clock.ts'
import type { IdSource } from './kernel/ids.ts'
import { err, ok, portError } from './kernel/result.ts'
import { readCapFacts } from './read/cap-facts.ts'
import { readFriction } from './read/friction.ts'
import { kpisOfWindow } from './read/kpis.ts'
import { readFrictionEvidence } from './read/friction-evidence.ts'
import { postgresOpenIssues } from './read/open-issues.ts'
import { readClosedSince, readLastFiled, readRetroOutcomes } from './read/retro-outcomes.ts'
import { readBudgetFacts, readIssueFates, readWindowFacts } from './read/throughput-loop.ts'
import type { Settings } from './settings.ts'
import type { createDoctorReader } from './adapters/doctor/index.ts'
import type { leadCheckoutOf } from './app/quality-checkout.ts'

/** What the loops are composed from: the server's stores, ports and settings, built once in `main.ts`. */
export interface LoopContext {
  sql: SQL
  uow: ServerUow
  clock: Clock
  /** the runner's own clock: the passes' last times are recorded on it */
  runnerClock: Clock
  ids: IdSource
  settings: Settings
  loopSettings: LoopSettings
  leadSettings: LeadSettings
  planningEnv: ReturnType<typeof planningSettings>
  agw: ReturnType<typeof agwPort>
  planning: ReturnType<typeof composePlanning>
  leads: Awaited<ReturnType<typeof composeLeads>>
  intake: Awaited<ReturnType<typeof composeIntake>>
  github: { token: string | null; apiUrl: string }
  checkpoints: ReturnType<typeof checkpointUses>
  checkpointDeps: SettleDeps
  checkpointSettings: ReturnType<typeof loadCheckpointSettings>
  repos: ReturnType<typeof rootedRepos>
  projects: ReturnType<typeof projectFileProjects>
  checkout: ReturnType<typeof leadCheckoutOf>
  ci: ReturnType<typeof githubCi>
  /** aborted when the server drains: a pass in flight stops what it can */
  draining: AbortSignal
  epoch: ReturnType<typeof loadEpoch>
  doctor: ReturnType<typeof createDoctorReader>
  mainCheckoutLines: MainCheckoutLines
  routes: ReturnType<typeof routeTimer>
  dataDir: string
  startedAt: Date
  reaperProcesses: ReturnType<typeof reaperProcesses>
  /** the heartbeat `GET /health` answers, read when the self-watch pass asks (the health read is built after the runner) */
  heartbeat: Parameters<typeof confirmedHeartbeat>[0]
}

/** The one repo the self-watch loop watches: the factory itself. */
const SELFWATCH_REPO = 'software-factory'

/**
 * Every recurring job of the server is one named loop on the runner, each with its interval (`FACTORY_TICK_MS` the default),
 * its trigger and its single-flight pass. A loop module (`app/loops/*.ts`) owns the spec, this wires its ports. Intake's
 * pollers, the uptime and OTel pushes and the health probe keep their own schedules: they have no place in `loop list`, and
 * a loop would record their last pass and start them at another time after a restart (the pushes start 1 s and 15 s after boot).
 */
export function composeLoops(ctx: LoopContext) {
  const { uow, sql, loopSettings, leadSettings, planningEnv, planning, leads, intake, checkpoints, checkpointDeps } =
    ctx
  const { repos, projects, checkout, ci, settings } = ctx
  const writes = { uow, clock: ctx.clock, ids: ctx.ids }
  const quotaAtReset = ledgerQuotaReader()
  const said = createSaid()
  const wiring = (name: keyof LoopSettings['intervalMs']): LoopWiring => ({
    intervalMs: loopSettings.intervalMs[name],
    said,
  })
  const changedBy = (name: keyof LoopSettings['intervalMs']) => () => runner.changed(name)
  const file: Parameters<typeof frictionLoop>[1]['file'] = (body, finding) => intake.api.file(body, 'agent', finding)
  const github = { token: ctx.github.token, apiUrl: ctx.github.apiUrl }
  const locate = (repo: string) => repos.locate(repo)
  const projectBudgets = () => readProjectBudgets(uow)
  const passOf = async (run: () => Promise<{ ok: boolean; error?: unknown }>, what: string) => {
    const result = await run()
    return result.ok ? ok(`${what} ran`) : err(portError('refused', JSON.stringify(result.error)))
  }
  const ciLive = githubCiLive({ locate, ...github })
  const resumeRules = resumeRulesOf({
    delaysMs: leadSettings.resumeDelaysMs,
    staggerMs: leadSettings.resumeStaggerMs,
  })
  const slots = () => uow.run(async ({ capacity }) => ok(await capacity.slots()))

  // The host loop's readers: one metered runner for every helper, so the CPU they take is the collector's cost, stored each minute.
  const hostRunner = textRunner(5_000)
  const { lsofBin, psBin } = planningEnv
  // Its own reader: the swapout rate of a minute sample counts from the last sample, not from an admission's reading.
  const hostSamples = hostWatch({
    host: hostReader({ sysctlBin: planningEnv.sysctlBin, minSampleMs: 0 }),
    sysctlBin: planningEnv.sysctlBin,
    psBin,
    topBin: planningEnv.topBin,
    vmStatBin: planningEnv.vmStatBin,
    runner: hostRunner,
  })
  const hostCwds = sharedCwds({ runner: hostRunner, lsofBin })
  const diskHost = hostReader({ sysctlBin: planningEnv.sysctlBin, minSampleMs: 0 })

  const desk = deskLoop(wiring('desk'), {
    settle: checkpointDeps,
    desk: uow,
    push: askHumanPush({ bin: loopSettings.askHumanBin, home: leadSettings.home, host: loopSettings.askHumanHost }),
    sync: askHumanSync({ host: loopSettings.askHumanHost }),
  })

  const specs: LoopSpec[] = [
    passLoop(wiring('leads'), {
      name: 'leads',
      onChange: true,
      // A worktree made or removed takes minutes and must not hold the next pass back.
      maxPasses: 4,
      pass: () => leads.tick(ctx.draining),
      summary: (t) =>
        `spool ${t.replayed} lines, ${t.lost} lead(s) lost, outbox ${JSON.stringify(t.outbox)}, api errors ${JSON.stringify(t.apiErrors)}`,
    }),
    passLoop(wiring('planning'), {
      name: 'planning',
      onChange: true,
      pass: async () => ok(await planning.pass()),
      problems: (problems) => problems,
      summary: (problems) =>
        problems.length ? `${problems.length} problem(s): ${problems.slice(0, 3).join(' | ')}` : 'planned and admitted',
    }),
    // The Watch's checks run on a loop of their own, so a `make verify` of minutes never holds the leads' tick.
    passLoop(wiring('watch'), {
      name: 'watch',
      pass: () =>
        checkWatches({
          ...writes,
          projects,
          checkout,
          proof: new MakeAndProbes({ ci }),
          timing: { ...DEFAULT_TIMING, retryMs: settings.quality.retryMs, recheckMs: settings.quality.recheckMs },
          settledAt: new Date(ctx.startedAt.getTime() + settings.quality.settleMs),
          signal: ctx.draining,
        }),
      summary: (w) => `checked ${w.checked}, passed ${w.passed}, regressed ${w.regressed}`,
    }),
    {
      name: 'settle',
      intervalMs: loopSettings.intervalMs.settle,
      onChange: true,
      run: async () => {
        const settled = await passOf(() => checkpoints.settle(), 'the settle pass')
        // an Errand this pass let through to the owner has its dialog pushed now: the desk pass is due for a command never pushed
        const open = await uow.run(async ({ errands: store }) => ok(await store.openErrands(500)))
        if (open.ok && hasUnpushed(open.value)) deskOnReturn()
        return settled
      },
    },
    passLoop(wiring('send'), {
      name: 'send',
      onChange: true,
      pass: () => passOf(() => checkpoints.send(), 'the send pass'),
      summary: (line) => line,
    }),
    stewardLoop(wiring('steward'), {
      ...writes,
      agw: ctx.agw,
      seats: planning.leads.seats,
      windows: planning.leads.windows,
      checkpoints: {
        ...writes,
        blobs: fileBlobStore(ctx.checkpointSettings.blobDir),
        consoleUrl: ctx.checkpointSettings.line.consoleUrl,
        checks: shellCheckRunner(),
      },
      planning: writes,
      claimQueued: planning.claimQueued,
      claimStalled: planning.claimStalled,
      claimStallMs: loopSettings.claimStallMs,
      slots,
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
      findings: ctx.mainCheckoutLines,
      resume: resumeRules,
      changed: changedBy('steward'),
    }),
    triageLoop(wiring('triage'), {
      ...writes,
      agw: ctx.agw,
      planning: writes,
      retryMs: loopSettings.triageRetryMs,
      changed: changedBy('triage'),
    }),
    queueLoop(wiring('queue'), {
      uow,
      clock: writes.clock,
      agw: ctx.agw,
      planning: writes,
      retryMs: loopSettings.queueRetryMs,
      minGapMs: loopSettings.queueGapMs,
      changed: changedBy('queue'),
    }),
    frictionLoop(wiring('friction'), {
      ...writes,
      friction: (now) => readFriction(sql, { now, days: FRICTION_WINDOW_DAYS, epoch: ctx.epoch }),
      // the seven KPIs over the pass's window, judged against their targets; the accounts' reset ledger gives quota_at_reset
      kpis: (window) => kpisOfWindow(sql, window, { now: window.to, quotaAtReset }),
      evidence: (now, keys) => readFrictionEvidence(sql, { now, days: FRICTION_WINDOW_DAYS, epoch: ctx.epoch }, keys),
      closedSince: (since, now) => readClosedSince(sql, { since, now }),
      retroFiledAt: () => readLastFiled(sql, RETRO_SUBJECT),
      retroOutcomes: (now, days) => readRetroOutcomes(sql, { now, days }),
      file,
    }),
    hygieneLoop(wiring('hygiene'), {
      ...writes,
      checker: createHygieneChecker({ repos, workDir: ctx.dataDir }),
      doctor: ctx.doctor,
      agw: ctx.agw,
      file,
      everyMs: loopSettings.hygieneEveryMs,
      dailyMs: loopSettings.hygieneDailyMs,
      fixes: true,
      retryMs: loopSettings.hygieneRetryMs,
      repos: null,
    }),
    selfwatchLoop(wiring('selfwatch'), {
      ...writes,
      repo: SELFWATCH_REPO,
      branch: loopSettings.selfwatchBranch,
      graceMs: loopSettings.selfwatchGraceMs,
      idleLeadMs: loopSettings.idleLeadMs,
      idleBackgroundMs: loopSettings.idleBackgroundMs,
      slots,
      resume: resumeRules,
      ciLive,
      ci: githubCiRuns({ locate, ...github }),
      migrations: gitMigrationFiles(repos),
      sharedNumbers: SHARED_NUMBERS,
      processCap: DEFAULT_PROCESS_CAP,
      memoryCeilings: planningEnv.memoryCeilings,
      serverPid: process.pid,
      routes: () => ctx.routes.snapshot(),
      overload: hostOverload({ dataDir: ctx.dataDir }),
      budgets: async (now) => readBudgetFacts(sql, { now, budgets: await projectBudgets(), epoch: ctx.epoch }),
      heartbeat: () => confirmedHeartbeat(ctx.heartbeat, (ms) => Bun.sleep(ms)),
      file,
    }),
    ciLedgerLoop(wiring('ci-ledger'), {
      ...writes,
      projects: async () => (await projectBudgets()).map((b) => b.repo),
      always: [SELFWATCH_REPO],
      refused: new Map<string, number>(),
      ledger: githubCiLedger({ locate, ...github }),
    }),
    throughputLoop(wiring('throughput'), {
      ...writes,
      tenants: { project: planningEnv.tenantProject, budgetMib: planningEnv.tenantBudgetMib },
      epoch: ctx.epoch,
      projects: async () =>
        (await projectBudgets()).map((b) => ({
          project: b.project,
          repo: b.repo,
          peakMib: b.peakMib,
          shape: b.shape,
          path: b.path,
        })),
      facts: (window, options) => readWindowFacts(sql, { ...window, ...options, epoch: ctx.epoch }),
      caps: async (at, shapes) => {
        const disk = await diskHost.disk?.()
        const facts = await readCapFacts(sql, { to: at, shapes, disk: disk?.ok ? disk.value : null })
        const paths = new Map((await projectBudgets()).map((b) => [b.project, b.path]))
        return Promise.all(
          facts.map(async (fact) => {
            const path = paths.get(fact.project)
            return { ...fact, comment: path ? await readCapComment(path, fact.lane) : null }
          }),
        )
      },
      fates: (ids) => readIssueFates(sql, ids),
      file,
    }),
    screenLoop(wiring('screen'), {
      ...writes,
      agw: ctx.agw,
      openIssues: postgresOpenIssues(sql),
      projects: planning.signals,
      promote: intake.api.promote,
      dismiss: intake.api.dismiss,
    }),
    fixClassesLoop(wiring('fix-classes'), {
      ...writes,
      reader: createFixCommitReader({ repos }),
      repos: null,
    }),
    hostLoop(
      wiring('host'),
      {
        ...writes,
        sampler: hostSamples,
        processes: processTable({
          rows: () => hostSamples.rows(),
          footprints: () => hostSamples.footprints(),
          lsofBin,
          cwds: hostCwds,
        }),
        snapshot: hostSnapshot({
          top: () => hostSamples.topSnapshot(),
          cwds: hostCwds,
          runner: hostRunner,
          psBin,
          launchctlBin: planningEnv.launchctlBin,
          lsofBin,
          sysctlBin: planningEnv.sysctlBin,
          vmVolume: planningEnv.vmVolume,
        }),
        memory: freshHostMemory(),
        // What each attempt's worktree takes on disk, measured by this loop; the times it was last measured live here between passes.
        sizer: { reader: duSizer(), measuredAt: new Map<string, number>() },
        self: { pid: process.pid, dirs: [process.cwd()] },
        facts: planning.capacityFacts,
      },
      () =>
        slotAimPass({
          ...writes,
          slots: planningEnv.slots,
          slotsMax: planningEnv.slotsMax,
          loadCeiling: hostRule(planningEnv).loadCeiling,
          swapoutCeilingMb: planningEnv.memoryCeilings.swapoutMbPer300s,
          leadWaiters: async () => {
            const view = await planning.capacity.queue()
            return view.ok ? view.value.queue.filter((e) => e.reason?.part === 'aim').length : null
          },
        }),
    ),
    digestLoop(wiring('digest'), { ...writes }),
    errandsLoop(wiring('errands'), {
      ...writes,
      checks: shellCheckRunner(),
      agw: ctx.agw,
      // a request an Issue joined ends for that Issue too
      end: async (errand, how) => {
        const ended = await endRequest(checkpointDeps, errand.id, how)
        return ended.ok && ended.value
      },
      broken: async (errand, line) => {
        await tellCheckBroken(checkpointDeps, errand, line)
      },
    }),
    reviewsLoop(wiring('reviews'), {
      ...writes,
      port: prReview({ workGhConfigDir: loopSettings.ghConfigDirWork }),
    }),
    desk.spec,
    reaperLoop(wiring('reaper'), {
      ...writes,
      processes: ctx.reaperProcesses,
      killer: processKiller({ psBin }),
      graceMs: loopSettings.reaperGraceMs,
      protect: [1, process.pid],
    }),
  ]

  const runner: LoopRunner = createLoopRunner({
    loops: specs,
    clock: ctx.runnerClock,
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
  const deskRunning = () => runner.view().some((loop) => loop.name === 'desk' && loop.running)
  /** a desk pass in flight is not started again: the dialogs it pushes are the ones he gets */
  const pushDesk = (): { started: boolean } => {
    if (deskRunning()) return { started: false }
    desk.force()
    void runner.runNow('desk')
    return { started: true }
  }
  const deskOnReturn = () => {
    if (!deskRunning()) void runner.runNow('desk')
  }
  return { runner, pushDesk, deskOnReturn, hostTop: () => hostSamples.top() }
}
