import { realpathSync } from 'node:fs'
import { constants } from 'node:os'
import { send } from '@software-factory/client'
import { DEFAULT_SLOT_RUN_MS, Slot } from '@software-factory/contract'
import { usage } from './exit.ts'
import { DEFAULT_URL, type Io, tokenOf } from './operation.ts'

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
  const deadline = Date.now() + waitMs
  const seconds = Math.round(waitMs / 1000)
  for (;;) {
    input.engage()
    const answer = await ask()
    if (answer.kind === 'outage') return { outage: answer.why }
    if (answer.slot.granted) return 'granted'
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

  const base = io.env.FACTORY_URL || DEFAULT_URL
  const token = tokenOf(io.env)
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
  const cwd = (() => {
    try {
      return realpathSync(process.cwd())
    } catch {
      return undefined
    }
  })()
  // The limit the server resolved for the grant; a server that does not say leaves it to the env or the default.
  let grantedRunMs: number | undefined
  const ask = async (): Promise<Asked> => {
    const answer = await send({ base, method: 'PUT', path, body: { name, cwd, limitMs: envLimit }, token })
    if (!answer.reached) return { kind: 'outage', why: answer.reason }
    if (answer.status >= 500) return { kind: 'outage', why: `the server answered ${answer.status}` }
    if (answer.status === 401 || answer.status === 403) {
      return { kind: 'outage', why: `the server refused the token (${answer.status}): set FACTORY_TOKEN` }
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
    if (!holding) await release()
    if (stopped) return 128 + (constants.signals[stopped] ?? 1)

    try {
      child = Bun.spawn([program, ...args], {
        stdin: 'inherit',
        stdout: 'inherit',
        stderr: 'inherit',
        env: io.env,
        detached: true,
      })
    } catch (error) {
      io.err(`factory: cannot run ${program}: ${error instanceof Error ? error.message : String(error)}\n`)
      return 127
    }
    // The lease is renewed while the command runs. A renewal that is answered "wait" means the lease had lapsed (the server
    // was out of reach for longer than it lasts) and the slot is someone else's: said once, and the line is left.
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
      // An answer still on its way would put the holder back after the slot is given up.
      await renewing
    }
    return limited ? EX_RUN_LIMIT : exitCodeOf(child)
  } finally {
    for (const signal of signals) process.off(signal, onSignal)
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
