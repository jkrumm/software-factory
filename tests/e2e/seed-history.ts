import { admit, admitted, fileIssue, loseLead, stateOf, tick } from '../scenarios/flow.ts'
import type { Lab } from '../scenarios/planning/lab.ts'
import { api } from './seed.ts'

/** one repo per lead these Issues need: a project takes one lead at a time (the lab is started with them) */
export const HISTORY_REPOS = ['orion', 'pearl']

export interface SeededHistory {
  /** the Issue with a rich history: two attempts (the first lead lost), a signal and its amendment, a note, two answered Decisions, a Spec and a Concept with different verdicts, a ship with a passed watch and a second ship whose watch regressed */
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
 * its lead is told a note and then lost, so a second attempt starts (the lead_gone event is real). That attempt asks two
 * Decisions the owner answers, submits a Spec he passes and a Concept he drops (a `changes` verdict files a note with the artifact's id, which the page prints), and ships twice: the ships, their
 * evidence, the watch that passed (attempt 1) and the one that regressed (attempt 2, a red verify run) are rows, as the
 * checkpoint rows of `seed` are (a real ship needs a deployable repo; only the factory records a `regressed` event, from a
 * watching Issue, so no such timeline line exists).
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

  // the first lead is lost; the Issue is queued again and a second lead starts: two attempts, with the lead_gone event between
  await loseLead(lab, rich, 1)
  for (let round = 0; round < 12 && (await stateOf(lab.world, rich)).state !== 'working'; round++) await admit(lab)
  await tick(lab)

  const askOf = (question: string, recommendation: string, other: string) =>
    api<{ decision: { id: string } }>(url, `/v1/issues/${rich}/ask`, {
      attempt: 2,
      question,
      recommendation,
      checked: 'Read how the other jobs report a full disk.',
      options: [
        { label: recommendation, reversible: true, cost: 'a full disk goes unnoticed for a run' },
        { label: other, reversible: true, cost: 'a noisy job when the disk is nearly full' },
      ],
      noAnswer: { consequence: 'The probe only warns until someone answers.' },
    })
  const first = await askOf('Should the probe fail the job or only warn?', 'warn', 'fail')
  await must(lab, ['decision', 'answer', first.decision.id, 'warn'])
  // a second Decision, answered the other way; an open one would be on the owner's list and move the Needs-you counts
  const second = await askOf('Should the probe also page someone?', 'page', 'log only')
  await must(lab, ['decision', 'answer', second.decision.id, 'log only'])
  const submit = (kind: string, title: string, content: string) =>
    api<{ artifact: { id: string } }>(url, `/v1/issues/${rich}/artifacts`, { attempt: 2, kind, title, content })
  const spec = await submit('spec', 'The probe spec', '# Probe\n\nThe job reports its free disk space on /health.')
  await api(url, `/v1/artifacts/${spec.artifact.id}/verdict`, { verdict: 'looks_good' })
  const concept = await submit(
    'concept',
    'The probe alerting concept',
    '# Alerting\n\nThe probe pages after three failed runs.',
  )
  await api(url, `/v1/artifacts/${concept.artifact.id}/verdict`, { verdict: 'no_longer_applies' })

  const sql = lab.world.db.sql
  const ship = 'e2e-ship-1'
  await sql`INSERT INTO factory.quality_ships (id, issue_id, attempt, event_key, at, result, detail, reported)
    VALUES ('ship_e2e_1', ${rich}, 1, ${ship}, now() - interval '30 minutes', 'accepted', NULL, '["a1b2c3d"]'::jsonb)`
  await sql`INSERT INTO factory.quality_evidence (id, issue_id, attempt, source_key, kind, at, payload) VALUES
    ('evidence_e2e_1', ${rich}, 1, ${ship}, 'commits', now() - interval '30 minutes',
      '{"commits":["a1b2c3d4e5f60718293a4b5c6d7e8f9012345678","b2c3d4e5f60718293a4b5c6d7e8f90123456789a"],"landedAt":null,"mergedAt":null,"deploys":true,"paths":["src/export.ts"]}'::jsonb),
    ('evidence_e2e_2', ${rich}, 1, ${ship}, 'review', now() - interval '30 minutes',
      '{"status":"covered","tier":"standard","ranges":[],"uncovered":[],"reason":null}'::jsonb),
    ('evidence_e2e_3', ${rich}, 1, ${ship}, 'acceptance', now() - interval '30 minutes',
      '{"statements":[{"status":"met","text":"the export downloads"},{"status":"not_met","text":"no CSV header yet"}]}'::jsonb)`
  await sql`INSERT INTO factory.quality_watches (key, issue_id, attempt, watch, started_at, window_ms, answer, answered_at)
    VALUES ('start_watch:e2e:1', ${rich}, 1, 1, now() - interval '29 minutes', 60000, 'passed', now() - interval '28 minutes')`
  await sql`INSERT INTO factory.quality_checks (watch_key, n, at, outcome, checks)
    VALUES ('start_watch:e2e:1', 1, now() - interval '28 minutes', 'green',
      '[{"name":"deployed version","ok":true,"detail":"the commits are live"},{"name":"make verify","ok":true,"detail":"green"}]'::jsonb)`

  // the second ship, of attempt 2: its watch came back regressed with a red verify run
  const regressed = 'e2e-ship-2'
  await sql`INSERT INTO factory.quality_ships (id, issue_id, attempt, event_key, at, result, detail, reported)
    VALUES ('ship_e2e_2', ${rich}, 2, ${regressed}, now() - interval '12 minutes', 'accepted', NULL, '["c3d4e5f"]'::jsonb)`
  await sql`INSERT INTO factory.quality_evidence (id, issue_id, attempt, source_key, kind, at, payload) VALUES
    ('evidence_e2e_4', ${rich}, 2, ${regressed}, 'commits', now() - interval '12 minutes',
      '{"commits":["c3d4e5f60718293a4b5c6d7e8f9012345678abcd"],"landedAt":null,"mergedAt":null,"deploys":true,"paths":["src/export.ts"]}'::jsonb),
    ('evidence_e2e_5', ${rich}, 2, ${regressed}, 'review', now() - interval '12 minutes',
      '{"status":"covered","tier":"standard","ranges":[],"uncovered":[],"reason":null}'::jsonb),
    ('evidence_e2e_6', ${rich}, 2, ${regressed}, 'acceptance', now() - interval '12 minutes',
      '{"statements":[{"status":"met","text":"the probe reports free disk space"},{"status":"not_met","text":"the probe fails the job on a full disk"}]}'::jsonb)`
  await sql`INSERT INTO factory.quality_watches (key, issue_id, attempt, watch, started_at, window_ms, answer, answered_at)
    VALUES ('start_watch:e2e:2', ${rich}, 2, 2, now() - interval '11 minutes', 60000, 'regressed', now() - interval '9 minutes')`
  await sql`INSERT INTO factory.quality_checks (watch_key, n, at, outcome, checks)
    VALUES ('start_watch:e2e:2', 1, now() - interval '9 minutes', 'red',
      '[{"name":"deployed version","ok":true,"detail":"the commits are live"},{"name":"make verify","ok":false,"detail":"export.test.ts: the probe timed out"}]'::jsonb)`

  const working = await fileIssue(lab, { repo: 'pearl', title: 'Show the export time on the board' })
  await admitted(lab, working)
  await tick(lab)
  return { rich, working }
}
