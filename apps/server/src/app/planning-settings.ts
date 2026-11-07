import { isAbsolute } from 'node:path'
import * as z from 'zod'
import {
  DEFAULT_LOAD_CEILING,
  DEFAULT_SWAP_CEILING_PCT,
  DEFAULT_SWAPOUT_CEILING_MB,
  type MemoryCeilings,
} from '../domains/capacity/host.ts'

const whole = (min: number, max: number) => z.coerce.number().int().min(min).max(max)

const Env = z.object({
  /** `FACTORY_REPO_ROOTS`: directories whose direct children are the repos the factory may read as projects */
  FACTORY_REPO_ROOTS: z.string().optional(),
  FACTORY_LEADS_PER_ACCOUNT: whole(1, 16).optional(),
  FACTORY_LOAD_CEILING: whole(1, 100_000).optional(),
  FACTORY_SWAPOUT_CEILING_MB: whole(1, 10_000_000).optional(),
  FACTORY_SWAP_CEILING_PCT: whole(1, 1000).optional(),
  FACTORY_SLOTS: whole(1, 64).optional(),
  FACTORY_CLAUDE_ACCOUNT_BIN: z.string().min(1).optional(),
  FACTORY_SYSCTL_BIN: z.string().min(1).optional(),
  /** a swapout rate is the delta between two readings; readings closer than this return the last one */
  FACTORY_MEMORY_SAMPLE_MS: whole(0, 3_600_000).optional(),
  FACTORY_GIT_TIMEOUT_MS: whole(1000, 600_000).optional(),
})

export interface PlanningSettings {
  repoRoots: string[]
  gitTimeoutMs: number
  claudeAccountBin: string
  sysctlBin: string
  memorySampleMs: number
  leadsPerAccount: number
  loadCeiling: number
  memoryCeilings: MemoryCeilings
  slots: number
}

/** The planning and capacity settings from the environment; throws one message naming every bad key. */
export function planningSettings(env: Record<string, string | undefined>, home = env.HOME ?? '/'): PlanningSettings {
  const parsed = Env.safeParse(env)
  if (!parsed.success) {
    throw new Error(parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; '))
  }
  const e = parsed.data
  const repoRoots = (e.FACTORY_REPO_ROOTS ?? '')
    .split(':')
    .map((root) => root.trim())
    .filter(Boolean)
  const relative = repoRoots.find((root) => !isAbsolute(root))
  if (relative) throw new Error(`FACTORY_REPO_ROOTS: ${relative} is not an absolute path`)
  return {
    repoRoots,
    gitTimeoutMs: e.FACTORY_GIT_TIMEOUT_MS ?? 20_000,
    claudeAccountBin: e.FACTORY_CLAUDE_ACCOUNT_BIN ?? `${home}/.local/bin/claude-account`,
    sysctlBin: e.FACTORY_SYSCTL_BIN ?? '/usr/sbin/sysctl',
    memorySampleMs: e.FACTORY_MEMORY_SAMPLE_MS ?? 30_000,
    leadsPerAccount: e.FACTORY_LEADS_PER_ACCOUNT ?? 2,
    loadCeiling: e.FACTORY_LOAD_CEILING ?? DEFAULT_LOAD_CEILING,
    memoryCeilings: {
      swapoutMbPer300s: e.FACTORY_SWAPOUT_CEILING_MB ?? DEFAULT_SWAPOUT_CEILING_MB,
      swapUsedPct: e.FACTORY_SWAP_CEILING_PCT ?? DEFAULT_SWAP_CEILING_PCT,
    },
    slots: e.FACTORY_SLOTS ?? 2,
  }
}
