import { bearer, type World } from '../scenarios/harness.ts'

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
export async function holdSignal(url: string, title = 'The export button does nothing'): Promise<void> {
  await api(url, '/signals', {
    from: 'feedback:argo',
    title: `${title} (${Date.now()}-${++held})`,
    text: 'it does nothing',
  })
}

/** The open needs the API reports, summed over the kinds. */
export async function needsCount(url: string): Promise<number> {
  const model = await api<{ counts: Record<string, number> }>(url, '/v1/needs')
  return Object.values(model.counts).reduce((sum, count) => sum + count, 0)
}

/**
 * A world with something on every screen: Issues filed by signals (settling) and one settled into the queue, a Decision
 * and an Errand as rows the checkpoints would leave (a lead's `ask` needs a working lead; the read models are views of
 * those rows, as in tests/scenarios/read/models.test.ts), and held signals through the route.
 */
export async function seed(world: World, url: string): Promise<void> {
  const file = async (repo: string, title: string) =>
    (await api<{ issue: string }>(url, '/signals', { from: 'owner:hermes', repo, title })).issue
  const logger = await file('argo', 'Pick a logger')
  const rotate = await file('chat', 'Rotate the chat key')
  await file('argo', 'The login page crashes on submit')
  await file('chat', 'Show unread counts in the sidebar')

  const sql = world.db.sql
  await sql`INSERT INTO factory.planning_projects (name, repo, source, project) VALUES
    ('argo', '/tmp/e2e/argo', 'defaults', '{}'::jsonb), ('chat', '/tmp/e2e/chat', 'defaults', '{}'::jsonb)
    ON CONFLICT (name) DO NOTHING`
  await api(url, '/planning/settle', { issue: logger, after: [] })

  await sql`INSERT INTO factory.decisions
    (id, key, issue_id, repo, attempt, question, recommendation, checked, options, no_answer, asked_at)
    VALUES ('decision_e2e', 'e2e-decision', ${logger}, 'argo', 1, 'Which logging library should argo use?', 'pino',
      'read the sizes', '[]'::jsonb, '{"consequence":"console","default":"pino","waitMinutes":60}'::jsonb, now() - interval '2 hours')`
  await sql`INSERT INTO factory.decision_steps (decision_id, step, outcome, at) VALUES ('decision_e2e', 'owner', 'open', now())`
  await sql`INSERT INTO factory.errands (id, key, issue_id, attempt, summary, detail, raised_at)
    VALUES ('errand_e2e', 'e2e-errand', ${rotate}, 1, 'Rotate the chat API key in the portal', 'Settings > Keys > Rotate', now() - interval '1 hour')`
  await holdSignal(url)
}
