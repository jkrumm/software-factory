import { lstatSync, mkdirSync, readlinkSync, realpathSync, rmdirSync, rmSync, symlinkSync } from 'node:fs'
import { constants, homedir } from 'node:os'
import { join } from 'node:path'
import { send } from '@software-factory/client'
import { credentialOf } from './credentials.ts'
import { usage } from './exit.ts'
import { DEFAULT_URL, type Io } from './operation.ts'
import { EX_TEMPFAIL, exitCodeOf, signalGroup } from './slot.ts'

const USAGE = 'usage: deploy-lock --project <name> -- <cmd> [args…]'
const MERGE_USAGE = 'usage: merge-lock --project <name> -- <cmd> [args…]'
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/
/** How long a caller waits for a live holder (`FACTORY_DEPLOY_LOCK_WAIT_MS`). */
const DEFAULT_WAIT_MS = 30 * 60_000
/** A merge lock is held across a CI run (~17 min), so a queue of leads waits longer (`FACTORY_MERGE_LOCK_WAIT_MS`). */
const DEFAULT_MERGE_WAIT_MS = 90 * 60_000

/** The two locks of a project: the deploy and the merge window (rebase, push, CI, merge). Each is its own file. */
export type LockKind = 'deploy' | 'merge'
/** How often a waiter looks again (`FACTORY_DEPLOY_LOCK_POLL_MS`). */
const DEFAULT_POLL_MS = 2_000
/** A lock path that reads EINVAL (not yet a readable symlink) is read again this often, for at most ~1 s. */
const READ_RETRIES = 100
const READ_RETRY_MS = 10

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

/** The pid a lock names, `gone` when it was released a moment ago, or why it cannot be read (never reclaimed). */
function holderOf(lock: string): { pid: number } | { gone: true } | { unreadable: string } {
  let target: string | undefined
  // EINVAL ("not a symlink") on a path another process just created or replaced is transient under load: the link is
  // not readable yet. Read again for a moment; one that stays a non-link is unreadable, never reclaimed.
  for (let attempt = 0; target === undefined; attempt++) {
    try {
      target = readlinkSync(lock)
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code === 'ENOENT') return { gone: true }
      if (code !== 'EINVAL' || attempt >= READ_RETRIES) return { unreadable: reason(error) }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, READ_RETRY_MS)
    }
  }
  return /^[0-9]+$/.test(target) && Number(target) > 0
    ? { pid: Number(target) }
    : { unreadable: `its target is "${target}", not a pid` }
}

/**
 * One try at the lock, a symlink to our pid (`symlinkSync` is atomic and the pid is in place from the first moment).
 * `taken`: ours. `held`: a live process has it. `retry`: it was released or retaken while we looked, look again at once.
 * `failed`: it cannot be created or read, the caller stops (closed).
 * A holder that is dead is reclaimed, one reclaimer at a time (`<lock>.reclaim`, a `mkdir`).
 */
function tryTake(lock: string): 'taken' | 'retry' | { held: number } | { failed: string } {
  try {
    symlinkSync(String(process.pid), lock)
    return 'taken'
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') return { failed: `cannot create ${lock}: ${reason(error)}` }
  }
  const holder = holderOf(lock)
  if ('gone' in holder) return 'retry'
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
      if ('pid' in again) {
        if (alive(again.pid)) return { held: again.pid }
        rmSync(lock, { force: true })
      }
    }
    symlinkSync(String(process.pid), lock)
    return 'taken'
  } catch (error) {
    // Taking needs no reclaim lock, so another caller may have taken it since the removal: look again.
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return 'retry'
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
 * `kind: 'merge'` (`factory merge-lock`) is the same lock under `<project>.merge.lock`: the one merge window of a project,
 * so leads rebase, wait for CI and merge one at a time instead of rebasing against each other's merges forever. It waits
 * up to `FACTORY_MERGE_LOCK_WAIT_MS` (90 min). A finished merge-lock call is also reported to the server (`POST /merge-windows`:
 * when it asked, when it got the window, when it gave it back), after the command and the release, best effort: a server
 * that cannot be reached changes neither the lock nor the exit code.
 */
export async function deployLock(
  input: { project: string; command: string[]; kind?: LockKind },
  io: Io,
): Promise<number> {
  const timing: Timing = {}
  const code = await holdAndRun(input, io, timing)
  if ((input.kind ?? 'deploy') === 'merge' && timing.requestedAt) {
    await reportWindow(io, {
      project: input.project,
      requestedAt: timing.requestedAt,
      acquiredAt: timing.acquiredAt ?? null,
      releasedAt: new Date(),
      exitCode: code,
    })
  }
  return code
}

/** When a call asked for its lock and when it got it, filled in as it goes. */
interface Timing {
  requestedAt?: Date
  acquiredAt?: Date
}

/** The finished merge-lock call, appended to the server's ledger. Best effort: a failure changes nothing. */
async function reportWindow(
  io: Io,
  window: { project: string; requestedAt: Date; acquiredAt: Date | null; releasedAt: Date; exitCode: number },
): Promise<void> {
  try {
    const { token } = await credentialOf(io.env)
    if (!token) return
    const cwd = (() => {
      try {
        return realpathSync(process.cwd())
      } catch {
        return undefined
      }
    })()
    await send({
      base: io.env.FACTORY_URL || DEFAULT_URL,
      method: 'POST',
      path: '/merge-windows',
      token,
      timeoutMs: 5_000,
      body: {
        project: window.project,
        ...(cwd === undefined ? {} : { cwd }),
        requestedAt: window.requestedAt.toISOString(),
        acquiredAt: window.acquiredAt?.toISOString() ?? null,
        releasedAt: window.releasedAt.toISOString(),
        exitCode: window.exitCode,
      },
    })
  } catch {
    // the ledger is a convenience
  }
}

async function holdAndRun(
  input: { project: string; command: string[]; kind?: LockKind },
  io: Io,
  timing: Timing,
): Promise<number> {
  const kind = input.kind ?? 'deploy'
  const [program, ...args] = input.command
  if (!program || !NAME.test(input.project)) throw usage(kind === 'merge' ? MERGE_USAGE : USAGE)

  const dir = io.env.FACTORY_DEPLOY_LOCK_DIR || join(io.env.HOME || homedir(), '.local/state/factory/deploy-locks')
  const waitMs =
    kind === 'merge'
      ? number(io.env.FACTORY_MERGE_LOCK_WAIT_MS, DEFAULT_MERGE_WAIT_MS)
      : number(io.env.FACTORY_DEPLOY_LOCK_WAIT_MS, DEFAULT_WAIT_MS)
  const pollMs = number(io.env.FACTORY_DEPLOY_LOCK_POLL_MS, DEFAULT_POLL_MS)
  const lock = join(dir, kind === 'merge' ? `${input.project}.merge.lock` : `${input.project}.lock`)

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
      io.err(`factory: ${kind} lock for ${input.project}: cannot create ${dir}: ${reason(error)}; not running\n`)
      return EX_TEMPFAIL
    }
    timing.requestedAt = new Date()
    const deadline = Date.now() + waitMs
    for (;;) {
      const outcome = tryTake(lock)
      if (outcome === 'taken') {
        held = true
        timing.acquiredAt = new Date()
        break
      }
      if (outcome === 'retry') {
        if (stopped) return 128 + (constants.signals[stopped] ?? 1)
        continue
      }
      if ('failed' in outcome) {
        io.err(`factory: ${kind} lock for ${input.project}: ${outcome.failed}; not running\n`)
        return EX_TEMPFAIL
      }
      if (stopped) return 128 + (constants.signals[stopped] ?? 1)
      if (Date.now() >= deadline) {
        io.err(
          `factory: ${kind} lock for ${input.project} still held by pid ${outcome.held} after ${Math.round(waitMs / 1000)}s; not running\n`,
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

/** `deploy-lock` / `merge-lock --project <name> -- <cmd> [args…]`: the words after the verb, split at the first `--`. */
export async function deployLockVerb(words: readonly string[], io: Io, kind: LockKind = 'deploy'): Promise<number> {
  const verb = kind === 'merge' ? 'merge-lock' : 'deploy-lock'
  const help = kind === 'merge' ? MERGE_USAGE : USAGE
  const split = words.indexOf('--')
  const options = split === -1 ? words : words.slice(0, split)
  const command = split === -1 ? [] : words.slice(split + 1)
  let project: string | undefined
  for (let i = 0; i < options.length; i++) {
    const word = options[i]
    if (word === '--project' && options[i + 1] !== undefined) project = options[++i]
    else if (word?.startsWith('--project=')) project = word.slice('--project='.length)
    else throw usage(`${verb}: unknown argument ${word}`, help)
  }
  if (project === undefined) throw usage(`${verb}: --project is required`, help)
  return deployLock({ project, command, kind }, io)
}
