import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { ProcessResult } from '../src/exec.ts'
import { LaunchdIntake, parseJob } from '../src/intake/launchd.ts'
import { parseManifest } from '../src/projects/manifest.ts'
import { TEST_REPO, TEST_ROOT } from './support/app.ts'
import { FakeClock } from './support/clock.ts'
import { startTestDb, type TestDb } from './support/pg.ts'

const SECOND_REPO = join(TEST_ROOT, 'second')
const IU_REPO = join(TEST_ROOT, 'IuRoot', 'ld')
mkdirSync(SECOND_REPO, { recursive: true })
mkdirSync(IU_REPO, { recursive: true })
const UID = 501
const JOB = 'com.example.job'

let db: TestDb
const clock = new FakeClock()

beforeAll(async () => {
  db = await startTestDb()
})
afterAll(() => db.stop())
beforeEach(() => db.reset())

const logged: unknown[][] = []
let errors: ReturnType<typeof spyOn>
beforeEach(() => {
  logged.length = 0
  errors = spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    logged.push(args)
  })
})
afterEach(() => errors.mockRestore())

const project = async (name: string, repo: string, yaml = `signals:\n  launchd: [${JOB}]`) => {
  const parsed = parseManifest(`apiVersion: factory/v2\nname: ${name}\n${yaml}`)
  if (!parsed.ok) throw new Error(parsed.message)
  await db.sql`
    INSERT INTO factory.projects (name, repo, manifest, make_targets, synced_at, created_at)
    VALUES (${name}, ${repo}, ${JSON.stringify(parsed.manifest)}::text::jsonb, NULL, ${clock.now()}, ${clock.now()})`
}

/** What `launchctl print` prints for a job, as far as the intake reads it. */
const printed = (state: string, exit: string, runs: number): string =>
  [
    'gui/501/com.example.job = {',
    '\tactive count = 0',
    `\tstate = ${state}`,
    '\tprogram = /bin/bash',
    `\truns = ${runs}`,
    `\tlast exit code = ${exit}`,
    '\tproperties = {',
    '\t\tstate = active',
    '\t}',
    '}',
  ].join('\n')

const FAILED = (runs = 3) => printed('not running', '1', runs)
const FINE = (runs = 3) => printed('not running', '0', runs)

function setup() {
  const asked: string[][] = []
  const jobs = new Map<string, ProcessResult>()
  const run = (cmd: string[]): Promise<ProcessResult> => {
    asked.push(cmd)
    const label = (cmd[2] ?? '').split('/')[2] ?? ''
    return Promise.resolve(jobs.get(label) ?? { exitCode: 113, stdout: '' })
  }
  const intake = new LaunchdIntake({
    sql: db.sql,
    now: () => clock.now(),
    roots: [TEST_ROOT],
    uid: UID,
    everyMs: 300_000,
    run,
  })
  return {
    asked,
    intake,
    say: (label: string, stdout: string) => jobs.set(label, { exitCode: 0, stdout }),
    pass: async () => {
      clock.advance(300_000)
      intake.kick()
      await intake.settled()
    },
  }
}

// oxlint-disable-next-line typescript/no-explicit-any -- rows of whichever table a test reads
const rows = async (table: string): Promise<Record<string, any>[]> => [
  ...(await db.sql.unsafe(`SELECT * FROM factory.${table} ORDER BY 1, 2`)),
]

describe('parseJob', () => {
  test('reads the state, the last exit code and the runs; a never-exited job has no code', () => {
    expect(parseJob(printed('not running', '78', 4))).toEqual({ state: 'not running', exitCode: 78, runs: 4 })
    expect(parseJob(printed('running', '(never exited)', 1))).toEqual({
      state: 'running',
      exitCode: undefined,
      runs: 1,
    })
    expect(parseJob('')).toEqual({ state: undefined, exitCode: undefined, runs: 0 })
  })
})

describe('the failed launchd job source', () => {
  test('a job whose last exit is non-zero files one Issue; only the named label is read', async () => {
    await project('r', TEST_REPO)
    const ld = setup()
    ld.say(JOB, FAILED())
    await ld.pass()
    expect(ld.asked).toEqual([['launchctl', 'print', `gui/${UID}/${JOB}`]])
    const [issue, ...rest] = await rows('issues')
    expect(rest).toEqual([])
    expect(issue).toMatchObject({ source: 'launchd', repo: TEST_REPO, title: `Failed launchd job "${JOB}" (exit 1)` })
    expect(issue?.facts).toMatchObject({
      source: 'launchd',
      monitor: JOB,
      status: 'down',
      details: { label: JOB, exitCode: 1, runs: 3 },
    })
    expect(await rows('door_issues')).toMatchObject([{ source: 'launchd', monitor: JOB }])
  })

  test('the same failure on the next pass is one Issue and files nothing more', async () => {
    await project('r', TEST_REPO)
    const ld = setup()
    ld.say(JOB, FAILED())
    await ld.pass()
    await ld.pass()
    await ld.pass()
    expect(await rows('issues')).toHaveLength(1)
    expect(await rows('issue_inbox')).toEqual([])
  })

  test('a new failed run of the same job is a signal on the open Issue, not a second Issue', async () => {
    await project('r', TEST_REPO)
    const ld = setup()
    ld.say(JOB, FAILED(3))
    await ld.pass()
    ld.say(JOB, FAILED(4))
    await ld.pass()
    expect(await rows('issues')).toHaveLength(1)
    expect(await rows('issue_inbox')).toMatchObject([{ kind: 'signal', payload: { regression: true, status: 'down' } }])
  })

  test('a job that exited 0 or never ran, and a job that is not loaded, say nothing', async () => {
    await project('r', TEST_REPO, 'signals:\n  launchd: [com.example.a, com.example.b, com.example.c]')
    const ld = setup()
    ld.say('com.example.a', FINE())
    ld.say('com.example.b', printed('not running', '(never exited)', 0))
    await ld.pass()
    expect(await rows('issues')).toEqual([])
    expect(await rows('intake_seen')).toEqual([])
    expect(ld.asked).toHaveLength(3)
    expect(logged).toHaveLength(1)
  })

  test('an up heals a pending down: nothing is filed', async () => {
    await project(
      'r',
      TEST_REPO,
      `signals:\n  launchd: [${JOB}]\nheal:\n  - {when: launchd.down, grace: 5m, runbook: make restart}`,
    )
    const ld = setup()
    ld.say(JOB, FAILED())
    await ld.pass()
    expect(await rows('issues')).toEqual([])
    expect(await rows('intake_pending')).toMatchObject([{ source: 'launchd', subject: JOB }])
    await ld.pass()
    expect(await rows('intake_pending')).toHaveLength(1)

    ld.say(JOB, FINE(4))
    await ld.pass()
    expect(await rows('intake_pending')).toEqual([])
    expect(await rows('issues')).toEqual([])
  })

  test('a job that runs again after a failure heals a pending down', async () => {
    await project('r', TEST_REPO, `signals:\n  launchd: [${JOB}]\nheal:\n  - {when: launchd.down, grace: 5m}`)
    const ld = setup()
    ld.say(JOB, FAILED())
    await ld.pass()
    expect(await rows('intake_pending')).toHaveLength(1)
    ld.say(JOB, printed('running', '1', 4))
    await ld.pass()
    expect(await rows('intake_pending')).toEqual([])
    expect(await rows('issues')).toEqual([])
  })

  test('a running job that never exited heals a pending down; with no episode it says nothing', async () => {
    await project('r', TEST_REPO, `signals:\n  launchd: [${JOB}]\nheal:\n  - {when: launchd.down, grace: 5m}`)
    const ld = setup()
    ld.say(JOB, printed('running', '(never exited)', 1))
    await ld.pass()
    expect(await rows('intake_seen')).toEqual([])
    ld.say(JOB, FAILED())
    await ld.pass()
    expect(await rows('intake_pending')).toHaveLength(1)
    ld.say(JOB, printed('running', '(never exited)', 4))
    await ld.pass()
    expect(await rows('intake_pending')).toEqual([])
    expect(await rows('issues')).toEqual([])
  })

  test('an up of an open Issue is a signal on it and closes nothing; a healthy job with no episode files nothing', async () => {
    await project('r', TEST_REPO)
    const ld = setup()
    ld.say(JOB, FINE())
    await ld.pass()
    expect(await rows('intake_seen')).toEqual([])

    ld.say(JOB, FAILED(4))
    await ld.pass()
    ld.say(JOB, FINE(5))
    await ld.pass()
    await ld.pass()
    const issues = await rows('issues')
    expect(issues).toHaveLength(1)
    expect(issues[0]?.state).not.toBe('closed')
    expect(await rows('issue_inbox')).toMatchObject([{ kind: 'signal', payload: { regression: false, status: 'up' } }])
  })

  test('a repo in IuRoot is never read', async () => {
    await project('iu', IU_REPO)
    const ld = setup()
    ld.say(JOB, FAILED())
    await ld.pass()
    expect(ld.asked).toEqual([])
    expect(await rows('issues')).toEqual([])
  })

  test('a paused project or one without signals.launchd is not read', async () => {
    await project('r', TEST_REPO, '')
    await project('s', SECOND_REPO)
    await db.sql`UPDATE factory.projects SET paused = true WHERE name = 's'`
    const ld = setup()
    ld.say(JOB, FAILED())
    await ld.pass()
    expect(ld.asked).toEqual([])
  })

  test('a label that is not a plain name is never passed to launchctl', async () => {
    await project('r', TEST_REPO, `signals:\n  launchd: ["../x", "a b", "${JOB}"]`)
    const ld = setup()
    await ld.pass()
    expect(ld.asked).toEqual([['launchctl', 'print', `gui/${UID}/${JOB}`]])
  })

  test('a runner that throws does not stop the pass', async () => {
    await project('r', TEST_REPO, 'signals:\n  launchd: [com.example.a, com.example.b]')
    const asked: string[] = []
    const intake = new LaunchdIntake({
      sql: db.sql,
      now: () => clock.now(),
      roots: [TEST_ROOT],
      uid: UID,
      everyMs: 300_000,
      run: (cmd: string[]) => {
        asked.push(cmd[2] ?? '')
        return cmd[2]?.endsWith('.a')
          ? Promise.reject(new Error('cannot execute launchctl'))
          : Promise.resolve({ exitCode: 0, stdout: FAILED() })
      },
    })
    clock.advance(300_000)
    intake.kick()
    await intake.settled()
    expect(asked).toHaveLength(2)
    expect(await rows('issues')).toMatchObject([{ source: 'launchd', facts: { monitor: 'com.example.b' } }])
  })

  test('the first pass waits 30 s, then the poll keeps its spacing', async () => {
    await project('r', TEST_REPO)
    const ld = setup()
    const kick = async () => {
      ld.intake.kick()
      await ld.intake.settled()
    }
    await kick()
    expect(ld.asked).toHaveLength(0)
    clock.advance(30_000)
    await kick()
    expect(ld.asked).toHaveLength(1)
    clock.advance(60_000)
    await kick()
    expect(ld.asked).toHaveLength(1)
    clock.advance(240_000)
    await kick()
    expect(ld.asked).toHaveLength(2)
  })
})
