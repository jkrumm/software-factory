import { basename } from 'node:path'
import type { ProcessKiller, ReaperProcesses } from '../../domains/loops/ports.ts'
import type { ReaperProc } from '../../domains/loops/reaper.ts'
import { runProcess } from './process.ts'
import { readCwds } from './processes.ts'

const LINE = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(\S.*?)\s*$/
const SESSION = /(^|\s)FACTORY_SESSION=(lead-[0-9]+-[0-9]+)(\s|$)/

/** `ps` elapsed time, `[[dd-]hh:]mm:ss`, in seconds; null when it is not one. */
export function parseEtime(text: string): number | null {
  const match = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/.exec(text.trim())
  if (!match) return null
  const [, days, hours, minutes, seconds] = match
  return Number(days ?? 0) * 86_400 + Number(hours ?? 0) * 3_600 + Number(minutes) * 60 + Number(seconds)
}

/**
 * The rows of `ps -Eww -Ao pid=,ppid=,etime=,command=` (macOS `-E` appends the environment of the user's own processes to
 * the command): only the pid, parent, age, the executable's basename and the value of `FACTORY_SESSION` are kept, the
 * command line itself is dropped here. A line that does not parse is skipped.
 */
export function parseSessionPs(output: string): Omit<ReaperProc, 'cwd'>[] {
  const rows: Omit<ReaperProc, 'cwd'>[] = []
  for (const line of output.split('\n')) {
    const match = LINE.exec(line)
    const ageS = parseEtime(match?.[3] ?? '')
    if (!match || ageS === null) continue
    const command = match[4] ?? ''
    // the first word: a path with spaces is cut there, which is enough to name the program
    const comm = basename(command.split(/\s+/)[0] ?? '')
    rows.push({
      pid: Number(match[1]),
      ppid: Number(match[2]),
      ageS,
      comm: comm === '' ? '?' : comm,
      session: SESSION.exec(command)?.[2] ?? null,
    })
  }
  return rows
}

export interface ReaperProcessesOptions {
  psBin: string
  lsofBin: string
  timeoutMs?: number
}

/** The process table with each process's lead session and directory; null when `ps` or `lsof` could not answer. */
export function reaperProcesses(options: ReaperProcessesOptions): ReaperProcesses {
  const timeoutMs = options.timeoutMs ?? 10_000
  return {
    async read() {
      try {
        const out = await runProcess([options.psBin, '-Eww', '-Ao', 'pid=,ppid=,etime=,command='], { timeoutMs })
        if (out.timedOut || out.code !== 0) return null
        const rows = parseSessionPs(out.stdout)
        if (rows.length === 0) return null
        const cwds = await readCwds(options.lsofBin, timeoutMs)
        if (cwds === null) return null
        return rows.map((row) => ({ ...row, cwd: cwds.get(row.pid) ?? null }))
      } catch {
        return null
      }
    },
  }
}

/** Slack for the two readings of a process's age being taken a moment apart. */
const AGE_SLACK_S = 5

/**
 * `process.kill` for a pid the decision named, after one more look at that pid: it must still exist and be at least as old
 * as when it was read (a reused pid is younger). Every failure is "not signalled", never an error.
 */
export function processKiller(options: { psBin: string; timeoutMs?: number }): ProcessKiller {
  return {
    async signal(target, signal) {
      try {
        const out = await runProcess([options.psBin, '-o', 'etime=', '-p', String(target.pid)], {
          timeoutMs: options.timeoutMs ?? 10_000,
        })
        const ageS = parseEtime(out.stdout)
        if (out.timedOut || ageS === null || ageS + AGE_SLACK_S < target.ageS) return false
        process.kill(target.pid, signal)
        return true
      } catch {
        return false
      }
    },
  }
}
