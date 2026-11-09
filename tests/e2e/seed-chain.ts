import { fileIssue, must } from '../scenarios/flow.ts'
import type { Lab } from '../scenarios/planning/lab.ts'

/** the repo whose plan holds the two rows not yet filed; the Issues of the chain live in `orion` and `pearl` (seed-history) */
export const CHAIN_REPOS = ['quartz']

const DAY = 86_400_000

/** A date `days` from now at 09:00 UTC, as the plan file writes it. */
const at = (now: number, days: number): string => {
  const date = new Date(now + days * DAY)
  date.setUTCHours(9, 0, 0, 0)
  return `${date.toISOString().slice(0, 19)}Z`
}

/**
 * Row `first` waits for a date far away, so it is never filed; `second` is a row of `orion` that waits for it. The burn-in
 * shape sits in the schedule: report 1 in two days, report 2 nine days out after report 1, report 3 in forty days.
 */
export const chainPlan = (now: number = Date.now()): string => `version: 1
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
  - key: burn-in-1
    title: Burn-in report, week 1
    facts: { why: the first report of the burn-in, acceptance: it stays unfiled }
    not_before: ${at(now, 2)}
  - key: burn-in-2
    title: Burn-in report, week 2
    facts: { why: the second report follows the first, acceptance: it stays unfiled }
    not_before: ${at(now, 9)}
    after: [burn-in-1]
  - key: burn-in-3
    title: Burn-in report, week 6
    facts: { why: the last report of the burn-in, acceptance: it stays unfiled }
    not_before: ${at(now, 40)}
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
