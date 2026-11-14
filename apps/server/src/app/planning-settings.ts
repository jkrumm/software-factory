import { availableParallelism } from 'node:os'
import { isAbsolute } from 'node:path'
import * as z from 'zod'
import {
  DEFAULT_LOAD_CEILING,
  DEFAULT_LOAD_PER_CORE,
  DEFAULT_PROCESS_CAP,
  loadCeilingOf,
  DEFAULT_SWAP_CEILING_PCT,
  DEFAULT_SWAPOUT_CEILING_MB,
  type MemoryCeilings,
} from '../domains/capacity/host.ts'
import { DEFAULT_TENANT_BUDGET_MIB, DEFAULT_TENANT_PROJECT } from '../kernel/throughput-limits.ts'
import { DEFAULT_WINDOW_LIMIT, type WindowLimits } from '../domains/capacity/accounts.ts'
import type { AimMode } from '../domains/capacity/slot-aim.ts'

const whole = (min: number, max: number) => z.coerce.number().int().min(min).max(max)

const Env = z.object({
  /** `FACTORY_REPO_ROOTS`: directories whose direct children are the repos the factory may read as projects */
  FACTORY_REPO_ROOTS: z.string().optional(),
  /** `FACTORY_REPO_ALLOW`: single repos outside the roots the factory may read as projects (absolute paths) */
  FACTORY_REPO_ALLOW: z.string().optional(),
  /** the cap of an account `FACTORY_ACCOUNT_LEADS` does not name */
  FACTORY_LEADS_PER_ACCOUNT: whole(1, 64).optional(),
  /** an account's own cap: `iu=20,me=10,me2=10` */
  FACTORY_ACCOUNT_LEADS: z.string().optional(),
  /** an account takes new leads until its 5-hour window / week is at this percent (default 100: reached, not reserved) */
  FACTORY_FIVE_HOUR_LIMIT: whole(1, 100).optional(),
  FACTORY_WEEKLY_LIMIT: whole(1, 100).optional(),
  FACTORY_LOAD_CEILING: whole(1, 100_000).optional(),
  /** `shadow` (default): the fixed ceiling is live and the throughput rule is only recorded; `on`: the throughput rule is live */
  FACTORY_LOAD_RULE: z.enum(['shadow', 'on']).optional(),
  /** the throughput rule's load ceiling in multiples of the host's cores */
  FACTORY_LOAD_PER_CORE: whole(1, 1000).optional(),
  /** the throughput rule's cap on the host's process count */
  FACTORY_PROCESS_CAP: whole(100, 1_000_000).optional(),
  FACTORY_SWAPOUT_CEILING_MB: whole(1, 10_000_000).optional(),
  FACTORY_SWAP_CEILING_PCT: whole(1, 1000).optional(),
  /** the most extra leads per account while the host idles with work queued; 0 turns it off */
  FACTORY_SEATS_MAX_BONUS: whole(0, 4).optional(),
  FACTORY_SLOTS: whole(1, 64).optional(),
  /** the most test steps at once when memory and load allow; below FACTORY_SLOTS it is FACTORY_SLOTS */
  FACTORY_SLOTS_MAX: whole(1, 64).optional(),
  /** the host load up to which a step beyond the base slots is granted */
  FACTORY_SLOT_EXTRA_LOAD: whole(1, 100_000).optional(),
  /** the slot count that follows memory pressure: `off`, `shadow` (record beside the live rule, the default) or `on` */
  FACTORY_SLOT_AIM: z.enum(['off', 'shadow', 'on']).optional(),
  /** the tenant class's budget in MiB: the daily throughput ranking files the class's average footprint above it */
  FACTORY_TENANT_BUDGET_MIB: whole(1, 10_000_000).optional(),
  /** the repo that owns the host's configuration, where tenant findings are filed */
  FACTORY_TENANT_PROJECT: z.string().min(1).optional(),
  FACTORY_CLAUDE_ACCOUNT_BIN: z.string().min(1).optional(),
  FACTORY_SYSCTL_BIN: z.string().min(1).optional(),
  /** a swapout rate is the delta between two readings; readings closer than this return the last one */
  FACTORY_MEMORY_SAMPLE_MS: whole(0, 3_600_000).optional(),
  FACTORY_GIT_TIMEOUT_MS: whole(1000, 600_000).optional(),
})

export interface PlanningSettings {
  repoRoots: string[]
  repoAllow: string[]
  gitTimeoutMs: number
  claudeAccountBin: string
  sysctlBin: string
  memorySampleMs: number
  leadsPerAccount: number
  /** each named account's own cap (`FACTORY_ACCOUNT_LEADS`); an account not in it takes `leadsPerAccount` */
  accountLeads: Map<string, number>
  /** the percent of a window at which an account takes no new lead */
  windowLimits: WindowLimits
  /** the fixed load ceiling (`FACTORY_LOAD_CEILING`); live while the throughput rule is in shadow */
  loadCeiling: number
  loadRule: 'shadow' | 'on'
  loadPerCore: number
  processCap: number
  /** the host's cores: the throughput rule's load ceiling is a multiple of them, and the slot aim adds no slot above twice them in load */
  cores: number
  memoryCeilings: MemoryCeilings
  seatsMaxBonus: number
  slots: number
  slotsMax: number
  slotExtraLoad: number
  slotAim: AimMode
  /** the tenant class's budget (launchd jobs and VMs), MiB; over it, the daily ranking files a finding */
  tenantBudgetMib: number
  /** where tenant findings are filed: a tenant is a job or VM no project's lead can shrink */
  tenantProject: string
}

const ACCOUNT_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/

/** `iu=20,me=10`: each account's cap; throws on a name that is no account's, a cap outside 1..64 or a name twice. */
function accountLeadsOf(text: string | undefined): Map<string, number> {
  const caps = new Map<string, number>()
  for (const part of (text ?? '').split(',').map((p) => p.trim())) {
    if (part === '') continue
    const [name, value, ...rest] = part.split('=').map((p) => p.trim())
    const cap = Number(value)
    if (!name || !ACCOUNT_NAME.test(name) || rest.length > 0 || !Number.isInteger(cap) || cap < 1 || cap > 64) {
      throw new Error(`FACTORY_ACCOUNT_LEADS: "${part}" is not <account>=<1..64>`)
    }
    if (caps.has(name)) throw new Error(`FACTORY_ACCOUNT_LEADS: ${name} is named twice`)
    caps.set(name, cap)
  }
  return caps
}

/** The planning and capacity settings from the environment; throws one message naming every bad key. */
export function planningSettings(
  env: Record<string, string | undefined>,
  options: { home?: string; repoRoots?: readonly string[]; repoAllow?: readonly string[]; cores?: number } = {},
): PlanningSettings {
  const home = options.home ?? env.HOME ?? '/'
  const parsed = Env.safeParse(env)
  if (!parsed.success) {
    throw new Error(parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; '))
  }
  const e = parsed.data
  // One setting, one meaning: the leads read FACTORY_REPO_ROOTS too, and their default stands when it is not set.
  const repoRoots = e.FACTORY_REPO_ROOTS
    ? e.FACTORY_REPO_ROOTS.split(':')
        .map((root) => root.trim())
        .filter(Boolean)
    : [...(options.repoRoots ?? [])]
  const relative = repoRoots.find((root) => !isAbsolute(root))
  if (relative) throw new Error(`FACTORY_REPO_ROOTS: ${relative} is not an absolute path`)
  const repoAllow = e.FACTORY_REPO_ALLOW
    ? e.FACTORY_REPO_ALLOW.split(':')
        .map((repo) => repo.trim())
        .filter(Boolean)
    : [...(options.repoAllow ?? [])]
  const relativeAllow = repoAllow.find((repo) => !isAbsolute(repo))
  if (relativeAllow) throw new Error(`FACTORY_REPO_ALLOW: ${relativeAllow} is not an absolute path`)
  return {
    repoRoots,
    repoAllow,
    gitTimeoutMs: e.FACTORY_GIT_TIMEOUT_MS ?? 20_000,
    claudeAccountBin: e.FACTORY_CLAUDE_ACCOUNT_BIN ?? `${home}/.local/bin/claude-account`,
    sysctlBin: e.FACTORY_SYSCTL_BIN ?? '/usr/sbin/sysctl',
    memorySampleMs: e.FACTORY_MEMORY_SAMPLE_MS ?? 30_000,
    leadsPerAccount: e.FACTORY_LEADS_PER_ACCOUNT ?? 2,
    accountLeads: accountLeadsOf(e.FACTORY_ACCOUNT_LEADS),
    windowLimits: {
      fiveHour: e.FACTORY_FIVE_HOUR_LIMIT ?? DEFAULT_WINDOW_LIMIT,
      weekly: e.FACTORY_WEEKLY_LIMIT ?? DEFAULT_WINDOW_LIMIT,
    },
    loadCeiling: e.FACTORY_LOAD_CEILING ?? DEFAULT_LOAD_CEILING,
    loadRule: e.FACTORY_LOAD_RULE ?? 'shadow',
    loadPerCore: e.FACTORY_LOAD_PER_CORE ?? DEFAULT_LOAD_PER_CORE,
    processCap: e.FACTORY_PROCESS_CAP ?? DEFAULT_PROCESS_CAP,
    cores: options.cores ?? availableParallelism(),
    memoryCeilings: {
      swapoutMbPer300s: e.FACTORY_SWAPOUT_CEILING_MB ?? DEFAULT_SWAPOUT_CEILING_MB,
      swapUsedPct: e.FACTORY_SWAP_CEILING_PCT ?? DEFAULT_SWAP_CEILING_PCT,
    },
    seatsMaxBonus: e.FACTORY_SEATS_MAX_BONUS ?? 2,
    slots: e.FACTORY_SLOTS ?? 2,
    slotsMax: Math.max(e.FACTORY_SLOTS ?? 2, e.FACTORY_SLOTS_MAX ?? 6),
    slotExtraLoad: e.FACTORY_SLOT_EXTRA_LOAD ?? 12,
    slotAim: e.FACTORY_SLOT_AIM ?? 'shadow',
    tenantBudgetMib: e.FACTORY_TENANT_BUDGET_MIB ?? DEFAULT_TENANT_BUDGET_MIB,
    tenantProject: e.FACTORY_TENANT_PROJECT ?? DEFAULT_TENANT_PROJECT,
  }
}

/**
 * The load ceiling and process cap in force, and the rule shadowed beside them. In `shadow` the fixed ceiling is live, no
 * process cap applies, and the throughput rule (multiples of the cores, the cap) is recorded per minute; in `on` the
 * throughput rule is live and nothing is shadowed.
 */
export function hostRule(
  settings: Pick<PlanningSettings, 'loadCeiling' | 'loadRule' | 'loadPerCore' | 'processCap' | 'cores'>,
) {
  const throughput = {
    loadCeiling: loadCeilingOf(settings.cores, settings.loadPerCore),
    processCap: settings.processCap,
  }
  return settings.loadRule === 'on'
    ? { loadCeiling: throughput.loadCeiling, processCap: throughput.processCap as number | null, shadow: null }
    : { loadCeiling: settings.loadCeiling, processCap: null as number | null, shadow: throughput }
}
