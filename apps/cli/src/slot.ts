import { realpathSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { constants, tmpdir } from 'node:os'
import { join } from 'node:path'
import { send } from '@software-factory/client'
import { DEFAULT_SLOT_RUN_MS, Slot, type StepCost } from '@software-factory/contract'
import { usage } from './exit.ts'
import { credentialOf } from './credentials.ts'
import { DEFAULT_URL, type Io } from './operation.ts'
import { collectJunit } from './junit.ts'
import { readProcesses, treeMeter } from './process-tree.ts'

/** How long a caller waits for a slot before it gives up with `EX_TEMPFAIL` (`FACTORY_SLOT_WAIT_MS`). */
const DEFAULT_SLOT_WAIT_MS = 45 * 60_000
/** The exit code of a wait that ran out: sysexits `EX_TEMPFAIL`, "try again later". The command did not run. */
export const EX_TEMPFAIL = 75
/** The exit code of a command killed for running past its limit: as `timeout(1)` reports it. */
const EX_RUN_LIMIT = 124
/** After SIGTERM a command's process group has this long to end before it gets SIGKILL (`FACTORY_SLOT_KILL_GRACE_MS`). */
const DEFAULT_KILL_GRACE_MS = 5_000
/** The longest run limit the server takes. */
const MAX_RUN_LIMIT_MS = 24 * 3_600_000
/** How often the grace wait looks whether the group has ended. */
const GRACE_POLL_MS = 50
/** How often a waiter asks again (`FACTORY_SLOT_POLL_MS`). */
const DEFAULT_SLOT_POLL_MS = 1_000
/** The server lets a waiter lapse after 15 s, so the poll stays well inside that. */
const MIN_SLOT_POLL_MS = 100
const MAX_SLOT_POLL_MS = 5_000
/** The server refuses a longer slot name (`SlotBody`). */
const MAX_SLOT_NAME = 200
/** The lease is renewed this often while the command runs; the server lets it lapse after 30 s. */
const RENEW_MS = 10_000
/** How often the command's process tree is measured while it runs. */
const MEASURE_MS = 3_000

const number = (value: string | undefined, fallback: number): number => {
  const n = Number(value)
  return value !== undefined && value !== '' && Number.isFinite(n) && n >= 0 ? n : fallback
}

/** `FACTORY_SLOT_RUN_MS`: a positive number of ms (at most 24 h), else nothing. */
const limitOf = (value: string | undefined): number | undefined => {
  const n = Math.floor(Number(value))
  return value !== undefined && value !== '' && Number.isFinite(n) && n >= 1 ? Math.min(n, MAX_RUN_LIMIT_MS) : undefined
}

/** `30 min` for whole minutes, else `45 s`, else `500 ms`. */
function describeLimit(ms: number): string {
  if (ms % 60_000 === 0) return `${ms / 60_000} min`
  if (ms % 1000 === 0) return `${ms / 1000} s`
  return `${ms} ms`
}

/** The command leads its own process group (`detached`): a signal goes to all of it, or to the command alone if that fails. */
export function signalGroup(
  proc: { pid: number; kill: (signal: NodeJS.Signals) => void },
  signal: NodeJS.Signals,
): void {
  try {
    process.kill(-proc.pid, signal)
  } catch {
    try {
      proc.kill(signal)
    } catch {
      // already gone
    }
  }
}

const groupAlive = (pid: number): boolean => {
  try {
    process.kill(-pid, 0)
    return true
  } catch {
    return false
  }
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/** The directory the caller runs in, symlinks resolved: the form the server matches a step or a merge window to a lead's worktree by. */
export function callerCwd(): string | undefined {
  try {
    return realpathSync(process.cwd())
  } catch {
    return undefined
  }
}

/** The exit code a child's end stands for: its own, or 128 plus the signal that killed it, as a shell reports it. */
export function exitCodeOf(proc: { exitCode: number | null; signalCode: NodeJS.Signals | number | null }): number {
  if (proc.exitCode !== null) return proc.exitCode
  const signal = typeof proc.signalCode === 'string' ? constants.signals[proc.signalCode] : proc.signalCode
  return 128 + (signal ?? 1)
}

/** What one call to the server came back with: the slot, or why the caller should run without one. */
type Asked = { kind: 'slot'; slot: Slot } | { kind: 'outage'; why: string }

/**
 * Asks until the slot is granted. `granted`: it is ours. `open`: run without one (the wait ran out under
 * `FACTORY_SLOT_OPEN=1`). `stopped`: this process was told to stop. A number is the exit code of a wait that ran out,
 * `EX_TEMPFAIL`: the command does not run.
 */
async function acquire(input: {
  ask: () => Promise<Asked>
  io: Io
  waitMs: number
  pollMs: number
  open: boolean
  engage: () => void
  stopped: () => boolean
}): Promise<'granted' | 'open' | 'stopped' | { outage: string } | number> {
  const { ask, io, waitMs, pollMs, open } = input
  const started = Date.now()
  const deadline = started + waitMs
  const seconds = Math.round(waitMs / 1000)
  let queued = false
  let told: string | null = null
  for (;;) {
    input.engage()
    const answer = await ask()
    if (answer.kind === 'outage') return { outage: answer.why }
    if (answer.slot.granted) {
      if (queued) io.err(`factory: got a test slot after ${Math.round((Date.now() - started) / 1000)}s\n`)
      return 'granted'
    }
    const why = answer.slot.why
    // The all-busy case keeps its wording; any other reason is said as the server gave it, and again when it changes.
    const reason = why === null || why.startsWith('all ') ? 'all busy' : why
    if (!queued) {
      queued = true
      told = reason
      io.err(
        `factory: queued for a test slot (${reason}, ${answer.slot.ahead} waiting ahead); waiting up to ${Math.round(waitMs / 60_000)} min\n`,
      )
    } else if (reason !== told) {
      told = reason
      io.err(`factory: still queued for a test slot (${reason}, ${answer.slot.ahead} waiting ahead)\n`)
    }
    if (input.stopped()) return 'stopped'
    if (Date.now() >= deadline) break
    await sleep(pollMs)
  }
  if (open) {
    io.err(`factory: no test slot within ${seconds}s; running without one (FACTORY_SLOT_OPEN=1)\n`)
    return 'open'
  }
  io.err(`factory: no test slot within ${seconds}s; not running (set FACTORY_SLOT_OPEN=1 to run anyway)\n`)
  return EX_TEMPFAIL
}

/** The finished step's cost, appended to the server's ledger. Best effort: a failure changes nothing. */
async function reportCost(input: {
  base: string
  path: string
  token: string | undefined
  cost: StepCost
}): Promise<void> {
  try {
    await send({ base: input.base, method: 'POST', path: `${input.path}/cost`, body: input.cost, token: input.token })
  } catch {
    // the ledger is a convenience
  }
}

/** Runs git in a directory; null when it fails (not a repository, no git). */
async function git(cwd: string, args: string[]): Promise<string | null> {
  try {
    const proc = Bun.spawn(['git', '-C', cwd, ...args], { stdin: 'ignore', stdout: 'pipe', stderr: 'ignore' })
    const out = await new Response(proc.stdout).text()
    return (await proc.exited) === 0 ? out.trim() : null
  } catch {
    return null
  }
}

/**
 * The code a step runs on: `HEAD`, and whether tracked files differ from it. Read before the command starts (the tests
 * may write files). A flake is the same code with both results, so a dirty tree is not evidence of one; untracked files
 * do not make a tree dirty (a log the caller redirects into the worktree would).
 */
async function codeOf(cwd: string | undefined): Promise<{ commit?: string; dirty?: boolean }> {
  if (cwd === undefined) return {}
  const [commit, status] = await Promise.all([
    git(cwd, ['rev-parse', 'HEAD']),
    git(cwd, ['status', '--porcelain', '--untracked-files=no']),
  ])
  return commit ? { commit, ...(status === null ? {} : { dirty: status !== '' }) } : {}
}

/** A command inside a slot its caller holds: run as it is, no queue, and the exit code is the command's. */
async function runHeld(program: string, args: string[], io: Io): Promise<number> {
  try {
    const child = Bun.spawn([program, ...args], { stdin: 'inherit', stdout: 'inherit', stderr: 'inherit', env: io.env })
    return exitCodeOf({ exitCode: await child.exited, signalCode: child.signalCode })
  } catch (error) {
    io.err(`factory: cannot run ${program}: ${error instanceof Error ? error.message : String(error)}\n`)
    return 127
  }
}

/**
 * `factory slot run [--name <label>] -- <cmd> [args…]`: takes one of the host's test slots from the server, runs the
 * command with this process's own stdin, stdout and stderr, renews the lease while it runs and gives the slot back when
 * it ends or this process is told to stop. The exit code is the command's. **Open only on an outage:** a server that
 * does not answer runs the command anyway with one line on stderr (a dead factory must not block the work that repairs
 * it). **Closed on contention:** no slot within `FACTORY_SLOT_WAIT_MS` (45 min) is one stderr line and exit 75 without
 * running the command, unless `FACTORY_SLOT_OPEN=1` says to run it anyway. A command that runs past its run limit
 * (`FACTORY_SLOT_RUN_MS`, else the project's `slots.run`, else 30 min; the server resolves it) has its whole process
 * group sent SIGTERM, then SIGKILL after `FACTORY_SLOT_KILL_GRACE_MS` (5 s), and the exit code is 124.
 */
export async function slotRun(input: { name?: string; command: string[] }, io: Io): Promise<number> {
  const [program, ...args] = input.command
  if (!program) throw usage('usage: slot run [--name <label>] -- <cmd> [args…]')
  // Inside a slot already (the whole `make check` runs in one): the steps below it are that slot's, they do not queue again.
  if (io.env.FACTORY_SLOT_ACTIVE === '1') return runHeld(program, args, io)

  const base = io.env.FACTORY_URL || DEFAULT_URL
  const { token, failure } = await credentialOf(io.env)
  const name = (input.name ?? program).slice(0, MAX_SLOT_NAME)
  const id = `${process.pid}-${crypto.randomUUID()}`
  const waitMs = number(io.env.FACTORY_SLOT_WAIT_MS, DEFAULT_SLOT_WAIT_MS)
  const open = io.env.FACTORY_SLOT_OPEN === '1'
  const pollMs = Math.min(
    MAX_SLOT_POLL_MS,
    Math.max(MIN_SLOT_POLL_MS, number(io.env.FACTORY_SLOT_POLL_MS, DEFAULT_SLOT_POLL_MS)),
  )
  const path = `/slots/${encodeURIComponent(id)}`
  const envLimit = limitOf(io.env.FACTORY_SLOT_RUN_MS)
  const graceMs = number(io.env.FACTORY_SLOT_KILL_GRACE_MS, DEFAULT_KILL_GRACE_MS)
  const cwd = callerCwd()
  // Once the command runs under a slot, its process tree is measured and the renewals carry the sizes.
  let meter: ReturnType<typeof treeMeter> | undefined
  // The limit the server resolved for the grant; a server that does not say leaves it to the env or the default.
  let grantedRunMs: number | undefined
  const ask = async (): Promise<Asked> => {
    const answer = await send({
      base,
      method: 'PUT',
      path,
      body: {
        name,
        cwd,
        limitMs: envLimit,
        rssMib: meter?.rssMib ?? undefined,
        peakRssMib: meter?.peakRssMib ?? undefined,
        // Set once the command runs: a lease that lapsed meanwhile is taken back, not queued for.
        holding: meter ? true : undefined,
      },
      token,
    })
    if (!answer.reached) return { kind: 'outage', why: answer.reason }
    if (answer.status >= 500) return { kind: 'outage', why: `the server answered ${answer.status}` }
    if (answer.status === 401 || answer.status === 403) {
      return {
        kind: 'outage',
        why: `the server refused the token (${answer.status}): set FACTORY_TOKEN${failure ? ` (${failure})` : ''}`,
      }
    }
    const parsed = Slot.safeParse(answer.json)
    if (!parsed.success)
      return { kind: 'outage', why: `the server answered ${answer.status} with a body this CLI does not know` }
    if (parsed.data.granted && grantedRunMs === undefined) grantedRunMs = parsed.data.runMs
    return { kind: 'slot', slot: parsed.data }
  }

  let engaged = false
  let child: ReturnType<typeof Bun.spawn> | undefined
  let stopped: NodeJS.Signals | undefined
  const release = async (): Promise<void> => {
    if (!engaged) return
    engaged = false
    await send({ base, method: 'DELETE', path, token })
  }
  // A signal while waiting leaves the line; while the command runs it is passed on to the command (from the terminal it
  // reaches the command as well, and a command that is told twice still ends), and the slot goes back when it has ended.
  const onSignal = (signal: NodeJS.Signals) => {
    stopped = signal
    if (child) signalGroup(child, signal)
  }
  const signals: NodeJS.Signals[] = ['SIGINT', 'SIGTERM', 'SIGHUP']
  for (const signal of signals) process.on(signal, onSignal)

  const askedAt = Date.now()
  // Where the command leaves its JUnit files (the repos' check targets write them there: docs/plan.md "Check tiers").
  let junitDir: string | undefined
  try {
    const outcome = await acquire({
      ask,
      io,
      waitMs,
      pollMs,
      open,
      engage: () => {
        engaged = true
      },
      stopped: () => stopped !== undefined,
    })
    if (typeof outcome === 'number') return outcome
    if (typeof outcome === 'object') {
      io.err(`factory: no test slot (${outcome.outage}); running without one\n`)
    }
    const holding = outcome === 'granted'
    const waitedMs = Date.now() - askedAt
    if (!holding) await release()
    if (stopped) return 128 + (constants.signals[stopped] ?? 1)

    let code: Awaited<ReturnType<typeof codeOf>> = {}
    if (holding) {
      code = await codeOf(cwd)
      junitDir = await mkdtemp(join(tmpdir(), 'factory-junit-')).catch(() => undefined)
    }
    try {
      child = Bun.spawn([program, ...args], {
        stdin: 'inherit',
        stdout: 'inherit',
        stderr: 'inherit',
        env: holding
          ? { ...io.env, FACTORY_SLOT_ACTIVE: '1', ...(junitDir === undefined ? {} : { FACTORY_JUNIT_DIR: junitDir }) }
          : io.env,
        detached: true,
      })
    } catch (error) {
      io.err(`factory: cannot run ${program}: ${error instanceof Error ? error.message : String(error)}\n`)
      return 127
    }
    const startedAt = Date.now()
    // Measured at once and then every few seconds, so even a short command has a size; a failed `ps` is skipped.
    let measuring: Promise<void> = Promise.resolve()
    let measureTimer: ReturnType<typeof setInterval> | undefined
    if (holding) {
      const tree = treeMeter(child.pid)
      meter = tree
      const measure = () => {
        measuring = measuring.then(async () => {
          const rows = await readProcesses()
          if (rows) tree.sample(rows)
        })
      }
      measure()
      measureTimer = setInterval(measure, MEASURE_MS)
    }
    // The lease is renewed while the command runs. A lease that lapsed (the server was out of reach for longer than it
    // lasts) is taken back by the renewal; an answer of "wait" is only a server that does not know `holding`: said once,
    // and the line is left.
    let renewing: Promise<void> = Promise.resolve()
    let ended = false
    let warned = false
    let renewalPending = false
    const renew = holding
      ? setInterval(() => {
          if (ended || warned || renewalPending) return
          renewalPending = true
          renewing = renewing.then(async () => {
            const answer = await ask()
            renewalPending = false
            if (ended || warned || answer.kind === 'outage' || answer.slot.granted) return
            warned = true
            io.err('factory: the test slot lease lapsed while the command ran; it runs on without a slot\n')
            await release()
          })
        }, RENEW_MS)
      : undefined
    // Past its run limit the whole process group gets SIGTERM, and SIGKILL if any of it is left after the grace.
    const proc = child
    const limitMs = grantedRunMs ?? envLimit ?? DEFAULT_SLOT_RUN_MS
    let limited = false
    let killing: Promise<void> = Promise.resolve()
    const limitTimer = setTimeout(() => {
      limited = true
      io.err(
        `factory: the command ran past the test-slot run limit of ${describeLimit(limitMs)} (FACTORY_SLOT_RUN_MS, or slots.run in project.yaml); killed its process group\n`,
      )
      killing = (async () => {
        signalGroup(proc, 'SIGTERM')
        const until = Date.now() + graceMs
        while (groupAlive(proc.pid) && Date.now() < until) await sleep(GRACE_POLL_MS)
        if (groupAlive(proc.pid)) signalGroup(proc, 'SIGKILL')
      })()
    }, limitMs)
    try {
      await child.exited
      await killing
    } finally {
      clearTimeout(limitTimer)
      ended = true
      if (renew) clearInterval(renew)
      if (measureTimer) clearInterval(measureTimer)
      // An answer still on its way would put the holder back after the slot is given up.
      await renewing
      await measuring
    }
    const exitCode = limited ? EX_RUN_LIMIT : exitCodeOf(child)
    if (holding && meter) {
      const tests = junitDir === undefined ? [] : await collectJunit(junitDir)
      await reportCost({
        base,
        path,
        token,
        cost: {
          name,
          ...(cwd === undefined ? {} : { cwd }),
          peakRssMib: meter.peakRssMib,
          cpuSeconds: meter.cpuSeconds,
          durationMs: Date.now() - startedAt,
          waitMs: waitedMs,
          exitCode,
          ...code,
          ...(tests.length === 0 ? {} : { tests }),
        },
      })
    }
    return exitCode
  } finally {
    for (const signal of signals) process.off(signal, onSignal)
    if (junitDir !== undefined) await rm(junitDir, { recursive: true, force: true }).catch(() => undefined)
    await release()
  }
}

/** `slot run [--name <label>] -- <cmd> [args…]`: the words after `slot`, split at the first `--`. */
export async function slotVerb(words: readonly string[], io: Io): Promise<number> {
  const [verb, ...rest] = words
  if (verb !== 'run') throw usage('usage: slot run [--name <label>] -- <cmd> [args…]')
  const split = rest.indexOf('--')
  const options = split === -1 ? rest : rest.slice(0, split)
  const command = split === -1 ? [] : rest.slice(split + 1)
  let name: string | undefined
  for (let i = 0; i < options.length; i++) {
    const word = options[i]
    if (word === '--name' && options[i + 1] !== undefined) name = options[++i]
    else if (word?.startsWith('--name=')) name = word.slice('--name='.length)
    else throw usage(`slot run: unknown argument ${word}`, 'usage: slot run [--name <label>] -- <cmd> [args…]')
  }
  return slotRun({ ...(name === undefined ? {} : { name }), command }, io)
}
