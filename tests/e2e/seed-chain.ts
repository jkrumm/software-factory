import { fileIssue, must } from '../scenarios/flow.ts'
import type { Lab } from '../scenarios/planning/lab.ts'

/** the repo whose plan holds the two rows not yet filed; the Issues of the chain live in `orion` and `pearl` (seed-history) */
export const CHAIN_REPOS = ['quartz']

/** Row `first` waits for a date far away, so it is never filed; `second` is a row of `orion` that waits for it. */
export const CHAIN_PLAN = `version: 1
rows:
  - key: first
    title: Draft the export schema
    facts: { why: the chain screen needs an unfiled row, acceptance: it stays unfiled }
    not_before: 2099-01-01
  - key: second
    title: Publish the export schema
    facts: { why: it needs the first, acceptance: it stays unfiled }
    repo: orion
    after: [first]
`

export interface SeededChain {
  /** the Issue every other waits for, in `pearl` */
  gate: string
  /** the blocker that was cancelled, so its edge is satisfied (`orion`) */
  done: string
  /** waits for the gate and for the done one (`orion`) */
  middle: string
  /** waits for the middle one (`pearl`) */
  last: string
}

/**
 * A chain across two projects through the routes a client has: gate (pearl) blocks middle (orion) blocks last (pearl), and
 * middle also followed a blocker that is cancelled now, so the chain has blocked edges and a satisfied one. Nothing here
 * is admitted: the gate stays settling, so the dependents never start a lead. The plan rows come from `quartz`'s plan file.
 */
export async function seedChain(lab: Lab): Promise<SeededChain> {
  const gate = await fileIssue(lab, { repo: 'pearl', title: 'Choose the export format' })
  const done = await fileIssue(lab, { repo: 'orion', title: 'Move the export job to the new queue' })
  const middle = await fileIssue(lab, { repo: 'orion', title: 'Add a retry to the export job' })
  const last = await fileIssue(lab, { repo: 'pearl', title: 'Show the retry count on the board' })
  await must(lab, ['planning', 'settle', '--body', JSON.stringify({ issue: middle, after: [gate, done] })])
  await must(lab, ['planning', 'settle', '--body', JSON.stringify({ issue: last, after: [middle] })])
  await must(lab, ['issue', 'cancel', done, '--reason', 'replaced by the gate'])
  await must(lab, ['project', 'sync'])
  return { gate, done, middle, last }
}
