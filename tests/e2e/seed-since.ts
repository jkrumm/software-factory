import type { SQL } from 'bun'

export interface SeededSince {
  /** the moment the owner "was last here": every event of the history is either before it or after it */
  visit: string
  /** Issues whose events happened before the visit: the band must never list or count them */
  before: string[]
  /** the Issues after the visit, by what happened to them */
  after: {
    shipped: string[]
    failed: string
    dropped: string
    judge: string
    screen: string
    incident: string
    filed: Record<'you' | 'github' | 'application' | 'infrastructure', string[]>
  }
  /** a Decision the Judge settled after the visit: settled, so an item link to it says so */
  settledDecision: string
}

let keys = 0

/**
 * The history the "Since you were here" band reads, as rows (a real ship and a real watch need a deployable repo, as in
 * `seed-history.ts`): closed Issues, so no loop touches them and no list of open work changes. Before the visit one of each
 * kind of event; after it, seconds later, two shipped with a passed watch, one regressed, one dropped, a Decision the Judge settled, a held
 * signal the Judge dismissed and an Errand turned away, Issues filed from four origins and one incident. After the visit
 * the owner's own settlements are there too, which the band must leave out.
 */
export async function seedSince(sql: SQL, now = new Date()): Promise<SeededSince> {
  // the visit is this moment: every event the earlier specs made precedes it, so the band holds the seeded history alone
  const visit = now
  /** before the visit: a negative number of minutes; after it: seconds (a few, the rows go in within a moment) */
  const at = (n: number): Date => new Date(visit.getTime() + (n < 0 ? n * 60_000 : n * 1_000))

  const event = async (
    issue: string,
    version: number,
    kind: string,
    when: Date,
    o: { payload?: unknown; outcome?: string; to?: string } = {},
  ) => {
    keys += 1
    await sql`INSERT INTO factory.issue_events (id, issue_id, key, kind, payload, actor, at, result, version, to_state, outcome)
      VALUES (${`event_since_e2e_${keys}`}, ${issue}, ${`since-e2e-${keys}`}, ${kind}, ${JSON.stringify(o.payload ?? {})}::text::jsonb,
        'factory', ${when}, 'applied', ${version}, ${o.to ?? 'closed'}, ${o.outcome ?? null})`
  }

  /** a closed Issue, filed at `filedAt` from `origin`; the caller adds its later events from version 2 */
  const issue = async (repo: string, title: string, origin: string, filedAt: Date): Promise<string> => {
    const [{ id }] = await sql`SELECT 'issue_' || nextval('factory.issue_numbers') AS id`
    await sql`INSERT INTO factory.issues (id, repo, state, outcome, version) VALUES (${id}, ${repo}, 'closed', 'done', 9)`
    await event(id, 1, 'filed', filedAt, { payload: { repo, title, kind: 'feature', origin }, to: 'settling' })
    return id
  }

  const decision = (id: string, issue: string, question: string, by: string, answeredAt: Date) =>
    sql`INSERT INTO factory.decisions (id, key, issue_id, repo, attempt, question, recommendation, checked, options, no_answer, asked_at, answer, settled_by, answered_at)
      VALUES (${id}, ${id}, ${issue}, 'orion', 1, ${question}, 'yes', 'read the notes', '[]'::jsonb, '{}'::jsonb,
        ${new Date(answeredAt.getTime() - 600_000)}, 'yes', ${by}, ${answeredAt})`

  const signal = (id: string, title: string, by: string, dismissedAt: Date) =>
    sql`INSERT INTO factory.intake_signals (id, source, kind, origin, trust, repo, fingerprint, title, text, received_at, state, dismissed_reason, dismissed_by, dismissed_at)
      VALUES (${id}, 'since-e2e', 'feedback', 'feedback', 'outside', 'orion', ${id}, ${title}, 'it flickers',
        ${new Date(dismissedAt.getTime() - 600_000)}, 'dismissed', 'noise', ${by}, ${dismissedAt})`

  const errand = (id: string, issue: string, summary: string, raisedAt: Date, turnedAwayAt: Date) =>
    sql`INSERT INTO factory.errands (id, key, issue_id, attempt, summary, raised_at, turned_away_at)
      VALUES (${id}, ${id}, ${issue}, 1, ${summary}, ${raisedAt}, ${turnedAwayAt})`

  // before the visit: one of each, none of it counted
  const early = await issue('orion', 'Early: tidy the export job', 'application', at(-180))
  await event(early, 2, 'watch_passed', at(-120), { payload: { watch: 1 } })
  const earlyFailed = await issue('orion', 'Early: the probe regressed', 'infrastructure', at(-170))
  await event(earlyFailed, 2, 'regressed', at(-40), { payload: { watch: 1, detail: 'broke' } })
  const earlyDropped = await issue('orion', 'Early: drop the old report', 'you', at(-160))
  await event(earlyDropped, 2, 'closed', at(-100), {
    payload: { attempt: null, outcome: 'dropped', reason: 'x' },
    outcome: 'dropped',
  })
  await decision('decision_since_e2e_early', early, 'Early: keep the old format?', 'judge', at(-80))
  await signal('signal_since_e2e_early', 'Early: the favicon is blurry', 'judge', at(-70))
  await errand('errand_since_e2e_early', early, 'Early: plug in the phone', at(-90), at(-60))
  const earlyIncident = await issue('orion', 'Early: the build host is down', 'infrastructure', at(-150))
  await sql`INSERT INTO factory.intake_incidents (issue_id, group_key, opened_at, last_alert_at)
    VALUES (${earlyIncident}, 'since-e2e-early', ${at(-50)}, ${at(-45)})`

  // after the visit
  const you = await issue('orion', 'Show the retention banner', 'you', at(3))
  await event(you, 2, 'watch_passed', at(10), { payload: { watch: 1 } })
  const github = await issue('pearl', 'Warm the cache on boot', 'github', at(4))
  await event(github, 2, 'watch_passed', at(12), { payload: { watch: 1 } })
  const application = await issue('orion', 'The export job times out', 'application', at(5))
  await event(application, 2, 'regressed', at(20), { payload: { watch: 1, detail: 'broke again' } })
  const dropped = await issue('pearl', 'Drop the legacy importer', 'you', at(6))
  await event(dropped, 2, 'closed', at(25), {
    payload: { attempt: null, outcome: 'dropped', reason: 'x' },
    outcome: 'dropped',
  })
  const incident = await issue('orion', 'The build host is out of disk', 'infrastructure', at(7))
  await sql`INSERT INTO factory.intake_incidents (issue_id, group_key, opened_at, last_alert_at)
    VALUES (${incident}, 'since-e2e-disk', ${at(7)}, ${at(8)})`
  await decision('decision_since_e2e_judge', you, 'Keep the banner for one week?', 'judge', at(11))
  await signal('signal_since_e2e_judge', 'The status page flickers', 'judge', at(30))
  await errand('errand_since_e2e_away', github, 'Plug in the spare phone', at(13), at(31))
  // the owner's own settlements are not the Judge's and not the screen's
  await decision('decision_since_e2e_owner', github, 'Name the cache after the repo?', 'owner', at(15))
  await signal('signal_since_e2e_owner', 'A duplicate complaint', 'owner', at(32))

  return {
    visit: visit.toISOString(),
    before: [early, earlyFailed, earlyDropped, earlyIncident],
    after: {
      shipped: [you, github],
      failed: application,
      dropped,
      judge: you,
      screen: github,
      incident,
      filed: { you: [you, dropped], github: [github], application: [application], infrastructure: [incident] },
    },
    settledDecision: 'decision_since_e2e_judge',
  }
}
