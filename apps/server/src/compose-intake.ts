import type { SQL } from 'bun'
import { beszelPoller } from './adapters/intake/beszel.ts'
import { githubPoller } from './adapters/intake/github.ts'
import { launchdPoller } from './adapters/intake/launchd.ts'
import { fileProjectSignals } from './adapters/intake/projects.ts'
import { makeRestartRunbook } from './adapters/intake/runbook.ts'
import { selfPaced } from './adapters/intake/schedule.ts'
import type { IntakeEnv } from './adapters/intake/settings.ts'
import { infraTopology, loadInfra } from './adapters/intake/topology.ts'
import type { ProjectSignals, TriageWorkflow } from './domains/intake/ports.ts'
import type { IntakeApi } from './api/intake.ts'
import { createIntake, type IntakeWrites } from './app/intake.ts'
import type { Clock } from './kernel/clock.ts'
import type { IdSource } from './kernel/ids.ts'
import { postgresOpenIssues } from './read/open-issues.ts'

export interface ComposedIntake {
  /** the routes' use cases */
  api: IntakeApi
  /** the door's health lines (a refused or silent source, an unrouted monitor that stays down); what the read API shows */
  doorLines(finishedMs: number): Promise<string[]>
  /** starts the pollers and the settle pass on their schedules */
  start(): void
  /** stops them and waits for the pass in flight, `graceMs` at most */
  stop(graceMs?: number): Promise<void>
}

/**
 * Intake's composition (the ports it needs and the adapters behind them), kept out of `main.ts` so that file gains
 * three lines. The projects come from planning's `project.yaml` reader (a JSON file overrides them when
 * `FACTORY_INTAKE_PROJECTS_FILE` is set), and the triage workflow is `factory-triage` through the agw port.
 */
export async function composeIntake(input: {
  sql: SQL
  uow: IntakeWrites
  env: IntakeEnv
  clock: Clock
  ids: IdSource
  /** the projects and what each hears: planning's `project.yaml` reader */
  projects: ProjectSignals
  /** `factory-triage` in amend mode (the agw port's), asked when the deterministic match is unsure */
  triage: TriageWorkflow
}): Promise<ComposedIntake> {
  const { env } = input
  const infra = await loadInfra(env.infraFile)
  // A JSON file named by the environment still wins, as an explicit override; otherwise the projects are planning's.
  const projects = env.projectsFile ? fileProjectSignals(env.projectsFile) : input.projects
  const intake = createIntake({
    uow: input.uow,
    clock: input.clock,
    ids: input.ids,
    projects,
    topology: infraTopology(infra),
    openIssues: postgresOpenIssues(input.sql),
    triage: input.triage,
    runbook: makeRestartRunbook({ sourceRoot: env.sourceRoot }),
    settings: {
      incidentWindowMs: env.incidentWindowMs,
      fingerprintWindowMs: env.fingerprintWindowMs,
      unroutedGraceMs: 10 * 60_000,
      homeRepo: env.homeRepo,
    },
  })

  const github = githubPoller({
    sink: intake.sink,
    projects,
    sourceRoot: env.sourceRoot,
    token: env.github.token,
    apiUrl: env.github.apiUrl,
    backlog: env.github.backlog,
    clock: input.clock,
  })
  const beszel = beszelPoller({
    sink: intake.sink,
    clock: input.clock,
    infra,
    url: env.beszel.url,
    email: env.beszel.email,
    password: env.beszel.password,
  })
  const launchd = launchdPoller({
    sink: intake.sink,
    projects,
    clock: input.clock,
    uid: process.getuid?.() ?? 0,
  })

  const stops: ((graceMs?: number) => Promise<void>)[] = []
  return {
    api: intake,
    async doorLines(finishedMs) {
      const lines = await intake.healthLines(finishedMs)
      if (!lines.ok) throw new Error(`the door's lines could not be read: ${JSON.stringify(lines.error)}`)
      return lines.value
    },
    start() {
      const settle = async () => {
        const out = await intake.settle()
        if (!out.ok) throw new Error(`settle failed: ${JSON.stringify(out.error)}`)
      }
      const jobs: [string, number | null, boolean, () => Promise<void>][] = [
        ['settle', env.settleEveryMs, true, settle],
        ['github intake', env.github.everyMs, github.enabled, () => github.pass()],
        ['beszel intake', env.beszel.everyMs, beszel.enabled, () => beszel.pass()],
        ['launchd intake', env.launchd.everyMs, launchd.enabled, () => launchd.pass()],
      ]
      for (const [name, every, enabled, pass] of jobs) {
        if (every !== null && enabled) stops.push(selfPaced(name, every, pass))
      }
    },
    async stop(graceMs) {
      await Promise.all(stops.map((stop) => stop(graceMs)))
    },
  }
}
