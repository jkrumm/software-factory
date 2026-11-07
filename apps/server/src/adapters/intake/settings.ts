import { join } from 'node:path'
import * as z from 'zod'

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
  FACTORY_SOURCE_ROOT: z.string().min(1).optional(),
  FACTORY_INTAKE_PROJECTS_FILE: z.string().min(1).optional(),
  FACTORY_INFRA_FILE: z.string().min(1).optional(),
  FACTORY_HOME_REPO: z.string().min(1).optional(),
  FACTORY_INCIDENT_WINDOW_MIN: z.coerce.number().int().min(1).default(30),
  FACTORY_FINGERPRINT_WINDOW_MIN: z.coerce.number().int().min(1).default(1440),
  FACTORY_GITHUB_TOKEN: z.string().min(1).optional(),
  FACTORY_GITHUB_API_URL: z.string().min(1).default('https://api.github.com'),
  FACTORY_GITHUB_POLL: Every('5m'),
  FACTORY_BESZEL_URL: z.string().min(1).optional(),
  FACTORY_BESZEL_EMAIL: z.string().min(1).optional(),
  FACTORY_BESZEL_PASSWORD: z.string().min(1).optional(),
  FACTORY_BESZEL_POLL: Every('1m'),
  FACTORY_LAUNCHD_POLL: Every('5m'),
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
  github: { token: string | null; apiUrl: string; everyMs: number | null }
  beszel: { url: string | null; email: string | null; password: string | null; everyMs: number | null }
  launchd: { everyMs: number | null }
  settleEveryMs: number | null
}

const SHIPPED_INFRA = join(import.meta.dir, '..', '..', '..', '..', '..', 'config', 'infra.json')

/** The intake's settings from the environment; throws one message naming every bad key. */
export function loadIntakeEnv(env: Record<string, string | undefined>): IntakeEnv {
  const parsed = Env.safeParse(env)
  if (!parsed.success) {
    throw new Error(parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; '))
  }
  const e = parsed.data
  return {
    sourceRoot: e.FACTORY_SOURCE_ROOT ?? join(env.HOME ?? '/', 'SourceRoot'),
    projectsFile: e.FACTORY_INTAKE_PROJECTS_FILE ?? null,
    infraFile: e.FACTORY_INFRA_FILE ?? SHIPPED_INFRA,
    homeRepo: e.FACTORY_HOME_REPO ?? null,
    incidentWindowMs: e.FACTORY_INCIDENT_WINDOW_MIN * 60_000,
    fingerprintWindowMs: e.FACTORY_FINGERPRINT_WINDOW_MIN * 60_000,
    github: { token: e.FACTORY_GITHUB_TOKEN ?? null, apiUrl: e.FACTORY_GITHUB_API_URL, everyMs: e.FACTORY_GITHUB_POLL },
    beszel: {
      url: e.FACTORY_BESZEL_URL ?? null,
      email: e.FACTORY_BESZEL_EMAIL ?? null,
      password: e.FACTORY_BESZEL_PASSWORD ?? null,
      everyMs: e.FACTORY_BESZEL_POLL,
    },
    launchd: { everyMs: e.FACTORY_LAUNCHD_POLL },
    settleEveryMs: e.FACTORY_SETTLE_POLL,
  }
}
