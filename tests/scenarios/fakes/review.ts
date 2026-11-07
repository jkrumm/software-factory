import { appendFileSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

/**
 * `agw review route` and `agw review covered`, scripted by `review-mode` beside the call log (written by a scenario):
 * `covered`, `none` (no review needed) or `uncovered`. Without it nothing is scripted and the call fails out loud like
 * every other fake call, which is how a scenario gets a ship whose review cannot be read.
 */
export function reviewCall(args: string[]): number | undefined {
  const [group, command] = args
  const log = process.env.FACTORY_FAKE_LOG
  if (group !== 'review' || !log) return undefined
  let mode: string
  try {
    mode = readFileSync(join(dirname(log), 'review-mode'), 'utf8').trim()
  } catch {
    return undefined
  }
  const flag = (name: string): string => args[args.indexOf(name) + 1] ?? ''
  appendFileSync(log, `${JSON.stringify({ tool: 'agw', args })}\n`)
  if (command === 'route') {
    process.stdout.write(`${JSON.stringify({ tier: mode === 'none' ? 'none' : 'standard' })}\n`)
    return 0
  }
  if (command === 'covered') {
    const head = flag('--range').split('..')[1] ?? ''
    const covered = mode !== 'uncovered'
    const commit = { sha: head, subject: 'feat: the change', required: 'standard' }
    process.stdout.write(
      `${JSON.stringify({ covered, commits: [covered ? commit : { ...commit, reason: 'an important finding is open' }], uncovered: covered ? [] : [head] })}\n`,
    )
    return 0
  }
  return undefined
}
