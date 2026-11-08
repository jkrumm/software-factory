import { admitted, fileIssue, tick } from '../scenarios/flow.ts'
import { bearer } from '../scenarios/harness.ts'
import type { Lab } from '../scenarios/planning/lab.ts'

/** Calls the API on the main port as the owner; a refusal throws with the body. */
export async function api<T = unknown>(url: string, path: string, body?: unknown): Promise<T> {
  const response = await fetch(`${url}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'content-type': 'application/json', ...bearer() },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await response.text()
  if (!response.ok) throw new Error(`${path} answered ${response.status}: ${text}`)
  return JSON.parse(text) as T
}

let held = 0

/** Outside text is held until the owner promotes it: one more thing that waits on the owner, through the public route. */
export async function holdSignal(url: string, title = 'The export button does nothing', app = 'argo'): Promise<void> {
  await api(url, '/signals', {
    from: `feedback:${app}`,
    title: `${title} (${Date.now()}-${++held})`,
    text: `it does nothing, seen ${held} times`,
  })
}

/** The open needs the API reports, summed over the kinds. */
export async function needsCount(url: string): Promise<number> {
  const model = await api<{ counts: Record<string, number> }>(url, '/v1/needs')
  return Object.values(model.counts).reduce((sum, count) => sum + count, 0)
}

/** one repo per lead the seed starts: a project takes one lead at a time */
export const LEAD_REPOS = ['argo', 'harbor', 'atlas', 'beacon', 'cedar', 'delta']

/** The Decision of a lead's `issue ask`. With no default it waits on the owner: only then is he paged and does it show on his list. */
const form = (question: string, recommendation: string, others: string[]) => ({
  attempt: 1,
  question,
  recommendation,
  checked: 'Read the package sizes and the release notes.',
  options: [recommendation, ...others].map((label, i) => ({
    label,
    reversible: i === 0,
    cost: i === 0 ? 'one dependency, fast to swap later' : 'heavier, with more moving parts',
  })),
  noAnswer: { consequence: 'The lead waits until someone answers.' },
})

/**
 * A world with something on every screen. Six Issues, one per repo, are admitted and their leads started against the fake `hc`;
 * each lead then raises one thing through its own verbs, as a lead does (`issue ask`, `artifact submit`, `errand raise`):
 * two of each kind (one the tests read and one they settle; the read Decision is a row with a default, see below). The rest: Issues filed by signals (settling) and one
 * settled into the queue, an Errand on a work repo as a row the checkpoints would leave, and held signals through the route.
 */
export async function seed(lab: Lab): Promise<void> {
  const url = lab.server.url
  const synced = await lab.cli(['project', 'sync'])
  if (synced.code !== 0) throw new Error(`project sync exited ${synced.code}: ${synced.err}`)
  const lead = async (repo: string, title: string): Promise<string> => {
    const issue = await fileIssue(lab, { repo, title })
    await admitted(lab, issue)
    await tick(lab)
    return issue
  }
  const titles = [
    'Pick a retention',
    'Pick a cache store',
    'Write the queue spec',
    'Write the cache spec',
    'Rotate the key',
    'Plug in the phone',
  ]
  const leads: string[] = []
  for (const [i, title] of titles.entries()) leads.push(await lead(LEAD_REPOS[i] ?? 'argo', title))
  const [retention, store, queue, cache, key, phone] = leads as [string, string, string, string, string, string]
  const ask = (issue: string, body: unknown) => api(url, `/v1/issues/${issue}/ask`, body)
  await ask(retention, form('How long should argo keep audit rows?', '90 days', ['30 days', 'forever']))
  await ask(store, form('Which cache store should argo use?', 'memory', ['redis']))
  // the pass tries policy and the Judge first; what neither settles is paged to the owner, which is when it waits on him
  await api(url, '/v1/checkpoints/pass', {})
  const submit = (issue: string, title: string, content: string) =>
    api(url, `/v1/issues/${issue}/artifacts`, { attempt: 1, kind: 'spec', title, content })
  await submit(
    queue,
    'The queue spec',
    '# Queue\n\nWe keep the queue in Postgres.\n\nOne advisory lock guards the pass.',
  )
  await submit(cache, 'The cache spec', '# Cache\n\nWe cache reads for ten seconds.')
  const raise = (issue: string, summary: string, detail: string) =>
    api(url, `/v1/issues/${issue}/errands`, { attempt: 1, summary, detail })
  await raise(
    key,
    'Rotate the argo deploy key in the portal',
    'Settings > Keys > Rotate, then paste the new key into 1Password.',
  )
  await raise(phone, 'Plug in the test phone and run the smoke suite', 'USB, trust the computer, run the suite once.')

  const file = async (repo: string, title: string) =>
    (await api<{ issue: string }>(url, '/signals', { from: 'owner:hermes', repo, title })).issue
  const queued = await file('argo', 'Pick a database')
  await file('argo', 'The login page crashes on submit')
  await file('chat', 'Show unread counts in the sidebar')
  const rotate = await file('chat', 'Rotate the chat key')
  await api(url, '/planning/settle', { issue: queued, after: [] })

  const sql = lab.world.db.sql
  await sql`INSERT INTO factory.planning_projects (name, repo, source, project) VALUES
    ('chat', '/tmp/e2e/chat', 'defaults', '{}'::jsonb) ON CONFLICT (name) DO NOTHING`
  // a Decision with a default that is still running down its wait (the real owner step comes only after it), as a row
  await sql`INSERT INTO factory.decisions
    (id, key, issue_id, repo, attempt, question, recommendation, checked, options, no_answer, asked_at)
    VALUES ('decision_e2e', 'e2e-decision', ${queued}, 'argo', 1, 'Which logging library should argo use?', 'pino',
      'Read the package sizes and the release notes.',
      '[{"label":"pino","reversible":true,"cost":"one dependency, fast to swap later"},{"label":"winston","reversible":false,"cost":"heavier, with more moving parts"}]'::jsonb,
      '{"consequence":"The lead logs to the console until someone answers.","default":"pino","waitMinutes":600}'::jsonb,
      now() - interval '2 hours')`
  await sql`INSERT INTO factory.decision_steps (decision_id, step, outcome, at) VALUES ('decision_e2e', 'owner', 'open', now())`
  await sql`INSERT INTO factory.errands (id, key, issue_id, attempt, summary, detail, raised_at)
    VALUES ('errand_e2e', 'e2e-errand', ${rotate}, 1, 'Rotate the chat API key in the portal', 'Settings > Keys > Rotate', now() - interval '1 hour')`
  // one app each: a source that files again at once is held back by intake
  for (const app of ['argo', 'chat', 'harbor']) await holdSignal(url, 'The export button does nothing', app)
}
