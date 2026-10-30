import { createHash } from 'node:crypto'
import { realpathSync } from 'node:fs'
import { basename } from 'node:path'
import type { Effort, Tier } from '@software-factory/contract'
import { z } from 'zod'
import type { Clock } from './clock.ts'
import { CannotExecute, DEFAULT_PROCESS_TIMEOUT_MS, EXIT_TIMEOUT, type ProcessResult, runProcess } from './exec.ts'

export interface StartInput {
  key: string
  repo: string
  /** the path whose herdr space the tab goes into (FL6); the repo when absent. A fan worker's worktree names its main checkout */
  space?: string
  /** a space of its own, even if the path already has one */
  newSpace?: boolean
  /**
   * The space an earlier try of this spawn used, as the spawn row recorded it: kept while herdr still has it, whatever the
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
  /** Claude's own session id: start the agent as `claude --resume <id>`, so the conversation carries on (herdr restart) */
  resume?: string
}

export interface StartResult {
  /** the pane the agent runs in */
  session: string
  tab: string
  /** the herdr space (workspace) the tab is in */
  workspace: string
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
 * The text may have been typed although the call failed (herdr timed out or died after submitting it): nothing is known to
 * have arrived and nothing is known not to have. The caller waits for a turn to show it, it does not type again.
 */
export class UncertainTyping extends RunnerError {
  constructor(message: string) {
    super(message, false)
    this.name = 'UncertainTyping'
  }
}

/** The start ran out of its time budget: not a herdr answer, so never swallowed as an unreadable state. */
class BudgetSpent extends RunnerError {
  constructor() {
    super('the start budget is spent', false)
  }
}

/** Longest one `start` may take, all steps together: the tick's lease is this plus a minute. */
export const DEFAULT_START_BUDGET_MS = 180_000
/** How long a sent prompt may leave the agent's state unchanged before it is sent once more (rd's rule). */
export const DEFAULT_DELIVER_WAIT_MS = 30_000
const DELIVER_POLL_MS = 1_000
/** `agent start` returns `agent_pane_busy` while the pane's shell is still coming up. */
const BUSY_RETRIES = 10
const BUSY_WAIT_MS = 1_000
/** `agent start` waits up to 30 s for the agent to be ready on its own; the process may run a little longer. */
const AGENT_START_TIMEOUT_MS = 45_000

export interface HerdrRunnerOptions {
  /** the command to run, normally `HERDR_BIN` */
  bin: string
  clock: Clock
  /** `dotfiles/scripts/claude-pretrust.sh`: accepts the folder-trust dialog in every account's config */
  pretrustBin: string
  /** `dotfiles/config/claude-accounts.json`: the registry that maps an account to its config directory */
  accountsFile: string
  /** `USAGE_LANE` of the pane, how the usage record tells the sessions apart */
  usageLane?: string
  processTimeoutMs?: number
  startBudgetMs?: number
  deliverWaitMs?: number
  home?: string
}

const HerdrError = z.object({ error: z.object({ code: z.string(), message: z.string() }) })

const Tab = z.object({ tab_id: z.string(), workspace_id: z.string(), label: z.string() })
const Workspace = z.object({ workspace_id: z.string(), label: z.string() })
const Pane = z.object({
  pane_id: z.string(),
  tab_id: z.string(),
  workspace_id: z.string().optional(),
  cwd: z.string().optional(),
})
const Agent = z.object({
  agent: z.string().optional(),
  agent_status: z.string(),
  pane_id: z.string(),
  name: z.string().optional(),
  interactive_ready: z.boolean().optional(),
  state_change_seq: z.number().optional(),
  completion_seq: z.number().optional(),
})
type Agent = z.infer<typeof Agent>

const TabList = z.object({ result: z.object({ tabs: z.array(Tab) }) })
const WorkspaceList = z.object({ result: z.object({ workspaces: z.array(Workspace) }) })
const PaneList = z.object({ result: z.object({ panes: z.array(Pane) }) })
const AgentList = z.object({ result: z.object({ agents: z.array(Agent) }) })
const AgentInfo = z.object({ result: z.object({ agent: Agent }) })
const Created = z.object({
  result: z.object({ root_pane: z.object({ pane_id: z.string(), tab_id: z.string(), workspace_id: z.string() }) }),
})

const Registry = z.object({ accounts: z.record(z.string(), z.object({ dir: z.string().nullable() })) })

/** herdr names an agent with a leading lowercase letter, then `[a-z0-9-]`, at most 32 characters. */
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
 * What a snapshot says about the prompt. A fresh agent is `idle` and has never finished a turn: `send`. One that is
 * working, or has finished a turn, already took its prompt (an earlier call of this start, a reclaimed claim): typing
 * it again would run the work twice. Anything else (`blocked` on a dialog, still starting, unknown) is neither, and
 * is an error for the tick to retry rather than a delivery that never happened.
 */
function promptState(agent: Agent): 'send' | 'delivered' | 'not_ready' {
  if (agent.agent_status === 'working' || agent.agent_status === 'done' || agent.completion_seq !== undefined) {
    return 'delivered'
  }
  return agent.agent_status === 'idle' ? 'send' : 'not_ready'
}

const changed = (a: Agent, b: Agent): boolean =>
  a.agent_status !== b.agent_status ||
  a.state_change_seq !== b.state_change_seq ||
  a.completion_seq !== b.completion_seq

/**
 * Starts Claude Code in a herdr tab named after the spawn key and hands it the prompt, in the steps `rd wave` takes:
 * the account's `CLAUDE_CONFIG_DIR` through `--env` at creation, the folder pre-trusted, `agent start` with
 * `--dangerously-skip-permissions`, the prompt submitted and proven by a state change (none within 30 s: one re-send).
 *
 * Every step first looks at what herdr has, so a second call (a retry, a reclaimed claim) continues where the first
 * stopped: the tab is found by its label, the agent by its pane, the prompt by the agent no longer being fresh and
 * idle. Whatever fails is reported as a transient error for the tick's time budget to retry. No call is made without
 * a process timeout, and all of them together stay inside `startBudgetMs`.
 */
export class HerdrRunner implements Runner {
  /** Tab creation runs one at a time: two starts in one repo must not both find no space and each make one. */
  private creating: Promise<unknown> = Promise.resolve()

  constructor(private readonly options: HerdrRunnerOptions) {}

  async start(input: StartInput): Promise<StartResult> {
    const budget = new Budget(this.options.clock, this.options.startBudgetMs ?? DEFAULT_START_BUDGET_MS)
    const env = await this.paneEnv(input)
    let known: string | undefined
    try {
      return await this.startIn(input, env, budget, (workspace) => (known = workspace))
    } catch (error) {
      if (error instanceof RunnerError && known) error.workspace ??= known
      throw error
    }
  }

  private async startIn(
    input: StartInput,
    env: string[],
    budget: Budget,
    noteWorkspace: (workspace: string) => void,
  ): Promise<StartResult> {
    const space = input.space ?? input.repo

    let tab: { tab: string; pane: string; workspace: string } | undefined
    for (const workspace of await this.findSpaces(space, input.workspace, budget)) {
      tab = await this.findTab(workspace, input.key, budget)
      if (tab) break
    }
    let agent = tab ? await this.findAgent(tab.pane, budget) : undefined
    const home = tab?.workspace ?? input.workspace ?? undefined
    if (tab) noteWorkspace(tab.workspace)
    if (tab && !agent) {
      // A tab with no agent has nothing running to keep, and its environment (the account) was fixed when it was made:
      // a retry may be on another account, so it is made again.
      await this.closeTab(tab.tab, budget)
      tab = undefined
    }
    if (!tab) {
      tab = await this.serialized(() => this.createTab(input, space, home, env, budget))
      noteWorkspace(tab.workspace)
    }
    const pane = tab.pane

    // An agent that already took its prompt is running, whatever else herdr says about it; only one that never became
    // ready is a failed launch to begin again.
    if (agent && !agent.interactive_ready && promptState(agent) !== 'delivered') {
      await this.closeTab(tab.tab, budget)
      throw new RunnerError(`the agent in ${pane} never became ready; its tab was closed`, false)
    }
    if (!agent) {
      await this.pretrust(input.repo, budget)
      agent = await this.startAgent(input, pane, budget)
    }

    await this.deliver(pane, input.prompt, budget)
    return { session: pane, tab: tab.tab, workspace: tab.workspace }
  }

  async type(input: { pane: string; text: string }): Promise<'typed' | 'busy'> {
    const budget = new Budget(this.options.clock, this.options.startBudgetMs ?? DEFAULT_START_BUDGET_MS)
    const agent = await this.snapshot(input.pane, budget)
    if (!agent) throw new RunnerError(`${input.pane}'s state is unreadable; nothing was typed`, false)
    // Only an agent at its prompt takes text: a working one queues it, a blocked one reads it as the answer to its dialog.
    if (agent.agent_status !== 'idle' && agent.agent_status !== 'done') return 'busy'
    const sent = await this.exec([this.options.bin, 'agent', 'prompt', input.pane, input.text], budget)
    const failure = herdrFailure(sent)
    if (failure) {
      // An error body is herdr refusing: nothing was typed. A timeout or a bad exit says nothing about whether it was.
      const message = `herdr agent prompt for ${input.pane}: ${failure.text}`
      throw failure.code ? new RunnerError(message, false) : new UncertainTyping(message)
    }
    return 'typed'
  }

  private serialized<T>(step: () => Promise<T>): Promise<T> {
    const run = this.creating.then(step, step)
    this.creating = run.catch(() => {})
    return run
  }

  // --- steps -----------------------------------------------------------------------------------------------------

  /** The environment the pane's shell gets at creation, so the agent started in it runs on the spawn's account. */
  private async paneEnv({ account, key, role }: StartInput): Promise<string[]> {
    let raw: string
    try {
      raw = await Bun.file(this.options.accountsFile).text()
    } catch (cause) {
      throw new RunnerError(`cannot read the account registry ${this.options.accountsFile}: ${String(cause)}`, false)
    }
    let registry: z.infer<typeof Registry>
    try {
      registry = Registry.parse(JSON.parse(raw))
    } catch (cause) {
      throw new RunnerError(`the account registry ${this.options.accountsFile} is unusable: ${String(cause)}`, false)
    }
    const entry = registry.accounts[account]
    if (!entry) throw new RunnerError(`account ${account} is not in the registry ${this.options.accountsFile}`, true)

    const home = this.options.home ?? process.env.HOME ?? ''
    // FACTORY_SESSION switches the hooks on: they report this session's events under the spawn key.
    const env = [
      `CLAUDE_ACCOUNT_PICKED=${account}`,
      `USAGE_LANE=${this.options.usageLane ?? 'wave'}`,
      `FACTORY_SESSION=${key}`,
      `FACTORY_ROLE=${role}`,
    ]
    // dir null is the default account: CLAUDE_CONFIG_DIR stays unset.
    if (entry.dir !== null) env.unshift(`CLAUDE_CONFIG_DIR=${entry.dir.replace(/^~(?=\/|$)/, home)}`)
    return env
  }

  /**
   * The spaces of `space`, a path, in herdr's order. A space is found by its path, never by its name: the label (the
   * directory's name, rd's convention) only narrows the candidates, and one counts when one of its panes is in the path
   * or below it (a worktree). Two repos with the same directory name therefore have two spaces. `preferred`, the space an
   * earlier try recorded, comes first when herdr still has it, with no further evidence asked.
   */
  private async findSpaces(space: string, preferred: string | null | undefined, budget: Budget): Promise<string[]> {
    const label = basename(space)
    const { workspaces } = (await this.herdr(WorkspaceList, ['workspace', 'list'], budget)).result
    const first = workspaces.find((w) => w.workspace_id === preferred)?.workspace_id
    const named = workspaces.filter((w) => w.label === label && w.workspace_id !== first)
    const { panes } = named.length ? (await this.herdr(PaneList, ['pane', 'list'], budget)).result : { panes: [] }
    const root = real(space)
    const found = named
      .filter((w) => panes.some((p) => p.workspace_id === w.workspace_id && p.cwd !== undefined && within(root, p.cwd)))
      .map((w) => w.workspace_id)
    return first ? [first, ...found] : found
  }

  /** The spawn's tab in one space, looked for by its label: a tab of that name anywhere else is not ours. */
  private async findTab(
    workspace: string,
    key: string,
    budget: Budget,
  ): Promise<{ tab: string; pane: string; workspace: string } | undefined> {
    const { tabs } = (await this.herdr(TabList, ['tab', 'list', '--workspace', workspace], budget)).result
    const tab = tabs.find((t) => t.label === key)
    if (!tab) return undefined
    const { panes } = (await this.herdr(PaneList, ['pane', 'list'], budget)).result
    const pane = panes.find((p) => p.tab_id === tab.tab_id)
    if (!pane) throw new RunnerError(`tab ${tab.tab_id} (${key}) has no pane`, false)
    return { tab: tab.tab_id, pane: pane.pane_id, workspace: tab.workspace_id }
  }

  /**
   * The tab goes into the space an earlier try used (`home`) while herdr still has it, else into the first existing space
   * of the path; the first spawn there creates the space, and so does a spawn that asks for a space of its own.
   */
  private async createTab(
    input: StartInput,
    space: string,
    home: string | undefined,
    env: string[],
    budget: Budget,
  ): Promise<{ tab: string; pane: string; workspace: string }> {
    const envArgs = env.flatMap((pair) => ['--env', pair])
    // Looked up again inside the lock: the space may have been made by a start that ran just before this one.
    const spaces = await this.findSpaces(space, home, budget)
    const existing = home && spaces[0] === home ? home : input.newSpace ? undefined : spaces[0]
    if (existing) {
      const created = await this.herdr(
        Created,
        ['tab', 'create', '--workspace', existing, '--cwd', input.repo, '--label', input.key, '--no-focus', ...envArgs],
        budget,
      )
      const { tab_id: tab, pane_id: pane } = created.result.root_pane
      return { tab, pane, workspace: existing }
    }

    // The pane's directory is the repo, which is the space's path or below it (a worktree): that is how the space is found again.
    const created = await this.herdr(
      Created,
      ['workspace', 'create', '--cwd', input.repo, '--label', basename(space), '--no-focus', ...envArgs],
      budget,
    )
    const { tab_id: tab, pane_id: pane, workspace_id: spaceId } = created.result.root_pane
    try {
      await this.herdr(z.object({}).loose(), ['tab', 'rename', tab, input.key], budget)
    } catch (error) {
      // The space is ours and holds only this tab: take it away again, or the next try would add a second tab to it.
      await this.herdr(z.object({}).loose(), ['workspace', 'close', spaceId], budget).catch(() => {})
      throw error
    }
    return { tab, pane, workspace: spaceId }
  }

  private async findAgent(pane: string, budget: Budget): Promise<Agent | undefined> {
    const { agents } = (await this.herdr(AgentList, ['agent', 'list'], budget)).result
    return agents.find((a) => a.pane_id === pane && a.agent === 'claude')
  }

  private async closeTab(tab: string, budget: Budget): Promise<void> {
    await this.herdr(z.object({}).loose(), ['tab', 'close', tab], budget).catch(() => {})
  }

  private async pretrust(repo: string, budget: Budget): Promise<void> {
    const result = await this.exec([this.options.pretrustBin, repo], budget)
    if (result.exitCode !== 0) {
      throw new RunnerError(`${this.options.pretrustBin} ${this.describe(result.exitCode)} for ${repo}`, false)
    }
  }

  private async startAgent(input: StartInput, pane: string, budget: Budget): Promise<Agent> {
    const { key, tier, effort } = input
    const args = [
      'agent',
      'start',
      agentName(key),
      '--kind',
      'claude',
      '--pane',
      pane,
      '--',
      '--dangerously-skip-permissions',
      '--model',
      tier,
      '--effort',
      effort,
      ...(input.resume ? ['--resume', input.resume] : []),
    ]
    for (let busy = 0; ; busy++) {
      const result = await this.exec([this.options.bin, ...args], budget, AGENT_START_TIMEOUT_MS)
      const failure = herdrFailure(result)
      if (!failure) {
        const started = AgentInfo.safeParse(parseJson(result.stdout))
        const agent = started.success ? started.data.result.agent : await this.findAgent(pane, budget)
        if (agent?.interactive_ready) return agent
        throw new RunnerError(`herdr started no ready agent in ${pane} (${key})`, false)
      }
      if (failure.code === 'agent_pane_busy' && busy < BUSY_RETRIES) {
        await this.options.clock.sleep(BUSY_WAIT_MS)
        continue
      }
      throw new RunnerError(`herdr agent start for ${key}: ${failure.text}`, false)
    }
  }

  /** Submit the prompt and prove it landed: a state change within the window, else one re-send, else an error. */
  private async deliver(pane: string, prompt: string, budget: Budget): Promise<void> {
    const waitMs = this.options.deliverWaitMs ?? DEFAULT_DELIVER_WAIT_MS
    for (let attempt = 1; attempt <= 2; attempt++) {
      const before = await this.snapshot(pane, budget)
      if (!before) throw new RunnerError(`${pane}'s state is unreadable; nothing was sent`, false)
      const state = promptState(before)
      if (state === 'delivered') return
      if (state === 'not_ready') {
        throw new RunnerError(`${pane} is ${before.agent_status}, not ready for a prompt; nothing was sent`, false)
      }

      const sent = await this.exec([this.options.bin, 'agent', 'prompt', pane, prompt], budget)
      const failure = herdrFailure(sent)
      if (failure) {
        // The body reports a rejection with exit 0, a dead herdr with a non-zero exit: either way nothing is known to
        // have arrived, and the next call looks at the agent's state before it sends anything.
        throw new RunnerError(`herdr agent prompt for ${pane}: ${failure.text}`, false)
      }

      const seen = await this.waitForChange(pane, before, waitMs, budget)
      if (seen === 'changed') return
      if (seen === 'unreadable') {
        throw new RunnerError(
          `the prompt was sent to ${pane}, but its state was unreadable afterwards: delivery unconfirmed`,
          false,
        )
      }
    }
    throw new RunnerError(`${pane} showed no state change after two sends of the prompt`, false)
  }

  private async waitForChange(
    pane: string,
    before: Agent,
    waitMs: number,
    budget: Budget,
  ): Promise<'changed' | 'unchanged' | 'unreadable'> {
    const polls = Math.max(1, Math.ceil(waitMs / DELIVER_POLL_MS))
    let observed = false
    for (let i = 0; i < polls; i++) {
      const now = await this.snapshot(pane, budget)
      if (now) {
        observed = true
        if (changed(before, now)) return 'changed'
      }
      if (i < polls - 1) await this.options.clock.sleep(DELIVER_POLL_MS)
    }
    return observed ? 'unchanged' : 'unreadable'
  }

  /** `undefined` when herdr does not answer or the answer carries no status: unreadable is never read as idle. */
  private async snapshot(pane: string, budget: Budget): Promise<Agent | undefined> {
    try {
      return (await this.herdr(AgentInfo, ['agent', 'get', pane], budget)).result.agent
    } catch (error) {
      if (error instanceof BudgetSpent) throw error
      return undefined
    }
  }

  // --- processes -------------------------------------------------------------------------------------------------

  private describe(exitCode: number): string {
    return exitCode === EXIT_TIMEOUT
      ? `timed out after ${this.options.processTimeoutMs ?? DEFAULT_PROCESS_TIMEOUT_MS} ms`
      : `exited ${exitCode}`
  }

  /** One herdr call whose stdout must parse as `schema`; an error body, a failed exit or other output is an error. */
  private async herdr<S extends z.ZodType>(schema: S, args: string[], budget: Budget): Promise<z.output<S>> {
    const result = await this.exec([this.options.bin, ...args], budget)
    const failure = herdrFailure(result)
    if (failure) throw new RunnerError(`herdr ${args.slice(0, 2).join(' ')}: ${failure.text}`, false)
    const parsed = schema.safeParse(parseJson(result.stdout))
    if (!parsed.success) {
      throw new RunnerError(
        `herdr ${args.slice(0, 2).join(' ')} printed something unexpected: ${result.stdout.slice(0, 120)}`,
        false,
      )
    }
    return parsed.data
  }

  private async exec(cmd: string[], budget: Budget, timeoutMs?: number): Promise<ProcessResult> {
    const limit = budget.limit(timeoutMs ?? this.options.processTimeoutMs ?? DEFAULT_PROCESS_TIMEOUT_MS)
    try {
      return await runProcess(cmd, limit)
    } catch (error) {
      if (error instanceof CannotExecute) throw new RunnerError(error.message, true)
      throw error
    }
  }
}

/** The time one `start` has left, counted on the injected clock. */
class Budget {
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
function real(path: string): string {
  try {
    return realpathSync(path)
  } catch {
    return path
  }
}

/** Whether `cwd` is `root` or inside it. */
function within(root: string, cwd: string): boolean {
  const at = real(cwd)
  return at === root || at.startsWith(root.endsWith('/') ? root : `${root}/`)
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

/** A failed call, from either signal herdr uses: a non-zero exit, or an `error` body (which it may print with exit 0). */
function herdrFailure(result: ProcessResult): { code: string | undefined; text: string } | undefined {
  const body = HerdrError.safeParse(parseJson(result.stdout))
  if (body.success) return { code: body.data.error.code, text: `${body.data.error.code}: ${body.data.error.message}` }
  if (result.exitCode === 0) return undefined
  const what = result.exitCode === EXIT_TIMEOUT ? 'timed out' : `exited ${result.exitCode}`
  return { code: undefined, text: `${what}${result.stdout ? `: ${result.stdout.slice(0, 120)}` : ''}` }
}
