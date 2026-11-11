import { afterAll, beforeAll, expect, test } from 'bun:test'
import { startWorld, type ServerProcess, type World } from '../harness.ts'
import { type Estate, fakeGithub, type FakeGithub, get, makeEstate, startIntakeServer, until } from './support.ts'

/** A red default branch against a fake GitHub: filed as an incident, filed once, healed when the check is green. */
let world: World
let estate: Estate
let github: FakeGithub
let server: ServerProcess

beforeAll(async () => {
  world = await startWorld()
  github = fakeGithub()
  estate = await makeEstate(world, [
    {
      repo: 'rail',
      sources: ['checks'],
      github: { label: 'factory', author: null, since: null, checks: true },
    },
  ])
  await estate.repo('rail', { origin: 'https://github.com/o/rail.git' })
  server = await startIntakeServer(world, estate, {
    FACTORY_GITHUB_TOKEN: 'ghp_fake_0123456789',
    FACTORY_GITHUB_API_URL: github.url,
    FACTORY_GITHUB_POLL: '1s',
  })
})

afterAll(async () => {
  await server.stop()
  github.stop()
  await estate.stop()
  await world.stop()
})

type Row = { state: string; kind: string | null; outcome: string | null }
const issues = async (): Promise<(Row & { id: string })[]> =>
  (await world.db.sql`
    SELECT i.id, i.state, i.outcome, e.payload->>'kind' AS kind
    FROM factory.issues i JOIN factory.issue_events e ON e.issue_id = i.id AND e.kind = 'filed'
    ORDER BY i.id`) as (Row & { id: string })[]
const pullReads = () => github.requests.filter((r) => r.startsWith('GET /repos/o/rail/pulls')).length

test('a failing default-branch check files one incident, reads the pull requests once, and heals when green', async () => {
  github.rail = { runs: [{ name: 'ci', conclusion: 'failure' }], pulls: ['factory/3-1'] }
  const [filed] = await until('the red check to be filed', async () => {
    const all = await issues()
    return all.length > 0 ? all : null
  })
  expect(filed).toMatchObject({ kind: 'incident', state: 'settling' })
  await until('the pull requests to be read', async () => pullReads() > 0)

  // more polls: the same red check files nothing and reads no pull request again
  const polls = () => github.requests.filter((r) => r.startsWith('GET /repos/o/rail/commits/main/check-runs')).length
  const seen = polls()
  await until('two more polls', async () => polls() >= seen + 2)
  expect(await issues()).toHaveLength(1)
  expect(pullReads()).toBe(1)

  // the check is green again before any lead started: the incident closes as healed
  github.rail.runs = [{ name: 'ci', conclusion: 'success' }]
  await until('the incident to heal', async () => (await issues())[0]?.outcome === 'healed')
  expect((await issues())[0]).toMatchObject({ state: 'closed', outcome: 'healed', kind: 'incident' })
  expect((await get(server, '/health')).status).toBe(200)
})
