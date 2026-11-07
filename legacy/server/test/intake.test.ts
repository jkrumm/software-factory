import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { IntakeAck } from '@software-factory/contract'
import { RepoRefused } from '../src/repos.ts'
import type { ProcessResult } from '../src/exec.ts'
import { intakeAlert } from '../src/issues/intake.ts'
import { Settler } from '../src/issues/settle.ts'
import { FINGERPRINT_WINDOW_MS, fileSignalIn, type Signal } from '../src/issues/signals.ts'
import { parseManifest } from '../src/projects/manifest.ts'
import { tick } from '../src/tick.ts'
import { noType } from './support/runner.ts'
import { TEST_REPO, TEST_ROOT } from './support/app.ts'
import { FakeClock } from './support/clock.ts'
import { startTestDb, type TestDb } from './support/pg.ts'

const IU_REPO = join(TEST_ROOT, 'IuRoot', 'intake')
mkdirSync(IU_REPO, { recursive: true })

let db: TestDb
const clock = new FakeClock()
const roots = [TEST_ROOT]

beforeAll(async () => {
  db = await startTestDb()
})
afterAll(() => db.stop())
beforeEach(() => db.reset())

const down = (extra: Partial<Signal> = {}): Signal => ({
  source: 'kuma',
  subject: 'api',
  event: 'd1',
  status: 'down',
  title: 'api is down',
  facts: { msg: 'refused' },
  repo: TEST_REPO,
  ...extra,
})
const up = (extra: Partial<Signal> = {}): Signal => down({ event: 'u1', status: 'up', title: 'api is up', ...extra })
const label = (extra: Partial<Signal> = {}): Signal => ({
  source: 'github',
  subject: 'o/r#1',
  event: 'labeled',
  status: 'event',
  title: 'Crash on start',
  facts: {},
  repo: TEST_REPO,
  fingerprint: 'o/r:crash on start',
  ...extra,
})

const file = (signal: Signal) => db.sql.begin((tx) => fileSignalIn(tx, signal, { repoRoots: roots, now: clock.now() }))
// oxlint-disable-next-line typescript/no-explicit-any -- rows of whichever table a test reads
const rows = async (table: string): Promise<Record<string, any>[]> => [
  ...(await db.sql.unsafe(`SELECT * FROM factory.${table} ORDER BY 1, 2`)),
]
const close = (id: number) =>
  db.sql`UPDATE factory.issues SET state = 'closed', outcome = 'done', closed_at = ${clock.now()} WHERE id = ${id}`

const project = async (yaml: string, makeTargets: Record<string, boolean> = { makefile: true, restart: true }) => {
  const parsed = parseManifest(`apiVersion: factory/v2\nname: repo\n${yaml}`)
  if (!parsed.ok) throw new Error(parsed.message)
  await db.sql`
    INSERT INTO factory.projects (name, repo, manifest, make_targets, synced_at, created_at)
    VALUES ('repo', ${TEST_REPO}, ${JSON.stringify(parsed.manifest)}::text::jsonb, ${JSON.stringify(makeTargets)}::text::jsonb, ${clock.now()}, ${clock.now()})`
}

describe('a stateful episode', () => {
  test('a down again is a signal on the one Issue; after the close a down is a new Issue', async () => {
    const first = await file(down())
    expect(first).toMatchObject({ status: 201, outcome: 'created' })
    const again = await file(down({ event: 'd2' }))
    expect(again).toMatchObject({ status: 200, outcome: 'attached', issue: first.issue })
    expect(await file(down({ event: 'd2' }))).toMatchObject({ outcome: 'replayed' })
    expect(await rows('issues')).toHaveLength(1)
    expect(await rows('issue_inbox')).toMatchObject([{ kind: 'signal', key: 'door:kuma:api:d2' }])
    expect(await file(up())).toMatchObject({ status: 200, outcome: 'attached' })

    await close(first.issue ?? 0)
    const next = await file(down({ event: 'd3' }))
    expect(next).toMatchObject({ status: 201, outcome: 'created' })
    expect(next.issue).not.toBe(first.issue)
  })

  test('an up with nothing open or pending is quiet', async () => {
    expect(await file(up())).toEqual({ status: 202, outcome: 'quiet', issue: null })
  })

  test('the door’s Issue keys stay: source alert, the escaped event key', async () => {
    await file(down({ subject: 'a:b%c' }))
    expect(await rows('issues')).toMatchObject([{ source: 'alert', source_key: 'kuma:a%3Ab%25c:d1' }])
  })
})

describe('a stateless fingerprint', () => {
  test('an open match is a signal and a count; the same GitHub key twice is replayed', async () => {
    const first = await file(label())
    expect(first).toMatchObject({ status: 201, outcome: 'created' })
    expect(await rows('issues')).toMatchObject([{ source: 'github', source_key: 'o/r#1' }])
    expect(await file(label())).toMatchObject({ outcome: 'replayed', issue: first.issue })
    const other = await file(label({ subject: 'o/r#2' }))
    expect(other).toMatchObject({ status: 200, outcome: 'attached', issue: first.issue })
    expect(await rows('door_issues')).toMatchObject([{ repeats: 1 }])
  })

  test('closed within the window it only counts; closed older it is a new Issue', async () => {
    const first = await file(label())
    await close(first.issue ?? 0)
    clock.advance(FINGERPRINT_WINDOW_MS - 60_000)
    expect(await file(label({ subject: 'o/r#2' }))).toMatchObject({
      status: 200,
      outcome: 'repeat',
      issue: first.issue,
    })
    expect(await rows('issue_inbox')).toEqual([])
    expect(await rows('door_issues')).toMatchObject([{ repeats: 1 }])
    clock.advance(2 * 60_000)
    const later = await file(label({ subject: 'o/r#3' }))
    expect(later).toMatchObject({ status: 201, outcome: 'created' })
    expect(later.issue).not.toBe(first.issue)
  })
})

describe('refusal', () => {
  test('a github signal in IuRoot is refused, as an alert is; nothing is stored', async () => {
    expect(await file(label({ repo: IU_REPO })).catch((e: unknown) => e)).toBeInstanceOf(RepoRefused)
    expect(await file(down({ source: 'checks', repo: IU_REPO })).catch((e: unknown) => e)).toBeInstanceOf(RepoRefused)
    expect(await rows('issues')).toEqual([])
    expect(await rows('intake_pending')).toEqual([])
  })
})

describe('settle', () => {
  const noRun = () => Promise.reject(new Error('no runbook is expected'))
  const pass = (run: typeof noRun | ((cmd: string[]) => Promise<ProcessResult>) = noRun) => {
    const settler = new Settler({ repoRoots: roots, run }, db.sql, () => clock.now())
    settler.kick()
    return settler.settled().then(() => settler.takeErrors())
  }

  test('a rule with a grace and no runbook files after the grace, with the settle facts', async () => {
    await project('heal:\n  - {when: kuma.down, grace: 5m}')
    expect(await file(down())).toEqual({ status: 202, outcome: 'settling', issue: null })
    expect(await file(down({ event: 'd2' }))).toMatchObject({ outcome: 'settling' })
    expect(await rows('intake_pending')).toHaveLength(1)
    expect(await pass()).toEqual([])
    expect(await rows('issues')).toEqual([])

    clock.advance(5 * 60_000)
    expect(await pass()).toEqual([])
    const [issue, ...rest] = await rows('issues')
    expect(rest).toEqual([])
    expect(issue).toMatchObject({ source: 'alert', source_key: 'kuma:api:d1' })
    expect(issue?.facts).toMatchObject({
      monitor: 'api',
      status: 'down',
      details: { msg: 'refused' },
      settle: { graceMs: 300_000, attempts: 0, results: [{ skipped: 'no runbook' }] },
    })
    expect(await rows('intake_pending')).toEqual([])
    expect(await rows('door_issues')).toMatchObject([{ source: 'kuma', monitor: 'api' }])
    // a replay creates nothing twice
    expect(await file(down())).toMatchObject({ outcome: 'replayed' })
  })

  test('a runbook runs once outside any transaction; an up afterwards heals and files nothing', async () => {
    await project('heal:\n  - {when: kuma.down, grace: 1m, runbook: make restart}')
    await file(down())
    const calls: string[][] = []
    let writable = false
    const run = async (cmd: string[]): Promise<ProcessResult> => {
      calls.push(cmd)
      // The row is not locked: another connection can write it, and the lease is already recorded.
      const [row] = await db.sql`SELECT attempts FROM factory.intake_pending WHERE source = 'kuma'`
      await db.sql`UPDATE factory.intake_pending SET opened_at = opened_at WHERE source = 'kuma'`
      writable = row?.attempts === 1
      return { exitCode: 0, stdout: 'restarted\n' }
    }
    clock.advance(60_000)
    expect(await pass(run)).toEqual([])
    expect(calls).toEqual([['sh', '-c', 'exec make -C "$1" restart 2>&1', 'sh', TEST_REPO]])
    expect(writable).toBe(true)
    const [pending] = await rows('intake_pending')
    expect(pending).toMatchObject({ attempts: 1, results: [{ exit: 0, tail: 'restarted' }] })
    expect(new Date(pending?.due_at).getTime()).toBe(clock.now().getTime() + 60_000)

    expect(await file(up())).toEqual({ status: 202, outcome: 'healed', issue: null })
    expect(await rows('intake_pending')).toEqual([])
    expect(await rows('issues')).toEqual([])
    // an old retry of the down does not open a new pending row
    expect(await file(down())).toMatchObject({ status: 200, outcome: 'replayed' })
    expect(await rows('intake_pending')).toEqual([])
  })

  test('max is respected: the run happens max times, then the Issue is filed with the results', async () => {
    await project('heal:\n  - {when: kuma.down, grace: 1m, runbook: make restart, max: 2}')
    await file(down())
    let runs = 0
    const run = async (): Promise<ProcessResult> => ({ exitCode: ++runs, stdout: 'x' })
    for (let i = 0; i < 4; i++) {
      clock.advance(60_000)
      expect(await pass(run)).toEqual([])
    }
    expect(runs).toBe(2)
    const [issue] = await rows('issues')
    expect(issue?.facts.settle).toMatchObject({
      attempts: 2,
      results: [{ exit: 1 }, { exit: 2 }, { skipped: 'attempts spent' }],
    })
  })

  test('no restart target: filed with the skip reason, nothing is run', async () => {
    await project('heal:\n  - {when: kuma.down, grace: 1m, runbook: make restart}', { makefile: true, restart: false })
    await file(down())
    clock.advance(60_000)
    expect(await pass()).toEqual([])
    const [issue] = await rows('issues')
    expect(issue?.facts.settle.results).toMatchObject([{ skipped: 'no restart target' }])
  })

  test('a rule of another source or a repo with no project files at once', async () => {
    expect(await file(down())).toMatchObject({ status: 201, outcome: 'created' })
    await db.reset()
    await project('heal:\n  - {when: hyperdx.down, grace: 1m}')
    expect(await file(down())).toMatchObject({ status: 201, outcome: 'created' })
  })

  test('the tick runs the pass with the injected runner', async () => {
    await project('heal:\n  - {when: kuma.down, grace: 1m, runbook: make restart}')
    await file(down())
    clock.advance(60_000)
    const calls: string[][] = []
    const settler = new Settler(
      {
        repoRoots: roots,
        run: (cmd) => {
          calls.push(cmd)
          return Promise.resolve({ exitCode: 0, stdout: '' })
        },
      },
      db.sql,
      () => clock.now(),
    )
    const result = await tick({
      sql: db.sql,
      clock,
      runner: { ...noType, start: () => Promise.reject(new Error('no spawn')) },
      settler,
    })
    await settler.settled()
    expect(result.errors).toEqual([])
    expect(calls).toHaveLength(1)
  })
})

describe('the door', () => {
  const input = (extra: Record<string, unknown> = {}) => ({
    source: 'kuma',
    monitor: 'api',
    event: 'd1',
    status: 'down' as const,
    title: 'api is down',
    facts: {},
    ...extra,
  })
  const door = (extra?: Record<string, unknown>) =>
    intakeAlert(db.sql, input(extra), { repoRoots: roots, now: clock.now() })

  test('settling and healed are 202 acks the contract knows, and the route counts only quiet', async () => {
    await project('heal:\n  - {when: kuma.down, grace: 1m}')
    await db.sql`INSERT INTO factory.door_routes (source, monitor, repo) VALUES ('kuma', 'api', ${TEST_REPO})`
    const settling = await door()
    expect(settling.status).toBe(202)
    expect(IntakeAck.parse(settling.ack)).toEqual({ outcome: 'settling', issue: null })
    const healed = await door({ event: 'u1', status: 'up' })
    expect(healed.status).toBe(202)
    expect(IntakeAck.parse(healed.ack)).toEqual({ outcome: 'healed', issue: null })
    expect(await rows('door_routes')).toMatchObject([{ quiet: 0 }])
    expect(await door({ event: 'u2', status: 'up' })).toMatchObject({ status: 202, ack: { outcome: 'quiet' } })
    expect(await rows('door_routes')).toMatchObject([{ quiet: 1 }])
  })
})

describe('manifest: heal and signals', () => {
  const parse = (body: string) => parseManifest(`apiVersion: factory/v2\nname: x\n${body}`)

  test('valid rules and signals are kept with their defaults; jobs and ticktick are dropped', () => {
    const parsed = parse(
      'heal:\n  - {when: kuma.down, grace: 30s}\n  - {when: launchd.down, grace: 1d, runbook: make restart, max: 5}\nsignals:\n  github: {}\n  launchd: [com.example.job]\n  kuma: whatever\njobs: [x]\nticktick: {}',
    )
    expect(parsed).toMatchObject({ ok: true })
    if (!parsed.ok) return
    expect(parsed.manifest.heal).toEqual([
      { when: 'kuma.down', grace: '30s', max: 1 },
      { when: 'launchd.down', grace: '1d', runbook: 'make restart', max: 5 },
    ])
    expect(parsed.manifest.signals).toEqual({
      github: { label: 'factory', checks: false },
      launchd: ['com.example.job'],
      kuma: 'whatever',
    })
    expect(parsed.manifest).not.toHaveProperty('jobs')
  })

  test('signals.github.checks opts in to red checks', () => {
    const parsed = parse('signals:\n  github: {checks: true}')
    expect(parsed.ok && parsed.manifest.signals).toEqual({ github: { label: 'factory', checks: true } })
  })

  test('no heal and no signals are an empty list and an empty object', () => {
    const parsed = parse('')
    expect(parsed.ok && parsed.manifest).toMatchObject({ heal: [], signals: {} })
  })

  test.each([
    ['a bad when', 'heal:\n  - {when: kuma.up, grace: 1m}'],
    ['a bad runbook', 'heal:\n  - {when: kuma.down, grace: 1m, runbook: make deploy}'],
    ['a grace over a day', 'heal:\n  - {when: kuma.down, grace: 2d}'],
    ['a grace that is no duration', 'heal:\n  - {when: kuma.down, grace: soon}'],
    ['max out of range', 'heal:\n  - {when: kuma.down, grace: 1m, max: 6}'],
    ['an unknown key in a rule', 'heal:\n  - {when: kuma.down, grace: 1m, extra: 1}'],
    ['signals that is not an object', 'signals: yes'],
    ['signals that is a list', 'signals: [github]'],
    ['a bad github label', 'signals:\n  github: {label: "a/b"}'],
    ['github checks that is not a boolean', 'signals:\n  github: {checks: yes please}'],
    ['launchd labels that are not strings', 'signals:\n  launchd: [1]'],
  ])('%s is a manifest error', (_name, body) => {
    expect(parse(body).ok).toBe(false)
  })
})
