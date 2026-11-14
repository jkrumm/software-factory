/** How long a stop may take before the process exits anyway; the loops' own grace (10 s) is inside it. */
export const SHUTDOWN_DEADLINE_MS = 30_000

/** A step is named in the timing line from this long on. */
const SLOW_STEP_MS = 500

const seconds = (ms: number) => (ms / 1000).toFixed(1)

export interface ShutdownStep {
  /** named in the deadline's line: where the stop was when it ran out */
  name: string
  run(): Promise<unknown>
}

export interface ShutdownOptions {
  steps: readonly ShutdownStep[]
  deadlineMs: number
  log?: (line: string) => void
  /** where the stop's own timing line goes (stdout: it is not an error) */
  report?: (line: string) => void
  /** a monotonic clock in milliseconds; the tests give their own */
  now?: () => number
  /** the process's exit; the scenarios and tests give their own */
  exit?: (code: number) => void
}

/**
 * The one way the server ends on a signal: the steps run in order, a step that throws is logged and the rest still run
 * (the lock must be let go even when a loop's stop failed), and the deadline ends the process with code 1 whatever
 * step it is stuck in. Exit 0 only when every step finished without error. A second signal does nothing.
 */
export function createShutdown(options: ShutdownOptions): (signal: string) => Promise<void> {
  const log = options.log ?? ((line: string) => console.error(line))
  const exit = options.exit ?? ((code: number) => process.exit(code))
  const report = options.report ?? ((line: string) => console.log(line))
  const now = options.now ?? (() => performance.now())
  let stopping = false
  return async (signal) => {
    if (stopping) return
    stopping = true
    console.log(`${signal}: stopping`)
    let current = 'start'
    // Referenced on purpose: a stop stuck on something that keeps no handle open must still end in the deadline.
    const deadline = setTimeout(() => {
      log(`shutdown took too long (still in: ${current}), exiting`)
      exit(1)
    }, options.deadlineMs)
    let clean = true
    const began = now()
    const slow: string[] = []
    for (const step of options.steps) {
      current = step.name
      const stepBegan = now()
      try {
        await step.run()
      } catch (error) {
        clean = false
        log(`shutdown: ${step.name} failed: ${error instanceof Error ? error.message : String(error)}`)
      }
      const took = now() - stepBegan
      if (took >= SLOW_STEP_MS) slow.push(`${step.name} ${seconds(took)}s`)
    }
    clearTimeout(deadline)
    // Where a restart's stop seconds go (`scripts/deploy.sh` prints the whole of it as `stopped_s`): the steps that took a while.
    report(`stopped in ${seconds(now() - began)}s${slow.length ? ` (${slow.join(', ')})` : ''}`)
    exit(clean ? 0 : 1)
  }
}
