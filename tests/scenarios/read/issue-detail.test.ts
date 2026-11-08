import { afterAll, beforeAll, expect, setDefaultTimeout, test } from 'bun:test'
import { ReadIssueDetail } from '@software-factory/contract'
import { admitted, must, tick } from '../flow.ts'
import { bearer } from '../harness.ts'
import type { LeadsWorld } from '../leads/support.ts'
import { commit, projectMake, scriptReview, ship, startQualityWorld, until } from '../quality/support.ts'

setDefaultTimeout(90_000)

/**
 * `GET /v1/issues/:id` with real data: an Issue filed by a signal and amended by a second, a note the lead was told, a
 * Decision the owner answered, a Spec with a verdict, a ship with its commits and a watch that passed. The read token reads the
 * same Issue once its repo is a work repo.
 */
let lw: LeadsWorld
let issue = ''
let sha = ''

const body = (value: unknown): string[] => ['--body', JSON.stringify(value)]
const json = async (args: string[]) =>
  (await must(lw, [...args, '--format', 'json'])).json as { decision: { id: string }; artifact: { id: string } }

const detail = async (as: 'owner' | 'read' = 'owner') => {
  const response = await fetch(`${lw.server.url}/v1/issues/${issue}`, { headers: bearer(as) })
  if (response.status !== 200) throw new Error(`answered ${response.status}: ${await response.text()}`)
  return ReadIssueDetail.parse(await response.json())
}

beforeAll(async () => {
  lw = await startQualityWorld({ FACTORY_WATCH_WINDOW_MS: '1500' }, { project: projectMake(1) })
  await scriptReview(lw.world, 'covered')
  const signal = async (title: string, text: string) =>
    (await (
      await fetch(`${lw.server.url}/signals`, {
        method: 'POST',
        headers: { ...bearer(), 'content-type': 'application/json' },
        body: JSON.stringify({ from: 'owner:hermes', repo: 'example', title, text }),
      })
    ).json()) as { outcome: string; issue: string }
  const first = await signal('The login page crashes on submit', 'it is a 500')
  expect(first.outcome).toBe('filed')
  issue = first.issue
  expect((await signal('The login page still crashes on submit', 'from /session')).outcome).toBe('amended')

  await admitted(lw, issue)
  await tick(lw)
  await until('the lead to work', async () => (await detail()).state === 'working')
  await lw.note(issue, 'use the staging database, not production')
  await tick(lw)

  const asked = await json([
    'issue',
    'ask',
    issue,
    ...body({
      attempt: 1,
      question: 'Which logging library?',
      recommendation: 'pino',
      checked: 'Read the sizes.',
      options: [
        { label: 'pino', reversible: true, cost: 'small' },
        { label: 'winston', reversible: true, cost: 'large' },
      ],
      noAnswer: { consequence: 'console until answered' },
    }),
  ])
  await must(lw, ['decision', 'answer', asked.decision.id, 'winston'])
  const submitted = await json([
    'artifact',
    'submit',
    issue,
    ...body({ attempt: 1, kind: 'spec', title: 'The queue spec', content: '# Queue\n\nPostgres.' }),
  ])
  await must(lw, ['artifact', 'verdict', submitted.artifact.id, ...body({ verdict: 'looks_good' })])
  sha = await commit(lw, 'src/a.ts', 'export const a = 1\n', 'feat: a')
  const shipped = await ship(lw.world, lw.server, issue, { call: 'ship-1', commits: [sha] })
  expect(shipped.code).toBe(0)
  await until('the watch to pass', async () => (await detail()).shipping[0]?.watch?.answer === 'passed', 30_000)
})

afterAll(async () => {
  await lw.stop()
})

test('triage: the signal that filed the Issue, then the one that amended it', async () => {
  const { triage } = await detail()
  expect(triage.map((t) => t.outcome)).toEqual(['filed', 'amended'])
  expect(triage[0]).toMatchObject({
    title: 'The login page crashes on submit',
    text: 'it is a 500',
    origin: 'you',
    trust: 'owner',
    kind: 'request',
  })
  expect(triage[1]?.text).toBe('from /session')
})

test('notes: the full text, with the lead it was typed to', async () => {
  const { notes } = await detail()
  const mine = notes.find((n) => n.text === 'use the staging database, not production')
  expect(notes).toHaveLength(1)
  expect(mine).toMatchObject({ session: expect.stringMatching(/^lead-\d+-1$/), delivered: true })
})

test('asks: the Decision with its id, recommendation, status and who settled it', async () => {
  const { asks } = await detail()
  expect(asks).toHaveLength(1)
  expect(asks[0]).toMatchObject({
    id: expect.stringMatching(/^decision_/),
    question: 'Which logging library?',
    options: ['pino', 'winston'],
    recommendation: 'pino',
    checked: 'Read the sizes.',
    status: 'answered',
    answer: 'winston',
    settledBy: 'owner',
  })
  expect(asks[0]?.answeredAt).not.toBeNull()
})

test('artifacts: the Spec with its revisions and the owner’s verdict', async () => {
  const { artifacts } = await detail()
  expect(artifacts).toMatchObject([
    {
      id: expect.stringMatching(/^artifact_/),
      kind: 'spec',
      title: 'The queue spec',
      revisions: 1,
      verdict: 'looks_good',
    },
  ])
})

test('shipping: the accepted ship with its commits, review, and the watch that passed with its check', async () => {
  const { shipping, timeline } = await detail()
  expect(shipping).toHaveLength(1)
  const [one] = shipping
  expect(one).toMatchObject({
    attempt: 1,
    result: 'accepted',
    detail: null,
    commits: [sha],
    review: { present: true },
    watch: { windowMs: 1000, answer: 'passed' },
  })
  expect(one?.watch?.answeredAt).not.toBeNull()
  expect(one?.checks[0]).toMatchObject({ result: 'green', summary: 'All 2 checks passed.' })
  // every kind on the timeline reads as a sentence, never the bare kind
  for (const line of timeline) expect(line.text).not.toBe(line.kind)
})

test('the read token gets the shape of a work repo’s Issue and none of its words', async () => {
  await lw.world.db
    .sql`INSERT INTO factory.planning_projects (name, repo, source, project) VALUES ('example', ${lw.repo}, 'defaults', '{}'::jsonb)
      ON CONFLICT (name) DO UPDATE SET source = 'defaults'`
  const red = await detail('read')
  expect(red.visible).toBe(true)
  const text = JSON.stringify(red)
  for (const word of [
    'login page',
    'a 500',
    'staging',
    'logging library',
    'winston',
    'pino',
    'queue spec',
    sha,
    'checks passed',
  ])
    expect(text).not.toContain(word)
  expect(red.triage.map((t) => t.outcome)).toEqual(['filed', 'amended'])
  expect(red.notes.length).toBeGreaterThan(0)
  expect(red.asks[0]).toMatchObject({ status: 'answered', settledBy: 'owner' })
  expect(red.artifacts[0]).toMatchObject({ revisions: 1, verdict: 'looks_good' })
  expect(red.shipping[0]).toMatchObject({ result: 'accepted', commits: [], watch: { answer: 'passed' } })
})
