import type { Clock } from './clock.ts'
import { HerdrTabOutput } from './schemas.ts'

export interface StartInput {
  key: string
  repo: string
  prompt: string
}

export interface StartResult {
  session: string
  /** adapter invocations this start took, retries included */
  attempts: number
}

/** Starts one agent session. Implementations must be idempotent per `key`. */
export interface Runner {
  start(input: StartInput): Promise<StartResult>
}

/** The runner gave up: `permanent` for a refusal that retrying cannot fix, otherwise retries ran out. */
export class RunnerError extends Error {
  constructor(
    message: string,
    readonly permanent: boolean,
    readonly attempts: number,
  ) {
    super(message)
    this.name = 'RunnerError'
  }
}

export const EXIT_PERMANENT = 2
export const EXIT_NAME_EXISTS = 3
/** Stands in for an exit code when the process had to be killed: a transient failure like any other non-zero exit. */
export const EXIT_TIMEOUT = -1

export interface RetryPolicy {
  retries: number
  baseMs: number
  capMs: number
}

export const DEFAULT_RETRY: RetryPolicy = { retries: 5, baseMs: 500, capMs: 8_000 }
/** Longest one `herdr` invocation may run before it is killed. */
export const DEFAULT_PROCESS_TIMEOUT_MS = 10_000

/** Capped exponential backoff before retry number `retry` (1-based): base, 2*base, 4*base, ... up to cap. */
export const backoffMs = (policy: RetryPolicy, retry: number): number =>
  Math.min(policy.capMs, policy.baseMs * 2 ** (retry - 1))

/** The longest `start` can take: every invocation times out and every backoff is slept. */
export function worstCaseMs(retry: RetryPolicy, processTimeoutMs: number): number {
  let total = (retry.retries + 1) * processTimeoutMs
  for (let n = 1; n <= retry.retries; n++) total += backoffMs(retry, n)
  return total
}

interface ProcessResult {
  exitCode: number
  stdout: string
}

export interface HerdrRunnerOptions {
  /** the command to run, normally `HERDR_BIN` */
  bin: string
  clock: Clock
  retry?: RetryPolicy
  processTimeoutMs?: number
}

/**
 * Starts a herdr tab named after the spawn key. Non-zero exits, kills on timeout and an exit 0 whose stdout does not
 * name a pane are retried with backoff (a retry finds the tab by its name: exit 3). Exit 2 is permanent; exit 3
 * (the name exists, so an earlier attempt already started it) is success.
 */
export class HerdrRunner implements Runner {
  private readonly retry: RetryPolicy
  private readonly processTimeoutMs: number

  constructor(private readonly options: HerdrRunnerOptions) {
    this.retry = options.retry ?? DEFAULT_RETRY
    this.processTimeoutMs = options.processTimeoutMs ?? DEFAULT_PROCESS_TIMEOUT_MS
  }

  async start(input: StartInput): Promise<StartResult> {
    for (let attempt = 1; ; attempt++) {
      const result = await this.run(input, attempt)

      const failure = this.evaluate(result, input.key, attempt)
      if ('session' in failure) return { session: failure.session, attempts: attempt }
      if (failure.permanent) throw new RunnerError(failure.reason, true, attempt)
      if (attempt > this.retry.retries)
        throw new RunnerError(`${failure.reason} after ${attempt} attempts`, false, attempt)
      await this.options.clock.sleep(backoffMs(this.retry, attempt))
    }
  }

  private evaluate(
    result: ProcessResult,
    key: string,
    attempt: number,
  ): { session: string } | { permanent: boolean; reason: string } {
    const pane = parsePane(result.stdout)
    if (result.exitCode === 0) {
      // The tab may exist already; only its name is certain, so try again and let exit 3 confirm it.
      return pane ? { session: pane } : { permanent: false, reason: `herdr printed no pane for ${key}` }
    }
    // The tab exists under this name; its own output names the pane, the name itself is the fallback.
    if (result.exitCode === EXIT_NAME_EXISTS) return { session: pane ?? key }
    if (result.exitCode === EXIT_PERMANENT) {
      return { permanent: true, reason: `herdr refused ${key} (exit ${EXIT_PERMANENT}) on attempt ${attempt}` }
    }
    const what =
      result.exitCode === EXIT_TIMEOUT ? `timed out after ${this.processTimeoutMs} ms` : `exit ${result.exitCode}`
    return { permanent: false, reason: `herdr ${what} for ${key}` }
  }

  private async run(input: StartInput, attempt: number): Promise<ProcessResult> {
    let proc: Bun.Subprocess<'ignore', 'pipe', 'ignore'>
    try {
      proc = Bun.spawn([this.options.bin, 'tab', 'create', '--name', input.key, '--cwd', input.repo], {
        stdout: 'pipe',
        stderr: 'ignore',
      })
    } catch (cause) {
      throw new RunnerError(`cannot execute ${this.options.bin}: ${String(cause)}`, true, attempt)
    }

    // The deadline also covers a child that is gone but whose stdout a grandchild keeps open.
    let timer: Timer | undefined
    const deadline = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), this.processTimeoutMs)
    })
    const finished = Promise.all([proc.stdout.text(), proc.exited]).then(([stdout, exitCode]) => ({ stdout, exitCode }))
    finished.catch(() => {})
    try {
      const outcome = await Promise.race([finished, deadline])
      if (outcome !== 'timeout') return outcome
      proc.kill('SIGKILL')
      return { exitCode: EXIT_TIMEOUT, stdout: '' }
    } finally {
      clearTimeout(timer)
    }
  }
}

/** The pane named by `tab create`'s stdout, or undefined if it is not the expected JSON. */
function parsePane(stdout: string): string | undefined {
  try {
    const parsed = HerdrTabOutput.safeParse(JSON.parse(stdout))
    return parsed.success ? parsed.data.pane : undefined
  } catch {
    return undefined
  }
}
