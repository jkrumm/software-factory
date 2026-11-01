import { createHash } from 'node:crypto'
import { basename } from 'node:path'
import { z } from 'zod'
import type { Clock } from './clock.ts'
import { CannotExecute, DEFAULT_PROCESS_TIMEOUT_MS, runProcess } from './exec.ts'
import { appSpaces, nameTab, seedSpace, type Rpc } from './app-doc.ts'
import { HcClient, HcError } from './hc.ts'
import {
  accountEnv,
  agentName,
  Budget,
  DEFAULT_DELIVER_WAIT_MS,
  DEFAULT_START_BUDGET_MS,
  LOCAL_TERMINAL,
  real,
  type Runner,
  RunnerError,
  type StartInput,
  type StartResult,
  UncertainTyping,
} from './runner.ts'

export interface HcRunnerOptions {
  /** the command to run, normally `HC_BIN` */
  bin: string
  /** `HC_SESSION`: another core than the default one (tests) */
  session?: string
  /** the program the terminal runs; `claude`, a stub in tests */
  claudeBin?: string
  clock: Clock
  /** `dotfiles/scripts/claude-pretrust.sh`: accepts the folder-trust dialog in every account's config */
  pretrustBin: string
  /** `dotfiles/config/claude-accounts.json`: the registry that maps an account to its config directory */
  accountsFile: string
  /** `USAGE_LANE` of the terminal, how the usage record tells the sessions apart */
  usageLane?: string
  processTimeoutMs?: number
  startBudgetMs?: number
  deliverWaitMs?: number
  home?: string
}

const DELIVER_POLL_MS = 1_000

const Status = z.object({ state: z.string() }).loose()
const Terminal = z
  .object({
    address: z.string(),
    labels: z.record(z.string(), z.string()),
    state: z.string(),
    status: Status.nullable().default(null),
    reported: z.boolean().default(false),
    turn: z.number().default(0),
    exit_code: z.number().nullable().default(null),
    argv: z.array(z.string()).default([]),
    parent: z.string().nullable().default(null),
  })
  .loose()
type Terminal = z.infer<typeof Terminal>

const TerminalList = z.object({ terminals: z.array(Terminal) }).loose()
const Sent = z.object({}).loose()
const Removed = z.object({}).loose()

const sha = (text: string): string => createHash('sha256').update(text).digest('hex').slice(0, 12)

/**
 * The terminal's name: an agent name, but hc refuses a name that could be an address (`t7`, `t7x`). Such a name is escaped
 * with a short hash of the key it came from, so it cannot be the name another key has (`f-t7` is a key too).
 */
export function terminalName(key: string): string {
  const name = agentName(key)
  return /^t\d/.test(name) ? `f-${sha(key).slice(0, 6)}-${name.slice(0, 22)}` : name
}

/** The tab a key always gets, so a retry finds the same one. */
export const tabId = (key: string): string => `tb-${sha(key)}`

/** The space of a path nothing else names: the full root is hashed, so `~/SourceRoot/x` and `~/IuRoot/x` differ. */
const defaultSpaceId = (root: string): string => `sp-${basename(root)}-${sha(root)}`

/** A space of a spawn's own: the key is in the hash, so its retry makes the same one. */
const ownSpaceId = (root: string, key: string): string => `sp-${basename(root)}-${sha(`${root}\0${key}`)}`

/** Whether the factory started this role as a hidden child of its parent's terminal. */
const isWorker = (role: string): boolean => role === 'worker' || role === 'mechanical'

type Placement =
  /** a tab of its own: named after the key once the app has adopted it */
  | { kind: 'tab'; space: string; tab: string; params: Record<string, unknown> }
  /** a hidden child of its parent's terminal: no tab, no space of its own */
  | { kind: 'child'; params: Record<string, unknown> }

/**
 * Starts Claude Code in a herdr-core terminal and types into running ones, over `hc connect` (one short-lived process per
 * call, `HcClient`). The prompt is the program's last argument, so there is nothing to send and nothing to send twice.
 *
 * It looks before it acts: the spawn's terminals are found by the label `factory.key=<key>`; a
 * live one is never started again, a finished one is removed and started afresh (a retry may be on another account).
 * That the agent started is proven by the terminal reporting (`reported`, a status or a turn) within the deliver window.
 * No call is made without a process timeout, and all of them together stay inside `startBudgetMs`.
 *
 * Placement is by labels, no window needed: a tab carries `herdr.space` (the app's space for the path, else a stable
 * id) and `herdr.tab` (a stable id for the key) and has no parent; a worker whose parent's terminal is known is that
 * terminal's hidden child instead.
 */
export class HcRunner implements Runner {
  private readonly hc: HcClient
  /** Looking, placing and running go one at a time: two starts must not both see an empty space and both take its id. */
  private creating: Promise<unknown> = Promise.resolve()

  constructor(private readonly options: HcRunnerOptions) {
    this.hc = new HcClient({ bin: options.bin, session: options.session })
  }

  async start(input: StartInput): Promise<StartResult> {
    // A prompt that begins with `-` would be read as an option of claude.
    if (input.prompt.startsWith('-')) throw new RunnerError('a prompt cannot start with "-"', true)
    const budget = new Budget(this.options.clock, this.options.startBudgetMs ?? DEFAULT_START_BUDGET_MS)
    const env = await accountEnv(this.options, input)
    let known: string | undefined
    try {
      return await this.startIn(input, env, budget, (space) => (known = space))
    } catch (error) {
      const failure = asRunnerError(error)
      if (known) failure.workspace ??= known
      throw failure
    }
  }

  private async startIn(
    input: StartInput,
    env: Record<string, string>,
    budget: Budget,
    noteSpace: (space: string) => void,
  ): Promise<StartResult> {
    const outcome = await this.serialized(() => this.findOrRun(input, env, budget, noteSpace))
    // Proving takes as long as the agent does to report: outside the lock, other starts go on.
    if (!outcome.proven) await this.prove(outcome.terminal.address, budget)
    return this.resultOf(outcome.terminal, budget)
  }

  private serialized<T>(step: () => Promise<T>): Promise<T> {
    const run = this.creating.then(step, step)
    this.creating = run.catch(() => {})
    return run
  }

  /** The spawn's running agent if there is one, else the terminal this call made for it. */
  private async findOrRun(
    input: StartInput,
    env: Record<string, string>,
    budget: Budget,
    noteSpace: (space: string) => void,
  ): Promise<{ terminal: Terminal; proven: boolean }> {
    const found = await this.find(input.key, budget)
    const claude = this.options.claudeBin ?? 'claude'
    // A kept terminal whose program was killed lives on as the shell the core put in its place, under the same label: that is
    // no agent. Only a live terminal still running claude is one.
    const live = found.find((t) => t.state === 'live' && t.argv[0] === claude)
    if (live) {
      const space = live.labels['herdr.space']
      if (space) noteSpace(space)
      return { terminal: live, proven: false }
    }
    // A terminal that did its work and ended (the reply of the run was lost, then the agent finished) ran the prompt: it is
    // started, and a second run would do the same work twice. Only one that never reported is a failed launch.
    const worked = found.find((t) => t.state === 'finished' && (t.reported || t.status !== null || t.turn >= 1))
    if (worked) {
      const space = worked.labels['herdr.space']
      if (space) noteSpace(space)
      return { terminal: worked, proven: true }
    }

    const root = real(input.space ?? input.repo)
    let placement = await this.place(input, root, budget)
    if (placement.kind === 'tab') noteSpace(placement.space)
    await this.pretrust(input.repo, budget)
    // A terminal whose program has ended, or was replaced by a shell, is not an agent: a retry starts one again, on whatever
    // account it was given now.
    for (const stale of found) {
      if (stale.state === 'live') await this.kill(stale.address, budget)
      await this.rpc('terminal.rm', { terminal: stale.address }, Removed, budget)
    }
    const run = (where: Placement) =>
      this.rpc(
        'terminal.run',
        {
          argv: this.argv(input),
          cwd: input.repo,
          env,
          labels: {
            'factory.key': input.key,
            ...(where.kind === 'tab'
              ? { 'herdr.space': where.space, 'herdr.tab': where.tab, 'factory.tab_name': input.key }
              : {}),
          },
          keep: true,
          name: terminalName(input.key),
          ...where.params,
        },
        Terminal,
        budget,
      )
    let created: Terminal
    try {
      created = await run(placement)
    } catch (error) {
      // The parent terminal is gone: this try is a tab instead of retrying until the budget is spent.
      if (!(placement.kind === 'child' && error instanceof HcError && error.refusal?.kind === 'not_found')) throw error
      placement = await this.tabPlacement(input, root, budget)
      noteSpace(placement.space)
      created = await run(placement)
    }
    if (placement.kind === 'tab') await nameTab(this.docRpc(budget), placement.tab, input.key)
    return { terminal: created, proven: false }
  }

  async type(input: { pane: string; text: string }): Promise<'typed' | 'busy'> {
    const budget = new Budget(this.options.clock, this.options.startBudgetMs ?? DEFAULT_START_BUDGET_MS)
    let status: string | undefined
    try {
      const terminal = await this.rpc('terminal.get', { terminal: input.pane }, Terminal, budget)
      if (terminal.state !== 'live') {
        throw new RunnerError(`${input.pane} has finished; nothing was typed`, false)
      }
      status = terminal.status?.state
    } catch (error) {
      throw asRunnerError(error)
    }
    // Only an agent at its prompt takes text: a working one queues it, a blocked one reads it as the answer to its dialog.
    if (status !== 'idle' && status !== 'done') return 'busy'

    try {
      // `if` can name idle or working only: for `done` the core's own refusal of a blocked program is the guard.
      const guard = status === 'idle' ? { if: 'idle' } : {}
      await this.rpc('terminal.send', { terminal: input.pane, text: input.text, ...guard }, Sent, budget)
      return 'typed'
    } catch (error) {
      if (!(error instanceof HcError)) throw asRunnerError(error)
      // The core looked and refused: nothing was typed. A refusal because the program is not at its prompt any more is
      // the answer `busy`; anything else is an error. No refusal (a timeout, a dead process) says nothing about the text.
      if (error.refusal?.kind === 'blocked' || error.refusal?.kind === 'status_mismatch') return 'busy'
      throw error.refusal ? new RunnerError(error.message, false) : new UncertainTyping(error.message)
    }
  }

  // --- steps -----------------------------------------------------------------------------------------------------

  /** The program and its arguments; the prompt is last. */
  private argv({ tier, effort, resume, prompt }: StartInput): string[] {
    return [
      this.options.claudeBin ?? 'claude',
      '--dangerously-skip-permissions',
      '--model',
      tier,
      '--effort',
      effort,
      ...(resume ? ['--resume', resume] : []),
      prompt,
    ]
  }

  /** Every terminal of the spawn, live or finished, found by its label. */
  private async find(key: string, budget: Budget): Promise<Terminal[]> {
    const list = await this.rpc('terminal.list', { all: true, labels: { 'factory.key': key } }, TerminalList, budget)
    return list.terminals
  }

  /**
   * What the tick records. A tab has its ids in its labels; a hidden child has no tab (null) and sits in its parent's space
   * (the parent's label, null when the parent has none or cannot be read).
   */
  private async resultOf(terminal: Terminal, budget: Budget): Promise<StartResult> {
    let workspace = terminal.labels['herdr.space'] ?? null
    if (workspace === null && terminal.parent) {
      try {
        workspace =
          (await this.rpc('terminal.get', { terminal: terminal.parent }, Terminal, budget)).labels['herdr.space'] ??
          null
      } catch (error) {
        if (!(error instanceof HcError)) throw error
      }
    }
    return { session: terminal.address, tab: terminal.labels['herdr.tab'] ?? null, workspace }
  }

  /** Where the terminal goes: a hidden child of its parent's terminal (a worker), else a tab of its own in the path's space. */
  private async place(input: StartInput, root: string, budget: Budget): Promise<Placement> {
    const parent = input.parentTerminal
    // A spawn that asks for a space of its own is a tab, whatever its role: a hidden child has no space.
    if (isWorker(input.role) && parent && LOCAL_TERMINAL.test(parent) && !input.newSpace) {
      // No labels: the app shows it as a sub-agent of its parent, not as a tab. The factory wakes the parent itself, so
      // the core must not type its own notes into it. It outlives the parent's program: the factory decides when it ends.
      return { kind: 'child', params: { parent, outlive_parent: true, no_notify: true } }
    }
    return this.tabPlacement(input, root, budget)
  }

  private async tabPlacement(
    input: StartInput,
    root: string,
    budget: Budget,
  ): Promise<Extract<Placement, { kind: 'tab' }>> {
    const { id, seed } = await this.spaceId(input, root, budget)
    // The app adopts a terminal into the space its label names; with no entry it makes one named after the terminal's cwd.
    if (seed) await seedSpace(this.docRpc(budget), { id, folder: root })
    return {
      kind: 'tab',
      space: id,
      tab: tabId(input.key),
      params: { no_parent: true },
    }
  }

  private async kill(address: string, budget: Budget): Promise<void> {
    try {
      await this.rpc('terminal.kill', { terminal: address }, Removed, budget)
    } catch (error) {
      // Already gone or already finished is what was wanted.
      if (!(error instanceof HcError && error.refusal)) throw error
    }
  }

  /**
   * The space of a path. A space an earlier try recorded wins (the ids the factory makes start with `sp`; another one
   * only while a terminal is in it); else the app's own entry for the folder; else a stable id. A spawn that asks for a
   * space of its own gets one only when the path already has a space. `seed`: the id is the factory's own, so the app's
   * document may have no entry for it yet.
   */
  private async spaceId(input: StartInput, root: string, budget: Budget): Promise<{ id: string; seed: boolean }> {
    const recorded = input.workspace
    if (recorded && /^sp/.test(recorded)) return { id: recorded, seed: recorded.startsWith('sp-') }
    if (recorded && (await this.occupied(recorded, budget))) return { id: recorded, seed: false }
    const known = (await appSpaces(this.docRpc(budget))).find(
      (space) => space.folder !== undefined && real(space.folder) === root,
    )
    const standing = known?.id ?? defaultSpaceId(root)
    if (!input.newSpace) return { id: standing, seed: known === undefined }
    const exists = known !== undefined || (await this.occupied(standing, budget))
    return { id: exists ? ownSpaceId(root, input.key) : standing, seed: true }
  }

  /** Whether a live terminal is in the space. */
  private async occupied(space: string, budget: Budget): Promise<boolean> {
    const list = await this.rpc('terminal.list', { labels: { 'herdr.space': space } }, TerminalList, budget)
    return list.terminals.length > 0
  }

  private async pretrust(repo: string, budget: Budget): Promise<void> {
    const limit = budget.limit(this.options.processTimeoutMs ?? DEFAULT_PROCESS_TIMEOUT_MS)
    let result: Awaited<ReturnType<typeof runProcess>>
    try {
      result = await runProcess([this.options.pretrustBin, repo], limit)
    } catch (error) {
      if (error instanceof CannotExecute) throw new RunnerError(error.message, true)
      throw error
    }
    if (result.exitCode !== 0) {
      throw new RunnerError(`${this.options.pretrustBin} exited ${result.exitCode} for ${repo}`, false)
    }
  }

  /** The agent started when its terminal reports: a status, a report or a turn within the window; else an error. */
  private async prove(address: string, budget: Budget): Promise<void> {
    const waitMs = this.options.deliverWaitMs ?? DEFAULT_DELIVER_WAIT_MS
    const polls = Math.max(1, Math.ceil(waitMs / DELIVER_POLL_MS))
    let observed = false
    for (let i = 0; i < polls; i++) {
      const terminal = await this.look(address, budget)
      if (terminal) {
        observed = true
        if (terminal.state !== 'live') {
          throw new RunnerError(
            `${address} ended before the agent reported (exit ${terminal.exit_code ?? 'unknown'})`,
            false,
          )
        }
        if (terminal.reported || terminal.status !== null || terminal.turn >= 1) return
      }
      if (i < polls - 1) await this.options.clock.sleep(DELIVER_POLL_MS)
    }
    throw new RunnerError(
      observed
        ? `${address} is running but reported nothing within ${waitMs} ms`
        : `${address}'s state is unreadable; the agent is unconfirmed`,
      false,
    )
  }

  /** `undefined` when the core does not answer: unreadable is never read as started. */
  private async look(address: string, budget: Budget): Promise<Terminal | undefined> {
    try {
      return await this.rpc('terminal.get', { terminal: address }, Terminal, budget)
    } catch (error) {
      if (error instanceof HcError) return undefined
      throw error
    }
  }

  private docRpc(budget: Budget): Rpc {
    return (method, params, schema) => this.rpc(method, params, schema, budget)
  }

  // --- processes -------------------------------------------------------------------------------------------------

  /** One call, inside the budget and the process timeout. `HcError` passes through for the caller to read. */
  private async rpc<S extends z.ZodType>(
    method: string,
    params: object,
    schema: S,
    budget: Budget,
  ): Promise<z.output<S>> {
    const limit = budget.limit(this.options.processTimeoutMs ?? DEFAULT_PROCESS_TIMEOUT_MS)
    try {
      return await this.hc.call(method, params, schema, limit)
    } catch (error) {
      if (error instanceof CannotExecute) throw new RunnerError(error.message, true)
      throw error
    }
  }
}

/** A call that failed is a transient runner error: the tick retries inside its time budget. */
function asRunnerError(error: unknown): RunnerError {
  if (error instanceof RunnerError) return error
  if (error instanceof HcError) return new RunnerError(error.message, false)
  throw error
}
