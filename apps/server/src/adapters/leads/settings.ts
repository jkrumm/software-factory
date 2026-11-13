import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import * as z from 'zod'
import { RESUME_DELAYS_MS, STAGGER_MS } from '../../domains/leads/apierror.ts'
import { TYPE_GAP_MS } from '../../domains/leads/type-gap.ts'

const Env = z.object({
  HOME: z.string().min(1),
  FACTORY_TICK_MS: z.coerce.number().int().min(0).optional(),
  HC_BIN: z.string().min(1).optional(),
  HC_SESSION: z.string().min(1).optional(),
  FACTORY_CLAUDE_BIN: z.string().min(1).optional(),
  FACTORY_REPO_ROOTS: z.string().min(1).optional(),
  FACTORY_REPO_ALLOW: z.string().min(1).optional(),
  FACTORY_ROLES_FILE: z.string().min(1).optional(),
  FACTORY_ACCOUNTS_FILE: z.string().min(1).optional(),
  FACTORY_PRETRUST_BIN: z.string().min(1).optional(),
  FACTORY_SPOOL_DIR: z.string().min(1).optional(),
  FACTORY_SOCKET: z.string().min(1).optional(),
  FACTORY_ARCHIVE_DIR: z.string().min(1).optional(),
  FACTORY_START_BUDGET_MS: z.coerce.number().int().min(0).optional(),
  FACTORY_GRACE_MS: z.coerce.number().int().min(0).optional(),
  FACTORY_FORCE_NOTE_MS: z.coerce.number().int().min(0).optional(),
  /** the waits before each `continue` after an API error, comma-separated ms (the length is the number of resumes) */
  FACTORY_API_RESUME_MS: z
    .string()
    .regex(/^\d+(,\d+){0,9}$/)
    .optional(),
  FACTORY_API_STAGGER_MS: z.coerce.number().int().min(0).optional(),
  /** the gap between two notes or nudges typed into leads in the first minutes after a server start; 0 is off */
  FACTORY_TYPE_GAP_MS: z.coerce.number().int().min(0).optional(),
  FACTORY_API_DETECT_MS: z.coerce.number().int().min(0).optional(),
  FACTORY_API_PROBE_MS: z.coerce.number().int().min(0).optional(),
  /** the agent token (`settings.ts`) and the API port: what a lead's `factory` calls the API with */
  FACTORY_AGENT_TOKEN: z.string().min(1).optional(),
  PORT: z.coerce.number().int().min(1).max(65_535).optional(),
})

/** The tracked table of this checkout or release: `config/roles.json`. */
const DEFAULT_ROLES_FILE = fileURLToPath(new URL('../../../../../config/roles.json', import.meta.url))

export interface LeadSettings {
  /** the lead tick's interval; 0 turns the tick off (the scenarios drive it) */
  tickMs: number
  hcBin: string
  hcSession: string | undefined
  claudeBin: string | undefined
  /** the directories a lead's repo must be inside */
  repoRoots: string[]
  /** single repos admitted outside the roots: absolute paths of the repos themselves */
  repoAllow: string[]
  rolesFile: string
  accountsFile: string
  /** unset when dotfiles' script is not there: the folder-trust dialog is then the owner's */
  pretrustBin: string | undefined
  spoolDir: string
  socket: string
  archiveDir: string
  home: string
  startBudgetMs: number
  graceMs: number
  forceNoteAfterMs: number
  /** the waits before each `continue` after a transient API error: 1 min, 3, 10, 10, 10 */
  resumeDelaysMs: number[]
  /** between two `continue`s into the leads of one edge incident */
  resumeStaggerMs: number
  /** between two notes or nudges typed into leads after a server start (`app/type-pace.ts`) */
  typeGapMs: number
  /** a turn open and silent this long has the end of its transcript read for an API error */
  apiErrorDetectMs: number
  /** a session's transcript is read at most this often */
  apiErrorProbeMs: number
  /** `FACTORY_TOKEN` of a lead's terminal: the agent token, never the owner's; unset, the lead's CLI will answer 401 */
  agentToken: string | undefined
  /** `FACTORY_URL` of a lead's terminal: the API's loopback address; unset without a `PORT` */
  apiUrl: string | undefined
}

/** The leads' settings from the environment; throws one message naming every bad key. */
export function loadLeadSettings(env: Record<string, string | undefined>): LeadSettings {
  const parsed = Env.safeParse(env)
  if (!parsed.success) {
    throw new Error(parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; '))
  }
  const e = parsed.data
  const roots = (e.FACTORY_REPO_ROOTS ?? `${e.HOME}/SourceRoot`).split(':')
  if (roots.some((root) => !root.startsWith('/'))) {
    throw new Error(`FACTORY_REPO_ROOTS must be colon-separated absolute paths, got: ${e.FACTORY_REPO_ROOTS}`)
  }
  const allow = (e.FACTORY_REPO_ALLOW ?? '').split(':').filter(Boolean)
  if (allow.some((repo) => !repo.startsWith('/'))) {
    throw new Error(`FACTORY_REPO_ALLOW must be colon-separated absolute paths, got: ${e.FACTORY_REPO_ALLOW}`)
  }
  const pretrust = e.FACTORY_PRETRUST_BIN ?? `${e.HOME}/SourceRoot/dotfiles/scripts/claude-pretrust.sh`
  return {
    tickMs: e.FACTORY_TICK_MS ?? 10_000,
    hcBin: e.HC_BIN ?? 'hc',
    hcSession: e.HC_SESSION,
    claudeBin: e.FACTORY_CLAUDE_BIN,
    repoRoots: roots,
    repoAllow: allow,
    rolesFile: e.FACTORY_ROLES_FILE ?? DEFAULT_ROLES_FILE,
    accountsFile: e.FACTORY_ACCOUNTS_FILE ?? `${e.HOME}/SourceRoot/dotfiles/config/claude-accounts.json`,
    pretrustBin: e.FACTORY_PRETRUST_BIN ?? (existsSync(pretrust) ? pretrust : undefined),
    spoolDir: e.FACTORY_SPOOL_DIR ?? `${e.HOME}/.local/share/factory/spool`,
    socket: e.FACTORY_SOCKET ?? `${e.HOME}/.local/share/factory/hook.sock`,
    archiveDir: e.FACTORY_ARCHIVE_DIR ?? `${e.HOME}/.local/share/factory/archive`,
    home: e.HOME,
    startBudgetMs: e.FACTORY_START_BUDGET_MS ?? 30 * 60_000,
    graceMs: e.FACTORY_GRACE_MS ?? 120_000,
    forceNoteAfterMs: e.FACTORY_FORCE_NOTE_MS ?? 5 * 60_000,
    resumeDelaysMs: e.FACTORY_API_RESUME_MS ? e.FACTORY_API_RESUME_MS.split(',').map(Number) : [...RESUME_DELAYS_MS],
    resumeStaggerMs: e.FACTORY_API_STAGGER_MS ?? STAGGER_MS,
    typeGapMs: e.FACTORY_TYPE_GAP_MS ?? TYPE_GAP_MS,
    apiErrorDetectMs: e.FACTORY_API_DETECT_MS ?? 45_000,
    apiErrorProbeMs: e.FACTORY_API_PROBE_MS ?? 20_000,
    agentToken: e.FACTORY_AGENT_TOKEN,
    apiUrl: e.PORT ? `http://127.0.0.1:${e.PORT}` : undefined,
  }
}
