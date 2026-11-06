import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { healthLines } from '../src/health.ts'
import { intakeAlert, listUnrouted } from '../src/issues/intake.ts'
import { fileUnrouted, UNROUTED_GRACE_MS, unroutedLines } from '../src/issues/unrouted.ts'
import { TEST_REPO, TEST_ROOT } from './support/app.ts'
import { FakeClock } from './support/clock.ts'
import { startTestDb, type TestDb } from './support/pg.ts'

const HOME = join(TEST_ROOT, 'dotfiles')
const MAPPED = join(TEST_ROOT, 'forecast')
const IU_REPO = join(TEST_ROOT, 'IuRoot', 'unrouted')
for (const dir of [HOME, MAPPED, IU_REPO]) mkdirSync(dir, { recursive: true })

let db: TestDb
const clock = new FakeClock()
const roots = [TEST_ROOT]
const deps = { repoRoots: roots, home: HOME }

beforeAll(async () => {
  db = await startTestDb()
})
afterAll(() => db.stop())
beforeEach(() => db.reset())

let counter = 0
const alert = (monitor: string, status: 'down' | 'up' = 'down', extra: { title?: string; facts?: unknown } = {}) =>
  intakeAlert(
    db.sql,
    {
      source: 'kuma',
      monitor,
      event: `e${++counter}`,
      status,
      title: extra.title ?? `${monitor} is ${status}`,
      facts: extra.facts ?? {},
    },
    { repoRoots: roots, now: clock.now() },
  )
const pass = () => fileUnrouted(db.sql, deps, clock.now())
const lines = () => unroutedLines(db.sql, clock.now())
// oxlint-disable-next-line typescript/no-explicit-any -- rows of whichever table a test reads
const rows = async (table: string): Promise<Record<string, any>[]> => [
  ...(await db.sql.unsafe(`SELECT * FROM factory.${table} ORDER BY 1, 2`)),
]
const settle = () => clock.advance(UNROUTED_GRACE_MS + 1_000)

describe('an unrouted monitor that stays down', () => {
  test('is no line and no Issue inside the grace, a line and one Issue in the home repo after it', async () => {
    expect(await alert('Plex - Stream')).toMatchObject({ status: 202, ack: { outcome: 'unrouted' } })
    clock.advance(UNROUTED_GRACE_MS - 1_000)
    await pass()
    expect(await lines()).toEqual([])
    expect(await rows('issues')).toEqual([])

    clock.advance(2_000)
    expect(await lines()).toEqual(['monitor kuma/Plex - Stream down 10 min with no route, to be filed'])
    await pass()
    await pass()
    const [issue, ...more] = await rows('issues')
    expect(more).toEqual([])
    expect(issue).toMatchObject({ source: 'alert', repo: HOME, state: 'queued' })
    expect(issue?.title).toContain('pick its repo')
    expect(issue?.title).toContain('Plex - Stream is down')
    expect(issue?.facts.details.ask).toContain('factory door route set')
    expect(await lines()).toEqual([`monitor kuma/Plex - Stream down 10 min with no route, filed as Issue ${issue?.id}`])
    expect((await healthLines(db.sql, clock.now())).filter((line) => line.startsWith('monitor '))).toHaveLength(1)
  })

  test('a long down keeps its line and does not file again, with no event in between', async () => {
    await alert('Plex - Stream')
    settle()
    await pass()
    clock.advance(28 * 3_600_000)
    await pass()
    expect(await lines()).toEqual([
      expect.stringMatching(/^monitor kuma\/Plex - Stream down 28\.\d h with no route, filed as Issue \d+$/),
    ])
    expect(await rows('issues')).toHaveLength(1)
    // the row outlives the month a quiet monitor is kept for, while it is down
    clock.advance(40 * 24 * 3_600_000)
    await alert('other')
    expect(await lines()).toHaveLength(1)
  })

  test('an up clears the line, and the next down files again', async () => {
    await alert('Plex - Stream')
    settle()
    await pass()
    expect(await lines()).toHaveLength(1)
    await alert('Plex - Stream', 'up')
    expect(await lines()).toEqual([])
    expect(await rows('door_unrouted')).toMatchObject([
      { status: 'up', down_since: null, filed_at: null, filed_issue: null },
    ])

    // the first Issue is still open: a new episode is a signal on it, not a second Issue
    await alert('Plex - Stream')
    settle()
    await pass()
    expect(await rows('issues')).toHaveLength(1)
    expect(await rows('issue_inbox')).toMatchObject([{ kind: 'signal' }])
    expect(await lines()).toHaveLength(1)
  })

  test('an up inside the grace never files', async () => {
    await alert('flaky')
    clock.advance(UNROUTED_GRACE_MS / 2)
    await alert('flaky', 'up')
    settle()
    await pass()
    expect(await rows('issues')).toEqual([])
    expect(await lines()).toEqual([])
  })

  test('a route set takes the line away and files nothing', async () => {
    await alert('Plex - Stream')
    settle()
    await db.sql`INSERT INTO factory.door_routes (source, monitor, repo) VALUES ('kuma', 'Plex - Stream', ${TEST_REPO})`
    await pass()
    expect(await lines()).toEqual([])
    expect(await rows('issues')).toEqual([])
  })

  test('a replay of the down does not restart its clock', async () => {
    const first = {
      source: 'kuma',
      monitor: 'm',
      event: 'same',
      status: 'down' as const,
      title: 'm is down',
      facts: {},
    }
    await intakeAlert(db.sql, first, { repoRoots: roots, now: clock.now() })
    clock.advance(UNROUTED_GRACE_MS - 1_000)
    await intakeAlert(db.sql, first, { repoRoots: roots, now: clock.now() })
    clock.advance(2_000)
    expect(await lines()).toHaveLength(1)
  })
})

describe('a mapped repo with a heal rule', () => {
  test('the down waits out the rule, and an up in the meantime cancels it', async () => {
    const manifest = { apiVersion: 'factory/v2', name: 'forecast', heal: [{ when: 'kuma.down', grace: '30m' }] }
    await db.sql`
      INSERT INTO factory.projects (name, repo, manifest, make_targets, synced_at, created_at)
      VALUES ('forecast', ${MAPPED}, ${JSON.stringify(manifest)}::text::jsonb, '{}'::jsonb, ${clock.now()}, ${clock.now()})`
    await alert('forecast - Push')
    settle()
    await pass()
    expect(await rows('issues')).toEqual([])
    expect(await rows('intake_pending')).toMatchObject([{ source: 'kuma', subject: 'forecast - Push', repo: MAPPED }])
    expect(await lines()).toEqual([
      'monitor kuma/forecast - Push down 10 min with no route, filing waits for the repo’s heal rule',
    ])

    await alert('forecast - Push', 'up')
    expect(await rows('intake_pending')).toEqual([])
    expect(await lines()).toEqual([])
  })
})

describe('group monitors', () => {
  test('never raise a line or file anything, however they say it', async () => {
    await alert('Homelab', 'down', { title: 'Homelab is down: Child monitors down' })
    await alert('Services', 'down', { facts: { msg: 'Child monitors down' } })
    await alert('Mixed', 'down', { facts: { heartbeat: { msg: 'child monitor down' } } })
    settle()
    await pass()
    expect(await lines()).toEqual([])
    expect(await rows('issues')).toEqual([])
    expect((await listUnrouted(db.sql)).map((row) => [row.monitor, row.group])).toEqual([
      ['Homelab', true],
      ['Mixed', true],
      ['Services', true],
    ])
  })
})

describe('where the Issue goes', () => {
  test('`<name> - Push` goes to the project named <name>', async () => {
    await db.sql`
      INSERT INTO factory.projects (name, repo, manifest, make_targets, synced_at, created_at)
      VALUES ('forecast', ${MAPPED}, '{}'::jsonb, '{}'::jsonb, ${clock.now()}, ${clock.now()})`
    await alert('forecast - Push')
    settle()
    await pass()
    const [issue] = await rows('issues')
    expect(issue).toMatchObject({ repo: MAPPED })
    expect(issue?.title).toBe('forecast - Push is down')
    expect(issue?.facts.details.ask).toBeUndefined()
  })

  test('`<name> - Door` goes to the repo of a route of another monitor of <name>', async () => {
    await db.sql`INSERT INTO factory.door_routes (source, monitor, repo) VALUES ('kuma', 'Forecast - API', ${MAPPED})`
    await alert('forecast - Door')
    settle()
    await pass()
    expect(await rows('issues')).toMatchObject([{ repo: MAPPED }])
  })

  test('a name with no such suffix, or no match, goes to the home repo', async () => {
    await alert('forecast')
    await alert('nothing - Push')
    settle()
    await pass()
    expect(await rows('issues')).toMatchObject([{ repo: HOME }, { repo: HOME }])
  })

  test('a mapped repo in IuRoot is never used: the home repo takes it, and no text names IuRoot', async () => {
    await db.sql`
      INSERT INTO factory.projects (name, repo, manifest, make_targets, synced_at, created_at)
      VALUES ('secret', ${IU_REPO}, '{}'::jsonb, '{}'::jsonb, ${clock.now()}, ${clock.now()})`
    await alert('secret - Push')
    settle()
    await pass()
    expect(await rows('issues')).toMatchObject([{ repo: HOME }])
    expect((await lines()).join('\n')).not.toMatch(/iuroot/i)
  })

  test('a home repo the policy refuses is a line that says so, and the next pass tries again', async () => {
    await alert('Plex - Stream')
    settle()
    await fileUnrouted(db.sql, { repoRoots: roots, home: '/nowhere/dotfiles' }, clock.now())
    expect(await rows('issues')).toEqual([])
    expect(await lines()).toEqual([
      'monitor kuma/Plex - Stream down 10 min with no route, not filed: no repo accepts it, the default one included',
    ])
    await pass()
    expect(await rows('issues')).toHaveLength(1)
    expect((await lines())[0]).toMatch(/filed as Issue \d+$/)
  })
})
