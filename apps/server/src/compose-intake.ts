import type { SQL } from 'bun'
import { beszelPoller } from './adapters/intake/beszel.ts'
import { githubPoller } from './adapters/intake/github.ts'
import { launchdPoller } from './adapters/intake/launchd.ts'
import { fileProjectSignals, stubProjectSignals } from './adapters/intake/projects.ts'
import { makeRestartRunbook } from './adapters/intake/runbook.ts'
import { selfPaced } from './adapters/intake/schedule.ts'
import type { IntakeEnv } from './adapters/intake/settings.ts'
import { stubTriageWorkflow } from './adapters/intake/triage.ts'
import { infraTopology, loadInfra } from './adapters/intake/topology.ts'
import type { IntakeApi } from './api/intake.ts'
import { createIntake, type IntakeWrites } from './app/intake.ts'
import type { Clock } from './kernel/clock.ts'
import type { IdSource } from './kernel/ids.ts'
import { postgresOpenIssues } from './read/open-issues.ts'

export interface ComposedIntake {
  /** the routes' use cases */
  api: IntakeApi
  /** starts the pollers and the settle pass on their schedules */
  start(): void
  /** stops them and waits for the pass in flight */
  stop(): Promise<void>
}

/**
 * Intake's composition (the ports it needs and the adapters behind them), kept out of `main.ts` so that file gains
 * three lines. The stubs are honest: `stubProjectSignals` hears nothing until a package reads `project.yaml` (a JSON file
 * stands in when `FACTORY_INTAKE_PROJECTS_FILE` is set), and `stubTriageWorkflow` is package 7's `factory-triage`.
 */
export async function composeIntake(input: {
  sql: SQL
  uow: IntakeWrites
  env: IntakeEnv
  clock: Clock
  ids: IdSource
}): Promise<ComposedIntake> {
  const { env } = input
  const infra = await loadInfra(env.infraFile)
  const projects = env.projectsFile ? fileProjectSignals(env.projectsFile) : stubProjectSignals
  const intake = createIntake({
    uow: input.uow,
    clock: input.clock,
    ids: input.ids,
    projects,
    topology: infraTopology(infra),
    openIssues: postgresOpenIssues(input.sql),
    triage: stubTriageWorkflow,
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

  const stops: (() => Promise<void>)[] = []
  return {
    api: intake,
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
    async stop() {
      await Promise.all(stops.map((stop) => stop()))
    },
  }
}
