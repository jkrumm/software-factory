import { CannotExecute, runProcess } from '../process.ts'

/** Runs read-only helpers for their output and adds up the CPU they took, so a loop can say what its readings cost. */
export interface TextRunner {
  /**
   * The program's stdout; null when it could not start, timed out, or exited non-zero (with `partial`, a non-zero exit
   * that still printed something counts: lsof exits 1 when it could not look at some process).
   */
  run(cmd: readonly string[], options?: { timeoutMs?: number; partial?: boolean }): Promise<string | null>
  /** the CPU the helpers used since the last call, ms */
  takeCpuMs(): number
}

export function textRunner(defaultTimeoutMs: number): TextRunner {
  let cpuUs = 0
  return {
    async run(cmd, options = {}) {
      try {
        const out = await runProcess(cmd, options.timeoutMs ?? defaultTimeoutMs, { group: true })
        cpuUs += out.cpuUs ?? 0
        if (out.timedOut) return null
        if (out.exitCode === 0 || (options.partial && out.stdout.trim() !== '')) return out.stdout
        return null
      } catch (error) {
        if (error instanceof CannotExecute) return null
        throw error
      }
    },
    takeCpuMs() {
      const ms = Math.round(cpuUs / 1000)
      cpuUs = 0
      return ms
    },
  }
}
