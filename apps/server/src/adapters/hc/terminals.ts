import { createHash } from 'node:crypto'
import { basename, join } from 'node:path'
import * as z from 'zod'
import type { StartTerminal, TerminalInfo, Terminals } from '../../domains/leads/ports.ts'
import { err, ok, portError, type PortError, type Result } from '../../kernel/result.ts'
import { appSpaces, nameTab, real, seedSpace, type Rpc } from './app-doc.ts'
import { CannotExecute, HcClient, HcError } from './client.ts'
import { DEFAULT_PROCESS_TIMEOUT_MS, runProcess } from './process.ts'
import { atPrompt } from './screen.ts'

export interface HcTerminalsOptions {
  /** the command to run, normally `HC_BIN` */
  bin: string
  /** `HC_SESSION`: another core than the default one (tests) */
  session?: string
  /** the program the terminal runs; `claude`, a stub in tests */
  claudeBin?: string
  /** accepts the folder-trust dialog in every account's config before a start; unset skips it */
  pretrustBin?: string
  /** the registry that maps an account to its config directory */
  accountsFile: string
  /** `USAGE_LANE` of the terminal, how the usage record tells the sessions apart */
  usageLane?: string
  home: string
  /** `FACTORY_TOKEN` of the terminal: the agent token, so a lead's `factory` calls the API as a lead */
  agentToken?: string
  /** `FACTORY_URL` of the terminal: the API's loopback address */
  apiUrl?: string
  processTimeoutMs?: number
  startBudgetMs?: number
  deliverWaitMs?: number
  pollMs?: number
}

/** Longest one `start` may take, all steps together. */
export const DEFAULT_START_BUDGET_MS = 180_000
/** How long a started agent may take to report before the start is called silent. */
export const DEFAULT_DELIVER_WAIT_MS = 30_000
const DELIVER_POLL_MS = 1_000

const Status = z.object({ state: z.string() }).loose()
const Screen = z.object({ text: z.string() }).loose()
const Terminal = z
  .object({
    address: z.string(),
    labels: z.record(z.string(), z.string()).default({}),
    state: z.string(),
    status: Status.nullable().default(null),
    reported: z.boolean().default(false),
    turn: z.number().default(0),
    exit_code: z.number().nullable().default(null),
    argv: z.array(z.string()).default([]),
  })
  .loose()
type Terminal = z.infer<typeof Terminal>
const TerminalList = z.object({ terminals: z.array(Terminal) }).loose()
const Empty = z.object({}).loose()
const Registry = z.object({ accounts: z.record(z.string(), z.object({ dir: z.string().nullable() })) })

const sha = (text: string): string => createHash('sha256').update(text).digest('hex').slice(0, 12)

/** A terminal name: a leading lowercase letter, then `[a-z0-9-]`, at most 32 characters, hc-valid and never an address (`t7`). */
export function terminalName(key: string): string {
  const clean = key
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  const base = /^[a-z]/.test(clean) ? clean : `f-${clean}`
  const name =
    base === key && base.length <= 32 ? base : `${base.slice(0, 25).replace(/-+$/, '')}-${sha(key).slice(0, 6)}`
  return /^t\d/.test(name) ? `f-${sha(key).slice(0, 6)}-${name.slice(0, 22)}` : name
}

/** The tab a key always gets, so a retry finds the same one. */
export const tabId = (key: string): string => `tb-${sha(key)}`

/** The space of a path nothing else names: the full root is hashed, so `~/SourceRoot/x` and `~/IuRoot/x` differ. */
const defaultSpaceId = (root: string): string => `sp-${basename(root)}-${sha(root)}`

class BudgetSpent extends Error {
  constructor() {
    super('the start budget is spent')
  }
}

/** The time one call has left; an empty budget is an error rather than a zero-length call. */
class Budget {
  private readonly end: number
  constructor(totalMs: number) {
    this.end = Date.now() + totalMs
  }
  limit(wantMs: number): number {
    const left = this.end - Date.now()
    if (left <= 0) throw new BudgetSpent()
    return Math.min(wantMs, left)
  }
}

/** A refusal the retry cannot fix: the caller records the lead gone. */
class Permanent extends Error {}

function asPortError(error: unknown): PortError {
  if (error instanceof Permanent) return portError('refused', error.message)
  if (error instanceof BudgetSpent) return portError('timeout', error.message)
  if (error instanceof CannotExecute) return portError('gone', error.message)
  if (error instanceof HcError) {
    if (error.refusal) return portError('refused', error.message)
    return portError(error.message.includes('timed out') ? 'timeout' : 'gone', error.message)
  }
  throw error
}

const infoOf = (terminal: Terminal): TerminalInfo => ({
  address: terminal.address,
  live: terminal.state === 'live',
  reported: terminal.reported,
  status: terminal.status?.state ?? null,
  turn: terminal.turn,
  exitCode: terminal.exit_code,
  tab: terminal.labels['herdr.tab'] ?? null,
  space: terminal.labels['herdr.space'] ?? null,
})

/**
 * Starts Claude Code in a herdr-core terminal and types into running ones, over `hc connect`. The prompt is the
 * program's last argument, so there is nothing to type and nothing to type twice.
 *
 * It looks before it acts: the key's terminals are found by the label `factory.key`; a live one running claude is never
 * started again, a finished one that worked is not either, a stale one is removed and the key started afresh. No call
 * is made without a process timeout, and all of a start's together stay inside its budget.
 *
 * Placement is by labels, no window needed: the tab carries `herdr.space` (the app's space for the path, else a stable
 * id) and `herdr.tab` (a stable id for the key).
 */
export class HcTerminals implements Terminals {
  private readonly hc: HcClient
  /** Looking, placing and running go one at a time: two starts must not both see an empty space and both take its id. */
  private creating: Promise<unknown> = Promise.resolve()

  constructor(private readonly options: HcTerminalsOptions) {
    this.hc = new HcClient({ bin: options.bin, session: options.session })
  }

  private budget(): Budget {
    return new Budget(this.options.startBudgetMs ?? DEFAULT_START_BUDGET_MS)
  }

  private serialized<T>(step: () => Promise<T>): Promise<T> {
    const run = this.creating.then(step, step)
    this.creating = run.catch(() => {})
    return run
  }

  async find(key: string): Promise<Result<TerminalInfo[]>> {
    try {
      return ok((await this.findAll(key, this.budget())).map(infoOf))
    } catch (error) {
      return err(asPortError(error))
    }
  }

  async start(input: StartTerminal): Promise<Result<TerminalInfo>> {
    // A prompt that begins with `-` would be read as an option of claude.
    if (input.prompt.startsWith('-')) return err(portError('refused', 'a prompt cannot start with "-"'))
    const budget = this.budget()
    try {
      const env = await this.accountEnv(input)
      const outcome = await this.serialized(() => this.findOrRun(input, env, budget))
      // Proving takes as long as the agent does to report: outside the lock, other starts go on.
      if (!outcome.proven) await this.prove(outcome.terminal.address, budget)
      return ok(infoOf(outcome.terminal))
    } catch (error) {
      return err(asPortError(error))
    }
  }

  async type(input: { terminal: string; text: string; force: boolean }): Promise<Result<'typed' | 'busy'>> {
    const budget = this.budget()
    try {
      const terminal = await this.rpc('terminal.get', { terminal: input.terminal }, Terminal, budget)
      if (terminal.state !== 'live') return err(portError('gone', `${input.terminal} has finished; nothing was typed`))
      const status = terminal.status?.state
      // Only an agent at its prompt takes text: a working one queues it (typed anyway when forced), a blocked one reads it as the answer to its dialog.
      const forced = input.force && status === 'working'
      // A terminal that never reported a status says nothing about a dialog: the screen must show the input box.
      const unreported = status === undefined && (await this.showsPrompt(input.terminal, budget))
      if (status !== 'idle' && status !== 'done' && !forced && !unreported) return ok('busy')
      try {
        const guard = status === 'idle' ? { if: 'idle' } : forced ? { if: 'working' } : {}
        await this.rpc('terminal.send', { terminal: input.terminal, text: input.text, ...guard }, Empty, budget)
        return ok('typed')
      } catch (error) {
        if (!(error instanceof HcError)) throw error
        // The core looked and refused because the program is not at its prompt any more: busy. A call that told us nothing may have typed.
        if (error.refusal?.kind === 'blocked' || error.refusal?.kind === 'status_mismatch') return ok('busy')
        return err(
          portError(
            error.refusal ? 'refused' : 'timeout',
            error.refusal ? error.message : `uncertain: ${error.message}`,
          ),
        )
      }
    } catch (error) {
      return err(asPortError(error))
    }
  }

  async close(key: string): Promise<Result<void>> {
    const budget = this.budget()
    try {
      for (const terminal of await this.findAll(key, budget)) {
        if (terminal.state === 'live') await this.kill(terminal.address, budget)
        await this.rpc('terminal.rm', { terminal: terminal.address }, Empty, budget).catch((error: unknown) => {
          if (!(error instanceof HcError && error.refusal?.kind === 'not_found')) throw error
        })
      }
      return ok(undefined)
    } catch (error) {
      return err(asPortError(error))
    }
  }

  // --- steps -----------------------------------------------------------------------------------------------------

  private async findOrRun(
    input: StartTerminal,
    env: Record<string, string>,
    budget: Budget,
  ): Promise<{ terminal: Terminal; proven: boolean }> {
    const found = await this.findAll(input.key, budget)
    const claude = this.options.claudeBin ?? 'claude'
    // A kept terminal whose program was killed lives on as the shell the core put in its place, under the same label: that is no agent.
    const live = found.find((t) => t.state === 'live' && t.argv[0] === claude)
    if (live) return { terminal: live, proven: false }
    // A terminal that did its work and ended ran the prompt: a second run would do the same work twice.
    const worked = found.find((t) => t.state === 'finished' && (t.reported || t.status !== null || t.turn >= 1))
    if (worked) return { terminal: worked, proven: true }

    const root = real(input.space)
    const space = await this.spaceId(root, budget)
    if (space.seed) await seedSpace(this.docRpc(budget), { id: space.id, folder: root })
    await this.pretrust(input.cwd, budget)
    for (const stale of found) {
      if (stale.state === 'live') await this.kill(stale.address, budget)
      await this.rpc('terminal.rm', { terminal: stale.address }, Empty, budget)
    }
    const tab = tabId(input.key)
    const created = await this.rpc(
      'terminal.run',
      {
        argv: this.argv(input),
        cwd: input.cwd,
        env,
        labels: { 'factory.key': input.key, 'herdr.space': space.id, 'herdr.tab': tab, 'factory.tab_name': input.key },
        keep: true,
        no_parent: true,
        name: terminalName(input.key),
      },
      Terminal,
      budget,
    )
    await nameTab(this.docRpc(budget), tab, input.key)
    return { terminal: created, proven: false }
  }

  /** The program and its arguments; the prompt is last. */
  private argv({ tier, effort, prompt }: StartTerminal): string[] {
    return [
      this.options.claudeBin ?? 'claude',
      '--dangerously-skip-permissions',
      '--model',
      tier,
      '--effort',
      effort,
      prompt,
    ]
  }

  private async findAll(key: string, budget: Budget): Promise<Terminal[]> {
    const list = await this.rpc('terminal.list', { all: true, labels: { 'factory.key': key } }, TerminalList, budget)
    return list.terminals
  }

  private async kill(address: string, budget: Budget): Promise<void> {
    try {
      await this.rpc('terminal.kill', { terminal: address }, Empty, budget)
    } catch (error) {
      // Already gone or already finished is what was wanted.
      if (!(error instanceof HcError && error.refusal)) throw error
    }
  }

  /** The app's own entry for the folder, else a stable id the app adopts; `seed`: the id is ours, so the document may have no entry yet. */
  private async spaceId(root: string, budget: Budget): Promise<{ id: string; seed: boolean }> {
    const known = (await appSpaces(this.docRpc(budget))).find(
      (space) => space.folder !== undefined && real(space.folder) === root,
    )
    return { id: known?.id ?? defaultSpaceId(root), seed: known === undefined }
  }

  private async showsPrompt(terminal: string, budget: Budget): Promise<boolean> {
    try {
      return atPrompt((await this.rpc('terminal.read', { terminal }, Screen, budget)).text)
    } catch (error) {
      if (error instanceof HcError) return false
      throw error
    }
  }

  private async pretrust(cwd: string, budget: Budget): Promise<void> {
    if (!this.options.pretrustBin) return
    const limit = budget.limit(this.options.processTimeoutMs ?? DEFAULT_PROCESS_TIMEOUT_MS)
    let result: Awaited<ReturnType<typeof runProcess>>
    try {
      result = await runProcess([this.options.pretrustBin, cwd], limit)
    } catch (error) {
      if (error instanceof CannotExecute) throw new Permanent(error.message)
      throw error
    }
    if (result.exitCode !== 0) throw new HcError(`${this.options.pretrustBin} exited ${result.exitCode} for ${cwd}`)
  }

  /** The agent started when its terminal reports within the window, or is live but silent (unconfirmed: the hooks confirm it later); else an error. */
  private async prove(address: string, budget: Budget): Promise<void> {
    const waitMs = this.options.deliverWaitMs ?? DEFAULT_DELIVER_WAIT_MS
    const pollMs = this.options.pollMs ?? DELIVER_POLL_MS
    const polls = Math.max(1, Math.ceil(waitMs / pollMs))
    let observed = false
    for (let i = 0; i < polls; i++) {
      const terminal = await this.rpc('terminal.get', { terminal: address }, Terminal, budget).catch(
        (error: unknown) => {
          if (error instanceof HcError) return undefined
          throw error
        },
      )
      if (terminal) {
        observed = true
        if (terminal.state !== 'live') {
          throw new HcError(`${address} ended before the agent reported (exit ${terminal.exit_code ?? 'unknown'})`)
        }
        if (terminal.reported || terminal.status !== null || terminal.turn >= 1) return
      }
      if (i < polls - 1) await Bun.sleep(pollMs)
    }
    // A live terminal that is slow to report (a loaded machine) is started, unconfirmed. Only one that cannot be read or ended is a failed start.
    if (observed) return
    throw new HcError(`${address}'s state is unreadable; the agent is unconfirmed`)
  }

  /**
   * The environment a lead's agent runs with: the account's `CLAUDE_CONFIG_DIR` (absent for the default account, never
   * empty), and the variables that switch the hooks on and tell the usage record who it is.
   */
  private async accountEnv(input: StartTerminal): Promise<Record<string, string>> {
    const home = this.options.home
    let dir: string | null = null
    const file = Bun.file(this.options.accountsFile)
    if (await file.exists()) {
      let registry: z.infer<typeof Registry>
      try {
        registry = Registry.parse(JSON.parse(await file.text()))
      } catch (cause) {
        throw new Permanent(`the account registry ${this.options.accountsFile} is unusable: ${String(cause)}`)
      }
      const entry = registry.accounts[input.account]
      // `default` is the account with no config directory of its own (what the stub seat gives until capacity brings real ones).
      if (!entry && input.account !== 'default') {
        throw new Permanent(`account ${input.account} is not in the registry ${this.options.accountsFile}`)
      }
      dir = entry?.dir ?? null
    } else if (input.account !== 'default') {
      throw new Permanent(`account ${input.account}: no registry at ${this.options.accountsFile}`)
    }
    return {
      ...(dir ? { CLAUDE_CONFIG_DIR: dir.replace(/^~(?=\/|$)/, home) } : {}),
      CLAUDE_ACCOUNT_PICKED: input.account,
      USAGE_LANE: this.options.usageLane ?? 'wave',
      // FACTORY_SESSION switches the hooks on: they report this session's events under the key.
      FACTORY_SESSION: input.key,
      FACTORY_ROLE: 'lead',
      ...(this.options.agentToken ? { FACTORY_TOKEN: this.options.agentToken } : {}),
      ...(this.options.apiUrl ? { FACTORY_URL: this.options.apiUrl } : {}),
    }
  }

  private docRpc(budget: Budget): Rpc {
    return (method, params, schema) => this.rpc(method, params, schema, budget)
  }

  /** One call, inside the budget and the process timeout. `HcError` passes through for the caller to read. */
  private rpc<S extends z.ZodType>(method: string, params: object, schema: S, budget: Budget): Promise<z.output<S>> {
    const limit = budget.limit(this.options.processTimeoutMs ?? DEFAULT_PROCESS_TIMEOUT_MS)
    return this.hc.call(method, params, schema, limit)
  }
}

/** The directory of an account's Claude Code projects (where transcripts lie), from the registry; the default account's is `~/.claude`. */
export async function claudeProjectsDirs(options: { accountsFile: string; home: string }): Promise<string[]> {
  const dirs = [join(options.home, '.claude', 'projects')]
  const file = Bun.file(options.accountsFile)
  if (!(await file.exists())) return dirs
  try {
    const registry = Registry.parse(JSON.parse(await file.text()))
    for (const entry of Object.values(registry.accounts)) {
      if (entry.dir) dirs.push(join(entry.dir.replace(/^~(?=\/|$)/, options.home), 'projects'))
    }
  } catch {
    // an unusable registry names no further directory
  }
  return dirs
}
