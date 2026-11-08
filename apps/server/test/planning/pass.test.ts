import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { planningPass } from '../../src/app/planning-pass.ts'
import { addAfter, setPrio, settleIssue } from '../../src/app/planning-chain.ts'
import { projectSignals } from '../../src/app/planning-signals.ts'
import { projectStates } from '../../src/app/planning-views.ts'
import { syncProjects } from '../../src/app/planning-sync.ts'
import { type IssueId, issueId } from '../../src/kernel/ids.ts'
import { key } from '../../src/kernel/keys.ts'
import { startWorld, value, type World } from './support.ts'

let world: World

beforeAll(async () => {
  world = await startWorld()
})
afterAll(async () => {
  await world.stop()
})
beforeEach(async () => {
  await world.reset()
})

const PROJECT = (name: string, extra = '') => ({
  state: 'text' as const,
  sha: `sha-${name}`,
  value: { apiVersion: 'factory/v2', name, ...(extra ? JSON.parse(extra) : {}) },
})
const plan = (sha: string, rows: object[]) => ({ state: 'text' as const, sha, value: { version: 1, rows } })
const row = (k: string, extra: object = {}) => ({
  key: k,
  title: `Title of ${k}`,
  facts: { why: `because ${k}` },
  ...extra,
})

const states = async () => value(await projectStates(world.deps))
const issues = async () =>
  world.db.sql`SELECT id, repo, state FROM factory.issues ORDER BY id`.then((r) =>
    r.map((x: { id: string; state: string }) => `${x.id}:${x.state}`),
  )

describe('syncing the projects', () => {
  test('a project and its plan are read from the default branch and stored with the branch', async () => {
    world.source.add('app', { project: PROJECT('app', '{"leads":2}'), plan: plan('p1', [row('a')]) })
    const synced = value(await syncProjects(world.deps, { fetch: false }))
    expect(synced).toMatchObject({ synced: 1, broken: [], errors: [] })
    const [app] = await states()
    expect(app?.project).toMatchObject({ name: 'app', repo: '/src/app', source: 'file', branch: 'origin/main' })
    expect(app?.project.project.leads).toBe(2)
    expect(app?.plan?.rows.map((r) => [r.key, r.state])).toEqual([['a', 'filable']])
  })

  test('the repo an open Issue names is read even without a project.yaml: a project on the defaults', async () => {
    world.source.add('work')
    const issue = await world.file({ repo: 'work' })
    value(await syncProjects(world.deps, { fetch: false }))
    const [work] = await states()
    expect(work?.project).toMatchObject({ name: 'work', source: 'defaults' })
    expect(work?.project.project.leads).toBe(1)
    expect(issue).toBe(issueId(1))
  })

  test('a repo that cannot be read keeps its row and is named in the errors', async () => {
    world.source.add('app', { project: PROJECT('app') })
    value(await syncProjects(world.deps, { fetch: false }))
    world.source.repos.set('/src/app', { ref: { directory: 'app', path: '/src/app' }, read: 'fail' })
    const again = value(await syncProjects(world.deps, { fetch: false }))
    expect(again.errors).toEqual(['/src/app: /src/app: cannot be read'])
    expect((await states())[0]?.project.source).toBe('file')
  })

  test('a broken project.yaml keeps the last valid content and files one Issue per content, settled', async () => {
    world.source.add('app', { project: PROJECT('app', '{"leads":3}') })
    value(await syncProjects(world.deps, { fetch: false }))
    world.source.set('app', {
      project: { state: 'text', sha: 'bad1', value: { apiVersion: 'factory/v2', name: 'app', leads: 99 } },
    })
    const first = value(await syncProjects(world.deps, { fetch: false }))
    expect(first.broken).toMatchObject([{ project: 'app', file: 'project.yaml', issue: issueId(1) }])
    value(await syncProjects(world.deps, { fetch: false }))
    expect(await issues()).toEqual(['issue_1:queued'])
    expect((await states())[0]?.project.project.leads).toBe(3)
    world.source.set('app', {
      project: { state: 'text', sha: 'bad2', value: { apiVersion: 'factory/v2', name: 'app', leads: 98 } },
    })
    value(await syncProjects(world.deps, { fetch: false }))
    expect(await issues()).toEqual(['issue_1:queued', 'issue_2:queued'])
  })
})

describe('the plan files its rows', () => {
  test('a row is filed once when its after row has closed, as a settled Issue with its facts as a note', async () => {
    world.source.add('app', {
      project: PROJECT('app'),
      plan: plan('p1', [row('first'), row('second', { after: ['first'] })]),
    })
    const one = value(await planningPass(world.deps))
    expect(one.filed).toEqual([{ project: 'app', row: 'first', issue: issueId(1) }])
    expect(await issues()).toEqual(['issue_1:queued'])
    const [facts] = await world.db.sql`
      SELECT payload->>'text' AS text FROM factory.issue_events WHERE issue_id = 'issue_1' AND kind = 'noted'`
    expect(facts?.text).toBe('Plan row first.\nwhy: because first')

    // nothing doubles while the first row is open, nor when the pass runs again
    expect(value(await planningPass(world.deps)).filed).toEqual([])
    await world.send(issueId(1), 'cancelled', 'cancelled', { reason: 'not needed' }, 'owner')
    const two = value(await planningPass(world.deps))
    expect(two.filed).toEqual([{ project: 'app', row: 'second', issue: issueId(2) }])
    expect(value(await planningPass(world.deps)).filed).toEqual([])
    expect(await issues()).toEqual(['issue_1:closed', 'issue_2:queued'])
    const rows = (await states())[0]?.plan?.rows
    expect(rows?.map((r) => [r.key, r.state, r.issue])).toEqual([
      ['first', 'done', 'issue_1'],
      ['second', 'open', 'issue_2'],
    ])
  })

  test('a row may target another repo: its Issue is filed there', async () => {
    world.source.add('app', { project: PROJECT('app'), plan: plan('p1', [row('far', { repo: 'lib' })]) })
    world.source.add('lib', { project: PROJECT('lib') })
    value(await planningPass(world.deps))
    const [filed] = await world.db.sql`SELECT repo FROM factory.issues WHERE id = 'issue_1'`
    expect(filed?.repo).toBe('lib')
  })

  test('a row whose time has not come is filed on the first pass after it, not before', async () => {
    world.source.add('app', { project: PROJECT('app'), plan: plan('p1', [row('later', { not_before: '2026-11-08' })]) })
    expect(value(await planningPass(world.deps)).filed).toEqual([])
    world.clock.set(new Date('2026-11-08T00:00:01Z'))
    expect(value(await planningPass(world.deps)).filed).toHaveLength(1)
  })

  test('a plan row filed by two passes at once is one Issue (the row key is the filed event key)', async () => {
    world.source.add('app', { project: PROJECT('app'), plan: plan('p1', [row('a')]) })
    value(await syncProjects(world.deps, { fetch: false }))
    await Promise.all([planningPass(world.deps), planningPass(world.deps)])
    // one Issue; which of the two passes drew the id first is not the test's to say
    expect(await issues()).toEqual([expect.stringMatching(/^issue_\d+:queued$/)])
  })

  test('a plan that does not parse files nothing, keeps the last valid plan and says so', async () => {
    world.source.add('app', { project: PROJECT('app'), plan: plan('p1', [row('a', { after: ['b'] }), row('b')]) })
    value(await syncProjects(world.deps, { fetch: false }))
    world.source.set('app', { plan: plan('p2', [row('a', { after: ['b'] }), row('b', { after: ['a'] })]) })
    const pass = value(await syncProjects(world.deps, { fetch: false }))
    expect(pass.broken).toMatchObject([
      { file: 'docs/plan.yaml', message: expect.stringContaining('cycle: a -> b -> a') },
    ])
    const [app] = await states()
    expect(app?.project.planError?.message).toContain('cycle')
    expect(app?.plan?.rows).toHaveLength(2)
  })
})

describe('what intake hears', () => {
  test('a project is found by name, path or worktree; polled lists the projects with automatic sources', async () => {
    const listens = JSON.stringify({ signals: { github: { label: 'factory' } } })
    world.source.add('app', { project: PROJECT('app', listens) })
    world.source.add('quiet', { project: PROJECT('quiet') })
    world.source.add('work')
    await world.file({ repo: 'work' })
    value(await syncProjects(world.deps, { fetch: false }))
    const port = projectSignals(world.deps)
    expect(value(await port.find('app'))).toMatchObject({ repo: 'app', work: false, sources: ['github'] })
    expect(value(await port.find('/src/app/.claude/worktrees/x'))).toMatchObject({ repo: 'app' })
    expect(value(await port.find('work'))).toMatchObject({ work: true, sources: [] })
    expect(value(await port.find('unknown'))).toBeNull()
    expect(value(await port.polled()).map((v) => v.repo)).toEqual(['app'])
  })
})

describe('the chain', () => {
  test('settling an Issue with edges queues it; a closed blocker, an unknown one and a cycle are refused and store nothing', async () => {
    const [a, b, c] = [
      await world.file({ repo: 'x' }),
      await world.file({ repo: 'x' }),
      await world.file({ repo: 'x' }),
    ]
    if (!a || !b || !c) throw new Error('no issues')
    const settled = value(await settleIssue(world.deps, { issue: b, after: [a] }))
    expect(settled).toEqual({ result: 'settled', edges: 1, state: 'queued' })
    // a repeat of the call settles nothing twice, even when the blocker has closed since
    expect(value(await settleIssue(world.deps, { issue: b, after: [a] }))).toMatchObject({
      result: 'replayed',
      edges: 0,
    })
    await world.send(a, 'cancelled-a', 'cancelled', { reason: 'x' }, 'owner')
    expect(value(await settleIssue(world.deps, { issue: b, after: [a] }))).toMatchObject({ result: 'replayed' })
    await world.send(a, 'reopened-a', 'reopened', { reason: 'again' }, 'owner')

    const cycle = await addAfter(world.deps, { issue: a, after: [b] })
    expect(cycle).toMatchObject({ ok: false, error: { kind: 'cycle', path: [a, b, a] } })

    await world.send(c, 'cancelled', 'cancelled', { reason: 'x' }, 'owner')
    const d = await world.file({ repo: 'x' })
    expect(await settleIssue(world.deps, { issue: d, after: [c] })).toMatchObject({
      ok: false,
      error: { kind: 'issue_closed', issue: c },
    })
    expect(await settleIssue(world.deps, { issue: d, after: [issueId(99)] })).toMatchObject({
      ok: false,
      error: { kind: 'unknown_issue' },
    })
    const [{ n }] = await world.db.sql`SELECT count(*)::int AS n FROM factory.planning_edges`
    expect(n).toBe(1)
    expect(await issues()).toEqual(['issue_1:queued', 'issue_2:queued', 'issue_3:closed', 'issue_4:settling'])
  })

  test('two settles at once that would close a cycle: one is refused, never both stored', async () => {
    const [a, b] = [await world.file({ repo: 'x' }), await world.file({ repo: 'x' })]
    if (!a || !b) throw new Error('no issues')
    const results = await Promise.all([
      settleIssue(world.deps, { issue: a, after: [b] }),
      settleIssue(world.deps, { issue: b, after: [a] }),
    ])
    expect(results.filter((r) => r.ok)).toHaveLength(1)
    expect(results.find((r) => !r.ok)).toMatchObject({ ok: false, error: { kind: 'cycle' } })
    const [{ n }] = await world.db.sql`SELECT count(*)::int AS n FROM factory.planning_edges`
    expect(n).toBe(1)
  })

  test('a settle on an Issue that is not settling chains nothing: the event is ignored and no edge is kept', async () => {
    const a = await world.queued({ repo: 'x' })
    const b = await world.file({ repo: 'x' })
    const result = value(await settleIssue(world.deps, { issue: a, after: [b] }))
    expect(result).toMatchObject({ result: 'ignored', edges: 0, state: 'queued' })
    const [{ n }] = await world.db.sql`SELECT count(*)::int AS n FROM factory.planning_edges`
    expect(n).toBe(0)
  })

  test('by default a working Issue takes no edge (the queue loop may hold a stale snapshot); the owner’s flag allows it', async () => {
    const a = await world.queued({ repo: 'x' })
    const b = await world.queued({ repo: 'x' })
    await world.send(a, 'admitted', 'admitted', {})
    expect(await addAfter(world.deps, { issue: a, after: [b] })).toMatchObject({
      ok: false,
      error: { kind: 'wrong_state' },
    })
    expect(value(await addAfter(world.deps, { issue: a, after: [b], running: true }))).toEqual({ edges: 1 })
  })

  test('a waiting Issue takes no edge', async () => {
    const a = await world.queued({ repo: 'x' })
    const b = await world.queued({ repo: 'x' })
    await world.send(a, 'admitted', 'admitted', {})
    await world.send(a, 'lead_started', 'lead_started', { attempt: 1, terminal: 't' })
    await world.send(a, 'errand_raised', 'errand_raised', { attempt: 1, errand: { id: 'e1', summary: 'x' } }, 'lead')
    expect(await addAfter(world.deps, { issue: a, after: [b], running: true })).toMatchObject({
      ok: false,
      error: { kind: 'wrong_state' },
    })
  })

  test('a lead that defers on an Issue is woken once, when that Issue closes in any outcome', async () => {
    world.source.add('x', { project: PROJECT('x') })
    const lead = await world.queued({ repo: 'x' })
    const blocker = await world.queued({ repo: 'x' })
    await world.send(lead, 'admitted', 'admitted', {})
    await world.send(lead, 'lead_started', 'lead_started', { attempt: 1, terminal: 't' })
    expect(await world.send(lead, 'deferred', 'deferred', { attempt: 1, after: [blocker] }, 'lead')).toBe('waiting')

    expect(value(await planningPass(world.deps)).woken).toEqual([])
    await world.send(blocker, 'cancelled', 'cancelled', { reason: 'dropped' }, 'owner')
    expect(value(await planningPass(world.deps)).woken).toEqual([lead])
    expect(value(await planningPass(world.deps)).woken).toEqual([])
    const [row] = await world.db.sql`SELECT state FROM factory.issues WHERE id = ${lead}`
    expect(row?.state).toBe('working')
  })

  describe('a lead that defers until a time', () => {
    const deferredUntil = async (offsetMs: number) => {
      world.source.add('x', { project: PROJECT('x') })
      const lead = await world.queued({ repo: 'x' })
      await world.send(lead, 'admitted', 'admitted', {})
      await world.send(lead, 'lead_started', 'lead_started', { attempt: 1, terminal: 't' })
      const until = new Date(world.clock.now().getTime() + offsetMs).toISOString()
      expect(await world.send(lead, 'deferred', 'deferred', { attempt: 1, until }, 'lead')).toBe('waiting')
      return lead
    }
    const stateOf = async (lead: IssueId) => {
      const [row] = await world.db.sql`SELECT state FROM factory.issues WHERE id = ${lead}`
      return row?.state
    }

    test('is woken once, when the time has come, and the lead is told', async () => {
      const lead = await deferredUntil(60_000)
      expect(value(await planningPass(world.deps)).woken).toEqual([])
      expect(await stateOf(lead)).toBe('waiting')
      world.clock.advance(61_000)
      expect(value(await planningPass(world.deps)).woken).toEqual([lead])
      expect(await stateOf(lead)).toBe('working')
      expect(value(await planningPass(world.deps)).woken).toEqual([])
      const told = await world.db
        .sql`SELECT 1 FROM factory.issue_effects WHERE issue_id = ${lead} AND kind = 'note_lead'`
      expect(told.length).toBe(1)
    })

    test('overdue by days, is woken on the first pass', async () => {
      const lead = await deferredUntil(60_000)
      world.clock.advance(3 * 24 * 60 * 60_000)
      expect(value(await planningPass(world.deps)).woken).toEqual([lead])
      expect(await stateOf(lead)).toBe('working')
    })
  })

  test('an edge is satisfied once, when its blocker is seen closed', async () => {
    const a = await world.file({ repo: 'x' })
    const b = await world.file({ repo: 'x' })
    value(await settleIssue(world.deps, { issue: b, after: [a] }))
    await world.send(a, 'cancelled', 'cancelled', { reason: 'x' }, 'owner')
    expect(value(await planningPass(world.deps)).satisfied).toBe(1)
    expect(value(await planningPass(world.deps)).satisfied).toBe(0)
    await world.send(a, 'reopened', 'reopened', { reason: 'again' }, 'owner')
    const [edge] = await world.db.sql`SELECT satisfied_at IS NOT NULL AS done FROM factory.planning_edges`
    expect(edge?.done).toBe(true)
  })

  test("the owner's prio: the latest by time wins, the same key records nothing again, a closed Issue takes none", async () => {
    const a = await world.queued({ repo: 'x' })
    expect(value(await setPrio(world.deps, { issue: a, value: 10, key: key('prio', 'k1') }))).toEqual({
      recorded: true,
    })
    expect(value(await setPrio(world.deps, { issue: a, value: 10, key: key('prio', 'k1') }))).toEqual({
      recorded: false,
    })
    world.clock.advance(1000)
    value(await setPrio(world.deps, { issue: a, value: -3, key: key('prio', 'k2') }))
    const prios = await world.deps.uow.run(async ({ planning }) => ok2(await planning.prios()))
    expect(value(prios).get(a)).toBe(-3)
    await world.send(a, 'cancelled', 'cancelled', { reason: 'x' }, 'owner')
    expect(await setPrio(world.deps, { issue: a, value: 1, key: key('prio', 'k3') })).toMatchObject({
      ok: false,
      error: { kind: 'issue_closed' },
    })
  })
})

const ok2 = <T>(v: T) => ({ ok: true as const, value: v })
