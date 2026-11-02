import { stat } from 'node:fs/promises'
import { z } from 'zod'
import { childEnv, EXIT_TIMEOUT, runProcess } from '../exec.ts'
import type { HcClient } from '../hc.ts'

/** Every read of a source is bounded: a hung `git` or `hc` costs this long, never the build. */
export const SOURCE_TIMEOUT_MS = 10_000
export const GIT_TIMEOUT_MS = 5_000

/** One live terminal of herdr-core, as far as the fleet reads it. */
export interface HcTerminal {
  address: string
  name: string | null
  cwd: string | null
  title: string | null
  /** the factory's key label, when the terminal was started by it */
  factoryKey: string | null
  /** `working`, `idle`, `done`, `blocked`, … ; null while the agent has said nothing */
  status: string | null
  statusMessage: string | null
  statusAt: string | null
  parent: string | null
  /** whether the foreground program is Claude Code */
  claude: boolean
  /** what the terminal was started with: the prompt of an agent started by `rd` is in here */
  prompt: string | null
  role: string | null
  account: string | null
}

export interface HcLister {
  list(): Promise<HcTerminal[]>
}

const Record_ = z
  .object({
    address: z.string(),
    name: z.string().nullable().default(null),
    cwd: z.string().optional(),
    title: z.string().optional(),
    labels: z.record(z.string(), z.string()).default({}),
    argv: z.array(z.string()).default([]),
    state: z.string().default('live'),
    parent: z.string().nullable().default(null),
    status: z
      .object({ state: z.string(), msg: z.string().optional(), app: z.string().optional() })
      .loose()
      .nullable()
      .default(null),
    status_ms: z.number().nullable().default(null),
    foreground: z
      .object({ name: z.string().optional(), argv: z.array(z.string()).default([]) })
      .loose()
      .nullable()
      .default(null),
  })
  .loose()
const TerminalList = z.object({ terminals: z.array(Record_) }).loose()

const envOf = (argv: readonly string[], name: string): string | null => {
  const prefix = `${name}=`
  const found = argv.find((arg) => arg.startsWith(prefix))
  return found ? found.slice(prefix.length) || null : null
}

/** `hc ls --json` is this RPC's summary (`terminal.list`); the RPC also has the title, the labels and the argv. */
export class HcTerminals implements HcLister {
  constructor(private readonly client: HcClient) {}

  async list(): Promise<HcTerminal[]> {
    const { terminals } = await this.client.call('terminal.list', {}, TerminalList, SOURCE_TIMEOUT_MS)
    return terminals
      .filter((t) => t.state === 'live')
      .map((t) => {
        const argv = t.foreground?.argv.length ? t.foreground.argv : t.argv
        const claude = t.status?.app === 'claude-code' || t.foreground?.name === 'claude' || argv.includes('claude')
        // The prompt an agent started with is its longest argument; a short one is a flag.
        const prompt = [...t.argv].sort((a, b) => b.length - a.length)[0] ?? null
        return {
          address: t.address,
          name: t.name,
          cwd: t.cwd ?? null,
          title: t.title?.trim() || null,
          factoryKey: t.labels['factory.key'] ?? null,
          status: t.status?.state ?? null,
          statusMessage: t.status?.msg ?? null,
          statusAt: t.status_ms === null ? null : new Date(t.status_ms).toISOString(),
          parent: t.parent,
          claude,
          prompt: prompt && prompt.length > 80 ? prompt : null,
          role: envOf(t.argv, 'FACTORY_ROLE'),
          account: envOf(t.argv, 'CLAUDE_ACCOUNT_PICKED'),
        }
      })
  }
}

/** One request in the human queue (`ask-human.sh list --json`). */
export interface QueueRequest {
  id: string
  text: string
  /** the command the request would run once the owner approves it: data, read by the probes for what it names, never run by the factory */
  cmd?: string | null
  askedAt: string
  state: string | null
}

export interface QueueReader {
  list(): Promise<QueueRequest[]>
}

export type QueueOutcome = 'done' | 'denied' | 'superseded'

/** The queue refused or could not take an answer: `reason` is what the owner is told (503). */
export class QueueUnavailable extends Error {}

/**
 * What `resolve` did: wrote the result, or found the request already had one (an earlier call whose record here failed, a human's
 * answer) and says what it shows. `status` is the queue's word (`done`, `denied`, `failed`), `resolvedAs` the outcome a `resolve` gave it.
 */
export type QueueResolved = { written: true } | { written: false; status: string; resolvedAs: QueueOutcome | null }

/** Writes a result into the human queue. It never runs the request's command: `resolve` only records how the request ended. */
export interface QueueActor {
  resolve(id: string, as: QueueOutcome, note?: string): Promise<QueueResolved>
}

const QueueList = z.array(
  z
    .object({
      id: z.string().min(1),
      text: z.string(),
      cmd: z.string().nullable().optional(),
      askedAt: z.string().refine((v) => !Number.isNaN(Date.parse(v)), 'askedAt is not a time'),
      state: z.string().optional(),
    })
    .loose(),
)

/**
 * The queue is dotfiles': `ask-human.sh list --json`, one JSON array. A script without the flag yet answers in plain text or
 * fails; that is an error line in the model, not a crash.
 */
export class AskHumanQueue implements QueueReader, QueueActor {
  constructor(
    private readonly bin: string,
    private readonly run: typeof runProcess = runProcess,
  ) {}

  async list(): Promise<QueueRequest[]> {
    if (
      !(await stat(this.bin).then(
        (s) => s.isFile(),
        () => false,
      ))
    )
      throw new Error(`${this.bin} does not exist`)
    const done = await this.run([this.bin, 'list', '--json'], SOURCE_TIMEOUT_MS, childEnv())
    if (done.exitCode === EXIT_TIMEOUT) throw new Error('ask-human.sh list --json did not answer in time')
    if (done.exitCode !== 0) throw new Error(`ask-human.sh list --json exited ${done.exitCode}`)
    let json: unknown
    try {
      json = JSON.parse(done.stdout)
    } catch {
      throw new Error('ask-human.sh list --json did not print JSON')
    }
    const parsed = QueueList.safeParse(json)
    if (!parsed.success)
      throw new Error(`ask-human.sh list --json: ${parsed.error.issues[0]?.message ?? 'unexpected shape'}`)
    return parsed.data.map((r) => ({
      id: r.id,
      text: r.text,
      cmd: r.cmd ?? null,
      askedAt: new Date(r.askedAt).toISOString(),
      state: r.state ?? null,
    }))
  }

  /**
   * `ask-human.sh resolve <id> --as done|denied|superseded [--note <text>]` (dotfiles': it lands beside this wave). Until the script
   * has it, the answer is `QueueUnavailable` with the reason: the help text is read first, so a script without the subcommand is
   * never asked to run an unknown one. The id is the queue's own (`list --json`), checked against its shape before it reaches argv.
   */
  async resolve(id: string, as: QueueOutcome, note?: string): Promise<QueueResolved> {
    if (!/^\w[\w.-]*$/.test(id)) throw new QueueUnavailable(`queue id ${id} is not a queue id`)
    if (
      !(await stat(this.bin).then(
        (s) => s.isFile(),
        () => false,
      ))
    )
      throw new QueueUnavailable(`${this.bin} does not exist`)
    const help = await this.run([this.bin, 'help'], SOURCE_TIMEOUT_MS, childEnv())
    if (help.exitCode !== 0 || !/\bresolve\b/.test(help.stdout))
      throw new QueueUnavailable(
        'the human queue has no `resolve` yet (ask-human.sh resolve lands with the dotfiles wave)',
      )
    const args = [this.bin, 'resolve', id, '--as', as, ...(note ? ['--note', note] : [])]
    const done = await this.run(args, SOURCE_TIMEOUT_MS, childEnv())
    if (done.exitCode === EXIT_TIMEOUT) throw new QueueUnavailable('ask-human.sh resolve did not answer in time')
    if (done.exitCode === 0) return { written: true }
    // Exit 2 is every refusal, "already has a result" among them (its line is on stderr, which is not read): ask the queue what the
    // request shows, so an answer written by an earlier call whose record failed here converges instead of failing for good.
    if (done.exitCode === 2) {
      const shown = await this.result(id)
      if (shown) return { written: false, ...shown }
    }
    throw new QueueUnavailable(`ask-human.sh resolve exited ${done.exitCode}`)
  }

  /** The result a request shows in `ask-human.sh status <id>` (the request's JSON, then its result's): its status and how it was resolved. */
  private async result(id: string): Promise<{ status: string; resolvedAs: QueueOutcome | null } | undefined> {
    const done = await this.run([this.bin, 'status', id], SOURCE_TIMEOUT_MS, childEnv())
    if (done.exitCode !== 0) return undefined
    for (const line of done.stdout.split('\n').reverse()) {
      if (!line.trim().startsWith('{')) continue
      try {
        const parsed = z
          .object({ status: z.string(), resolvedAs: z.enum(['done', 'denied', 'superseded']).nullish() })
          .loose()
          .safeParse(JSON.parse(line))
        // Only a result the queue has written is one: an open or pending request is a refusal for another reason.
        if (parsed.success && ['done', 'denied', 'failed', 'superseded'].includes(parsed.data.status))
          return { status: parsed.data.status, resolvedAs: parsed.data.resolvedAs ?? null }
      } catch {
        // not a result line
      }
    }
    return undefined
  }
}

/**
 * Whether every source an ask comes from answered in this build (hc, the database, the human queue, the digest's reply asks, the stored
 * snapshot it restarts from): only then does an ask that is not listed have left, and its occurrence end. A plan or a repo that could not be
 * read changes no ask's existence.
 */
export const askSourcesAnswered = (errors: readonly string[]): boolean =>
  !errors.some((e) => /^(hc|database|human queue|digest|snapshot)/.test(e))
