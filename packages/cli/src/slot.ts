import { constants } from 'node:os'
import { Slot, SlotRelease } from '@software-factory/contract'
import { usage } from './exit.ts'
import { call, type Io } from './run.ts'

/** How long a caller waits for a slot before it runs without one (`FACTORY_SLOT_WAIT_MS`). */
export const DEFAULT_SLOT_WAIT_MS = 600_000
/** How often a waiter asks again (`FACTORY_SLOT_POLL_MS`). */
export const DEFAULT_SLOT_POLL_MS = 1_000
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
 * `factory slot run [--name <label>] -- <cmd> [args…]` (FL7): takes one of the host's test slots through the socket, runs
 * the command with this process's own stdin, stdout and stderr, renews the lease while it runs and gives the slot back when it
 * ends or this process is told to stop. The exit code is the command's. Fails open: a server that does not answer, or no
 * slot within `FACTORY_SLOT_WAIT_MS`, runs the command anyway with one line on stderr, because a slot is there to cut
 * flakes and must never block work.
 */
export async function slotRun(input: { name?: string; command: string[] }, io: Io): Promise<number> {
  const [program, ...args] = input.command
  if (!program) throw usage('usage: slot run [--name <label>] -- <cmd> [args…]')

  const name = input.name ?? program
  const id = `${process.pid}-${crypto.randomUUID()}`
  const waitMs = number(io.env.FACTORY_SLOT_WAIT_MS, DEFAULT_SLOT_WAIT_MS)
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
  // A signal while waiting leaves the line; while the command runs it is the command's to answer (the terminal's Ctrl-C
  // already reaches it as well), and the slot goes back when it has.
  const onSignal = (signal: NodeJS.Signals) => {
    stopped = signal
    if (signal !== 'SIGINT') child?.kill(signal)
  }
  const signals: NodeJS.Signals[] = ['SIGINT', 'SIGTERM', 'SIGHUP']
  for (const signal of signals) process.on(signal, onSignal)

  try {
    const deadline = Date.now() + waitMs
    let holding = false
    try {
      for (;;) {
        engaged = true
        const { body } = await ask()
        if (body.granted) {
          holding = true
          break
        }
        if (stopped) return 128 + (constants.signals[stopped] ?? 1)
        if (Date.now() >= deadline) {
          io.err(`factory: no test slot within ${Math.round(waitMs / 1000)}s; running without one\n`)
          break
        }
        await sleep(pollMs)
      }
    } catch (error) {
      io.err(`factory: no test slot (${error instanceof Error ? error.message : String(error)}); running without one\n`)
    }
    if (!holding) await release()
    if (stopped) return 128 + (constants.signals[stopped] ?? 1)

    try {
      child = Bun.spawn([program, ...args], { stdin: 'inherit', stdout: 'inherit', stderr: 'inherit', env: io.env })
    } catch (error) {
      io.err(`factory: cannot run ${program}: ${error instanceof Error ? error.message : String(error)}\n`)
      return 127
    }
    const renew = holding ? setInterval(() => void ask().catch(() => {}), RENEW_MS) : undefined
    try {
      await child.exited
    } finally {
      clearInterval(renew)
    }
    return exitCodeOf(child)
  } finally {
    for (const signal of signals) process.off(signal, onSignal)
    await release()
  }
}
