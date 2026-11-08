import { admitted, fileIssue, tick } from '../scenarios/flow.ts'
import type { Lab } from '../scenarios/planning/lab.ts'
import { api } from './seed.ts'

/** one repo per lead these Issues need: a project takes one lead at a time (the lab is started with them) */
export const HISTORY_REPOS = ['orion', 'pearl']

export interface SeededHistory {
  /** the Issue with a rich history: a signal and its amendment, a note, an answered Decision, a Spec with a verdict, a ship with a passed watch */
  rich: string
  /** an Issue that is working now, with a live lead */
  working: string
}

const must = async (lab: Lab, args: string[]): Promise<string> => {
  const run = await lab.cli(args)
  if (run.code !== 0) throw new Error(`factory ${args.join(' ')} exited ${run.code}: ${run.err}`)
  return run.out
}

/**
 * Two Issues for the Issue page, through the routes a client has. The rich one is filed by a signal and amended by a second,
 * its lead is told a note, asks a Decision the owner answers, submits a Spec the owner passes, and ships: the ship, its
 * evidence and the watch that passed are rows, as the checkpoint rows of `seed` are (a real ship needs a deployable repo).
 * Nothing here waits on the owner when it is done, so the Needs-you counts stay what the other tests expect.
 */
export async function seedHistory(lab: Lab): Promise<SeededHistory> {
  const url = lab.server.url
  const synced = await lab.cli(['project', 'sync'])
  if (synced.code !== 0) throw new Error(`project sync exited ${synced.code}: ${synced.err}`)

  const signal = (title: string, text: string) =>
    api<{ issue: string }>(url, '/signals', { from: 'owner:hermes', repo: 'orion', title, text })
  const rich = (await signal('Add a health probe to the export job', 'The job fails silently when the disk is full.'))
    .issue
  await signal('Add a health probe to the export job', 'It also needs to report the last run time.')
  await admitted(lab, rich)
  await tick(lab)

  await must(lab, ['issue', 'note', rich, 'Use the existing /health route, do not add a second one.'])
  await tick(lab)

  const asked = await api<{ decision: { id: string } }>(url, `/v1/issues/${rich}/ask`, {
    attempt: 1,
    question: 'Should the probe fail the job or only warn?',
    recommendation: 'warn',
    checked: 'Read how the other jobs report a full disk.',
    options: [
      { label: 'warn', reversible: true, cost: 'a full disk goes unnoticed for a run' },
      { label: 'fail', reversible: true, cost: 'a noisy job when the disk is nearly full' },
    ],
    noAnswer: { consequence: 'The probe only warns until someone answers.' },
  })
  await must(lab, ['decision', 'answer', asked.decision.id, 'warn'])
  const spec = await api<{ artifact: { id: string } }>(url, `/v1/issues/${rich}/artifacts`, {
    attempt: 1,
    kind: 'spec',
    title: 'The probe spec',
    content: '# Probe\n\nThe job reports its free disk space on /health.',
  })
  await api(url, `/v1/artifacts/${spec.artifact.id}/verdict`, { verdict: 'looks_good' })

  const sql = lab.world.db.sql
  const ship = 'e2e-ship-1'
  await sql`INSERT INTO factory.quality_ships (id, issue_id, attempt, event_key, at, result, detail, reported)
    VALUES ('ship_e2e_1', ${rich}, 1, ${ship}, now() - interval '30 minutes', 'accepted', NULL, '["a1b2c3d"]'::jsonb)`
  await sql`INSERT INTO factory.quality_evidence (id, issue_id, attempt, source_key, kind, at, payload) VALUES
    ('evidence_e2e_1', ${rich}, 1, ${ship}, 'commits', now() - interval '30 minutes',
      '{"commits":["a1b2c3d4e5f60718293a4b5c6d7e8f9012345678","b2c3d4e5f60718293a4b5c6d7e8f90123456789a"],"landedAt":null,"mergedAt":null,"deploys":true,"paths":["src/export.ts"]}'::jsonb),
    ('evidence_e2e_2', ${rich}, 1, ${ship}, 'review', now() - interval '30 minutes',
      '{"status":"covered","tier":"standard","ranges":[],"uncovered":[],"reason":null}'::jsonb)`
  await sql`INSERT INTO factory.quality_watches (key, issue_id, attempt, watch, started_at, window_ms, answer, answered_at)
    VALUES ('start_watch:e2e:1', ${rich}, 1, 1, now() - interval '29 minutes', 60000, 'passed', now() - interval '28 minutes')`
  await sql`INSERT INTO factory.quality_checks (watch_key, n, at, outcome, checks)
    VALUES ('start_watch:e2e:1', 1, now() - interval '28 minutes', 'green',
      '[{"name":"deployed version","ok":true,"detail":"the commits are live"},{"name":"make verify","ok":true,"detail":"green"}]'::jsonb)`

  const working = await fileIssue(lab, { repo: 'pearl', title: 'Show the export time on the board' })
  await admitted(lab, working)
  await tick(lab)
  return { rich, working }
}
