import { createHash } from 'node:crypto'
import { realpathSync } from 'node:fs'
import type { Effort, Tier } from '@software-factory/contract'
import { z } from 'zod'
import type { Clock } from './clock.ts'

export interface StartInput {
  key: string
  repo: string
  /** the path whose space the tab goes into (FL6); the repo when absent. A fan worker's worktree names its main checkout */
  space?: string
  /** a space of its own, even if the path already has one */
  newSpace?: boolean
  /**
   * The space an earlier try of this spawn used, as the spawn row recorded it: kept while it still counts, whatever the
   * path says. A retry (or a resume) goes back into it, so a new-space spawn never makes a second space for itself.
   */
  workspace?: string | null
  /** goes into the pane as `FACTORY_ROLE`, so the session reports it at its start */
  role: string
  prompt: string
  /** a key of the account registry: where `CLAUDE_CONFIG_DIR` comes from */
  account: string
  /** the role's tier and effort: `--model <tier>` (an alias, never a model id) and `--effort` */
  tier: Tier
  effort: Effort
  /** Claude's own session id: start the agent as `claude --resume <id>`, so the conversation carries on (runner restart) */
  resume?: string
  /** the terminal the spawn's parent session runs in, if the factory knows it: a worker is started as that terminal's hidden child */
  parentTerminal?: string
}

export interface StartResult {
  /** the pane the agent runs in */
  session: string
  /** null for a hidden child: it has no tab */
  tab: string | null
  /** the space (workspace) the tab is in; a hidden child's is its parent's, null when that is not known */
  workspace: string | null
}

/** Starts one agent session and types into running ones. `start` must be idempotent per `key`. */
export interface Runner {
  start(input: StartInput): Promise<StartResult>
  /**
   * Submits `text` to the agent in `pane`. `busy` unless the agent is idle or done: a prompt typed into a working session only
   * queues in Claude Code and one typed into a blocked session answers its dialog, so nothing was sent. An error means nothing is known to have arrived.
   */
  type(input: { pane: string; text: string }): Promise<'typed' | 'busy'>
}

/** The runner gave up: `permanent` for a refusal that retrying cannot fix, otherwise the spawn is retried later. */
export class RunnerError extends Error {
  /** the space the start had made or found when it failed: the caller records it for the retry */
  workspace?: string
  constructor(
    message: string,
    readonly permanent: boolean,
  ) {
    super(message)
    this.name = 'RunnerError'
  }
}

/**
 * The text may have been typed although the call failed (the runner timed out or died after submitting it): nothing is known to
 * have arrived and nothing is known not to have. The caller waits for a turn to show it, it does not type again.
 */
export class UncertainTyping extends RunnerError {
  constructor(message: string) {
    super(message, false)
    this.name = 'UncertainTyping'
  }
}

/** The start ran out of its time budget: not a runner answer, so never swallowed as an unreadable state. */
export class BudgetSpent extends RunnerError {
  constructor() {
    super('the start budget is spent', false)
  }
}

/** Longest one `start` may take, all steps together: the tick's lease is this plus a minute. */
export const DEFAULT_START_BUDGET_MS = 180_000
/** How long a started agent may take to report before the start is called silent. */
export const DEFAULT_DELIVER_WAIT_MS = 30_000

const Registry = z.object({ accounts: z.record(z.string(), z.object({ dir: z.string().nullable() })) })

/** A terminal name: a leading lowercase letter, then `[a-z0-9-]`, at most 32 characters (herdr-core takes more, this is the narrow subset). */
export function agentName(key: string): string {
  const clean = key
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  const base = /^[a-z]/.test(clean) ? clean : `f-${clean}`
  if (base === key && base.length <= 32) return base
  // Altered or clipped: a short hash of the key keeps two keys from sharing a name.
  const hash = createHash('sha256').update(key).digest('hex').slice(0, 6)
  return `${base.slice(0, 25).replace(/-+$/, '')}-${hash}`
}

/**
 * The environment a spawn's agent runs with: the account's `CLAUDE_CONFIG_DIR` (absent for the default account, never
 * empty), and the variables that switch the hooks on and tell the usage record who it is. Shared by both runners.
 */
export async function accountEnv(
  options: { accountsFile: string; home?: string; usageLane?: string },
  { account, key, role }: Pick<StartInput, 'account' | 'key' | 'role'>,
): Promise<Record<string, string>> {
  let raw: string
  try {
    raw = await Bun.file(options.accountsFile).text()
  } catch (cause) {
    throw new RunnerError(`cannot read the account registry ${options.accountsFile}: ${String(cause)}`, false)
  }
  let registry: z.infer<typeof Registry>
  try {
    registry = Registry.parse(JSON.parse(raw))
  } catch (cause) {
    throw new RunnerError(`the account registry ${options.accountsFile} is unusable: ${String(cause)}`, false)
  }
  const entry = registry.accounts[account]
  if (!entry) throw new RunnerError(`account ${account} is not in the registry ${options.accountsFile}`, true)

  const home = options.home ?? process.env.HOME ?? ''
  // dir null is the default account: CLAUDE_CONFIG_DIR stays unset.
  return {
    ...(entry.dir ? { CLAUDE_CONFIG_DIR: entry.dir.replace(/^~(?=\/|$)/, home) } : {}),
    CLAUDE_ACCOUNT_PICKED: account,
    USAGE_LANE: options.usageLane ?? 'wave',
    // FACTORY_SESSION switches the hooks on: they report this session's events under the spawn key.
    FACTORY_SESSION: key,
    FACTORY_ROLE: role,
  }
}

/** The time one `start` has left, counted on the injected clock. */
export class Budget {
  private readonly end: number

  constructor(
    private readonly clock: Clock,
    totalMs: number,
  ) {
    this.end = clock.now().getTime() + totalMs
  }

  /** `wantMs`, cut to what is left; an empty budget is an error rather than a zero-length call. */
  limit(wantMs: number): number {
    const left = this.end - this.clock.now().getTime()
    if (left <= 0) throw new BudgetSpent()
    return Math.min(wantMs, left)
  }
}

/** `path` with links resolved, or as given when it cannot be (a directory that is gone). */
export function real(path: string): string {
  try {
    return realpathSync(path)
  } catch {
    return path
  }
}
