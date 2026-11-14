import { afterAll, beforeAll, expect, test } from 'bun:test'
import { ProjectPlanModel } from '@software-factory/contract'
import { factory } from '../harness.ts'
import { type Lab, startLab } from './lab.ts'

let lab: Lab

const PLAN = `version: 1
rows:
  - key: tokens
    title: The design tokens
    facts: { what: the colour and spacing tokens, why: every screen reads them }
  - key: screens
    title: The screens
    facts: { what: the three screens, why: they use the tokens }
    after: [tokens]
  - key: private-work
    title: A step in a work repo
    facts: { what: the work repo's build }
    repo: bare
  - key: adopted
    issue: 1
`

beforeAll(async () => {
  lab = await startLab({
    leads: true,
    env: { FACTORY_LEADS_PER_ACCOUNT: '16' },
    repos: {
      app: { project: 'apiVersion: factory/v2\nname: app\n', plan: PLAN },
      bare: { project: 'apiVersion: factory/v2\nname: bare\nwork: true\n' },
    },
  })
  expect((await lab.cli(['project', 'sync'])).code).toBe(0)
  expect((await lab.cli(['planning', 'pass'])).code).toBe(0)
})

afterAll(async () => {
  await lab.stop()
})

const plan = (name: string, as: 'owner' | 'agent' | 'read') =>
  factory(lab.world, ['project', 'plan', name], { FACTORY_URL: lab.server.url }, { as })

test('a lead reads the rows of a project with their state, their words and their after keys', async () => {
  const result = await plan('app', 'agent')
  expect(result.code).toBe(0)
  const model = ProjectPlanModel.parse(JSON.parse(result.out))
  expect(model.project).toBe('app')
  expect(model.rows.map((r) => [r.key, r.state, r.title, r.after, r.what])).toEqual([
    ['tokens', 'open', 'The design tokens', [], 'the colour and spacing tokens'],
    ['screens', 'waiting', 'The screens', ['tokens'], 'the three screens'],
    ['private-work', 'open', 'A step in a work repo', [], "the work repo's build"],
    ['adopted', 'open', null, [], null],
  ])
  expect(model.rows.find((r) => r.key === 'screens')?.reason).toBe('after app:tokens')
})

test('the owner reads a work project and the target of a row filed into it; the read token gets neither', async () => {
  const owner = await plan('bare', 'owner')
  expect(owner.code).toBe(0)
  expect(ProjectPlanModel.parse(JSON.parse(owner.out)).rows).toEqual([])
  expect((await plan('bare', 'agent')).code).toBe(0)
  expect((await plan('bare', 'read')).code).toBe(4)

  const asOwner = ProjectPlanModel.parse(JSON.parse((await plan('app', 'owner')).out))
  expect(asOwner.rows.find((r) => r.key === 'private-work')?.target).toBe('bare')
  const asRead = ProjectPlanModel.parse(JSON.parse((await plan('app', 'read')).out))
  expect(asRead.rows.find((r) => r.key === 'private-work')?.target).toBe('private')
  expect(asRead.rows.find((r) => r.key === 'tokens')?.target).toBe('app')
})

test('an unknown project is exit 4 for every caller, and --format plain prints one line per row', async () => {
  expect((await plan('nothing', 'agent')).code).toBe(4)
  const plain = await factory(
    lab.world,
    ['project', 'plan', 'app', '--format', 'plain'],
    { FACTORY_URL: lab.server.url },
    { as: 'agent' },
  )
  expect(plain.out.split('\n').slice(0, 2)).toEqual([
    expect.stringMatching(/^tokens\topen\tissue_\d+\t-\tThe design tokens$/),
    'screens\twaiting\t-\tafter app:tokens\tThe screens',
  ])
})
