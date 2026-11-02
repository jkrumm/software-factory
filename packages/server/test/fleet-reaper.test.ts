/* oxlint-disable typescript/await-thenable -- bun types the `rejects` matchers as void; they return a promise */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Fleet, Since, TriageList } from '@software-factory/contract'
import { runProcess } from '../src/exec.ts'
import { GitReader } from '../src/fleet/git.ts'
import { FleetBuilder } from '../src/fleet/index.ts'
import { HcError, type HcClient } from '../src/hc.ts'
import { Places } from '../src/fleet/place.ts'
import type { SinceReader } from '../src/fleet/since.ts'
import { type HcCloser, type HcLister, type HcTerminal, HcTerminals, NotClosed } from '../src/fleet/sources.ts'
import { createIssue } from '../src/issues/create.ts'
import { loadMorning } from '../src/notify/digest.ts'
import { startApp, TEST_TOKEN, type TestApp } from './support/app.ts'
import { FakeClock } from './support/clock.ts'
import { startTestDb, type TestDb } from './support/pg.ts'
import { world } from './support/world.ts'

const NOW = new Date('2026-11-02T12:00:00.000Z')
const HOUR = 3_600_000

let db: TestDb
let tmp: string
let src: string
let iu: string
let clock: FakeClock
let app: TestApp
let w: ReturnType<typeof world>
let terminals: HcTerminal[]
let hcFails: boolean
let processes: string[][]
let closer: FakeCloser
/** runs once after the first `git status --porcelain` of a worktree: the world moves between the judging and the close */
let afterFirstStatus: (() => void) | undefined
let n = 0

class FakeCloser implements HcCloser {
  calls: { address: string; cwd: string }[] = []
  /** each close takes the next one: an error is thrown with the terminal untouched, `partial` kills it and then throws */
  failures: (Error | 'partial')[] = []
  finished: string[] = []
  /** the list hc answers keeps the terminal (a stale listing) */
  keepListed = false

  async close(target: { address: string; cwd: string }): Promise<void> {
    const failure = this.failures.shift()
    if (failure === 'partial') {
      terminals = terminals.filter((t) => t.address !== target.address)
      throw new Error('hc rm timed out after the kill')
    }
    if (failure) throw failure
    this.calls.push(target)
    if (!this.keepListed) terminals = terminals.filter((t) => t.address !== target.address)
  }

  async finish(address: string): Promise<'gone' | 'live'> {
    this.finished.push(address)
    return terminals.some((t) => t.address === address) ? 'live' : 'gone'
  }
}

const hc: HcLister = {
  list: async () => {
    if (hcFails) throw new Error('hc is down')
    return terminals
  },
}

beforeAll(async () => {
  db = await startTestDb()
  tmp = realpathSync(mkdtempSync('/tmp/factory-reaper-'))
  src = join(tmp, 'src')
  iu = join(tmp, 'IuRoot')
  mkdirSync(src)
  mkdirSync(iu)
})
afterAll(async () => {
  await app?.stop()
  rmSync(tmp, { recursive: true, force: true })
  await db.stop()
})

function git(cwd: string, args: string[]): string {
  const run = Bun.spawnSync(
    ['git', '-c', 'user.name=test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false', ...args],
    {
      cwd,
      env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' },
      stderr: 'pipe',
      stdout: 'pipe',
    },
  )
  if (run.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${run.stderr.toString()}`)
  return run.stdout.toString().trim()
}

function commit(dir: string, file: string, text: string): void {
  writeFileSync(join(dir, file), text)
  git(dir, ['add', '-A'])
  git(dir, ['commit', '-q', '-m', `${file}: ${text}`])
}

/** A repo on `master` with one commit, in `root`. */
function repo(root: string, name: string): string {
  const path = join(root, name)
  mkdirSync(path)
  git(path, ['init', '-q', '-b', 'master'])
  commit(path, 'README.md', `${name}\n`)
  return path
}

/** A worktree `<repo>/.claude/worktrees/<name>` on a new branch of that name, and the commits it holds in the way asked for. */
function worktree(
  main: string,
  name: string,
  how: 'none' | 'merged' | 'squash' | 'cherry' | 'unmerged' = 'merged',
): string {
  const path = join(main, '.claude', 'worktrees', name)
  git(main, ['worktree', 'add', '-q', '-b', name, path])
  if (how === 'none') return path
  commit(path, `${name}-a.txt`, 'a\n')
  commit(path, `${name}-b.txt`, 'b\n')
  if (how === 'merged') git(main, ['merge', '-q', '--no-ff', '-m', `merge ${name}`, name])
  if (how === 'squash') {
    git(main, ['merge', '-q', '--squash', name])
    git(main, ['commit', '-q', '-m', `squash ${name}`])
  }
  if (how === 'cherry') {
    // A commit of its own first: a pick onto the very parent would make the same commit.
    commit(main, `${name}-other.txt`, 'other\n')
    git(main, ['cherry-pick', `${name}~1`, name])
  }
  return path
}

function terminal(
  name: string,
  cwd: string,
  options: { idleHours?: number; status?: string; parent?: string } = {},
): HcTerminal {
  return {
    address: `t${++n}`,
    name,
    cwd,
    title: name,
    factoryKey: null,
    status: options.status ?? 'idle',
    statusMessage: null,
    statusAt: new Date(NOW.getTime() - (options.idleHours ?? 3) * HOUR).toISOString(),
    parent: options.parent ?? null,
    claude: true,
    prompt: null,
    role: 'worker',
    account: null,
  }
}

let current: FleetBuilder

async function setup(mode: 'on' | 'dry' | 'off'): Promise<FleetBuilder> {
  await app?.stop()
  const run: typeof runProcess = async (cmd, ...rest) => {
    processes.push(cmd)
    const done = await runProcess(cmd, ...rest)
    if (cmd.includes('--porcelain') && cmd.join(' ').includes('worktrees') && afterFirstStatus) {
      const hook = afterFirstStatus
      afterFirstStatus = undefined
      hook()
    }
    return done
  }
  const places = await Places.of({ visibleRoots: [iu], configured: [src], home: tmp })
  const reader: SinceReader = {
    sql: db.sql,
    now: () => clock.now(),
    visible: async () => (path) => places.isVisible(path),
  }
  current = new FleetBuilder({
    sql: db.sql,
    now: () => clock.now(),
    roots: [src],
    visibleRoots: [iu],
    home: tmp,
    hc,
    queue: { list: async () => [] },
    git: new GitReader(run),
    reaper: { mode, closer },
  })
  app = startApp({ sql: db.sql, clock, fleet: current, repoRoots: [src], since: reader })
  return current
}

beforeEach(async () => {
  await db.reset()
  clock = new FakeClock(NOW)
  w = world(db.sql, clock)
  terminals = []
  hcFails = false
  processes = []
  afterFirstStatus = undefined
  closer = new FakeCloser()
})

/** The worktree sessions of the scene, one repo each, so tests never see each other's branches. */
let sceneRepo = 0
const freshRepo = (root = src) => repo(root, `proj${++sceneRepo}`)

async function reap(mode: 'on' | 'dry' | 'off' = 'on'): Promise<Fleet> {
  const builder = await setup(mode)
  return Fleet.parse(await builder.refreshNow())
}

const reapedRows = () => db.sql`SELECT * FROM factory.fleet_triage_log WHERE kind = 'reaped' ORDER BY id`

describe('the reaper closes', () => {
  test('a merged, clean worktree session idle for 2 h: hc kill and rm, one log row, gone from the model', async () => {
    const main = freshRepo()
    const wt = worktree(main, 'feat-merged', 'merged')
    const session = terminal('feat-merged', wt)
    terminals = [session]
    const model = await reap('on')

    expect(closer.calls).toEqual([{ address: session.address, cwd: wt }])
    expect(model.reaper.mode).toBe('on')
    expect(model.reaper.closed).toHaveLength(1)
    const [line] = model.reaper.closed
    expect(line).toMatchObject({ session: 'feat-merged', repo: expect.stringMatching(/^proj\d+$/), dry: false })
    expect(line?.evidence).toContain('idle since 2026-11-02T09:00:00.000Z')
    expect(line?.evidence).toContain('is in master')
    expect(line?.evidence).toContain('no parent')
    expect(line?.why).toContain('Not undoable')
    expect(model.repos.flatMap((r) => r.sessions).map((s) => s.id)).not.toContain('feat-merged')
    expect(await reapedRows()).toHaveLength(1)
  })

  test('a squash merge is merged by content, a cherry-pick by its patches', async () => {
    const a = worktree(freshRepo(), 'feat-squash', 'squash')
    const b = worktree(freshRepo(), 'feat-cherry', 'cherry')
    terminals = [terminal('feat-squash', a), terminal('feat-cherry', b)]
    const model = await reap('on')
    expect(model.reaper.closed.map((c) => c.session).sort()).toEqual(['feat-cherry', 'feat-squash'])
    const proofs = model.reaper.closed.map((c) => c.evidence)
    expect(proofs.some((p) => p.includes('tree equals'))).toBe(true)
    expect(proofs.some((p) => p.includes('equal patch'))).toBe(true)
  })

  test('a replayed pass closes nothing twice; a stale listing writes no second log row', async () => {
    const wt = worktree(freshRepo(), 'feat-once', 'merged')
    terminals = [terminal('feat-once', wt)]
    const builder = await setup('on')
    await builder.refreshNow()
    await builder.refreshNow()
    expect(closer.calls).toHaveLength(1)
    expect(await reapedRows()).toHaveLength(1)

    // hc lists the terminal again (a stale answer): the key is the same, so the log has still one row.
    await db.reset()
    closer = new FakeCloser()
    closer.keepListed = true
    const wt2 = worktree(freshRepo(), 'feat-twice', 'merged')
    terminals = [terminal('feat-twice', wt2)]
    const again = await setup('on')
    await again.refreshNow()
    await again.refreshNow()
    expect((await reapedRows()).length).toBe(1)
  })

  test('hc failing in a build: nothing is closed from the last listing', async () => {
    const wt = worktree(freshRepo(), 'feat-late', 'merged')
    const builder = await setup('dry')
    terminals = [terminal('feat-late', wt)]
    await builder.refreshNow()
    hcFails = true
    const model = Fleet.parse(await builder.refreshNow())
    expect(model.errors.some((e) => e.startsWith('hc:'))).toBe(true)
    expect(closer.calls).toHaveLength(0)
  })

  test('a parent that is not waiting on workers, or is gone, does not hold it', async () => {
    const main = freshRepo()
    const idleParent = terminal('boss-idle', main)
    const a = terminal('child-a', worktree(main, 'child-a'), { parent: idleParent.address })
    const b = terminal('child-b', worktree(main, 'child-b'), { parent: 't999' })
    terminals = [idleParent, a, b]
    const model = await reap('on')
    expect(model.reaper.closed.map((c) => c.session).sort()).toEqual(['child-a', 'child-b'])
    const gone = model.reaper.closed.find((c) => c.session === 'child-b')
    expect(gone?.evidence).toContain('parent t999 is gone')
  })

  test('a worktree that turns dirty between the judging and the close is not closed', async () => {
    const wt = worktree(freshRepo(), 'feat-late-dirty', 'merged')
    terminals = [terminal('feat-late-dirty', wt)]
    afterFirstStatus = () => writeFileSync(join(wt, 'late.txt'), 'someone is working here\n')
    const model = await reap('on')
    expect(closer.calls).toHaveLength(0)
    expect(model.errors.some((e) => e.includes('feat-late-dirty') && e.includes('uncommitted or untracked'))).toBe(true)
    expect(await reapedRows()).toHaveLength(0)
  })

  test('at most 5 closes a pass: the rest wait for the next', async () => {
    const main = freshRepo()
    terminals = Array.from({ length: 7 }, (_, i) =>
      terminal(`many-${i}`, worktree(main, `many-${i}`), { idleHours: 3 + i }),
    )
    const builder = await setup('on')
    await builder.refreshNow()
    expect(closer.calls).toHaveLength(5)
    await builder.refreshNow()
    expect(closer.calls).toHaveLength(7)
  })

  test('a close that did nothing takes its row back and is tried again at the next pass', async () => {
    const wt = worktree(freshRepo(), 'feat-retry', 'merged')
    terminals = [terminal('feat-retry', wt)]
    closer.failures = [new NotClosed('refused')]
    const builder = await setup('on')
    const first = Fleet.parse(await builder.refreshNow())
    expect(first.errors.some((e) => e.includes('feat-retry') && e.includes('refused'))).toBe(true)
    expect(closer.calls).toHaveLength(0)
    expect(first.reaper.closed).toHaveLength(0)
    expect(await reapedRows()).toHaveLength(0)
    const second = Fleet.parse(await builder.refreshNow())
    expect(closer.calls).toHaveLength(1)
    expect(second.errors.some((e) => e.includes('reaper:'))).toBe(false)
    expect(await reapedRows()).toHaveLength(1)
  })

  test('a close that failed on an unknown footing keeps its row unsettled; the next pass finds the terminal still running and takes it back', async () => {
    const wt = worktree(freshRepo(), 'feat-unsure', 'merged')
    terminals = [terminal('feat-unsure', wt)]
    closer.failures = [new Error('hc timed out')]
    const builder = await setup('on')
    const first = Fleet.parse(await builder.refreshNow())
    expect(first.errors.some((e) => e.includes('hc timed out'))).toBe(true)
    expect(first.reaper.closed).toHaveLength(0)
    expect((await reapedRows()).map((r: { payload: { state?: string } }) => r.payload.state)).toEqual(['closing'])
    expect(
      (await Since.parse(await (await app.get(`/fleet/since?t=${NOW.toISOString()}`)).json())).handled,
    ).toHaveLength(0)
    const second = Fleet.parse(await builder.refreshNow())
    expect(closer.finished).toHaveLength(1)
    expect(closer.calls).toHaveLength(1)
    expect(second.reaper.closed).toHaveLength(1)
    const rows = await reapedRows()
    expect(rows).toHaveLength(1)
    expect(rows[0]?.payload.state).toBeUndefined()
  })

  test('a kill that worked and a rm that failed: the next pass settles the row as closed, once', async () => {
    const wt = worktree(freshRepo(), 'feat-half', 'merged')
    terminals = [terminal('feat-half', wt)]
    closer.failures = ['partial']
    const builder = await setup('on')
    const first = Fleet.parse(await builder.refreshNow())
    expect(first.reaper.closed).toHaveLength(0)
    const second = Fleet.parse(await builder.refreshNow())
    expect(second.reaper.closed).toHaveLength(1)
    expect(second.reaper.closed[0]).toMatchObject({ session: 'feat-half', dry: false })
    const rows = await reapedRows()
    expect(rows).toHaveLength(1)
    expect(rows[0]?.payload.state).toBeUndefined()
    expect(closer.calls).toHaveLength(0)
  })

  test('a row left by a crash before the close, with the terminal still running, is taken back and the close is made', async () => {
    const wt = worktree(freshRepo(), 'feat-crash', 'merged')
    const session = terminal('feat-crash', wt)
    terminals = [session]
    await db.sql`
      INSERT INTO factory.fleet_triage_log (kind, subject, fingerprint, what, why, evidence, payload, at)
      VALUES ('reaped', ${wt}, 'stale-incarnation', 'Closed feat-crash', 'x', 'y',
              ${JSON.stringify({ session: 'feat-crash', address: session.address, state: 'closing' })}::text::jsonb, ${clock.now()})`
    const model = await reap('on')
    expect(closer.finished).toEqual([session.address])
    expect(closer.calls).toHaveLength(1)
    expect(model.reaper.closed).toHaveLength(1)
    expect(await reapedRows()).toHaveLength(1)
  })
})

describe('each guard alone keeps a session', () => {
  async function kept(setupScene: () => void, mode: 'on' | 'dry' = 'on'): Promise<Fleet> {
    setupScene()
    const model = await reap(mode)
    expect(closer.calls).toHaveLength(0)
    expect(model.reaper.closed).toHaveLength(0)
    return model
  }

  test('the control: the same scene with no defect closes', async () => {
    terminals = [terminal('control', worktree(freshRepo(), 'control'))]
    const model = await reap('on')
    expect(model.reaper.closed).toHaveLength(1)
  })

  test("a repo's main checkout", async () => {
    const model = await kept(() => {
      terminals = [terminal('in-main', freshRepo())]
    })
    expect(model.reaper.kept).toEqual([])
  })

  test('IuRoot: shown, never acted on, not even listed', async () => {
    const model = await kept(() => {
      terminals = [terminal('iu-session', worktree(repo(iu, `iurepo${++sceneRepo}`), 'iu-wt'))]
    })
    expect(model.reaper.kept).toEqual([])
    expect(processes.some((p) => p.join(' ').includes(`${iu}/`) && p.join(' ').includes('worktrees'))).toBe(false)
  })

  test('a session of an open Issue', async () => {
    const main = freshRepo()
    const wt = worktree(main, 'lead-wt')
    await w.spawned('issue-lead', { repo: wt, role: 'lead', startedMinutesAgo: 500 })
    await w.emit('issue-lead', 'turn_started', w.at(300))
    await w.emit('issue-lead', 'turn_ended', w.at(200))
    const { issue } = await createIssue(
      db.sql,
      { source: 'request', sourceKey: 'q', repo: main, title: 'An Issue', facts: {} },
      { repoRoots: [src], now: clock.now() },
    )
    await db.sql`UPDATE factory.sessions SET issue_id = ${issue.id} WHERE id = 'issue-lead'`
    terminals = [terminal('issue-lead', wt)]
    const model = await reap('on')
    expect(closer.calls).toHaveLength(0)
    expect(model.reaper.kept).toEqual([])

    // The same Issue closed: the session is no longer an Issue's.
    await db.sql`UPDATE factory.issues SET state = 'closed', closed_at = now(), outcome = 'done' WHERE id = ${issue.id}`
    const after = await reap('on')
    expect(after.reaper.closed.map((c) => c.session)).toEqual(['issue-lead'])
  })

  test('a worktree an open Issue holds (the lead worktree), whoever sits in it', async () => {
    const main = freshRepo()
    const wt = worktree(main, 'held-wt')
    const { issue } = await createIssue(
      db.sql,
      { source: 'request', sourceKey: 'q2', repo: main, title: 'Another Issue', facts: {} },
      { repoRoots: [src], now: clock.now() },
    )
    await db.sql`
      INSERT INTO factory.lead_worktrees (issue_id, attempt, status, path, first_at, next_at)
      VALUES (${issue.id}, 1, 'made', ${wt}, ${clock.now()}, ${clock.now()})`
    terminals = [terminal('a-worker', wt)]
    await reap('on')
    expect(closer.calls).toHaveLength(0)
  })

  test('idle 1 h', async () => {
    const model = await kept(() => {
      terminals = [terminal('fresh', worktree(freshRepo(), 'fresh'), { idleHours: 1 })]
    })
    expect(model.reaper.kept).toEqual([])
  })

  test('working, or blocked, in hc', async () => {
    await kept(() => {
      const main = freshRepo()
      terminals = [
        terminal('busy', worktree(main, 'busy'), { status: 'working' }),
        terminal('stuck-dialog', worktree(main, 'stuck-dialog'), { status: 'blocked' }),
      ]
    })
  })

  test('a dirty worktree is kept and listed', async () => {
    const model = await kept(() => {
      const wt = worktree(freshRepo(), 'dirty')
      writeFileSync(join(wt, 'dirty-a.txt'), 'changed\n')
      terminals = [terminal('dirty', wt)]
    })
    expect(model.reaper.kept).toHaveLength(1)
    expect(model.reaper.kept[0]).toMatchObject({ session: 'dirty' })
    expect(model.reaper.kept[0]?.why).toContain('uncommitted or untracked')
  })

  test('an untracked file alone is enough', async () => {
    const model = await kept(() => {
      const wt = worktree(freshRepo(), 'untracked')
      writeFileSync(join(wt, 'notes.txt'), 'not added\n')
      terminals = [terminal('untracked', wt)]
    })
    expect(model.reaper.kept[0]?.why).toContain('1 uncommitted or untracked entry')
  })

  test('an unmerged branch is kept and listed', async () => {
    const model = await kept(() => {
      terminals = [terminal('unmerged', worktree(freshRepo(), 'unmerged', 'unmerged'))]
    })
    expect(model.reaper.kept).toHaveLength(1)
    expect(model.reaper.kept[0]?.why).toContain('is unmerged')
    expect(model.reaper.kept[0]?.why).toContain('2 commit(s) the default branch lacks')
  })

  test('a parent waiting on workers', async () => {
    const main = freshRepo()
    await w.spawned('boss', { repo: main, role: 'lead', startedMinutesAgo: 500 })
    await w.emit('boss', 'turn_started', w.at(400))
    await w.emit('boss', 'wait_declared', w.at(390), { on: 'workers' })
    await w.emit('boss', 'turn_ended', w.at(389))
    const boss = terminal('boss', main, { idleHours: 6 })
    terminals = [boss, terminal('child', worktree(main, 'child'), { parent: boss.address })]
    const model = await reap('on')
    expect(closer.calls).toHaveLength(0)
    expect(model.reaper.kept).toEqual([])
  })

  test('a parent waiting for something else (the owner) does not hold it', async () => {
    const main = freshRepo()
    await w.spawned('boss2', { repo: main, role: 'lead', startedMinutesAgo: 500 })
    await w.emit('boss2', 'turn_started', w.at(400))
    await w.emit('boss2', 'wait_declared', w.at(390), { on: 'owner' })
    await w.emit('boss2', 'turn_ended', w.at(389))
    const boss = terminal('boss2', main, { idleHours: 6 })
    terminals = [boss, terminal('child2', worktree(main, 'child2'), { parent: boss.address })]
    const model = await reap('on')
    expect(model.reaper.closed.map((c) => c.session)).toEqual(['child2'])
  })

  test('a session outside every root', async () => {
    const outside = join(tmp, 'elsewhere')
    mkdirSync(outside)
    const main = repo(outside, 'foreign')
    await kept(() => {
      terminals = [terminal('foreign-session', worktree(main, 'foreign-wt'))]
    })
  })
})

describe('the switch', () => {
  test('dry lists what it would close, marked dry, and closes and writes nothing', async () => {
    terminals = [terminal('feat-dry', worktree(freshRepo(), 'feat-dry'))]
    const model = await reap('dry')
    expect(model.reaper.mode).toBe('dry')
    expect(model.reaper.closed).toHaveLength(1)
    expect(model.reaper.closed[0]).toMatchObject({ session: 'feat-dry', dry: true, at: null, logId: null })
    expect(model.reaper.closed[0]?.what).toStartWith('Would close')
    expect(closer.calls).toHaveLength(0)
    expect(await reapedRows()).toHaveLength(0)
    expect(model.repos.flatMap((r) => r.sessions).map((s) => s.id)).toContain('feat-dry')
  })

  test('off reads nothing: no git in a worktree, no close, an empty part', async () => {
    terminals = [terminal('feat-off', worktree(freshRepo(), 'feat-off'))]
    processes = []
    const model = await reap('off')
    expect(model.reaper).toEqual({ mode: 'off', closed: [], kept: [] })
    expect(closer.calls).toHaveLength(0)
    expect(processes.some((p) => p.join(' ').includes('.claude/worktrees'))).toBe(false)
  })
})

describe('the log and the readings', () => {
  test('a close shows under Handled for you, not undoable, and in the morning reading as one line', async () => {
    const main = freshRepo()
    terminals = [terminal('feat-seen', worktree(main, 'feat-seen'))]
    await reap('on')

    const log = TriageList.parse(await (await app.get('/fleet/triage')).json())
    const entry = log.entries.find((e) => e.kind === 'reaped')
    expect(entry).toBeDefined()
    expect(entry?.what).toContain('feat-seen')

    const undo = await app.send('POST', `/fleet/triage/${entry?.id}/undo`, {})
    expect(undo.status).toBe(409)
    expect(await undo.json()).toMatchObject({ code: 'not_undoable' })
    expect((await reapedRows())[0]?.undone_at).toBeNull()

    clock.advance(60_000)
    const since = Since.parse(
      await (
        await app.get(`/fleet/since?t=${encodeURIComponent(new Date(NOW.getTime() - HOUR).toISOString())}`)
      ).json(),
    )
    const handled = since.handled.filter((h) => h.kind === 'reaped')
    expect(handled).toHaveLength(1)
    expect(handled[0]).toMatchObject({ undoId: null, visible: false, source: `fleet_triage_log:${entry?.id}` })

    const morning = await loadMorning(db.sql, { now: clock.now(), date: '2026-11-02', isVisible: () => false })
    expect(morning).toContain('Closed for you: 1 finished worker session (the worktrees stay)')
  })

  test('the token API carries the part; a snapshot an older release stored reads as off', async () => {
    terminals = []
    await reap('dry')
    const res = await fetch(new URL('/fleet', app.url), { headers: { authorization: `Bearer ${TEST_TOKEN}` } })
    expect(Fleet.parse(await res.json()).reaper.mode).toBe('dry')
    const stored = (await (await app.get('/fleet')).json()) as Record<string, unknown>
    const old = Fleet.parse({ ...stored, reaper: undefined })
    expect(old.reaper).toEqual({ mode: 'off', closed: [], kept: [] })
  })
})

describe('HcTerminals.close', () => {
  type Reply = { result: unknown } | { refuse: string }
  function client(replies: Record<string, Reply>) {
    const calls: string[] = []
    const fake = {
      call: async (method: string) => {
        calls.push(method)
        const reply = replies[method]
        if (!reply) throw new Error(`unexpected ${method}`)
        if ('refuse' in reply) throw new HcError(`hc ${method}: ${reply.refuse}`, { kind: reply.refuse })
        return reply.result
      },
    }
    return { calls, closer: new HcTerminals(fake as unknown as HcClient) }
  }
  const live = (status = 'idle', cwd = '/w') => ({ address: 't1', state: 'live', cwd, status: { state: status } })

  test('kills and removes a terminal that is still where the build saw it', async () => {
    const { calls, closer } = client({
      'terminal.get': { result: live() },
      'terminal.kill': { result: {} },
      'terminal.rm': { result: {} },
    })
    await closer.close({ address: 't1', cwd: '/w' })
    expect(calls).toEqual(['terminal.get', 'terminal.kill', 'terminal.rm'])
  })

  test('a terminal that works again, or sits elsewhere, is not touched', async () => {
    for (const seen of [live('working'), live('blocked'), live('idle', '/elsewhere')]) {
      const { calls, closer } = client({ 'terminal.get': { result: seen } })
      await expect(closer.close({ address: 't1', cwd: '/w' })).rejects.toThrow('not closed')
      expect(calls).toEqual(['terminal.get'])
    }
  })

  test('finish: gone when not found, removed when finished, live when it runs', async () => {
    const gone = client({ 'terminal.get': { refuse: 'not_found' } })
    expect(await gone.closer.finish('t1')).toBe('gone')
    const dead = client({ 'terminal.get': { result: { ...live(), state: 'finished' } }, 'terminal.rm': { result: {} } })
    expect(await dead.closer.finish('t1')).toBe('gone')
    expect(dead.calls).toEqual(['terminal.get', 'terminal.rm'])
    const running = client({ 'terminal.get': { result: live() } })
    expect(await running.closer.finish('t1')).toBe('live')
    expect(running.calls).toEqual(['terminal.get'])
  })

  test('a kill the core refused leaves it running: no rm, an error', async () => {
    const { calls, closer } = client({
      'terminal.get': { result: live() },
      'terminal.kill': { refuse: 'blocked' },
      'terminal.rm': { result: {} },
    })
    await expect(closer.close({ address: 't1', cwd: '/w' })).rejects.toThrow('blocked')
    expect(calls).toEqual(['terminal.get', 'terminal.kill'])
  })

  test('already finished is removed; already gone is done', async () => {
    const finished = client({
      'terminal.get': { result: live() },
      'terminal.kill': { refuse: 'finished' },
      'terminal.rm': { result: {} },
    })
    await finished.closer.close({ address: 't1', cwd: '/w' })
    expect(finished.calls).toEqual(['terminal.get', 'terminal.kill', 'terminal.rm'])
    const gone = client({ 'terminal.get': { refuse: 'not_found' } })
    await gone.closer.close({ address: 't1', cwd: '/w' })
    expect(gone.calls).toEqual(['terminal.get'])
  })
})
