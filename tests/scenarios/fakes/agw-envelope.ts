import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const keyOf = (args: string[]): string => {
  const at = args.indexOf('--idempotency-key')
  return at >= 0 ? (args[at + 1] ?? 'no-key') : 'no-key'
}

/** A run id the fake derives from the idempotency key, so the same key is the same run. */
const runIdOf = (args: string[]): string => `fake-${keyOf(args).replace(/[^A-Za-z0-9-]/g, '-')}`

const pendingDir = (): string =>
  join(process.env.FACTORY_FAKE_LOG ? join(process.env.FACTORY_FAKE_LOG, '..') : '/tmp', 'pending')

const envelope = (workflow: string, runId: string, output: unknown) => ({
  runId,
  workflowId: workflow,
  status: 'done',
  output,
  cost: 0,
  unpricedCalls: 0,
})

/**
 * What the real `agw <workflow> --format json` prints: the run envelope on stdout. With `FACTORY_FAKE_PENDING=1` the first
 * call of a key is still running (exit 10, the hint on stderr) and `agw run wait <runId>` finishes it, as the real CLI
 * does when its wait budget is spent.
 */
export function done(workflow: string, args: string[], output: unknown): number {
  const runId = runIdOf(args)
  if (process.env.FACTORY_FAKE_PENDING === '1') {
    mkdirSync(pendingDir(), { recursive: true })
    writeFileSync(join(pendingDir(), `${runId}.json`), JSON.stringify(envelope(workflow, runId, output)))
    process.stdout.write(`${JSON.stringify({ runId, workflowId: workflow, status: 'running' })}\n`)
    process.stderr.write(`kind: pending\nhint: "agw run wait ${runId}"\n`)
    return 10
  }
  process.stdout.write(`${JSON.stringify(envelope(workflow, runId, output))}\n`)
  return 0
}

/** `agw run wait <runId>`: the run a pending call left behind, now done. */
export function runWait(args: string[]): number {
  if (process.env.FACTORY_FAKE_LOG)
    appendFileSync(process.env.FACTORY_FAKE_LOG, `${JSON.stringify({ tool: 'agw', args })}\n`)
  const runId = args[2] ?? ''
  const file = join(pendingDir(), `${runId}.json`)
  if (!existsSync(file)) {
    process.stderr.write(`fake agw: no run ${runId}\n`)
    return 4
  }
  process.stdout.write(`${readFileSync(file, 'utf8')}\n`)
  return 0
}
