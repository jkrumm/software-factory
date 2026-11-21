import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { registryPath } from '@software-factory/accounts'
import * as z from 'zod'
import { parseEnv } from '../../kernel/env.ts'
import { RESUME_DELAYS_MS, STAGGER_MS } from '../../domains/leads/apierror.ts'
import { MAX_REVIVE_TRIES, QUIESCE_AFTER_MS } from '../../domains/leads/quiesce.ts'
import { TYPE_GAP_MS } from '../../domains/leads/type-gap.ts'

const Env = z.object({
  /** the home directory the defaults are built from; the one reader of it: the checkpoints, the intake and the ask queue take `home` from these settings */
  HOME: z.string().min(1),
  /** the herdr-core client (hc) that a lead terminal runs through */
  HC_BIN: z.string().min(1).optional(),
  /** another herdr-core session than the default one (tests) */
  HC_SESSION: z.string().min(1).optional(),
  /** the claude binary a lead runs; unset, the one on PATH */
  FACTORY_CLAUDE_BIN: z.string().min(1).optional(),
  /** colon-separated directories a lead repo must be inside; the one reader of it: planning takes `repoRoots` from these settings */
  FACTORY_REPO_ROOTS: z.string().min(1).optional(),
  /** colon-separated single repos a lead may work in, outside the roots; the one reader of it: planning takes `repoAllow` from these settings */
  FACTORY_REPO_ALLOW: z.string().min(1).optional(),
  /** the role table; config/roles.json of this checkout when unset */
  FACTORY_ROLES_FILE: z.string().min(1).optional(),
  /** the script that marks a lead's folder trusted before it starts */
  FACTORY_PRETRUST_BIN: z.string().min(1).optional(),
  /** where factory hook spools events until the server reads them */
  FACTORY_SPOOL_DIR: z.string().min(1).optional(),
  /** the unix socket factory hook posts events to */
  FACTORY_SOCKET: z.string().min(1).optional(),
  /** where a finished attempt's transcripts are archived */
  FACTORY_ARCHIVE_DIR: z.string().min(1).optional(),
  /** an attempt's archived transcripts are deleted this many days after they were archived; 0 keeps them */
  FACTORY_ARCHIVE_RETENTION_DAYS: z.coerce.number().int().min(0).optional(),
  /** after a restart, how long a live terminal may run no agent before its lead counts as lost */
  FACTORY_GRACE_MS: z.coerce.number().int().min(0).optional(),
  /** how long a lead's turn may read as ended before a note is typed into it anyway */
  FACTORY_FORCE_NOTE_MS: z.coerce.number().int().min(0).optional(),
  /** the waits before each `continue` after an API error, comma-separated ms (the length is the number of resumes) */
  FACTORY_API_RESUME_MS: z
    .string()
    .regex(/^\d+(,\d+){0,9}$/)
    .optional(),
  /** the gap between two notes or nudges typed into leads in the first minutes after a server start; 0 is off */
  FACTORY_TYPE_GAP_MS: z.coerce.number().int().min(0).optional(),
  /** a turn open and silent this long has its transcript read for an API error */
  FACTORY_API_DETECT_MS: z.coerce.number().int().min(0).optional(),
  /** how often a session's transcript is read for an API error, at most */
  FACTORY_API_PROBE_MS: z.coerce.number().int().min(0).optional(),
  /** a waiting lead is dormant (its `claude` ended) after this long */
  FACTORY_QUIESCE_AFTER_MS: z.coerce.number().int().min(0).optional(),
})

/** A lead's start is given up on after this long. */
const START_BUDGET_MS = 30 * 60_000

/** The tracked table of this checkout or release: `config/roles.json`. */
const DEFAULT_ROLES_FILE = fileURLToPath(new URL('../../../../../config/roles.json', import.meta.url))

export interface LeadSettings {
  hcBin: string
  hcSession: string | undefined
  claudeBin: string | undefined
  /** the directories a lead's repo must be inside */
  repoRoots: string[]
  /** single repos admitted outside the roots: absolute paths of the repos themselves */
  repoAllow: string[]
  rolesFile: string
  /** the account registry: where the package resolves it (`CLAUDE_ACCOUNTS_REGISTRY`, the per-user file, the legacy shared one) */
  accountsFile: string
  /** unset when dotfiles' script is not there: the folder-trust dialog is then the owner's */
  pretrustBin: string | undefined
  spoolDir: string
  socket: string
  archiveDir: string
  /** days an archived attempt is kept; 0 forever */
  archiveRetentionDays: number
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
  /** how long a lead's Issue waits, quiet, before its `claude` is ended */
  quiesceAfterMs: number
  /** failed resumes of a dormant session after which its lead is called gone */
  maxReviveTries: number
  /** `FACTORY_TOKEN` of a lead's terminal: the agent token, never the owner's; unset, the lead's CLI will answer 401 */
  agentToken: string | undefined
  /** `FACTORY_URL` of a lead's terminal: the API's loopback address; unset without a port */
  apiUrl: string | undefined
}

/** What a lead's terminal reaches the API with: the server's own settings (`settings.ts` reads `FACTORY_AGENT_TOKEN` and `PORT`). */
export interface LeadApi {
  agentToken?: string | undefined
  port?: number | undefined
}

/** The leads' settings from the environment; throws one message naming every bad key. */
export function loadLeadSettings(env: Record<string, string | undefined>, api: LeadApi = {}): LeadSettings {
  const e = parseEnv(Env, env)
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
    hcBin: e.HC_BIN ?? 'hc',
    hcSession: e.HC_SESSION,
    claudeBin: e.FACTORY_CLAUDE_BIN,
    repoRoots: roots,
    repoAllow: allow,
    rolesFile: e.FACTORY_ROLES_FILE ?? DEFAULT_ROLES_FILE,
    accountsFile: registryPath(),
    pretrustBin: e.FACTORY_PRETRUST_BIN ?? (existsSync(pretrust) ? pretrust : undefined),
    spoolDir: e.FACTORY_SPOOL_DIR ?? `${e.HOME}/.local/share/factory/spool`,
    socket: e.FACTORY_SOCKET ?? `${e.HOME}/.local/share/factory/hook.sock`,
    archiveDir: e.FACTORY_ARCHIVE_DIR ?? `${e.HOME}/.local/share/factory/archive`,
    archiveRetentionDays: e.FACTORY_ARCHIVE_RETENTION_DAYS ?? 90,
    home: e.HOME,
    startBudgetMs: START_BUDGET_MS,
    graceMs: e.FACTORY_GRACE_MS ?? 120_000,
    forceNoteAfterMs: e.FACTORY_FORCE_NOTE_MS ?? 5 * 60_000,
    resumeDelaysMs: e.FACTORY_API_RESUME_MS ? e.FACTORY_API_RESUME_MS.split(',').map(Number) : [...RESUME_DELAYS_MS],
    resumeStaggerMs: STAGGER_MS,
    typeGapMs: e.FACTORY_TYPE_GAP_MS ?? TYPE_GAP_MS,
    apiErrorDetectMs: e.FACTORY_API_DETECT_MS ?? 45_000,
    apiErrorProbeMs: e.FACTORY_API_PROBE_MS ?? 20_000,
    quiesceAfterMs: e.FACTORY_QUIESCE_AFTER_MS ?? QUIESCE_AFTER_MS,
    maxReviveTries: MAX_REVIVE_TRIES,
    agentToken: api.agentToken,
    apiUrl: api.port ? `http://127.0.0.1:${api.port}` : undefined,
  }
}
