import { lstatSync, mkdirSync, readlinkSync, rmdirSync, rmSync, symlinkSync } from 'node:fs'
import { constants } from 'node:os'
import { join } from 'node:path'
import { usage } from './exit.ts'
import type { Io } from './operation.ts'
import { EX_TEMPFAIL, exitCodeOf, signalGroup } from './slot.ts'

const USAGE = 'usage: deploy-lock --project <name> -- <cmd> [args…]'
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/
/** How long a caller waits for a live holder (`FACTORY_DEPLOY_LOCK_WAIT_MS`). */
const DEFAULT_WAIT_MS = 30 * 60_000
/** How often a waiter looks again (`FACTORY_DEPLOY_LOCK_POLL_MS`). */
const DEFAULT_POLL_MS = 2_000

const number = (value: string | undefined, fallback: number): number => {
  const n = Number(value)
  return value !== undefined && value !== '' && Number.isFinite(n) && n >= 0 ? n : fallback
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

const exists = (path: string): boolean => {
  try {
    lstatSync(path)
    return true
  } catch {
    return false
  }
}

const reason = (error: unknown): string => (error instanceof Error ? error.message : String(error))

/** The pid a lock names, or why it cannot be read (the lock is then never reclaimed). */
function holderOf(lock: string): { pid: number } | { unreadable: string } {
  let target: string
  try {
    target = readlinkSync(lock)
  } catch (error) {
    return { unreadable: reason(error) }
  }
  return /^[0-9]+$/.test(target) && Number(target) > 0
    ? { pid: Number(target) }
    : { unreadable: `its target is "${target}", not a pid` }
}

/**
 * One try at the lock, a symlink to our pid (`symlinkSync` is atomic and the pid is in place from the first moment).
 * `taken`: ours. `held`: a live process has it. `failed`: it cannot be created or read, the caller stops (closed).
 * A holder that is dead is reclaimed, one reclaimer at a time (`<lock>.reclaim`, a `mkdir`).
 */
function tryTake(lock: string): 'taken' | { held: number } | { failed: string } {
  try {
    symlinkSync(String(process.pid), lock)
    return 'taken'
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') return { failed: `cannot create ${lock}: ${reason(error)}` }
  }
  const holder = holderOf(lock)
  if ('unreadable' in holder) return { failed: `cannot read ${lock}: ${holder.unreadable}` }
  if (alive(holder.pid)) return { held: holder.pid }

  const reclaim = `${lock}.reclaim`
  try {
    mkdirSync(reclaim)
  } catch (error) {
    return {
      failed: `cannot reclaim ${lock}: ${reclaim} (${reason(error)}); someone else is reclaiming, or a crashed reclaim needs a manual rm`,
    }
  }
  try {
    // Under the reclaim lock: look again, and remove the lock only if its holder is still dead.
    if (exists(lock)) {
      const again = holderOf(lock)
      if ('unreadable' in again) return { failed: `cannot read ${lock}: ${again.unreadable}` }
      if (alive(again.pid)) return { held: again.pid }
      rmSync(lock, { force: true })
    }
    symlinkSync(String(process.pid), lock)
    return 'taken'
  } catch (error) {
    return { failed: `cannot take ${lock}: ${reason(error)}` }
  } finally {
    rmdirSync(reclaim)
  }
}

/** Removes the lock only while it still names this process. */
function release(lock: string): void {
  const holder = holderOf(lock)
  if ('pid' in holder && holder.pid === process.pid) rmSync(lock, { force: true })
}

/**
 * `factory deploy-lock --project <name> -- <cmd> [args…]`: runs the command, with this process's own stdin, stdout and
 * stderr, while holding the one deploy lock of the project on this host, so two leads of one project never deploy at the
 * same time. The exit code is the command's. A live holder is waited for (`FACTORY_DEPLOY_LOCK_WAIT_MS`, 30 min, polled
 * every `FACTORY_DEPLOY_LOCK_POLL_MS`, 2 s); past that, and whenever the lock cannot be created or read, it is one stderr
 * line and exit 75 without running the command. **Closed always:** there is no server call and no open-on-outage mode.
 * The lock is a symlink to the holder's pid in `FACTORY_DEPLOY_LOCK_DIR` (default `~/.local/state/factory/deploy-locks`).
 */
export async function deployLock(input: { project: string; command: string[] }, io: Io): Promise<number> {
  const [program, ...args] = input.command
  if (!program || !NAME.test(input.project)) throw usage(USAGE)

  const dir = io.env.FACTORY_DEPLOY_LOCK_DIR || join(io.env.HOME ?? '', '.local/state/factory/deploy-locks')
  const waitMs = number(io.env.FACTORY_DEPLOY_LOCK_WAIT_MS, DEFAULT_WAIT_MS)
  const pollMs = number(io.env.FACTORY_DEPLOY_LOCK_POLL_MS, DEFAULT_POLL_MS)
  const lock = join(dir, `${input.project}.lock`)

  let child: ReturnType<typeof Bun.spawn> | undefined
  let stopped: NodeJS.Signals | undefined
  const onSignal = (signal: NodeJS.Signals) => {
    stopped = signal
    if (child) signalGroup(child, signal)
  }
  const signals: NodeJS.Signals[] = ['SIGINT', 'SIGTERM', 'SIGHUP']
  for (const signal of signals) process.on(signal, onSignal)

  let held = false
  try {
    try {
      mkdirSync(dir, { recursive: true })
    } catch (error) {
      io.err(`factory: deploy lock for ${input.project}: cannot create ${dir}: ${reason(error)}; not running\n`)
      return EX_TEMPFAIL
    }
    const deadline = Date.now() + waitMs
    for (;;) {
      const outcome = tryTake(lock)
      if (outcome === 'taken') {
        held = true
        break
      }
      if ('failed' in outcome) {
        io.err(`factory: deploy lock for ${input.project}: ${outcome.failed}; not running\n`)
        return EX_TEMPFAIL
      }
      if (stopped) return 128 + (constants.signals[stopped] ?? 1)
      if (Date.now() >= deadline) {
        io.err(
          `factory: deploy lock for ${input.project} still held by pid ${outcome.held} after ${Math.round(waitMs / 1000)}s; not running\n`,
        )
        return EX_TEMPFAIL
      }
      await sleep(pollMs)
    }
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
      io.err(`factory: cannot run ${program}: ${reason(error)}\n`)
      return 127
    }
    await child.exited
    return exitCodeOf(child)
  } finally {
    for (const signal of signals) process.off(signal, onSignal)
    if (held) release(lock)
  }
}

/** `deploy-lock --project <name> -- <cmd> [args…]`: the words after `deploy-lock`, split at the first `--`. */
export async function deployLockVerb(words: readonly string[], io: Io): Promise<number> {
  const split = words.indexOf('--')
  const options = split === -1 ? words : words.slice(0, split)
  const command = split === -1 ? [] : words.slice(split + 1)
  let project: string | undefined
  for (let i = 0; i < options.length; i++) {
    const word = options[i]
    if (word === '--project' && options[i + 1] !== undefined) project = options[++i]
    else if (word?.startsWith('--project=')) project = word.slice('--project='.length)
    else throw usage(`deploy-lock: unknown argument ${word}`, USAGE)
  }
  if (project === undefined) throw usage('deploy-lock: --project is required', USAGE)
  return deployLock({ project, command }, io)
}
