import { availableParallelism } from 'node:os'
import { isAbsolute } from 'node:path'
import * as z from 'zod'
import { parseEnv, type Environment } from '../kernel/env.ts'
import {
  DEFAULT_LOAD_PER_CORE,
  DEFAULT_PROCESS_CAP,
  loadCeilingOf,
  DEFAULT_SWAP_CEILING_PCT,
  DEFAULT_SWAPOUT_CEILING_MB,
  type MemoryCeilings,
} from '../domains/capacity/host.ts'
import { DEFAULT_TENANT_BUDGET_MIB, DEFAULT_TENANT_PROJECT } from '../kernel/throughput-limits.ts'

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
  /** the load ceiling in multiples of the host's cores */
  FACTORY_LOAD_PER_CORE: whole(1, 1000).optional(),
  /** the cap on the host's process count */
  FACTORY_PROCESS_CAP: whole(100, 1_000_000).optional(),
  /** the most extra leads per account while the host idles with work queued; 0 turns it off */
  FACTORY_SEATS_MAX_BONUS: whole(0, 4).optional(),
  FACTORY_SLOTS: whole(1, 64).optional(),
  /** the most test steps at once when memory and load allow; below FACTORY_SLOTS it is FACTORY_SLOTS */
  FACTORY_SLOTS_MAX: whole(1, 64).optional(),
  /** the host load up to which a step beyond the base slots is granted */
  FACTORY_SLOT_EXTRA_LOAD: whole(1, 100_000).optional(),
  /** the ssh target of the VPS that runs steps off the mini (an alias of the owner's ssh config); unset: every step runs on the mini */
  FACTORY_STEP_REMOTE_TARGET: z
    .string()
    .regex(/^[A-Za-z0-9][A-Za-z0-9@._-]{0,99}$/, 'an ssh host alias or user@host')
    .optional(),
  /** the projects whose declared steps may run off the mini, space- or comma-separated (the owner's admission) */
  FACTORY_STEP_REMOTE_PROJECTS: z.string().optional(),
  /** the host tools the host loop, the reaper and the capacity reads run (a scenario points them at fakes) */
  FACTORY_SYSCTL_BIN: z.string().min(1).optional(),
  FACTORY_LSOF_BIN: z.string().min(1).optional(),
  FACTORY_PS_BIN: z.string().min(1).optional(),
  FACTORY_TOP_BIN: z.string().min(1).optional(),
  FACTORY_VM_STAT_BIN: z.string().min(1).optional(),
  FACTORY_LAUNCHCTL_BIN: z.string().min(1).optional(),
  /** the volume whose use is the host's swap */
  FACTORY_VM_VOLUME: z.string().min(1).optional(),
  /** a swapout rate is the delta between two readings; readings closer than this return the last one */
  FACTORY_MEMORY_SAMPLE_MS: whole(0, 3_600_000).optional(),
})

export interface PlanningSettings {
  repoRoots: string[]
  repoAllow: string[]
  gitTimeoutMs: number
  sysctlBin: string
  lsofBin: string
  psBin: string
  topBin: string
  vmStatBin: string | undefined
  launchctlBin: string
  vmVolume: string
  memorySampleMs: number
  leadsPerAccount: number
  /** each named account's own cap (`FACTORY_ACCOUNT_LEADS`); an account not in it takes `leadsPerAccount` */
  accountLeads: Map<string, number>
  loadPerCore: number
  processCap: number
  /** the host's cores: the load ceiling is a multiple of them, and the slot aim adds no slot above twice them in load */
  cores: number
  memoryCeilings: MemoryCeilings
  seatsMaxBonus: number
  slots: number
  slotsMax: number
  slotExtraLoad: number
  slotPassMs: number
  /** the VPS that runs steps off the mini and the projects admitted to it; null: every step runs on the mini */
  stepRemote: { target: string; projects: readonly string[] } | null
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
  env: Environment,
  options: { repoRoots?: readonly string[]; repoAllow?: readonly string[]; cores?: number } = {},
): PlanningSettings {
  const e = parseEnv(Env, env)
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
    gitTimeoutMs: 20_000,
    sysctlBin: e.FACTORY_SYSCTL_BIN ?? '/usr/sbin/sysctl',
    lsofBin: e.FACTORY_LSOF_BIN ?? '/usr/sbin/lsof',
    psBin: e.FACTORY_PS_BIN ?? '/bin/ps',
    topBin: e.FACTORY_TOP_BIN ?? '/usr/bin/top',
    vmStatBin: e.FACTORY_VM_STAT_BIN,
    launchctlBin: e.FACTORY_LAUNCHCTL_BIN ?? '/bin/launchctl',
    vmVolume: e.FACTORY_VM_VOLUME ?? '/System/Volumes/VM',
    memorySampleMs: e.FACTORY_MEMORY_SAMPLE_MS ?? 30_000,
    leadsPerAccount: e.FACTORY_LEADS_PER_ACCOUNT ?? 2,
    accountLeads: accountLeadsOf(e.FACTORY_ACCOUNT_LEADS),
    loadPerCore: e.FACTORY_LOAD_PER_CORE ?? DEFAULT_LOAD_PER_CORE,
    processCap: e.FACTORY_PROCESS_CAP ?? DEFAULT_PROCESS_CAP,
    cores: options.cores ?? availableParallelism(),
    memoryCeilings: {
      swapoutMbPer300s: DEFAULT_SWAPOUT_CEILING_MB,
      swapUsedPct: DEFAULT_SWAP_CEILING_PCT,
    },
    seatsMaxBonus: e.FACTORY_SEATS_MAX_BONUS ?? 2,
    slots: e.FACTORY_SLOTS ?? 2,
    slotsMax: Math.max(e.FACTORY_SLOTS ?? 2, e.FACTORY_SLOTS_MAX ?? 6),
    slotExtraLoad: e.FACTORY_SLOT_EXTRA_LOAD ?? 12,
    slotPassMs: 10 * 60_000,
    stepRemote:
      e.FACTORY_STEP_REMOTE_TARGET === undefined
        ? null
        : {
            target: e.FACTORY_STEP_REMOTE_TARGET,
            projects: (e.FACTORY_STEP_REMOTE_PROJECTS ?? '').split(/[\s,]+/).filter((p) => p !== ''),
          },
    tenantBudgetMib: DEFAULT_TENANT_BUDGET_MIB,
    tenantProject: DEFAULT_TENANT_PROJECT,
  }
}

/** The load ceiling (the cores times `FACTORY_LOAD_PER_CORE`) and the cap on the host's process count that admission holds. */
export function hostRule(settings: Pick<PlanningSettings, 'loadPerCore' | 'processCap' | 'cores'>) {
  return { loadCeiling: loadCeilingOf(settings.cores, settings.loadPerCore), processCap: settings.processCap }
}
