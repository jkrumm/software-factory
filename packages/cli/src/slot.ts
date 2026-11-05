import { constants } from 'node:os'
import { Slot, SlotRelease } from '@software-factory/contract'
import { usage } from './exit.ts'
import { call, type Io } from './client.ts'

/** How long a caller waits for a slot before it gives up with `EX_TEMPFAIL` (`FACTORY_SLOT_WAIT_MS`). */
const DEFAULT_SLOT_WAIT_MS = 45 * 60_000
/** The exit code of a wait that ran out: sysexits `EX_TEMPFAIL`, "try again later". The command did not run. */
const EX_TEMPFAIL = 75
/** How often a waiter asks again (`FACTORY_SLOT_POLL_MS`). */
const DEFAULT_SLOT_POLL_MS = 1_000
/** The lease is renewed this often while the command runs; the server lets it lapse after 30 s. */
const RENEW_MS = 10_000

const number = (value: string | undefined, fallback: number): number => {
  const n = Number(value)
  return value !== undefined && value !== '' && Number.isFinite(n) && n >= 0 ? n : fallback
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/** The exit code a child's end stands for: its own, or 128 plus the signal that killed it, as a shell reports it. */
function exitCodeOf(proc: { exitCode: number | null; signalCode: NodeJS.Signals | number | null }): number {
  if (proc.exitCode !== null) return proc.exitCode
  const signal = typeof proc.signalCode === 'string' ? constants.signals[proc.signalCode] : proc.signalCode
  return 128 + (signal ?? 1)
}

/**
 * Asks until the slot is granted. `granted`: it is ours. `open`: run without one (the wait ran out under
 * `FACTORY_SLOT_OPEN=1`). `stopped`: this process was told to stop. A number is the exit code of a wait that ran out, `EX_TEMPFAIL`:
 * the command does not run. A server that does not answer throws, and the caller runs the command anyway.
 */
async function acquire(input: {
  ask: () => Promise<{ body: { granted: boolean } }>
  io: Io
  waitMs: number
  pollMs: number
  open: boolean
  engage: () => void
  stopped: () => boolean
}): Promise<'granted' | 'open' | 'stopped' | number> {
  const { ask, io, waitMs, pollMs, open } = input
  const deadline = Date.now() + waitMs
  const seconds = Math.round(waitMs / 1000)
  for (;;) {
    input.engage()
    const { body } = await ask()
    if (body.granted) return 'granted'
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
 * `factory slot run [--name <label>] -- <cmd> [args…]` (FL7): takes one of the host's test slots through the socket, runs
 * the command with this process's own stdin, stdout and stderr, renews the lease while it runs and gives the slot back when it
 * ends or this process is told to stop. The exit code is the command's. Open only on an outage: a server that does not
 * answer runs the command anyway with one line on stderr (a dead factory must not block the work that repairs it). On
 * contention it keeps waiting; no slot within `FACTORY_SLOT_WAIT_MS` (45 min) is one stderr line and exit 75 without running
 * the command, unless `FACTORY_SLOT_OPEN=1` says to run it anyway.
 */
export async function slotRun(input: { name?: string; command: string[] }, io: Io): Promise<number> {
  const [program, ...args] = input.command
  if (!program) throw usage('usage: slot run [--name <label>] -- <cmd> [args…]')

  const name = input.name ?? program
  const id = `${process.pid}-${crypto.randomUUID()}`
  const waitMs = number(io.env.FACTORY_SLOT_WAIT_MS, DEFAULT_SLOT_WAIT_MS)
  const open = io.env.FACTORY_SLOT_OPEN === '1'
  const pollMs = number(io.env.FACTORY_SLOT_POLL_MS, DEFAULT_SLOT_POLL_MS)
  const path = `/slots/${encodeURIComponent(id)}`
  const ask = () => call(io, path, { method: 'PUT', auth: false, socket: true, schema: Slot, body: { name } })

  let engaged = false
  let child: ReturnType<typeof Bun.spawn> | undefined
  let stopped: NodeJS.Signals | undefined
  const release = async (): Promise<void> => {
    if (!engaged) return
    engaged = false
    await call(io, path, { method: 'DELETE', auth: false, socket: true, schema: SlotRelease }).catch(() => {})
  }
  // A signal while waiting leaves the line; while the command runs it is passed on to the command (from the terminal it
  // reaches the command as well, and a command that is told twice still ends), and the slot goes back when it has ended.
  const onSignal = (signal: NodeJS.Signals) => {
    stopped = signal
    child?.kill(signal)
  }
  const signals: NodeJS.Signals[] = ['SIGINT', 'SIGTERM', 'SIGHUP']
  for (const signal of signals) process.on(signal, onSignal)

  try {
    let outcome: Awaited<ReturnType<typeof acquire>>
    try {
      outcome = await acquire({
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
    } catch (error) {
      io.err(`factory: no test slot (${error instanceof Error ? error.message : String(error)}); running without one\n`)
      outcome = 'open'
    }
    if (typeof outcome === 'number') return outcome
    const holding = outcome === 'granted'
    if (!holding) await release()
    if (stopped) return 128 + (constants.signals[stopped] ?? 1)

    try {
      child = Bun.spawn([program, ...args], { stdin: 'inherit', stdout: 'inherit', stderr: 'inherit', env: io.env })
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
            const answer = await ask().catch(() => undefined)
            renewalPending = false
            if (ended || warned || !answer || answer.body.granted) return
            warned = true
            io.err('factory: the test slot lease lapsed while the command ran; it runs on without a slot\n')
            await release()
          })
        }, RENEW_MS)
      : undefined
    try {
      await child.exited
    } finally {
      ended = true
      clearInterval(renew)
      // An answer still on its way would put the holder back after the slot is given up.
      await renewing
    }
    return exitCodeOf(child)
  } finally {
    for (const signal of signals) process.off(signal, onSignal)
    await release()
  }
}
