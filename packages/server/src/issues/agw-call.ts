import { childEnv, EXIT_TIMEOUT, runProcess } from '../exec.ts'

/** `agw` exits 10 for a run that is still going. */
const EXIT_PENDING = 10

/** One `agw` call: past this it is killed. A call waits at most the CLI's own budget (110 s by default), so this only guards a hang. */
export const DEFAULT_CALL_TIMEOUT_MS = 150_000
/**
 * All the waiting for one workflow run. A single model request is no worker, but a short limit turns a slow answer into a failure
 * (`rules/agent-limits.md`): this is a hang guard, and a call that reaches it is a failure like any other.
 */
export const DEFAULT_DEADLINE_MS = 30 * 60_000

const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9-]{5,127}$/

/** The id of a pending run, from the JSON `agw` printed with exit 10. */
function runIdOf(stdout: string): string | undefined {
  try {
    const body = JSON.parse(stdout) as Record<string, unknown>
    const run = body.run as Record<string, unknown> | undefined
    const id = body.runId ?? body.run_id ?? run?.id ?? body.id
    return typeof id === 'string' && RUN_ID.test(id) ? id : undefined
  } catch {
    return undefined
  }
}

export interface AgwOptions {
  /** the `agw` binary (`FACTORY_AGW_BIN`) */
  bin: string
  callTimeoutMs?: number
  deadlineMs?: number
  /** swapped by the tests */
  run?: typeof runProcess
  now?: () => number
}

export interface AgwCall {
  /** the workflow's name, `factory-classify` */
  workflow: string
  /** names the call in an error (`classify`) */
  label: string
  idempotencyKey: string
  /** the workflow's input as JSON */
  stdin: string
  /** the error the caller's port throws */
  failure: (message: string) => Error
}

/**
 * One `agw <workflow> --format json` with the input on stdin. Exit 10 means the run is still going: `agw run wait <runId>` until the exit
 * is not 10, as every `agw` caller does. Exit 0 is read for `status` (`done`) and the workflow's `output`. Anything else throws
 * `call.failure`, which the caller treats as a failed judgment.
 */
export async function callAgw(options: AgwOptions, call: AgwCall): Promise<unknown> {
  const run = options.run ?? runProcess
  const now = options.now ?? Date.now
  const callMs = options.callTimeoutMs ?? DEFAULT_CALL_TIMEOUT_MS
  const deadline = now() + (options.deadlineMs ?? DEFAULT_DEADLINE_MS)
  // The key is the subject's: a call asked again after a restart finds its run instead of paying for a second.
  const command = [options.bin, call.workflow, '--format', 'json', '--idempotency-key', call.idempotencyKey]
  let result = await run(command, callMs, childEnv(), call.stdin)
  while (result.exitCode === EXIT_PENDING) {
    const runId = runIdOf(result.stdout)
    if (!runId) throw call.failure('agw says the run is pending but names no run id')
    if (now() >= deadline) throw call.failure(`${call.label} run ${runId} did not finish in time`)
    result = await run([options.bin, 'run', 'wait', runId, '--format', 'json'], callMs, childEnv())
  }
  if (result.exitCode === EXIT_TIMEOUT) throw call.failure('agw did not answer in time')
  if (result.exitCode !== 0) throw call.failure(`agw exited ${result.exitCode}`)
  let body: unknown
  try {
    body = JSON.parse(result.stdout)
  } catch {
    throw call.failure('agw printed no JSON')
  }
  const envelope = body as { status?: unknown; output?: unknown }
  if (envelope.status !== undefined && envelope.status !== 'done') {
    throw call.failure(`the ${call.label} run is ${String(envelope.status)}`)
  }
  return envelope.output ?? body
}
