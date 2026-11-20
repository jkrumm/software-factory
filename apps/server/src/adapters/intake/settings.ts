import { join } from 'node:path'
import * as z from 'zod'
import { parseEnv, type Environment } from '../../kernel/env.ts'
import { GITHUB_API } from '../github/reader.ts'

/** `30s`, `5m`, `2h`, `off`: how often a poller or the settle pass runs; null is off. */
export function everyMs(text: string): number | null | undefined {
  if (text === 'off') return null
  const found = /^(\d{1,6})(ms|s|m|h)$/.exec(text)
  if (!found) return undefined
  const unit = { ms: 1, s: 1000, m: 60_000, h: 3_600_000 }[found[2] as 'ms' | 's' | 'm' | 'h']
  return Number(found[1]) * unit
}

const Every = (fallback: string) =>
  z
    .string()
    .default(fallback)
    .transform((text, ctx) => {
      const ms = everyMs(text)
      if (ms === undefined)
        ctx.addIssue({ code: 'custom', message: `${text} is not a duration like 30s, 5m, 2h or off` })
      return ms ?? null
    })

const Env = z.object({
  /** the directory a repo name is under; SourceRoot in the home directory when unset */
  FACTORY_SOURCE_ROOT: z.string().min(1).optional(),
  /** a JSON file of the projects and what each one hears, until the project list comes from project.yaml */
  FACTORY_INTAKE_PROJECTS_FILE: z.string().min(1).optional(),
  /** the infra table; config/infra.json unless the owner names a copy */
  FACTORY_INFRA_FILE: z.string().min(1).optional(),
  /** the repo an alert no repo hears is filed to, for the owner to pick its repo */
  FACTORY_HOME_REPO: z.string().min(1).optional(),
  /** the window in minutes within which alerts count as one incident */
  FACTORY_INCIDENT_WINDOW_MIN: z.coerce.number().int().min(1).default(30),
  /** the token the GitHub reader uses; without it nothing is read */
  FACTORY_GITHUB_TOKEN: z.string().min(1).optional(),
  /** the GitHub API base the reader calls; a scenario points it at a fake */
  FACTORY_GITHUB_API_URL: z.string().min(1).default(GITHUB_API),
  /** how often the GitHub reader polls; off disables it */
  FACTORY_GITHUB_POLL: Every('5m'),
  /** whether the GitHub reader also takes the backlog (1) or not (0) */
  FACTORY_GITHUB_BACKLOG: z.enum(['0', '1']).default('0'),
  /** how often the launchd jobs are read; off disables it */
  FACTORY_LAUNCHD_POLL: Every('5m'),
  /** how often the intake's settle pass runs; off disables it */
  FACTORY_SETTLE_POLL: Every('10s'),
})

export interface IntakeEnv {
  /** the directory a repo name is under (`~/SourceRoot`) */
  sourceRoot: string
  /** a JSON file of the projects and what each hears, until the package that reads `project.yaml` brings the real list */
  projectsFile: string | null
  /** `config/infra.json` or the owner's copy */
  infraFile: string
  homeRepo: string | null
  incidentWindowMs: number
  fingerprintWindowMs: number
  github: { token: string | null; apiUrl: string; everyMs: number | null; backlog: boolean }
  launchd: { everyMs: number | null }
  settleEveryMs: number | null
}

/** A signal that repeats within this long is one finding. */
const FINGERPRINT_WINDOW_MS = 24 * 3_600_000

const SHIPPED_INFRA = join(import.meta.dir, '..', '..', '..', '..', '..', 'config', 'infra.json')

/** The intake's settings from the environment; throws one message naming every bad key. */
export function loadIntakeEnv(env: Environment, options: { home: string }): IntakeEnv {
  const e = parseEnv(Env, env)
  return {
    sourceRoot: e.FACTORY_SOURCE_ROOT ?? join(options.home, 'SourceRoot'),
    projectsFile: e.FACTORY_INTAKE_PROJECTS_FILE ?? null,
    infraFile: e.FACTORY_INFRA_FILE ?? SHIPPED_INFRA,
    homeRepo: e.FACTORY_HOME_REPO ?? null,
    incidentWindowMs: e.FACTORY_INCIDENT_WINDOW_MIN * 60_000,
    fingerprintWindowMs: FINGERPRINT_WINDOW_MS,
    github: {
      token: e.FACTORY_GITHUB_TOKEN ?? null,
      apiUrl: e.FACTORY_GITHUB_API_URL,
      everyMs: e.FACTORY_GITHUB_POLL,
      backlog: e.FACTORY_GITHUB_BACKLOG === '1',
    },
    launchd: { everyMs: e.FACTORY_LAUNCHD_POLL },
    settleEveryMs: e.FACTORY_SETTLE_POLL,
  }
}
