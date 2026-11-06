/* oxlint-disable typescript/await-thenable -- bun types the `rejects` matchers as void; they return a promise */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  DEFAULT_HOLD_MS,
  defaultManifest,
  IssueEvidenceAck,
  type ProjectManifest,
  Spawn,
} from '@software-factory/contract'
import { serveHooks } from '../src/http.ts'
import { FileTranscripts } from '../src/issues/archive.ts'
import { Classification } from '../src/issues/classify.ts'
import { type CommitRead, type Commits, GitCommits } from '../src/issues/commits.ts'
import { createIssue } from '../src/issues/create.ts'
import { runProcess } from '../src/exec.ts'
import { type Effect, type EffectPorts, runEffects, Waiting } from '../src/issues/effects.ts'
import { branchOnBase } from '../src/issues/origin.ts'
import { GitWorktrees } from '../src/issues/worktree.ts'
import { FakeReview } from './support/review.ts'
import { healthLines } from '../src/health.ts'
import { kindOfPath, requiredEvidence } from '../src/issues/evidence.ts'
import { finalizePorts } from '../src/issues/finalize.ts'
import {
  type HoldCheck,
  CHECKOUT_RECHECK_MS,
  holdPorts,
  MakeAndProbes,
  NO_TARGET_LINE,
  type Proof,
  VERIFY_SETTLE_MS,
} from '../src/issues/hold.ts'
import { enqueue } from '../src/issues/inbox.ts'
import { leadPorts } from '../src/issues/lead.ts'
import { WorktreeMaker } from '../src/issues/leadtree.ts'
import { REOPEN_WINDOW_MS } from '../src/issues/lifecycle.ts'
import { leadKey, regressionPromptId } from '../src/issues/names.ts'
import { OffTick } from '../src/issues/offtick.ts'
import { issuePass } from '../src/issues/worker.ts'
import { notifyFailures } from '../src/notify/rules.ts'
import { ProjectSync } from '../src/projects/sync.ts'
import { QuotaPoller } from '../src/quota.ts'
import type { StartInput, StartResult } from '../src/runner.ts'
import { type EventKind, openSession, recordEvent } from '../src/sessions.ts'
import { tick } from '../src/tick.ts'
import { startApp, TEST_ROLES, TEST_TOKEN, type TestApp } from './support/app.ts'
import { FakeClassifier } from './support/classifier.ts'
import { FakeClock } from './support/clock.ts'
import { startTestDb, type TestDb } from './support/pg.ts'
import { FakeQuotaSource, usage } from './support/quota.ts'
import { repoRoot } from './support/repos.ts'
import { FakeRunner } from './support/world.ts'
import { FakeWorktrees } from './support/worktree.ts'

const SHA = 'a'.repeat(40)
const newJobs = (limit?: number) => new OffTick({ limit, now: () => clock.now().getTime() })
const SERVICE = `apiVersion: factory/v2
name: NAME
deploy:
  mode: make
  hold: 45m
  migrations: [db/]
  probes:
    - { name: home, http: 'http://127.0.0.1:9/', expect: 200 }
`

class PaneRunner extends FakeRunner {
  panes = 0
  override async start(input: StartInput): Promise<StartResult> {
    await super.start(input)
    return { session: `t${++this.panes}`, tab: null, workspace: 'w1' }
  }
}

/** Commits as a test says they are: what they touched, and when the merge was. */
class FakeCommits implements Commits {
  paths: string[] = ['src/server.ts']
  mergedAt: Date | null = null
  branch: string[] = []
  failure?: Error
  calls = 0
  /** what a short sha or a name resolves to, as git does */
  resolves: Record<string, string> = {}
  /** origin/<default> as the ship found it */
  landedAt: string | null = 'f'.repeat(40)
  async read({ reported }: { reported: readonly string[] }): Promise<CommitRead> {
    this.calls++
    if (this.failure) throw this.failure
    const full = reported.map((sha) => this.resolves[sha] ?? sha)
    return { landedAt: this.landedAt, commits: [...full, ...this.branch], paths: this.paths, mergedAt: this.mergedAt }
  }
}

class FakeProof implements Proof {
  checks: HoldCheck[] = [{ name: 'make verify', ok: true, detail: 'exit 0' }]
  runs = 0
  async run(): Promise<HoldCheck[]> {
    this.runs++
    return this.checks
  }
}

const fixture = repoRoot('factory-evidence-')
let db: TestDb
let clock: FakeClock
let app: TestApp
let commits: FakeCommits
let review: FakeReview
let proof: FakeProof
let worktrees: FakeWorktrees
let maker: WorktreeMaker
let runner: PaneRunner
let offTick: OffTick
let classification: Classification
let sync: ProjectSync
let archive: string
let copied: string[]
let n = 0
let repos = 0

beforeAll(async () => {
  db = await startTestDb()
})
afterAll(async () => {
  await db.stop()
  fixture.cleanup()
})
beforeEach(async () => {
  await db.reset()
  clock = new FakeClock()
  n = 0
  const source = new FakeQuotaSource()
  source.readings = ['a', 'b'].map((account) => ({
    account,
    ...usage(1, 1, new Date(clock.now().getTime() + 1_000 * 3_600_000)),
  }))
  await new QuotaPoller({ sql: db.sql, clock, source }).poll()
  commits = new FakeCommits()
  review = new FakeReview()
  proof = new FakeProof()
  worktrees = new FakeWorktrees()
  maker = new WorktreeMaker({ sql: db.sql, worktrees, now: () => clock.now() })
  runner = new PaneRunner()
  offTick = newJobs()
  classification = new Classification({
    sql: db.sql,
    classifier: new FakeClassifier(),
    roles: TEST_ROLES,
    now: () => clock.now(),
  })
  // One full pass per test: this file's clock jumps, and the fixture's repos add up.
  sync = new ProjectSync({ sql: db.sql, roots: [fixture.root], now: () => clock.now(), intervalMs: 3_650 * 86_400_000 })
  archive = mkdtempSync('/tmp/factory-archive-')
  copied = []
  await app?.stop()
  app = startApp({ sql: db.sql, clock, commits, review, repoRoots: [fixture.root] })
})

const ports = (): EffectPorts => ({
  ...leadPorts({ sql: db.sql, clock, roles: TEST_ROLES, repoRoots: [fixture.root] }),
  ...holdPorts({ sql: db.sql, clock, proof, offTick }),
  ...finalizePorts({
    sql: db.sql,
    clock,
    runner,
    worktrees,
    transcripts: {
      copy: async (input) => {
        copied.push(input.to)
        return true
      },
    },
    archiveDir: archive,
    projectsDir: async () => '/projects',
    making: (id) => maker.busy(id),
    offTick,
  }),
})

async function pass() {
  const result = await tick({
    sql: db.sql,
    clock,
    runner,
    issuePorts: ports(),
    classification,
    leadWorktrees: maker,
    projects: sync,
  })
  await classification.settled()
  await maker.settled()
  await offTick.settled()
  clock.advance(5_000)
  return result
}
const drive = async (passes = 4) => {
  for (let i = 0; i < passes; i++) await pass()
}

const newRepo = (manifest?: string) => {
  const name = `repo${++repos}`
  return fixture.repo(name, manifest ? { 'project.yaml': manifest.replace('NAME', name) } : {})
}

async function file(repo: string): Promise<number> {
  const { issue } = await createIssue(
    db.sql,
    { source: 'request', sourceKey: `k${++n}`, repo, title: 'the title', facts: {} },
    { repoRoots: [fixture.root], now: clock.now() },
  )
  return issue.id
}

/** An Issue with its lead started and its session reporting. */
async function lead(repo = newRepo(SERVICE)) {
  const id = await file(repo)
  await drive(4)
  const key = leadKey(id, 1)
  await emit(key, 'session_started', { claudeSessionId: `claude-${id}`, transcriptPath: `/tmp/t/claude-${id}.jsonl` })
  return { id, key, repo }
}

const moveTo = (at: Date) => clock.advance(at.getTime() - clock.now().getTime())

let events = 0
const emit = (session: string, kind: EventKind, payload?: Record<string, unknown>, at: Date = clock.now()) =>
  recordEvent(db.sql, { key: `e${++events}`, session, kind, at, payload })

const post = (id: number, verb: string, body: Record<string, unknown> = {}) =>
  app.send('POST', `/issues/${id}/${verb}`, body)
const ship = (id: number, key: string, extra: Record<string, unknown> = {}) =>
  post(id, 'ship', { summary: 'shipped', commits: [SHA], session: key, ...extra })
const prove = (id: number, key: string, kind: string) =>
  post(id, 'evidence', { kind, link: 'https://example.com/proof', session: key })

const issue = async (id: number) => {
  const [row] = await db.sql`SELECT * FROM factory.issues WHERE id = ${id}`
  return row as Record<string, unknown> & { state: string; wake_at: Date | null; attempt: number; hold: number }
}
const trail = async (id: number): Promise<string[]> => {
  const rows: { kind: string; from_state: string | null; to_state: string | null }[] = await db.sql`
    SELECT kind, from_state, to_state FROM factory.issue_events WHERE issue_id = ${id} ORDER BY id`
  return rows.map((r) => (r.to_state ? `${r.kind} ${r.from_state ?? '-'}→${r.to_state}` : r.kind))
}
const evidence = (id: number): Promise<{ kind: string; link: string | null; payload: unknown }[]> =>
  db.sql`SELECT kind, link, payload FROM factory.evidence WHERE issue_id = ${id} ORDER BY id`
const notes = (key: string): Promise<{ id: string; text: string }[]> =>
  db.sql`SELECT id, text FROM factory.prompts WHERE source = 'note' AND session = ${key} ORDER BY created_at`

/** What a watching Issue needs: the commits touch a service, the evidence is on record. */
async function shipped() {
  const made = await lead()
  await prove(made.id, made.key, 'service')
  expect((await ship(made.id, made.key)).status).toBe(201)
  return made
}

async function holdEnds(id: number) {
  const { wake_at: wake } = await issue(id)
  if (!wake) throw new Error('no hold is running')
  moveTo(wake)
  await drive(4)
}

/** A red check retries 1, 2 and 4 minutes after each red: the clock goes past each due time and the passes run. */
async function retriesEnd(until = 3) {
  for (const minutes of [1, 2, 4].slice(0, until)) {
    clock.advance(minutes * 60_000)
    await drive(4)
  }
}

describe('what a change requires', () => {
  const manifest = (over: Partial<ProjectManifest['deploy']> = {}): ProjectManifest => {
    const base = defaultManifest('x')
    return { ...base, deploy: { ...base.deploy, mode: 'make', ...over } }
  }

  test.each([
    ['src/server.ts', 'service'],
    ['packages/server/src/http.ts', 'service'],
    ['apps/web/src/App.tsx', 'ui'],
    ['styles/main.css', 'ui'],
    ['deploy/app.plist.template', 'infra'],
    ['Makefile', 'infra'],
    ['packages/a/Dockerfile', 'infra'],
    ['.github/workflows/ci.yml', 'infra'],
    ['project.yaml', 'infra'],
    ['docs/design.md', null],
    ['README.md', null],
    ['packages/server/test/a.test.ts', null],
    ['src/a.test.tsx', null],
  ])('%s asks for %s', (path, kind) => {
    expect(kindOfPath(path, manifest())).toBe(kind as ReturnType<typeof kindOfPath>)
  })

  test('the manifest’s migrations are data, as a directory or a glob, whatever else they look like', () => {
    const m = manifest({ migrations: ['packages/server/migrations/', 'db/*.sql'] })
    expect(kindOfPath('packages/server/migrations/017_x.sql', m)).toBe('data')
    expect(kindOfPath('db/1.sql', m)).toBe('data')
    expect(kindOfPath('db/1.ts', m)).toBe('service')
  })

  test('kinds come once each; a project that deploys nothing requires nothing, so no manifest is never a bar', () => {
    expect(requiredEvidence(['a.ts', 'b.ts', 'c.tsx', 'docs/x.md'], manifest())).toEqual(['ui', 'service'])
    expect(requiredEvidence(['docs/x.md'], manifest())).toEqual([])
    expect(requiredEvidence(['a.ts', 'c.tsx'], defaultManifest('x'))).toEqual([])
  })
})

describe('GitCommits, against a repo with an origin', () => {
  function cloned(name: string) {
    const origin = fixture.repo(`${name}-origin`, { 'README.md': 'one' })
    const clone = join(fixture.root, name)
    fixture.git(fixture.root, 'clone', '-q', origin, clone)
    const head = (repo: string) => fixture.git(repo, 'rev-parse', 'HEAD')
    return { origin, clone, head, cut: head(clone) }
  }
  const read = (input: { repo: string; cut?: string | null; reported: string[]; merged?: boolean }) =>
    new GitCommits().read({ branch: 'factory/1-1', cut: null, ...input })

  test('reads what a merged commit touched and when, looking on the remote for one this checkout has not seen', async () => {
    const { origin, clone, head } = cloned('merged')
    fixture.commit(origin, { 'src/a b.ts': 'x', 'docs/ü.md': 'y' })
    const sha = head(origin)
    const found = await read({ repo: clone, reported: [sha.slice(0, 12)] })
    expect(found.commits).toEqual([sha])
    expect(found.paths).toEqual(['docs/ü.md', 'src/a b.ts'])
    expect(found.mergedAt).toBeInstanceOf(Date)
  })

  test('landedAt is origin’s default branch as the ship found it: the tip holding the work, not the commits the lead named', async () => {
    const { origin, clone, head } = cloned('landed')
    fixture.commit(origin, { 'src/a.ts': 'x' })
    const early = head(origin)
    fixture.commit(origin, { 'src/b.ts': 'y' })
    const tip = head(origin)
    // The lead names only the early commit; later work is on the base already.
    const found = await read({ repo: clone, reported: [early] })
    expect(found.landedAt).toBe(tip)
    // Nothing named and nothing on the branch: nothing was proven landed.
    expect((await read({ repo: clone, reported: [] })).landedAt).toBeNull()
  })

  test('a merge commit counts as what it brought in', async () => {
    const { origin, clone, head } = cloned('merging')
    fixture.git(origin, 'checkout', '-q', '-b', 'side')
    fixture.commit(origin, { 'src/side.ts': 'x' })
    fixture.git(origin, 'checkout', '-q', 'master')
    fixture.commit(origin, { 'README.md': 'two' })
    fixture.git(origin, 'merge', '-q', '--no-edit', 'side')
    const found = await read({ repo: clone, reported: [head(origin)] })
    expect(found.paths).toEqual(['src/side.ts'])
  })

  test('a commit that is not on the remote’s default branch, or nowhere at all, is refused and says so', async () => {
    const { clone, head } = cloned('unmerged')
    fixture.git(clone, 'checkout', '-q', '-b', 'factory/1-1')
    fixture.commit(clone, { 'src/a.ts': 'x' })
    await expect(read({ repo: clone, reported: [head(clone)] })).rejects.toThrow('is not on origin/master')
    await expect(read({ repo: clone, reported: ['b'.repeat(40)] })).rejects.toThrow('push it first')
  })

  test('an old commit of the base proves nothing about this attempt', async () => {
    const { clone, head } = cloned('old')
    const sha = head(clone)
    await expect(read({ repo: clone, cut: sha, reported: [sha] })).rejects.toThrow('older than this attempt')
  })

  test('ship: all the branch holds must be on the base, by commit or by content', async () => {
    const { origin, clone, head, cut } = cloned('held')
    fixture.git(clone, 'checkout', '-q', '-b', 'factory/1-1')
    fixture.commit(clone, { 'src/a.ts': 'x' })
    fixture.commit(origin, { 'docs/other.md': 'y' })
    const reported = [head(origin)]
    await expect(read({ repo: clone, cut, reported, merged: true })).rejects.toThrow('holds work that is not on')
    // The same change squashed onto the base: no commit of the branch is there, its content is.
    fixture.commit(origin, { 'src/a.ts': 'x' })
    const found = await read({ repo: clone, cut, reported: [head(origin)], merged: true })
    expect(found.paths).toContain('src/a.ts')
  })

  test('ship: a reported commit already seen, with the branch merged only on the remote, is found after a fetch', async () => {
    const { origin, clone, head, cut } = cloned('late')
    fixture.git(clone, 'checkout', '-q', '-b', 'factory/1-1')
    fixture.commit(clone, { 'src/b.ts': 'x' })
    fixture.commit(origin, { 'docs/seen.md': 'y' })
    fixture.git(clone, 'fetch', '-q', 'origin')
    const reported = [head(origin)]
    fixture.commit(origin, { 'src/b.ts': 'x' })
    const found = await read({ repo: clone, cut, reported, merged: true })
    expect(found.paths).toEqual(['docs/seen.md', 'src/b.ts'])
  })

  describe('a squash whose lines later commits moved on', () => {
    /** A branch with two commits on `src/a.ts`, squashed onto the base, and a later commit on the same lines: a three-way merge conflicts. */
    function squashed(name: string) {
      const made = cloned(name)
      fixture.commit(made.origin, { 'src/a.ts': 'old\n' })
      fixture.git(made.clone, 'fetch', '-q', 'origin')
      fixture.git(made.clone, 'merge', '-q', '--ff-only', 'origin/master')
      const cut = made.head(made.clone)
      fixture.git(made.clone, 'checkout', '-q', '-b', 'factory/1-1')
      fixture.commit(made.clone, { 'src/a.ts': 'half\n' })
      fixture.commit(made.clone, { 'src/a.ts': 'whole\n' })
      fixture.commit(made.origin, { 'src/a.ts': 'whole\n' })
      const squash = made.head(made.origin)
      fixture.commit(made.origin, { 'src/a.ts': 'whole and more\n' })
      fixture.git(made.clone, 'fetch', '-q', 'origin')
      return { ...made, cut, squash }
    }

    test('ship takes the commit the lead reports as merged', async () => {
      const { clone, cut, squash } = squashed('squash-ship')
      const found = await read({ repo: clone, cut, reported: [squash], merged: true })
      expect(found.paths).toEqual(['src/a.ts'])
    })

    test('an unrelated commit, or more work after the merge, is still work not on the base', async () => {
      const { origin, clone, head, cut, squash } = squashed('squash-other')
      fixture.commit(origin, { 'docs/other.md': 'x' })
      fixture.git(clone, 'fetch', '-q', 'origin')
      await expect(read({ repo: clone, cut, reported: [head(origin)], merged: true })).rejects.toThrow(
        'holds work that is not on',
      )
      const later = Math.floor(Date.now() / 1000) + 3_600
      fixture.git(clone, 'checkout', '-q', 'factory/1-1')
      await Bun.write(join(clone, 'src/b.ts'), 'x')
      Bun.spawnSync(['git', '-C', clone, 'add', '-A'])
      Bun.spawnSync(
        ['git', '-C', clone, '-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-q', '-m', 'more'],
        { env: { ...process.env, GIT_COMMITTER_DATE: `${later} +0000` } },
      )
      await expect(read({ repo: clone, cut, reported: [squash], merged: true })).rejects.toThrow(
        'holds work that is not on',
      )
    })

    test('a commit that only touches the same files proves nothing', async () => {
      const { origin, clone, head, cut } = squashed('squash-same-file')
      fixture.commit(origin, { 'src/a.ts': 'something else\n' })
      fixture.git(clone, 'fetch', '-q', 'origin')
      await expect(read({ repo: clone, cut, reported: [head(origin)], merged: true })).rejects.toThrow(
        'holds work that is not on',
      )
    })

    test('a git that cannot answer is no proof, so nothing is deleted', async () => {
      const { clone, squash } = squashed('squash-git-fails')
      const failing: typeof runProcess = async (cmd, ...rest) =>
        cmd.includes('diff') ? { exitCode: 128, stdout: '' } : runProcess(cmd, ...rest)
      expect(await branchOnBase(clone, 'factory/1-1', 'origin/master', { reported: [squash] })).toBe(true)
      expect(await branchOnBase(clone, 'factory/1-1', 'origin/master', { reported: [squash], run: failing })).toBe(
        false,
      )
    })

    test('a commit from before the branch forked proves nothing for a branch that deletes', async () => {
      const made = cloned('squash-older')
      const older = made.head(made.origin)
      fixture.commit(made.origin, { 'src/a.ts': 'x\n' })
      fixture.git(made.clone, 'fetch', '-q', 'origin')
      fixture.git(made.clone, 'merge', '-q', '--ff-only', 'origin/master')
      fixture.git(made.clone, 'checkout', '-q', '-b', 'factory/1-1')
      fixture.git(made.clone, 'rm', '-q', 'src/a.ts')
      fixture.git(made.clone, 'commit', '-q', '-m', 'delete')
      fixture.commit(made.origin, { 'docs/more.md': 'later\n' })
      fixture.git(made.clone, 'fetch', '-q', 'origin')
      // The old commit has no src/a.ts, as the branch has none: equal, and older than the fork.
      expect(await branchOnBase(made.clone, 'factory/1-1', 'origin/master', { reported: [older] })).toBe(false)
      // The same deletion landed after the fork is the squash.
      fixture.git(made.origin, 'rm', '-q', 'src/a.ts')
      fixture.git(made.origin, 'commit', '-q', '-m', 'squash')
      fixture.git(made.clone, 'fetch', '-q', 'origin')
      const squash = made.head(made.origin)
      expect(await branchOnBase(made.clone, 'factory/1-1', 'origin/master', { reported: [older, squash] })).toBe(true)
    })

    test('finalize removes it on the reported commit, and keeps it with none', async () => {
      const { clone, squash } = squashed('squash-remove')
      fixture.git(clone, 'checkout', '-q', 'master')
      const left = join(clone, '.claude', 'worktrees', 'left')
      fixture.git(clone, 'worktree', 'add', '-q', left, 'factory/1-1')
      const git = new GitWorktrees()
      expect(await git.remove({ repo: clone, branch: 'factory/1-1' })).toEqual({
        kept: 'its commits are not on origin/master',
        path: left,
      })
      expect(await git.remove({ repo: clone, branch: 'factory/1-1', reported: [squash] })).toEqual({ removed: true })
      expect(existsSync(left)).toBe(false)
    })
  })

  test('every commit of the branch counts, however many, and a range that cannot be read is a failure', async () => {
    const { clone, cut } = cloned('long')
    fixture.git(clone, 'checkout', '-q', '-b', 'factory/1-1')
    for (let i = 0; i < 3; i++) fixture.commit(clone, { [`src/${i}.ts`]: 'x' })
    expect((await read({ repo: clone, cut, reported: [] })).paths).toEqual(['src/0.ts', 'src/1.ts', 'src/2.ts'])
    await expect(read({ repo: clone, cut: 'c'.repeat(40), reported: [] })).rejects.toThrow('rev-list failed')
  })

  test('what else is on the lead’s branch counts, so the commits it names do not set the bar', async () => {
    const { origin, clone, head, cut } = cloned('branch')
    fixture.git(clone, 'checkout', '-q', '-b', 'factory/1-1')
    fixture.commit(clone, { 'src/unnamed.ts': 'x' })
    fixture.commit(origin, { 'docs/named.md': 'y' })
    const found = await read({ repo: clone, cut, reported: [head(origin)] })
    expect(found.paths).toEqual(['docs/named.md', 'src/unnamed.ts'])
    expect((await read({ repo: clone, cut, reported: [] })).paths).toEqual(['src/unnamed.ts'])
  })
})

describe('ship', () => {
  test('refused: without the evidence the row is answered with what is missing, and the call fails', async () => {
    const { id, key } = await lead()
    const response = await ship(id, key, { id: 's1' })
    expect(response.status).toBe(409)
    const body = (await response.json()) as { error: string; code: string }
    expect(body.code).toBe('refused')
    expect(body.error).toContain('evidence missing')
    expect(body.error).toContain('service (`make verify`')
    expect(body.error).toContain(`factory issue evidence ${id}`)
    expect((await issue(id)).state).toBe('working')
    const [row] = await db.sql`SELECT result, detail FROM factory.issue_inbox WHERE kind = 'ship'`
    expect(row).toEqual({ result: 'refused', detail: body.error })
    expect(await trail(id)).toContain('refused')
  })

  test('a refusal does not pin the answer: the same id derives again, and an accepted call stays one event', async () => {
    const { id, key } = await lead()
    commits.failure = new Error('git log did not finish in time')
    expect((await ship(id, key, { id: 's1' })).status).toBe(409)
    commits.failure = undefined
    expect((await ship(id, key, { id: 's1' })).status).toBe(409)
    expect(commits.calls).toBe(2)
    await prove(id, key, 'service')
    const accepted = await ship(id, key, { id: 's1' })
    expect(accepted.status).toBe(201)
    expect(await accepted.json()).toMatchObject({ key: `${id}:1:ship:s1:retry:2`, result: 'applied' })
    expect((await issue(id)).state).toBe('watching')

    const again = await ship(id, key, { id: 's1' })
    expect(again.status).toBe(200)
    expect(await again.json()).toMatchObject({ duplicate: true, key: `${id}:1:ship:s1:retry:2`, result: 'applied' })
    expect(commits.calls).toBe(3)
    expect((await issue(id)).hold).toBe(1)
  })

  test('a retry after a refusal does not store its inline evidence again', async () => {
    const { id, key } = await lead()
    const inline = { evidence: [{ kind: 'ui', link: 'https://example.com/shot' }] }
    expect((await ship(id, key, { id: 's1', ...inline })).status).toBe(409)
    await prove(id, key, 'service')
    expect((await ship(id, key, { id: 's1', ...inline })).status).toBe(201)
    expect((await evidence(id)).filter((e) => e.link === 'https://example.com/shot')).toHaveLength(1)
  })

  test('accepted: `watching` for the manifest’s hold, with what was found on the row', async () => {
    const { id, key } = await lead()
    commits.paths = ['src/a.ts', 'web/App.tsx', 'db/1.sql', 'docs/x.md']
    await prove(id, key, 'service')
    await post(id, 'evidence', { kind: 'ui', text: 'phone width, looks right', session: key })
    const response = await ship(id, key, {
      evidence: [{ kind: 'data', link: 'https://example.com/q', note: 'the count matches' }],
    })
    expect(response.status).toBe(201)
    expect(await response.json()).toMatchObject({ verb: 'ship', result: 'applied', detail: null })
    const row = await issue(id)
    expect(row).toMatchObject({ state: 'watching', hold: 1 })
    expect(row.wake_at?.getTime()).toBe(clock.now().getTime() + 45 * 60_000)
    const [filed] = await db.sql`SELECT payload FROM factory.issue_inbox WHERE kind = 'ship'`
    expect(filed.payload.derived).toMatchObject({ required: ['ui', 'service', 'data'], problem: null })
    expect((await evidence(id)).map((e) => e.kind)).toEqual(['service', 'ui', 'data'])
  })

  test('with no deploy mode the hold is the default, and nothing is required', async () => {
    const { id, key } = await lead(newRepo())
    expect((await ship(id, key)).status).toBe(201)
    const row = await issue(id)
    expect(row.wake_at?.getTime()).toBe(clock.now().getTime() + DEFAULT_HOLD_MS)
  })

  test('freshness: evidence older than the merged commit does not count, and the same second does', async () => {
    const { id, key } = await lead()
    await prove(id, key, 'service')
    clock.advance(60_000)
    commits.mergedAt = new Date(clock.now().getTime())
    const stale = await ship(id, key)
    expect(stale.status).toBe(409)
    expect(((await stale.json()) as { error: string }).error).toContain('older than the merged commit')
    await prove(id, key, 'service')
    expect((await ship(id, key)).status).toBe(201)
  })

  test('a commit that cannot count, and a git that fails, refuse it: the bar is never read as low', async () => {
    const { id, key } = await lead()
    commits.failure = new Error('git log did not finish in time')
    const failed = await ship(id, key)
    expect(failed.status).toBe(409)
    expect(((await failed.json()) as { error: string }).error).toContain('the commits could not be read')
    expect((await issue(id)).state).toBe('working')
  })

  test('a lead cannot declare its own bar: the body has no such field', async () => {
    const { id, key } = await lead()
    const response = await ship(id, key, { derived: { required: [] } })
    expect(response.status).toBe(400)
  })

  test('a ship must name its commits, a sha and nothing an option could be', async () => {
    const { id, key } = await lead()
    expect((await post(id, 'ship', { summary: 's', session: key })).status).toBe(400)
    expect((await post(id, 'ship', { summary: 's', commits: ['--all'], session: key })).status).toBe(400)
  })

  test('evidence that says nothing is none: a kind alone is refused', async () => {
    const { id, key } = await lead()
    expect((await ship(id, key, { evidence: [{ kind: 'service' }] })).status).toBe(400)
  })

  test('a lead that stops on a refused ship has reported nothing, and is sent back', async () => {
    const { id, key } = await lead()
    const { stopCheck } = await import('../src/rules.ts')
    await db.sql`
      INSERT INTO factory.prompts (id, session, source, via, text, status, created_at, next_at, sent_count)
      VALUES ('brief', ${key}, 'brief', 'type', 'x', 'delivered', ${clock.now()}, ${clock.now()}, 1)
      ON CONFLICT (id) DO NOTHING`
    await emit(key, 'turn_started')
    clock.advance(1_000)
    await ship(id, key)
    const check = await stopCheck(db.sql, key, { stopHookActive: false }, clock.now())
    expect(check.sendBack).toBe(true)
  })
})

describe('evidence', () => {
  test('a link or a text, up to 32 KiB, once per call id; a closed Issue takes none', async () => {
    const { id, key } = await lead()
    const first = await post(id, 'evidence', { id: 'e1', kind: 'ui', link: 'https://example.com/s.png', session: key })
    expect(first.status).toBe(201)
    expect(IssueEvidenceAck.parse(await first.json())).toMatchObject({
      issue: id,
      kind: 'ui',
      key: `evidence:${id}:1:e1`,
      duplicate: false,
    })
    const again = await post(id, 'evidence', { id: 'e1', kind: 'ui', link: 'https://example.com/s.png', session: key })
    expect(again.status).toBe(200)
    expect(await evidence(id)).toHaveLength(1)

    expect((await post(id, 'evidence', { kind: 'ui', session: key })).status).toBe(400)
    expect((await post(id, 'evidence', { kind: 'ui', link: 'x', text: 'y', session: key })).status).toBe(400)
    expect((await post(id, 'evidence', { kind: 'nonsense', link: 'x', session: key })).status).toBe(400)
    const large = 'x'.repeat(32 * 1024 + 1)
    expect((await post(id, 'evidence', { kind: 'ui', text: large, session: key })).status).toBe(400)
    expect((await post(id, 'evidence', { kind: 'ui', text: 'x'.repeat(32 * 1024), session: key })).status).toBe(201)

    await post(id, 'drop', { reason: 'no', session: key })
    await drive(2)
    expect((await post(id, 'evidence', { kind: 'ui', link: 'x' })).status).toBe(409)
  })

  test('text Postgres cannot keep is refused at the door: a binary file is a link', async () => {
    const { id, key } = await lead()
    expect((await post(id, 'evidence', { kind: 'ui', text: 'a\u0000b', session: key })).status).toBe(400)
  })

  test('another Issue’s lead is not heard', async () => {
    const mine = await lead()
    const theirs = await lead()
    expect((await post(theirs.id, 'evidence', { kind: 'ui', link: 'x', session: mine.key })).status).toBe(409)
  })
})

describe('review evidence', () => {
  const standard = (covered: boolean) => ({
    tier: 'standard' as const,
    covered,
    uncovered: covered ? [] : [{ sha: 'a'.repeat(40), subject: 'feat: the change', required: 'standard' as const }],
  })
  const lastDerived = async () => {
    const [row] =
      await db.sql`SELECT payload->'derived' AS derived FROM factory.issue_inbox WHERE kind = 'ship' ORDER BY id DESC LIMIT 1`
    return row?.derived as Record<string, unknown>
  }

  test('tier none: review is not required, and what was asked is on the row', async () => {
    const { id, key } = await lead()
    await prove(id, key, 'service')
    expect((await ship(id, key)).status).toBe(201)
    expect(review.asked).toHaveLength(1)
    expect(review.asked[0]).toMatchObject({ base: '0'.repeat(40), head: 'f'.repeat(40) })
    expect(await lastDerived()).toMatchObject({
      review: { tier: 'none', covered: true, uncovered: [], base: '0'.repeat(40), head: 'f'.repeat(40) },
      reviewProblem: null,
    })
  })

  test('standard and covered: ship passes', async () => {
    review.answer = standard(true)
    const { id, key } = await lead()
    await prove(id, key, 'service')
    expect((await ship(id, key)).status).toBe(201)
    expect((await issue(id)).state).toBe('watching')
  })

  test('uncovered: ship is refused naming the commits and their tiers, and a filed review link does not satisfy it', async () => {
    review.answer = standard(false)
    const { id, key } = await lead()
    await prove(id, key, 'service')
    expect((await post(id, 'evidence', { kind: 'review', link: 'rv_abc', session: key })).status).toBe(201)
    const response = await ship(id, key, { id: 's1' })
    expect(response.status).toBe(409)
    const body = (await response.json()) as { error: string }
    expect(body.error).toContain('review missing')
    expect(body.error).toContain(`${'a'.repeat(12)} feat: the change (needs standard)`)
    expect((await issue(id)).state).toBe('working')

    review.answer = standard(true)
    expect((await ship(id, key, { id: 's1' })).status).toBe(201)
  })

  test('agw failing refuses the ship, and the next call asks again', async () => {
    review.failure = new Error('agw review covered exited 1')
    const { id, key } = await lead()
    await prove(id, key, 'service')
    const response = await ship(id, key, { id: 's1' })
    expect(response.status).toBe(409)
    expect(((await response.json()) as { error: string }).error).toContain(
      'review could not be read: agw review covered exited 1',
    )
    review.failure = undefined
    expect((await ship(id, key, { id: 's1' })).status).toBe(201)
  })

  test('close is not asked for review', async () => {
    review.failure = new Error('down')
    commits.paths = ['docs/a.md']
    const { id, key } = await lead()
    expect((await post(id, 'close', { summary: 'done', commits: [SHA], session: key })).status).toBe(201)
    expect(review.asked).toHaveLength(0)
  })

  test('the kind is accepted by the evidence route', async () => {
    const { id, key } = await lead()
    expect((await post(id, 'evidence', { kind: 'review', link: 'rv_abc', session: key })).status).toBe(201)
  })
})

describe('close', () => {
  test('refused when the commits touch deployable paths', async () => {
    const { id, key } = await lead()
    const response = await post(id, 'close', { summary: 'done', commits: [SHA], session: key })
    expect(response.status).toBe(409)
    expect(((await response.json()) as { error: string }).error).toContain('touch deployable paths')
    expect((await issue(id)).state).toBe('working')
  })

  test('accepted when they do not: a document change in a deployed project', async () => {
    const { id, key } = await lead()
    commits.paths = ['docs/x.md']
    const response = await post(id, 'close', { summary: 'done', commits: [SHA], session: key })
    expect(response.status).toBe(201)
    expect(await issue(id)).toMatchObject({ state: 'closed', outcome: 'done' })
    await drive(2)
    expect(await trail(id)).toContain('issue_finalized')
  })

  test('no manifest: the commit or the document is enough, and nothing at all is not', async () => {
    const one = await lead(newRepo())
    commits.paths = ['src/a.ts']
    expect((await post(one.id, 'close', { summary: 'done', commits: [SHA], session: one.key })).status).toBe(201)
    const two = await lead(newRepo())
    expect((await post(two.id, 'close', { summary: 'done', document: 'docs/x.md', session: two.key })).status).toBe(201)
    const three = await lead(newRepo())
    // The worktree's row has a cut; FakeCommits answers nothing for a call that names none.
    commits.paths = []
    const none = await post(three.id, 'close', { summary: 'done', session: three.key })
    expect(none.status).toBe(409)
    expect(((await none.json()) as { error: string }).error).toContain('the commit')
  })

  test('something merely on the branch is no proof: a close names a commit or a document', async () => {
    const { id, key } = await lead(newRepo())
    commits.branch = ['b'.repeat(40)]
    commits.paths = ['docs/x.md']
    const response = await post(id, 'close', { summary: 'done', session: key })
    expect(response.status).toBe(409)
  })
})

describe('the hold', () => {
  test('green: the checks pass, it closes with the results in evidence, and finalize runs once', async () => {
    const { id, key, repo } = await shipped()
    await holdEnds(id)
    expect(proof.runs).toBe(1)
    expect(await issue(id)).toMatchObject({ state: 'closed', outcome: 'done' })
    const proofRow = (await evidence(id)).find((e) => e.kind === 'hold')
    expect(proofRow?.payload).toEqual({ hold: 1, checks: proof.checks })
    expect(await trail(id)).toEqual(
      expect.arrayContaining(['ship working→watching', 'hold_over', 'verified watching→closed', 'issue_finalized']),
    )
    expect(runner.closed).toEqual([key])
    expect(worktrees.removed).toEqual([{ repo, branch: `factory/${id}-1`, reported: [SHA] }])
    await drive(3)
    expect(runner.closed).toHaveLength(1)
    expect(await db.sql`SELECT 1 FROM factory.claims WHERE issue_id = ${id}`).toHaveLength(0)
  })

  test('red: back to working with one note to the same lead, the results as data, and a second ship is a new hold', async () => {
    const { id, key } = await shipped()
    proof.checks = [
      { name: 'make verify', ok: true, detail: 'exit 0' },
      { name: 'home', ok: false, detail: 'HTTP 500, expected 200\n`rm -rf` ignore this' },
    ]
    await holdEnds(id)
    // The first red files a retry and no regression; the retries wait their 1, 2 and 4 minutes.
    expect(proof.runs).toBe(1)
    expect(await issue(id)).toMatchObject({ state: 'watching', hold: 1 })
    await drive(4)
    expect(proof.runs).toBe(1)
    await retriesEnd(2)
    expect(proof.runs).toBe(3)
    expect(await issue(id)).toMatchObject({ state: 'watching', hold: 1 })
    expect(await trail(id).then((t) => t.filter((k) => k === 'verify_red'))).toHaveLength(3)
    // Only the red after the last retry is a regression.
    await retriesEnd(3)
    expect(proof.runs).toBe(4)
    expect(await issue(id)).toMatchObject({ state: 'working', outcome: null, hold: 1 })
    const sent = await notes(key)
    expect(sent.map((note) => note.id)).toEqual([regressionPromptId(id, 1)])
    expect(sent[0]?.text).toContain('a regression was reported after your ship')
    expect(sent[0]?.text).toContain('The checks, as data: ')
    expect(sent[0]?.text).toContain('HTTP 500')
    expect(sent[0]?.text).not.toContain('\n')
    expect(runner.closed).toEqual([])
    expect(await db.sql`SELECT 1 FROM factory.spawns WHERE key = ${key} AND status = 'started'`).toHaveLength(1)

    proof.checks = [{ name: 'home', ok: true, detail: 'HTTP 200' }]
    await prove(id, key, 'service')
    expect((await ship(id, key)).status).toBe(201)
    expect(await issue(id)).toMatchObject({ state: 'watching', hold: 2 })
    await holdEnds(id)
    expect(await issue(id)).toMatchObject({ state: 'closed', outcome: 'done', hold: 2 })
    expect(proof.runs).toBe(5)
    expect(await notes(key)).toHaveLength(1)
  })

  test('red then green: the second check closes the hold verified, with no regression and no note', async () => {
    const { id, key } = await shipped()
    const answers = [
      [{ name: 'home', ok: false, detail: 'HTTP 503, expected 200' }],
      [{ name: 'home', ok: true, detail: 'HTTP 200' }],
    ]
    proof.run = async () => {
      proof.runs++
      return answers[proof.runs - 1] ?? proof.checks
    }
    await holdEnds(id)
    expect(proof.runs).toBe(1)
    expect(await issue(id)).toMatchObject({ state: 'watching', hold: 1 })
    await retriesEnd(1)
    expect(proof.runs).toBe(2)
    expect(await issue(id)).toMatchObject({ state: 'closed', outcome: 'done', hold: 1 })
    expect(await trail(id)).toEqual(expect.arrayContaining(['verify_red', 'verified watching→closed']))
    expect(await trail(id)).not.toContain('regression watching→working')
    expect(await notes(key)).toHaveLength(0)
    expect(await db.sql`SELECT 1 FROM factory.issue_inbox WHERE key LIKE 'regression:%'`).toHaveLength(0)
    // The replay: a second pass files no third check and no second answer.
    await drive(3)
    expect(proof.runs).toBe(2)
    expect(await db.sql`SELECT key FROM factory.issue_effects WHERE kind = 'verify' ORDER BY id`).toHaveLength(2)
  })

  test('a blocked checkout is no red: no regression, no retry, the effect waits and a clean run closes the hold', async () => {
    const { id, key } = await shipped()
    // The lead has begun its first turn: a started spawn without one is a health line of its own.
    await emit(key, 'turn_started')
    const blockedCheck = {
      name: 'checkout',
      ok: false,
      blocked: true,
      detail: 'the repo has uncommitted changes (a.txt)',
    }
    let blocked = true
    proof.run = async () => {
      proof.runs++
      return blocked ? [blockedCheck, { name: 'home', ok: true, detail: 'HTTP 200' }] : proof.checks
    }
    await holdEnds(id)
    expect(proof.runs).toBe(1)
    expect(await issue(id)).toMatchObject({ state: 'watching', hold: 1 })
    expect(await trail(id)).not.toContain('verify_red')
    expect(await trail(id).then((t) => t.filter((k) => k === 'checkout_blocked'))).toHaveLength(1)
    expect(await db.sql`SELECT 1 FROM factory.issue_inbox WHERE key LIKE 'regression:%'`).toHaveLength(0)
    const open = await db.sql`SELECT payload FROM factory.issue_effects WHERE kind = 'verify' AND done_at IS NULL`
    expect(open).toHaveLength(1)
    expect(open[0].payload.blocked).toMatchObject({ detail: blockedCheck.detail })
    const due = Date.parse(open[0].payload.notBefore) - clock.now().getTime()
    expect(due).toBeGreaterThan(CHECKOUT_RECHECK_MS - 60_000)
    expect(due).toBeLessThanOrEqual(CHECKOUT_RECHECK_MS)
    expect(await healthLines(db.sql, clock.now())).toContain(
      `Issue ${id}: the hold cannot verify, ${blockedCheck.detail}; it checks again every 5 min`,
    )

    // Not due yet: nothing runs. Due: it asks again, and a blocked check never counts as a regression, however often.
    await drive(4)
    expect(proof.runs).toBe(1)
    for (let i = 0; i < 4; i++) {
      clock.advance(CHECKOUT_RECHECK_MS)
      await drive(4)
    }
    expect(proof.runs).toBe(5)
    expect(await issue(id)).toMatchObject({ state: 'watching', hold: 1 })
    expect(await trail(id)).not.toContain('verify_red')
    expect(await trail(id).then((t) => t.filter((k) => k === 'checkout_blocked'))).toHaveLength(1)
    const since = (await db.sql`SELECT payload FROM factory.issue_effects WHERE kind = 'verify' AND done_at IS NULL`)[0]
      .payload.blocked.since
    expect(Date.parse(since)).toBeLessThan(clock.now().getTime() - 3 * CHECKOUT_RECHECK_MS)

    blocked = false
    clock.advance(CHECKOUT_RECHECK_MS)
    await drive(4)
    expect(await issue(id)).toMatchObject({ state: 'closed', outcome: 'done' })
    expect(await healthLines(db.sql, clock.now())).toEqual([])
  })

  test('a red after a blocked run is a retry without the blocked payload', async () => {
    const { id } = await shipped()
    const answers: HoldCheck[][] = [
      [{ name: 'checkout', ok: false, blocked: true, detail: 'x' }],
      [{ name: 'home', ok: false, detail: 'HTTP 503, expected 200' }],
    ]
    proof.run = async () => {
      proof.runs++
      return answers[proof.runs - 1] ?? proof.checks
    }
    await holdEnds(id)
    clock.advance(CHECKOUT_RECHECK_MS)
    await drive(4)
    expect(proof.runs).toBe(2)
    expect(await trail(id)).toContain('verify_red')
    const open = await db.sql`SELECT payload FROM factory.issue_effects WHERE kind = 'verify' AND done_at IS NULL`
    expect(open).toHaveLength(1)
    expect(open[0].payload).not.toHaveProperty('blocked')
    expect(open[0].payload.retry).toBe(1)
  })

  describe('a hold of 0m: no artificial wait', () => {
    const NOW = SERVICE.replace('hold: 45m', 'hold: 0m')

    test('green: the hold ends on the next timer pass, the check runs at once, the Issue closes and the claim is free', async () => {
      const { id, key, repo } = await lead(newRepo(NOW))
      await prove(id, key, 'service')
      const shippedAt = clock.now().getTime()
      expect((await ship(id, key)).status).toBe(201)
      expect((await issue(id)).wake_at?.getTime()).toBe(shippedAt)
      expect(await db.sql`SELECT 1 FROM factory.claims WHERE issue_id = ${id}`).toHaveLength(1)

      await drive(4)
      expect(proof.runs).toBe(1)
      expect(await issue(id)).toMatchObject({ state: 'closed', outcome: 'done', hold: 1 })
      expect(await trail(id)).toEqual(expect.arrayContaining(['hold_over', 'verified watching→closed']))
      expect(await db.sql`SELECT 1 FROM factory.claims WHERE issue_id = ${id}`).toHaveLength(0)
      expect(repo).toBeTruthy()
    })

    test('red: retried on 1, 2 and 4 minutes, then a regression to the lead; the third regression parks', async () => {
      const { id, key } = await lead(newRepo(NOW))
      proof.checks = [{ name: 'home', ok: false, detail: 'HTTP 500, expected 200' }]
      await prove(id, key, 'service')
      expect((await ship(id, key)).status).toBe(201)
      for (const hold of [1, 2]) {
        await drive(4)
        await retriesEnd()
        expect(proof.runs).toBe(hold * 4)
        expect(await issue(id)).toMatchObject({ state: 'working', hold })
        expect(await db.sql`SELECT 1 FROM factory.claims WHERE issue_id = ${id}`).toHaveLength(1)
        await prove(id, key, 'service')
        expect((await ship(id, key)).status).toBe(201)
      }
      await drive(4)
      await retriesEnd()
      expect(proof.runs).toBe(12)
      expect(await issue(id)).toMatchObject({ state: 'waiting', reason: 'parked', hold: 3 })
    })
  })

  test('red after the last retry files one regression; the third regression of the Issue parks it instead of going back to the lead', async () => {
    const { id, key } = await shipped()
    proof.checks = [{ name: 'home', ok: false, detail: 'HTTP 500, expected 200' }]
    for (const hold of [1, 2]) {
      await holdEnds(id)
      await retriesEnd()
      expect(await issue(id)).toMatchObject({ state: 'working', hold })
      expect(await db.sql`SELECT 1 FROM factory.issue_inbox WHERE key = ${`regression:${id}:${hold}`}`).toHaveLength(1)
      await prove(id, key, 'service')
      expect((await ship(id, key)).status).toBe(201)
    }
    await holdEnds(id)
    await retriesEnd()
    expect(await issue(id)).toMatchObject({ state: 'waiting', reason: 'parked', hold: 3 })
    expect(await trail(id)).toContain('regression watching→waiting')
    const [parked] = await db.sql`
      SELECT payload FROM factory.issue_events WHERE issue_id = ${id} AND kind = 'regression' AND to_state = 'waiting'`
    expect(parked.payload.detail).toBe('regressed three times')
    // The lead was told of the first two and not of the third; the owner got one park message and no third regression message.
    expect((await notes(key)).map((note) => note.id)).toEqual([regressionPromptId(id, 1), regressionPromptId(id, 2)])
    const sent = await db.sql`SELECT key FROM factory.notifications ORDER BY key`
    expect(sent.map((row: { key: string }) => row.key)).toEqual([
      `notify:parked:${id}:${String((await issue(id)).revision)}`,
      `notify:regression:${id}:1`,
      `notify:regression:${id}:2`,
    ])
    await drive(3)
    expect(await issue(id)).toMatchObject({ state: 'waiting', reason: 'parked' })
  })

  test('nothing to check is green: a project with no verify and no probes closes at the end of its hold', async () => {
    const real = holdPorts({ sql: db.sql, clock, proof: new MakeAndProbes(), offTick })
    const { id, key } = await lead(newRepo())
    expect((await ship(id, key)).status).toBe(201)
    clock.advance(DEFAULT_HOLD_MS)
    for (let i = 0; i < 3; i++) {
      await issuePass(db.sql, { now: () => clock.now(), ports: real })
      await offTick.settled()
    }
    expect((await issue(id)).state).toBe('closed')
  })

  test('a note reaches the lead while the check runs', async () => {
    const { id, key } = await shipped()
    let open: (() => void) | undefined
    proof.run = async () => {
      proof.runs++
      await new Promise<void>((resolve) => {
        open = resolve
      })
      return proof.checks
    }
    moveTo((await issue(id)).wake_at as Date)
    const round = () => issuePass(db.sql, { now: () => clock.now(), ports: ports() })
    await round()
    await round()
    expect(proof.runs).toBe(1)
    await enqueue(db.sql, {
      issueId: id,
      key: 'owner-note',
      kind: 'note',
      at: clock.now(),
      payload: { text: 'look here' },
    })
    await round()
    expect((await notes(key)).map((note) => note.text)).toEqual([`Factory, Issue ${id}: look here`])
    open?.()
    await offTick.settled()
  })

  test('more checks waiting than a pass takes do not starve a note', async () => {
    const { id, key } = await lead()
    await enqueue(db.sql, {
      issueId: id,
      key: 'owner-note',
      kind: 'note',
      at: clock.now(),
      payload: { text: 'look here' },
    })
    await issuePass(db.sql, { now: () => clock.now(), ports: {} })
    const waiting: EffectPorts = {
      verify: async () => {
        throw new Waiting('a check runs')
      },
      note_lead: ports().note_lead,
    }
    for (let i = 0; i < 25; i++) {
      const other = await file(newRepo())
      await db.sql`
        INSERT INTO factory.issue_effects (issue_id, key, kind, payload, created_at)
        VALUES (${other}, ${`verify:v${i}`}, 'verify', ${{ hold: 1 }}, ${clock.now()})`
    }
    await db.sql`UPDATE factory.issue_effects SET id = id + 1000 WHERE key LIKE 'note_lead:%'`
    await runEffects(db.sql, waiting, () => clock.now())
    expect(await notes(key)).toHaveLength(1)
  })

  test('a stop kills make verify and all it started, files nothing, and the next server asks again', async () => {
    const repo = fixture.repo(`repo${++repos}`, {})
    const marker = join(repo, 'grandchild.pid')
    fixture.commit(repo, {
      'project.yaml': SERVICE.replace('NAME', repo.split('/').pop() as string).replace(/ {2}probes:\n.*\n/, ''),
      Makefile: `verify:\n\t@sleep 60 & echo $$! > ${marker}; wait\nversion:\n\t@git rev-parse HEAD\n`,
    })
    commits.landedAt = fixture.git(repo, 'rev-parse', 'HEAD')
    const { id, key } = await lead(repo)
    await prove(id, key, 'service')
    expect((await ship(id, key)).status).toBe(201)
    moveTo((await issue(id)).wake_at as Date)
    const real = { ...ports(), ...holdPorts({ sql: db.sql, clock, proof: new MakeAndProbes(), offTick }) }
    await issuePass(db.sql, { now: () => clock.now(), ports: real })
    await issuePass(db.sql, { now: () => clock.now(), ports: real })
    for (let i = 0; i < 100 && !existsSync(marker); i++) await Bun.sleep(50)
    const pid = Number(readFileSync(marker, 'utf8'))
    expect(Bun.spawnSync(['kill', '-0', String(pid)]).exitCode).toBe(0)
    await offTick.stop(5_000)
    await Bun.sleep(100)
    expect(Bun.spawnSync(['kill', '-0', String(pid)]).exitCode).not.toBe(0)
    await issuePass(db.sql, { now: () => clock.now(), ports: real })
    expect(await issue(id)).toMatchObject({ state: 'watching' })
    expect(
      await db.sql`SELECT 1 FROM factory.issue_inbox WHERE key LIKE 'regression:%' OR key LIKE 'verified:%'`,
    ).toHaveLength(0)
  })

  test('a check that threw backs off: it is not started again every pass', async () => {
    const { id } = await shipped()
    moveTo((await issue(id)).wake_at as Date)
    proof.run = async () => {
      proof.runs++
      throw new Error('the database went away')
    }
    const round = async () => {
      await issuePass(db.sql, { now: () => clock.now(), ports: ports() })
      await offTick.settled()
      clock.advance(5_000)
    }
    for (let i = 0; i < 5; i++) await round()
    expect(proof.runs).toBe(1)
    clock.advance(30_000)
    for (let i = 0; i < 2; i++) await round()
    expect(proof.runs).toBe(2)
    expect((await issue(id)).state).toBe('watching')
  })

  test('a check overtaken by a stop files nothing', async () => {
    const { id, key } = await shipped()
    let open: (() => void) | undefined
    proof.run = async () => {
      proof.runs++
      await new Promise<void>((resolve) => {
        open = resolve
      })
      return proof.checks
    }
    const { wake_at: wake } = await issue(id)
    moveTo(wake as Date)
    const started = tick({ sql: db.sql, clock, runner, issuePorts: ports(), classification, projects: sync })
    await started
    await tick({ sql: db.sql, clock, runner, issuePorts: ports(), classification, projects: sync })
    expect(proof.runs).toBe(1)
    await enqueue(db.sql, { issueId: id, key: 'stop', kind: 'stop', at: clock.now() })
    await issuePass(db.sql, { now: () => clock.now(), ports: {} })
    open?.()
    await offTick.settled()
    await drive(3)
    expect(await issue(id)).toMatchObject({ state: 'closed', outcome: 'dropped' })
    expect(await db.sql`SELECT 1 FROM factory.issue_inbox WHERE key LIKE 'verified:%'`).toHaveLength(0)
    expect(runner.closed).toEqual([key])
  })

  test('a seeded red `make verify` reaches the lead as exactly one note, and is typed once', async () => {
    const repo = fixture.repo(`repo${++repos}`, {})
    fixture.commit(repo, {
      'project.yaml': SERVICE.replace('NAME', repo.split('/').pop() as string).replace(/ {2}probes:\n.*\n/, ''),
      Makefile: 'verify:\n\t@echo the deployed service is broken; exit 3\nversion:\n\t@git rev-parse HEAD\n',
    })
    commits.landedAt = fixture.git(repo, 'rev-parse', 'HEAD')
    const issuePorts = {
      ...ports(),
      ...holdPorts({ sql: db.sql, clock, proof: new MakeAndProbes(), offTick }),
    }
    const round = async () => {
      await tick({ sql: db.sql, clock, runner, issuePorts, classification, leadWorktrees: maker, projects: sync })
      await classification.settled()
      await maker.settled()
      await offTick.settled()
      clock.advance(5_000)
    }
    const { id, key } = await lead(repo)
    await prove(id, key, 'service')
    expect((await ship(id, key)).status).toBe(201)
    await emit(key, 'turn_started')
    await emit(key, 'turn_ended')
    moveTo((await issue(id)).wake_at as Date)
    for (let i = 0; i < 6; i++) await round()
    for (const minutes of [1, 2, 4]) {
      clock.advance(minutes * 60_000)
      for (let i = 0; i < 6; i++) await round()
    }
    expect((await issue(id)).state).toBe('working')
    const sent = await notes(key)
    expect(sent).toHaveLength(1)
    expect(sent[0]?.text).toContain('the deployed service is broken')
    expect(sent[0]?.text).toContain('Error 3')
    expect(runner.typed.filter((t) => t.text.includes('the deployed service is broken'))).toHaveLength(1)
  })
})

describe('the deployed version', () => {
  // These repos stay out of the tests after this describe: a project each would join every later pass.
  const made: string[] = []
  afterEach(() => {
    for (const path of made.splice(0)) rmSync(path, { recursive: true, force: true })
  })

  /** A repo with three commits and a `make version` that prints what the test says is deployed. */
  function deployable(
    name: string,
    makefile = 'verify:\n\t@true\nversion:\n\t@cat .deployed\n',
    more: Record<string, string> = {},
  ) {
    const repo = fixture.repo(name, {
      Makefile: makefile,
      'project.yaml': SERVICE.replace('NAME', name).replace(/ {2}probes:\n.*\n/, ''),
      ...more,
    })
    made.push(repo)
    const head = () => fixture.git(repo, 'rev-parse', 'HEAD')
    const c1 = head()
    fixture.commit(repo, { 'a.txt': '2' })
    const c2 = head()
    fixture.commit(repo, { 'a.txt': '3' })
    const c3 = head()
    return { repo, c1, c2, c3, deployed: (sha: string) => writeFileSync(join(repo, '.deployed'), `${sha}\n`) }
  }
  const run = (repo: string, landedAt: string, extra: { makeVerify?: boolean } = {}) =>
    new MakeAndProbes().run({ repo, makeVerify: extra.makeVerify ?? false, version: { landedAt }, probes: [] })

  test('a deployed commit behind where the work landed is red, naming both; at it or past it is green; the checkout is not touched', async () => {
    const { repo, c1, c2, c3, deployed } = deployable('versions')
    deployed(c1)
    const behind = await run(repo, c2)
    expect(behind).toEqual([{ name: 'deployed version', ok: false, detail: expect.stringContaining('make deploy') }])
    expect(behind[0]?.detail).toContain(c2.slice(0, 12))
    expect(behind[0]?.detail).toContain(`deployed ${c1.slice(0, 12)}`)
    deployed(c2)
    expect((await run(repo, c2))[0]).toMatchObject({ ok: true })
    deployed(c3)
    expect((await run(repo, c2))[0]).toMatchObject({ ok: true })
    // The one sha is where the work landed: a deployed version past it holds the rest, one before it does not.
    deployed(c2)
    expect((await run(repo, c3))[0]).toMatchObject({ ok: false })
    // Read-only: HEAD, the branch and the working tree are as they were.
    expect(fixture.git(repo, 'rev-parse', 'HEAD')).toBe(c3)
    expect(fixture.git(repo, 'status', '--porcelain', '--untracked-files=no')).toBe('')
  })

  test('no `make version` is make’s own word: red with the line saying it is a probe, the owner’s to add', async () => {
    const bare = deployable('versions-bare', 'verify:\n\t@true\n')
    const checks = await run(bare.repo, bare.c2)
    expect(checks).toEqual([{ name: 'deployed version', ok: false, detail: NO_TARGET_LINE }])
    expect(NO_TARGET_LINE).toContain('factory issue block')
    expect(NO_TARGET_LINE).toContain('a lead does not')
    const noMakefile = fixture.repo('versions-no-makefile', {})
    made.push(noMakefile)
    expect((await run(noMakefile, fixture.git(noMakefile, 'rev-parse', 'HEAD')))[0]?.detail).toBe(NO_TARGET_LINE)
  })

  test('a target a variable-built include defines is found: only make knows, so it is run', async () => {
    const { repo, c2, deployed } = deployable('versions-include', 'DIR = .\ninclude $(DIR)/v.mk\n', {
      'v.mk': 'version:\n\t@cat .deployed\n',
    })
    deployed(c2)
    expect((await run(repo, c2))[0]).toMatchObject({ ok: true })
  })

  test('another missing target is not the missing `version`: a prerequisite make cannot build is its own failure', async () => {
    const { repo, c2 } = deployable('versions-prereq', 'version: build\n\t@true\n')
    const [check] = await run(repo, c2)
    expect(check).toMatchObject({ ok: false })
    expect(check?.detail).not.toBe(NO_TARGET_LINE)
    expect(check?.detail).toContain('make version exit')
  })

  test('a missing prerequisite that merely starts with `version` is not a missing `version` target', async () => {
    const { repo, c2 } = deployable('versions-prereq-h', 'version: version.h\n\t@true\n')
    const [check] = await run(repo, c2)
    expect(check?.detail).not.toBe(NO_TARGET_LINE)
    expect(check?.detail).toContain('make version exit')
  })

  test('garbage, two lines, a failure with its stderr, and a sha the repo lacks are red, each with its reason', async () => {
    const garbage = deployable('versions-garbage', 'version:\n\t@echo the version is 3\n')
    const printed = await run(garbage.repo, garbage.c2)
    expect(printed[0]).toMatchObject({ ok: false })
    expect(printed[0]?.detail).toContain('the deployed commit sha')
    const failing = deployable('versions-failing', 'version:\n\t@echo no release >&2; echo some out; exit 4\n')
    const failed = (await run(failing.repo, failing.c2))[0]
    expect(failed?.detail).toMatch(/^make version exit 2: stdout: some out \/ stderr: no release\n/)
    expect(failed?.detail).not.toContain('  ')
    const two = deployable('versions-two-lines', 'version:\n\t@git rev-parse HEAD; git rev-parse HEAD\n')
    expect((await run(two.repo, two.c2))[0]).toMatchObject({ ok: false })
    const noisy = deployable('versions-noisy', 'version:\n\t@echo a warning >&2; cat .deployed\n')
    noisy.deployed(noisy.c2)
    expect((await run(noisy.repo, noisy.c2))[0]).toMatchObject({ ok: true })
    const unknown = deployable('versions-unknown')
    unknown.deployed('b'.repeat(40))
    expect((await run(unknown.repo, unknown.c2))[0]?.detail).toContain('is not in')
  })

  test('make’s words in a failed recipe are not its own: only the top-level line with no failed recipe after it is a missing target', async () => {
    const quoted = deployable(
      'versions-quoted',
      'version:\n\t@echo "make: *** No rule to make target \'version\'.  Stop." >&2; exit 2\n',
    )
    const [check] = await run(quoted.repo, quoted.c2)
    expect(check?.detail).not.toBe(NO_TARGET_LINE)
    expect(check?.detail).toContain('make version exit')
    const nested = deployable(
      'versions-nested',
      'version:\n\t@$(MAKE) --no-print-directory -f /nonexistent/version.mk version\n',
    )
    expect((await run(nested.repo, nested.c2))[0]?.detail).not.toBe(NO_TARGET_LINE)
  })

  test('a failure that printed nothing shows only what make itself said', async () => {
    const { repo, c2 } = deployable('versions-mute', 'version:\n\t@exit 5\n')
    expect((await run(repo, c2))[0]?.detail).toMatch(
      /^make version exit 2: stderr: make: \*\*\* \[.*version\] Error 5$/,
    )
  })

  test('a failure of stderr is bounded', async () => {
    const { repo, c2 } = deployable('versions-loud', 'version:\n\t@yes boom | head -c 100000 >&2; exit 3\n')
    const [check] = await run(repo, c2)
    expect(check?.ok).toBe(false)
    expect(check?.detail.length).toBeLessThan(3_300)
  })

  test('a git that cannot compare is not "make deploy has not run"; one that does not answer is red, not an error', async () => {
    const { repo, c2, deployed } = deployable('versions-git')
    deployed(c2)
    const real = (await import('../src/exec.ts')).runProcess
    const stubbed = (answer: (cmd: string[]) => { exitCode: number; stdout: string } | undefined) =>
      new MakeAndProbes({
        run: (cmd, ...rest) => Promise.resolve(answer(cmd)).then((stub) => stub ?? real(cmd, ...rest)),
      })
    const input = { repo, makeVerify: true, version: { landedAt: c2 }, probes: [] }
    const broken = await stubbed((cmd) =>
      cmd.includes('--is-ancestor') ? { exitCode: 128, stdout: '' } : undefined,
    ).run(input)
    expect(broken[0]).toMatchObject({ ok: false })
    expect(broken[0]?.detail).toContain('could not compare: git merge-base exit 128')
    expect(broken[0]?.detail).not.toContain('make deploy')
    const stopped = await stubbed((cmd) =>
      cmd.includes('--is-ancestor') ? { exitCode: -2, stdout: '' } : undefined,
    ).run(input)
    expect(stopped[0]?.detail).toContain('could not compare')
    const hung = await stubbed((cmd) => (cmd[0] === 'git' ? { exitCode: -1, stdout: '' } : undefined)).run(input)
    expect(hung.map((c) => [c.name, c.ok])).toEqual([
      ['deployed version', false],
      ['make verify', true],
    ])
    expect(hung[0]?.detail).toContain('did not finish in time')
  })

  test('a reason instead of a sha is red with that reason, and the other checks still run', async () => {
    const { repo } = deployable('versions-problem')
    const checks = await new MakeAndProbes().run({
      repo,
      makeVerify: true,
      version: { problem: 'the ship recorded no landed commit' },
      probes: [],
    })
    expect(checks).toEqual([
      { name: 'deployed version', ok: false, detail: 'the ship recorded no landed commit' },
      expect.objectContaining({ name: 'make verify', ok: true }),
    ])
  })

  test('a stopped server leaves nothing running: the version is red, not a throw', async () => {
    const { repo, c2, deployed } = deployable('versions-stopped')
    deployed(c2)
    const checks = await new MakeAndProbes().run(
      { repo, makeVerify: false, version: { landedAt: c2 }, probes: [] },
      AbortSignal.abort(),
    )
    expect(checks[0]).toMatchObject({ name: 'deployed version', ok: false })
  })

  async function holdOver(repo: string, landedAt: string | null, between: () => Promise<void> = async () => {}) {
    commits.landedAt = landedAt
    if (landedAt === null) {
      // Review cannot be asked without a landed commit (ship is refused on it); these tests are about the hold, so they bring no review.
      await app.stop()
      app = startApp({ sql: db.sql, clock, commits, repoRoots: [fixture.root] })
    }
    const issuePorts = { ...ports(), ...holdPorts({ sql: db.sql, clock, proof: new MakeAndProbes(), offTick }) }
    const { id, key } = await lead(repo)
    await prove(id, key, 'service')
    expect((await ship(id, key)).status).toBe(201)
    await between()
    await emit(key, 'turn_started')
    await emit(key, 'turn_ended')
    moveTo((await issue(id)).wake_at as Date)
    for (let i = 0; i < 6; i++) {
      await tick({ sql: db.sql, clock, runner, issuePorts, classification, leadWorktrees: maker, projects: sync })
      await classification.settled()
      await maker.settled()
      await offTick.settled()
      clock.advance(5_000)
    }
    // A red check waits out its retries (1, 2 and 4 minutes) before it is a regression; a green one has closed the Issue already.
    for (const minutes of (await issue(id)).state === 'watching' ? [1, 2, 4] : []) {
      clock.advance(minutes * 60_000)
      for (let i = 0; i < 6; i++) {
        await tick({ sql: db.sql, clock, runner, issuePorts, classification, leadWorktrees: maker, projects: sync })
        await classification.settled()
        await maker.settled()
        await offTick.settled()
        clock.advance(5_000)
      }
    }
    return { id, key }
  }
  const regression = async (made: { id: number; key: string }, ...words: string[]) => {
    expect((await issue(made.id)).state).toBe('working')
    const sent = await notes(made.key)
    expect(sent).toHaveLength(1)
    for (const word of words) expect(sent[0]?.text).toContain(word)
  }

  test('through the hold: behind where the work landed is a regression to the lead, at it the Issue closes verified', async () => {
    const stale = deployable('hold-behind')
    stale.deployed(stale.c1)
    await regression(await holdOver(stale.repo, stale.c2), 'deployed version', 'make deploy')

    const current = deployable('hold-current')
    current.deployed(current.c3)
    expect((await issue((await holdOver(current.repo, current.c2)).id)).state).toBe('closed')
  })

  test('through the hold: the check is the landed base, so a lead that reports only an early commit does not pass', async () => {
    const { repo, c1, c2, c3, deployed } = deployable('hold-early')
    deployed(c2)
    // The lead names c1; the work landed at c3.
    commits.resolves[SHA] = c1
    await regression(await holdOver(repo, c3), 'deployed version')
  })

  test('through the hold: a squash or rebase leaves commits the repo never had, and none of them matter', async () => {
    const { repo, c2, deployed } = deployable('hold-squash')
    deployed(c2)
    commits.branch = ['c'.repeat(40)]
    expect((await issue((await holdOver(repo, c2)).id)).state).toBe('closed')
  })

  test('through the hold: no landed commit is red', async () => {
    const { repo, c3, deployed } = deployable('hold-no-landed')
    deployed(c3)
    await regression(await holdOver(repo, null), 'recorded no landed commit')
  })

  test('through the hold: a ship with nothing derived on it is red', async () => {
    const { repo, c2, c3, deployed } = deployable('hold-no-derived')
    deployed(c3)
    const made = await holdOver(repo, c2, async () => {
      await db.sql`UPDATE factory.issue_inbox SET payload = payload - 'derived' WHERE kind = 'ship'`
    })
    await regression(made, 'without its commits derived')
  })

  test('through the hold: no ship of the attempt on record is red', async () => {
    const { repo, c2, c3, deployed } = deployable('hold-no-ship')
    deployed(c3)
    const made = await holdOver(repo, c2, async () => {
      await db.sql`UPDATE factory.issue_inbox SET payload = jsonb_set(payload, '{attempt}', '9') WHERE kind = 'ship'`
    })
    await regression(made, 'no ship of attempt 1')
  })

  test('through the hold: a project that is gone by hold time is red', async () => {
    const { repo, c2, c3, deployed } = deployable('hold-no-project')
    deployed(c3)
    commits.landedAt = c2
    const { id, key } = await lead(repo)
    await prove(id, key, 'service')
    expect((await ship(id, key)).status).toBe(201)
    // The tick would file the repo's project again; the hold alone is asked here.
    await db.sql`DELETE FROM factory.projects WHERE repo = ${repo}`
    moveTo((await issue(id)).wake_at as Date)
    const real = { ...ports(), ...holdPorts({ sql: db.sql, clock, proof: new MakeAndProbes(), offTick }) }
    for (const minutes of [0, 1, 2, 4]) {
      clock.advance(minutes * 60_000)
      for (let i = 0; i < 3; i++) {
        await issuePass(db.sql, { now: () => clock.now(), ports: real })
        await offTick.settled()
      }
    }
    expect((await issue(id)).state).toBe('working')
    const [red] = await db.sql`SELECT payload FROM factory.issue_inbox WHERE key LIKE 'regression:%'`
    expect(JSON.stringify(red.payload.checks)).toContain('project is not known')
  })

  test('through the hold: a project that is gone is red even for a ship that deploys nothing', async () => {
    const { repo, c2 } = deployable('hold-no-project-docs')
    commits.landedAt = c2
    commits.paths = ['docs/x.md']
    const { id, key } = await lead(repo)
    expect((await ship(id, key)).status).toBe(201)
    await db.sql`DELETE FROM factory.projects WHERE repo = ${repo}`
    moveTo((await issue(id)).wake_at as Date)
    const real = { ...ports(), ...holdPorts({ sql: db.sql, clock, proof: new MakeAndProbes(), offTick }) }
    for (const minutes of [0, 1, 2, 4]) {
      clock.advance(minutes * 60_000)
      for (let i = 0; i < 3; i++) {
        await issuePass(db.sql, { now: () => clock.now(), ports: real })
        await offTick.settled()
      }
    }
    expect((await issue(id)).state).toBe('working')
  })

  test('through the hold: no `make version` is a regression saying the owner adds it', async () => {
    const { repo, c2 } = deployable('hold-bare', 'verify:\n\t@true\n')
    await regression(await holdOver(repo, c2), 'factory issue block', 'a lead does not')
  })

  test('through the hold: a change that deploys nothing skips it, and so do modes auto and none', async () => {
    const docs = deployable('hold-docs', 'verify:\n\t@true\n')
    commits.paths = ['docs/x.md']
    expect((await issue((await holdOver(docs.repo, null)).id)).state).toBe('closed')

    commits.paths = ['src/server.ts']
    for (const mode of ['auto', 'none']) {
      const name = `hold-${mode}`
      const repo = fixture.repo(name, {
        'project.yaml': SERVICE.replace('NAME', name)
          .replace('mode: make', `mode: ${mode}`)
          .replace(/ {2}probes:\n.*\n/, ''),
        Makefile: 'verify:\n\t@true\n',
      })
      made.push(repo)
      expect((await issue((await holdOver(repo, null)).id)).state).toBe('closed')
    }
  })
})

describe('finalize', () => {
  test('from a drop: the tab closes, the transcript is archived and linked, the worktree goes, the next Issue is promoted', async () => {
    const repo = newRepo(SERVICE)
    const { id, key } = await lead(repo)
    const next = await file(repo)
    await drive(2)
    expect((await issue(next)).state).toBe('queued')
    await post(id, 'drop', { reason: 'no', session: key })
    await drive(4)
    expect(await issue(id)).toMatchObject({ state: 'closed', outcome: 'dropped' })
    expect(runner.closed).toEqual([key])
    expect(copied).toEqual([join(archive, String(id), '1', `claude-${id}.jsonl`)])
    expect((await evidence(id)).find((e) => e.kind === 'transcript')?.link).toBe(copied[0] as string)
    expect(worktrees.removed).toHaveLength(1)
    expect((await issue(next)).state).toBe('working')
    expect(await trail(id)).toContain('issue_finalized')
  })

  test('the worktree is judged on the full shas resolved at ship, not the strings the lead typed', async () => {
    const { id, key } = await lead()
    await prove(id, key, 'service')
    const resolved = 'f'.repeat(40)
    commits.resolves = { abc1234: 'e'.repeat(40) }
    commits.branch = [resolved]
    expect((await post(id, 'ship', { summary: 'shipped', commits: ['abc1234'], session: key })).status).toBe(201)
    await holdEnds(id)
    await drive(4)
    expect(worktrees.removed).toHaveLength(1)
    expect(worktrees.removed[0]?.reported).toEqual(['e'.repeat(40), resolved])
  })

  test('a queued Issue that is stopped never had a lead: only its place goes', async () => {
    const repo = newRepo(SERVICE)
    const id = await file(repo)
    await enqueue(db.sql, { issueId: id, key: 'stop', kind: 'stop', at: clock.now() })
    await issuePass(db.sql, { now: () => clock.now(), ports: ports() })
    await offTick.settled()
    await issuePass(db.sql, { now: () => clock.now(), ports: ports() })
    expect(runner.closed).toEqual([])
    expect(worktrees.removed).toEqual([])
    expect(await trail(id)).toContain('issue_finalized')
  })

  test('a worktree that cannot go is kept, with a line for the owner, and everything else still ends', async () => {
    const { id, key } = await lead()
    worktrees.removal = { kept: 'it has uncommitted changes', path: '/work/tree' }
    await post(id, 'drop', { reason: 'no', session: key })
    await drive(3)
    const status = (await (await app.get('/status')).json()) as { attention: string[]; health: string[] }
    expect(status.attention).toEqual([])
    expect(status.health).toContain(`Issue ${id}: its worktree was kept (it has uncommitted changes): /work/tree`)
    expect(await trail(id)).toContain('issue_finalized')
    expect(await db.sql`SELECT 1 FROM factory.claims WHERE issue_id = ${id}`).toHaveLength(0)
  })

  test('a finalize that fails has given the place back, says so in status, and is tried again', async () => {
    const repo = newRepo(SERVICE)
    const { id, key } = await lead(repo)
    runner.failure = new Error('hc is down')
    const next = await file(repo)
    await post(id, 'drop', { reason: 'no', session: key })
    await drive(3)
    expect(await db.sql`SELECT 1 FROM factory.claims WHERE issue_id = ${id}`).toHaveLength(0)
    const status = (await (await app.get('/status')).json()) as { attention: string[]; health: string[] }
    expect(status.health).toContain(`Issue ${id}: it cannot be finalized: hc is down`)
    expect(await trail(id)).not.toContain('issue_finalized')
    runner.failure = undefined
    clock.advance(60_000)
    await drive(4)
    expect(await trail(id)).toContain('issue_finalized')
    expect((await issue(next)).state).toBe('working')
  })

  test.each(['queued', 'starting'])('a lead’s spawn left %s never starts, a crash’s lease or not', async (status) => {
    const { id, key } = await lead()
    await db.sql`UPDATE factory.spawns SET status = ${status} WHERE key = ${key}`
    await post(id, 'drop', { reason: 'no', session: key })
    expect(await issuePass(db.sql, { now: () => clock.now(), ports: ports() })).toEqual([])
    await offTick.settled()
    const [spawn] = await db.sql`SELECT status FROM factory.spawns WHERE key = ${key}`
    expect(spawn?.status).toBe('failed')
  })

  test('the workers it spawned are closed with the lead', async () => {
    const { id, key, repo } = await lead()
    await db.sql`
      INSERT INTO factory.spawns (key, repo, prompt, role, tier, effort, status, created_at, parent)
      VALUES ('its-worker', ${repo}, 'x', 'worker', 'sonnet', 'high', 'started', ${clock.now()}, ${key})`
    await db.sql`
      INSERT INTO factory.spawns (key, repo, prompt, role, tier, effort, status, created_at, parent)
      VALUES ('its-next-worker', ${repo}, 'x', 'worker', 'sonnet', 'high', 'queued', ${clock.now()}, ${key})`
    await post(id, 'drop', { reason: 'no', session: key })
    expect(await issuePass(db.sql, { now: () => clock.now(), ports: ports() })).toEqual([])
    await offTick.settled()
    await issuePass(db.sql, { now: () => clock.now(), ports: ports() })
    expect(runner.closed[0]).toBe(key)
    expect(runner.closed.slice(1).sort()).toEqual(['its-next-worker', 'its-worker'])
    const [next] = await db.sql`SELECT status FROM factory.spawns WHERE key = 'its-next-worker'`
    expect(next?.status).toBe('failed')
  })

  test('a plan: key is never passed to close', async () => {
    const { id, key, repo } = await lead()
    await db.sql`
      INSERT INTO factory.spawns (key, repo, prompt, role, tier, effort, status, created_at, parent)
      VALUES ('plan:lookalike', ${repo}, 'x', 'worker', 'sonnet', 'high', 'started', ${clock.now()}, ${key})`
    await post(id, 'drop', { reason: 'no', session: key })
    await drive(4)
    expect(await trail(id)).toContain('issue_finalized')
    expect(runner.closed).toEqual([key])
  })

  test('the place is back on the tick, whatever fills the off-tick jobs', async () => {
    const { id, key } = await lead()
    offTick = newJobs(0)
    await post(id, 'drop', { reason: 'no', session: key })
    await drive(2)
    expect(await db.sql`SELECT 1 FROM factory.claims WHERE issue_id = ${id}`).toHaveLength(0)
    expect(await trail(id)).not.toContain('issue_finalized')
  })

  test('a worktree asked for before the close is not made after it, when the Issue is reopened', async () => {
    const { id, key } = await lead()
    await post(id, 'drop', { reason: 'no', session: key })
    await drive(3)
    await db.sql`UPDATE factory.lead_worktrees SET status = 'pending', next_at = ${clock.now()} WHERE issue_id = ${id}`
    await db.sql`UPDATE factory.projects SET paused = true`
    await post(id, 'reopen', { reason: 'back' })
    await drive(2)
    expect((await issue(id)).state).toBe('queued')
    expect(worktrees.made).toHaveLength(1)
  })

  test('a transcript copied for real, with its subagents, and a file that is not one', async () => {
    const dir = mkdtempSync('/tmp/factory-transcripts-')
    const from = join(dir, 'abc.jsonl')
    writeFileSync(from, '{"not":"parsed"}\n')
    mkdirSync(join(dir, 'abc', 'subagents'), { recursive: true })
    writeFileSync(join(dir, 'abc', 'subagents', 'one.jsonl'), 'x')
    const to = join(archive, '1', '1', 'abc.jsonl')
    const store = new FileTranscripts()
    const root = dir
    expect(await store.copy({ from, to, root })).toBe(true)
    expect(await store.copy({ from, to, root })).toBe(true)
    expect(readFileSync(to, 'utf8')).toBe('{"not":"parsed"}\n')
    expect(existsSync(join(archive, '1', '1', 'abc', 'subagents', 'one.jsonl'))).toBe(true)
    expect(await store.copy({ from: join(dir, 'gone.jsonl'), to, root })).toBe(false)
    expect(await store.copy({ from: join(dir, 'abc'), to, root })).toBe(false)
    rmSync(dir, { recursive: true, force: true })
  })

  test('a path a pane reported is copied only from under the account’s projects directory, through no link', async () => {
    const dir = mkdtempSync('/tmp/factory-transcripts-')
    const root = join(dir, 'projects')
    const outside = join(dir, 'secrets')
    mkdirSync(join(root, 'p'), { recursive: true })
    mkdirSync(outside)
    writeFileSync(join(outside, 'id.jsonl'), 'a secret')
    writeFileSync(join(root, 'p', 'ok.jsonl'), 'a session')
    symlinkSync(join(outside, 'id.jsonl'), join(root, 'p', 'file-link.jsonl'))
    symlinkSync(outside, join(root, 'dir-link'))
    const to = join(archive, 'x.jsonl')
    const store = new FileTranscripts()
    expect(await store.copy({ from: join(root, 'p', 'ok.jsonl'), to, root: undefined })).toBe(false)
    expect(await store.copy({ from: join(outside, 'id.jsonl'), to, root })).toBe(false)
    expect(await store.copy({ from: join(root, '..', 'secrets', 'id.jsonl'), to, root })).toBe(false)
    expect(await store.copy({ from: join(root, 'p', 'file-link.jsonl'), to, root })).toBe(false)
    expect(await store.copy({ from: join(root, 'dir-link', 'id.jsonl'), to, root })).toBe(false)
    expect(existsSync(to)).toBe(false)
    expect(await store.copy({ from: join(root, 'p', 'ok.jsonl'), to, root })).toBe(true)
    rmSync(dir, { recursive: true, force: true })
  })

  test('the account comes from the spawn, not from what the pane says of itself', async () => {
    const { id, key } = await lead()
    const [spawn] = await db.sql`SELECT account FROM factory.spawns WHERE key = ${key}`
    await db.sql`UPDATE factory.sessions SET account = 'someone-else' WHERE id = ${key}`
    const asked: (string | null)[] = []
    const asking = {
      ...ports(),
      ...finalizePorts({
        sql: db.sql,
        clock,
        runner,
        worktrees,
        transcripts: { copy: async () => true },
        archiveDir: archive,
        projectsDir: async (account) => {
          asked.push(account)
          return '/projects'
        },
        making: () => false,
        offTick,
      }),
    }
    await post(id, 'drop', { reason: 'no', session: key })
    await issuePass(db.sql, { now: () => clock.now(), ports: asking })
    await offTick.settled()
    expect(asked).toEqual([spawn?.account as string])
  })

  test('a transcript that is not copied leaves a line, and the attempt still ends', async () => {
    const { id, key } = await lead()
    const refusing = {
      ...ports(),
      ...finalizePorts({
        sql: db.sql,
        clock,
        runner,
        worktrees,
        transcripts: new FileTranscripts(),
        archiveDir: archive,
        projectsDir: async () => undefined,
        making: () => false,
        offTick,
      }),
    }
    await post(id, 'drop', { reason: 'no', session: key })
    for (let i = 0; i < 3; i++) {
      await issuePass(db.sql, { now: () => clock.now(), ports: refusing })
      await offTick.settled()
    }
    expect(await trail(id)).toEqual(expect.arrayContaining(['transcript_missing', 'issue_finalized']))
    expect((await evidence(id)).filter((e) => e.kind === 'transcript')).toEqual([])
  })

  test('a transcript whose path cannot be resolved is not copied, and nothing throws', async () => {
    const dir = mkdtempSync('/tmp/factory-transcripts-')
    writeFileSync(join(dir, 'plain'), 'x')
    const store = new FileTranscripts()
    expect(await store.copy({ from: join(dir, 'plain', 'a.jsonl'), to: join(dir, 'out', 'a.jsonl'), root: dir })).toBe(
      false,
    )
    expect(
      await store.copy({ from: join(dir, 'a.jsonl'), to: join(dir, 'out', 'a.jsonl'), root: join(dir, 'plain', 'x') }),
    ).toBe(false)
  })

  test('a registry that cannot be read leaves a line, and the attempt still ends', async () => {
    const { id, key } = await lead()
    const broken = {
      ...ports(),
      ...finalizePorts({
        sql: db.sql,
        clock,
        runner,
        worktrees,
        transcripts: new FileTranscripts(),
        archiveDir: archive,
        projectsDir: async () => {
          throw new Error('cannot read the account registry')
        },
        making: () => false,
        offTick,
      }),
    }
    await post(id, 'drop', { reason: 'no', session: key })
    for (let i = 0; i < 3; i++) {
      await issuePass(db.sql, { now: () => clock.now(), ports: broken })
      await offTick.settled()
    }
    expect(await trail(id)).toEqual(expect.arrayContaining(['transcript_missing', 'issue_finalized']))
    expect(worktrees.removed).toHaveLength(1)
  })

  test('a finalize older than the running attempt leaves that attempt’s claim alone', async () => {
    const { id, repo } = await lead()
    // As a finalize planned before its port existed stands: attempt 1 closed and reopened, attempt 2 working and holding the claim.
    await db.sql`UPDATE factory.issues SET attempt = 2 WHERE id = ${id}`
    await db.sql`
      INSERT INTO factory.issue_effects (issue_id, key, kind, payload, created_at)
      VALUES (${id}, 'finalize:old', 'finalize', ${{ attempt: 1, hold: 0, cause: 'stop' }}, ${clock.now()})`
    const held = await db.sql`SELECT key FROM factory.claims WHERE issue_id = ${id}`
    expect(held).toHaveLength(1)
    for (let i = 0; i < 3; i++) {
      await issuePass(db.sql, { now: () => clock.now(), ports: ports() })
      await offTick.settled()
    }
    expect(await db.sql`SELECT key FROM factory.claims WHERE issue_id = ${id}`).toEqual(held)
    expect(runner.closed).toEqual([leadKey(id, 1)])
    expect(worktrees.removed).toEqual([{ repo, branch: `factory/${id}-1`, reported: [] }])
    expect(await trail(id)).toContain('issue_finalized')
  })
})

describe('reopen', () => {
  async function closed() {
    const made = await lead()
    commits.paths = ['docs/x.md']
    await post(made.id, 'close', { summary: 'done', commits: [SHA], session: made.key })
    await drive(3)
    commits.paths = ['src/server.ts']
    return made
  }

  test('within 30 days: queued, then a new attempt in a fresh worktree', async () => {
    const { id, repo } = await closed()
    clock.advance(REOPEN_WINDOW_MS - 60_000)
    const response = await post(id, 'reopen', { reason: 'it came back' })
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ id, state: 'queued', closedAt: null, outcome: null })
    await drive(4)
    expect(await issue(id)).toMatchObject({ state: 'working', attempt: 2 })
    expect(worktrees.made.map((w) => w.branch)).toEqual([`factory/${id}-1`, `factory/${id}-2`])
    expect(worktrees.removed).toEqual([{ repo, branch: `factory/${id}-1`, reported: [SHA] }])
  })

  test('past 30 days: refused, with the way to a new Issue', async () => {
    const { id } = await closed()
    clock.advance(REOPEN_WINDOW_MS + 60_000)
    const response = await post(id, 'reopen', { reason: 'it came back' })
    expect(response.status).toBe(409)
    expect(((await response.json()) as { error: string }).error).toContain('factory issue new')
    expect((await issue(id)).state).toBe('closed')
  })

  test('only a closed Issue reopens, and only with a reason', async () => {
    const { id } = await lead()
    expect((await post(id, 'reopen', { reason: 'x' })).status).toBe(409)
    expect((await post(id, 'reopen', {})).status).toBe(400)
    expect((await post(4242, 'reopen', { reason: 'x' })).status).toBe(404)
  })

  test('a reopened Issue proves itself again: the last attempt’s evidence does not count', async () => {
    const { id, key } = await lead()
    await prove(id, key, 'service')
    commits.paths = ['docs/x.md']
    await post(id, 'close', { summary: 'done', commits: [SHA], session: key })
    await drive(3)
    await post(id, 'reopen', { reason: 'it came back' })
    await drive(4)
    const second = leadKey(id, 2)
    await emit(second, 'session_started', { claudeSessionId: 'c2' })
    commits.paths = ['src/server.ts']
    expect((await ship(id, second)).status).toBe(409)
    await prove(id, second, 'service')
    expect((await ship(id, second)).status).toBe(201)
  })

  test('a reopened Issue starts no new lead until the old one is closed', async () => {
    const { id, key } = await lead()
    runner.failure = new Error('hc is down')
    await post(id, 'drop', { reason: 'no', session: key })
    await drive(2)
    expect((await post(id, 'reopen', { reason: 'it came back' })).status).toBe(200)
    await drive(3)
    expect(await issue(id)).toMatchObject({ state: 'queued', attempt: 1 })
    expect(worktrees.made).toHaveLength(1)
    runner.failure = undefined
    clock.advance(60_000)
    await drive(4)
    expect(await issue(id)).toMatchObject({ state: 'working', attempt: 2 })
    expect(runner.closed).toEqual([key])
  })
})

describe('stop', () => {
  const stopIt = (id: number, body: Record<string, unknown> = { reason: 'a door proof' }) => post(id, 'stop', body)

  test('why it exists: a lead’s drop does not reach a queued Issue', async () => {
    const id = await file(newRepo(SERVICE))
    await post(id, 'drop', { reason: 'no' })
    await issuePass(db.sql, { now: () => clock.now(), ports: {} })
    expect((await issue(id)).state).toBe('queued')
    expect(await trail(id)).toContain('refused')
  })

  test.each(['request', 'alert'])(
    'a queued %s with no lead closes as dropped and finalizes, with the reason on record',
    async (source) => {
      const { issue: filed } = await createIssue(
        db.sql,
        { source, sourceKey: `stop-${source}`, repo: newRepo(SERVICE), title: 'a proof', facts: {} },
        { repoRoots: [fixture.root], now: clock.now() },
      )
      const response = await stopIt(filed.id)
      expect(response.status).toBe(200)
      expect(await response.json()).toMatchObject({ id: filed.id, state: 'closed', outcome: 'dropped', attempt: 0 })
      await issuePass(db.sql, { now: () => clock.now(), ports: ports() })
      await offTick.settled()
      await issuePass(db.sql, { now: () => clock.now(), ports: ports() })
      expect(await trail(filed.id)).toEqual(['created -→queued', 'stop queued→closed', 'issue_finalized'])
      const [event] = await db.sql`SELECT payload FROM factory.issue_events WHERE kind = 'stop'`
      expect(event?.payload).toEqual({ reason: 'a door proof' })
      expect(runner.closed).toEqual([])
      expect(worktrees.removed).toEqual([])
      const open = await db.sql`SELECT 1 FROM factory.issue_effects WHERE done_at IS NULL AND cancelled_at IS NULL`
      expect(open).toHaveLength(0)
    },
  )

  test('a queued Issue that holds a claim gives it back', async () => {
    const repo = newRepo(SERVICE)
    const held = await file(repo)
    await drive(2)
    const waiting = await file(repo)
    await drive(2)
    await db.sql`
      INSERT INTO factory.claims (key, issue_id, urgent, queued_at, held_at)
      VALUES ('repo:other', ${waiting}, false, ${clock.now()}, ${clock.now()})`
    await stopIt(waiting)
    await drive(2)
    expect(await db.sql`SELECT 1 FROM factory.claims WHERE issue_id = ${waiting}`).toHaveLength(0)
    expect((await issue(held)).state).toBe('working')
  })

  test('a working lead is closed, its transcript archived and its worktree removed', async () => {
    const { id, key, repo } = await lead()
    expect((await stopIt(id)).status).toBe(200)
    await drive(2)
    expect(await issue(id)).toMatchObject({ state: 'closed', outcome: 'dropped' })
    expect(runner.closed).toEqual([key])
    expect(copied).toHaveLength(1)
    expect(worktrees.removed).toEqual([{ repo, branch: `factory/${id}-1`, reported: [] }])
    expect(await trail(id)).toContain('issue_finalized')
  })

  test('a watching Issue stops too, where a lead’s drop is refused, and its hold ends nothing', async () => {
    const { id } = await shipped()
    expect((await stopIt(id)).status).toBe(200)
    expect(await issue(id)).toMatchObject({ state: 'closed', outcome: 'dropped', wake_at: null })
    await drive(3)
    expect(proof.runs).toBe(0)
  })

  test('the same call again is one event; a closed Issue is refused, an unknown one 404, a reason required', async () => {
    const id = await file(newRepo(SERVICE))
    expect((await stopIt(id, { id: 's1', reason: 'x' })).status).toBe(200)
    expect((await stopIt(id, { id: 's1', reason: 'x' })).status).toBe(200)
    expect(await trail(id)).toEqual(['created -→queued', 'stop queued→closed'])
    const again = await stopIt(id)
    expect(again.status).toBe(409)
    expect(((await again.json()) as { error: string }).error).toContain('stop does not apply to a closed Issue')
    expect((await stopIt(4242)).status).toBe(404)
    expect((await stopIt(id, {})).status).toBe(400)
    expect((await stopIt(id, { reason: 'x', surprise: true })).status).toBe(400)
  })

  test('an id another event took is refused: no answer of something else reads as a stop', async () => {
    const id = await file(newRepo(SERVICE))
    await enqueue(db.sql, { issueId: id, key: `stop:${id}:taken`, kind: 'turn_started', at: clock.now() })
    const response = await stopIt(id, { id: 'taken', reason: 'x' })
    expect(response.status).toBe(409)
    expect((await issue(id)).state).toBe('queued')
    expect((await stopIt(id, { id: 'free', reason: 'x' })).status).toBe(200)
  })

  test('the token is required on the port, and the socket has no such route', async () => {
    const id = await file(newRepo(SERVICE))
    const bare = await app.bare(`/issues/${id}/stop`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ reason: 'x' }),
    })
    expect(bare.status).toBe(401)

    const dir = mkdtempSync('/tmp/factory-stop-sock-')
    const socketPath = join(dir, 'h.sock')
    const hooks = serveHooks({
      sql: db.sql,
      clock,
      token: TEST_TOKEN,
      socketPath,
      repoRoots: [fixture.root],
      roles: TEST_ROLES,
      slots: 2,
      commits,
    })
    let status = 0
    try {
      const viaSocket = await fetch(`http://localhost/issues/${id}/stop`, {
        method: 'POST',
        unix: socketPath,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ reason: 'x', session: 'anyone' }),
      })
      status = viaSocket.status
    } finally {
      await hooks.stop(true)
      rmSync(dir, { recursive: true, force: true })
    }
    expect(status).toBe(400)
    expect((await issue(id)).state).toBe('queued')
    expect(await db.sql`SELECT 1 FROM factory.issue_inbox WHERE kind = 'stop'`).toHaveLength(0)
  })
})

describe('the owner’s line', () => {
  const sent = async (id: number): Promise<string[]> =>
    (await db.sql`SELECT key FROM factory.notifications WHERE issue_id = ${id} ORDER BY key`).map(
      (row: { key: string }) => row.key,
    )

  test('a regression from the hold is one message, naming what failed; a green hold is none', async () => {
    const { id, key } = await shipped()
    proof.checks = [
      { name: 'make verify', ok: true, detail: 'exit 0' },
      { name: 'home', ok: false, detail: 'HTTP 500' },
    ]
    await holdEnds(id)
    expect(await sent(id)).toEqual([])
    await retriesEnd()
    await drive(3)
    expect(await sent(id)).toEqual([`notify:regression:${id}:1`])
    const [row] = await db.sql`SELECT text FROM factory.notifications WHERE issue_id = ${id}`
    expect(row?.text).toContain('home failed')

    proof.checks = [{ name: 'home', ok: true, detail: 'HTTP 200' }]
    await prove(id, key, 'service')
    await ship(id, key)
    await holdEnds(id)
    expect((await issue(id)).state).toBe('closed')
    expect(await sent(id)).toEqual([`notify:regression:${id}:1`])
  }, 20_000)

  test('issue stop sends nothing, with a lead or without one, and neither does its finalize', async () => {
    const queued = await file(newRepo(SERVICE))
    const running = await lead()
    const before = await db.sql`SELECT key FROM factory.notifications`
    await post(queued, 'stop', { reason: 'a door proof' })
    await post(running.id, 'stop', { reason: 'not needed' })
    await drive(3)
    await notifyFailures(db.sql, clock.now())
    expect(await trail(running.id)).toContain('issue_finalized')
    expect(await db.sql`SELECT key FROM factory.notifications`).toEqual(before)
  })

  test('a finalize that keeps failing reaches the failed sweep once, as a failure and not a wait', async () => {
    const { id, key } = await lead()
    runner.failure = new Error('hc is down')
    await post(id, 'drop', { reason: 'no', session: key })
    for (let i = 0; i < 8; i++) {
      await pass()
      clock.advance(5 * 60_000)
    }
    await notifyFailures(db.sql, clock.now())
    await notifyFailures(db.sql, clock.now())
    const [effect] = await db.sql`SELECT key FROM factory.issue_effects WHERE kind = 'finalize' AND issue_id = ${id}`
    expect(await sent(id)).toEqual([`notify:failed:finalize:${effect?.key}`])
    const [row] = await db.sql`SELECT text FROM factory.notifications WHERE issue_id = ${id}`
    expect(row?.text).toContain('hc is down')
  })

  test('one failed finalize is unlucky, however long it waited before: nothing is sent', async () => {
    const { id, key } = await lead()
    offTick = newJobs(0)
    await post(id, 'drop', { reason: 'no', session: key })
    for (let i = 0; i < 6; i++) await pass()
    const [waited] =
      await db.sql`SELECT attempts FROM factory.issue_effects WHERE kind = 'finalize' AND issue_id = ${id}`
    expect(waited?.attempts).toBe(0)
    offTick = newJobs()
    runner.failure = new Error('hc blinked')
    for (let i = 0; i < 2; i++) await pass()
    await notifyFailures(db.sql, clock.now())
    runner.failure = undefined
    clock.advance(60_000)
    await drive(3)
    await notifyFailures(db.sql, clock.now())
    expect(await sent(id)).toEqual([])
    expect(await trail(id)).toContain('issue_finalized')
  })
})

describe('an Issue watching since before this code', () => {
  /** As the live row stands: shipped without a gate, `hold_over` handled, and its `verify` waiting for the port this wave brings. */
  async function legacy() {
    const made = await lead()
    await db.sql`UPDATE factory.issues SET state = 'watching', hold = 1, wake_at = NULL WHERE id = ${made.id}`
    await db.sql`
      INSERT INTO factory.issue_effects (issue_id, key, kind, payload, created_at)
      VALUES (${made.id}, ${`verify:hold:${made.id}:1:1`}, 'verify', ${{ hold: 1, cause: 'hold_over', attempt: 1 }}, ${clock.now()})`
    return made
  }

  test('its waiting check runs once, on its old ship, and green closes and finalizes it', async () => {
    const { id, key, repo } = await legacy()
    await drive(4)
    expect(proof.runs).toBe(1)
    expect(await issue(id)).toMatchObject({ state: 'closed', outcome: 'done' })
    expect((await evidence(id)).map((e) => e.kind)).toContain('hold')
    expect(await trail(id)).toContain('issue_finalized')
    expect(runner.closed).toEqual([key])
    expect(worktrees.removed).toEqual([{ repo, branch: `factory/${id}-1`, reported: [] }])
    expect(await db.sql`SELECT 1 FROM factory.claims WHERE issue_id = ${id}`).toHaveLength(0)
  })

  test('red goes back to its lead as one note and one message, with no ship gate in the way', async () => {
    const { id, key } = await legacy()
    proof.checks = [{ name: 'make verify', ok: false, detail: 'exit 2' }]
    await drive(4)
    await retriesEnd()
    expect(await issue(id)).toMatchObject({ state: 'working', hold: 1 })
    expect((await notes(key)).map((note) => note.id)).toEqual([regressionPromptId(id, 1)])
    const rows = await db.sql`SELECT key FROM factory.notifications WHERE issue_id = ${id}`
    expect(rows).toEqual([{ key: `notify:regression:${id}:1` }])
  })

  test('no check runs while a deploy is still finishing: it waits out the settling, holds nothing, and fails nothing', async () => {
    const { id } = await legacy()
    const settling = holdPorts({
      sql: db.sql,
      clock,
      proof,
      offTick,
      settledAt: new Date(clock.now().getTime() + VERIFY_SETTLE_MS),
    })
    const round = () => issuePass(db.sql, { now: () => clock.now(), ports: settling })
    expect(await round()).toEqual([])
    await offTick.settled()
    expect(proof.runs).toBe(0)
    expect((await issue(id)).state).toBe('watching')
    clock.advance(VERIFY_SETTLE_MS)
    for (let i = 0; i < 3; i++) {
      await round()
      await offTick.settled()
    }
    expect(proof.runs).toBe(1)
    expect((await issue(id)).state).toBe('closed')
  })
})

describe('resume', () => {
  test('forks the archived session in a spawn of its own, which is no lead of the Issue', async () => {
    const { id, key, repo } = await lead()
    await post(id, 'drop', { reason: 'no', session: key })
    await drive(3)
    const response = await post(id, 'resume', { id: 'r1' })
    expect(response.status).toBe(201)
    const spawn = Spawn.parse(await response.json())
    expect(spawn).toMatchObject({ key: `resume-${id}-1-r1`, repo, role: 'lead' })
    await drive(1)
    const started = runner.started.find((s) => s.key === spawn.key)
    expect(started?.fork).toEqual({
      session: `claude-${id}`,
      archive: join(archive, String(id), '1', `claude-${id}.jsonl`),
    })
    expect(await db.sql`SELECT 1 FROM factory.sessions WHERE id = ${spawn.key} AND issue_id IS NOT NULL`).toHaveLength(
      0,
    )
    expect(await db.sql`SELECT 1 FROM factory.claims WHERE issue_id = ${id}`).toHaveLength(0)
  })

  test('an attempt with nothing archived, and an Issue that is not there', async () => {
    const { id } = await lead()
    expect((await post(id, 'resume', {})).status).toBe(409)
    expect((await post(4242, 'resume', {})).status).toBe(404)
  })
})

describe('the start after the worktree', () => {
  test('a drop filed while the worktree was made keeps the lead from starting', async () => {
    const id = await file(newRepo(SERVICE))
    let release: (() => void) | undefined
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const create = worktrees.create.bind(worktrees)
    worktrees.create = async (input) => {
      await gate
      return create(input)
    }
    const round = () =>
      tick({ sql: db.sql, clock, runner, issuePorts: ports(), classification, leadWorktrees: maker, projects: sync })
    for (let i = 0; i < 3; i++) {
      await round()
      await classification.settled()
      clock.advance(5_000)
    }
    expect((await issue(id)).state).toBe('working')
    release?.()
    await maker.settled()
    // Filed after the pass took its inbox, before the effect looks: the row is there and not handled.
    await enqueue(db.sql, { issueId: id, key: 'late-drop', kind: 'drop', at: clock.now(), payload: { attempt: 1 } })
    const lead_ = ports().start_lead
    const [effect]: { id: string; key: string; payload: Effect['payload'] }[] = await db.sql`
      SELECT id, key, payload FROM factory.issue_effects WHERE kind = 'start_lead' AND issue_id = ${id}`
    await expect(
      lead_?.({
        id: Number(effect?.id),
        issueId: id,
        key: effect?.key ?? '',
        kind: 'start_lead',
        payload: effect?.payload ?? null,
        attempts: 1,
      }),
    ).rejects.toThrow('a stop of Issue')
    await drive(4)
    expect((await issue(id)).state).toBe('closed')
    expect(runner.started).toEqual([])
  })
})

describe('the replay test: a crash after every effect of the hold and finalize', () => {
  class Crash extends Error {}

  /** Stops the process at the n-th point: around each port call, and between the steps of a pass. */
  class Faults {
    seen = 0
    crashed = false
    constructor(private readonly at: number) {}
    point(): void {
      if (this.crashed) return
      if (this.seen++ === this.at) {
        this.crashed = true
        throw new Crash(`crash at point ${this.at}`)
      }
    }
  }

  /** The outside world, which keeps what was done across a crash: each thing done once, however often it is asked. */
  class World {
    closed = new Set<string>()
    copied = new Set<string>()
    removed = new Set<string>()
    proofs = 0
  }

  function portsWith(world: World, faults: Faults, tickJobs: OffTick): EffectPorts {
    const around = async <T>(work: () => Promise<T>): Promise<T> => {
      faults.point()
      const result = await work()
      faults.point()
      return result
    }
    return {
      ...leadPorts({ sql: db.sql, clock, roles: TEST_ROLES, repoRoots: [fixture.root] }),
      ...holdPorts({
        sql: db.sql,
        clock,
        offTick: tickJobs,
        proof: {
          // The same hold reads the same: what a crash interrupts is the call, not what production looks like.
          run: () =>
            around(async () => {
              world.proofs++
              const [row] = await db.sql`SELECT max(hold) AS hold FROM factory.issues`
              const ok = row.hold > 1
              return [{ name: 'make verify', ok, detail: ok ? 'exit 0' : 'exit 2: broken' }]
            }),
        },
      }),
      ...finalizePorts({
        sql: db.sql,
        clock,
        offTick: tickJobs,
        archiveDir: archive,
        projectsDir: async () => '/projects',
        making: () => false,
        runner: { close: (key) => around(async () => void world.closed.add(key)) },
        worktrees: {
          remove: ({ branch }) =>
            around(async () => {
              world.removed.add(branch)
              return { removed: true as const }
            }),
        },
        transcripts: {
          copy: ({ to }) =>
            around(async () => {
              world.copied.add(to)
              return true
            }),
        },
      }),
    }
  }

  /** The hold's answer is keyed by the hold, so a replay finds what it filed: the proof of a check that ended is not asked twice. */
  async function passWith(world: World, faults: Faults, jobs: OffTick): Promise<void> {
    faults.point()
    await issuePass(db.sql, { now: () => clock.now(), ports: portsWith(world, faults, jobs) })
    await jobs.settled()
    faults.point()
    if (faults.crashed) throw new Crash('crashed in a job')
  }

  const derived = {
    commits: [SHA],
    paths: ['docs/x.md'],
    required: [],
    mergedAt: null,
    holdMs: DEFAULT_HOLD_MS,
    problem: null,
  }

  async function run(id: number, world: World, faults: Faults, jobs: OffTick): Promise<void> {
    const shipAs = async (n_: number) => {
      await enqueue(db.sql, {
        issueId: id,
        key: `${id}:1:ship:${n_}`,
        kind: 'ship',
        at: clock.now(),
        session: leadKey(id, 1),
        payload: { attempt: 1, derived },
      })
    }
    const holdIsOver = async (hold: number) => {
      const [row] = await db.sql`SELECT state, hold, wake_at FROM factory.issues WHERE id = ${id}`
      if (row.state === 'watching' && row.hold === hold && row.wake_at) moveTo(row.wake_at as Date)
    }
    await shipAs(1)
    for (let i = 0; i < 2; i++) await passWith(world, faults, jobs)
    await holdIsOver(1)
    for (let i = 0; i < 6; i++) await passWith(world, faults, jobs)
    for (const minutes of [1, 2, 4]) {
      clock.advance(minutes * 60_000)
      for (let i = 0; i < 6; i++) await passWith(world, faults, jobs)
    }
    await shipAs(2)
    for (let i = 0; i < 2; i++) await passWith(world, faults, jobs)
    await holdIsOver(2)
    for (let i = 0; i < 6; i++) await passWith(world, faults, jobs)
  }

  const snapshot = async (id: number) => ({
    state: (await issue(id)).state,
    outcome: (await issue(id)).outcome,
    hold: (await issue(id)).hold,
    events: await trail(id),
    effects: (
      await db.sql`SELECT key, done_at IS NOT NULL AS done FROM factory.issue_effects WHERE issue_id = ${id} ORDER BY id`
    ).map((r: { key: string; done: boolean }) => `${r.key}:${r.done}`),
    inbox: (
      await db.sql`SELECT key, result FROM factory.issue_inbox WHERE issue_id = ${id} AND session IS DISTINCT FROM ${leadKey(id, 1)} ORDER BY key`
    ).map((r: { key: string; result: string | null }) => `${r.key}:${r.result}`),
    notes: (await notes(leadKey(id, 1))).map((note) => note.id),
    notifications: (await db.sql`SELECT key FROM factory.notifications ORDER BY key`).map(
      (row: { key: string }) => row.key,
    ),
    evidence: (await evidence(id)).map((e) => `${e.kind}:${e.link}`).sort(),
    claims: (await db.sql`SELECT 1 FROM factory.claims WHERE issue_id = ${id}`).length,
  })

  /** An Issue whose lead has started, as the tick leaves it, with its session reporting. */
  async function reset(): Promise<number> {
    await db.reset()
    clock = new FakeClock()
    const repo = fixture.repo(`replay${++repos}`, {})
    const id = await file(repo)
    const key = leadKey(id, 1)
    await db.sql`UPDATE factory.issues SET state = 'working', attempt = 1, classified_at = ${clock.now()} WHERE id = ${id}`
    await db.sql`
      INSERT INTO factory.spawns (key, repo, prompt, role, tier, effort, status, session, created_at, issue_id)
      VALUES (${key}, ${repo}, 'x', 'lead', 'sonnet', 'high', 'started', 't1', ${clock.now()}, ${id})`
    await openSession(db.sql, { id: key, spawnKey: key, pane: 't1', issueId: id, at: clock.now() })
    await emit(key, 'session_started', { claudeSessionId: 'c1', transcriptPath: '/tmp/t/c1.jsonl' })
    return id
  }

  test('every crash point replays to the run without one, with zero duplicates', async () => {
    const id = await reset()
    const clean = new World()
    const never = new Faults(Number.MAX_SAFE_INTEGER)
    await run(id, clean, never, new OffTick())
    const expected = await snapshot(id)
    expect(expected).toMatchObject({ state: 'closed', outcome: 'done', hold: 2, claims: 0 })
    expect(expected.notes).toEqual([regressionPromptId(id, 1)])
    expect(expected.notifications).toEqual([`notify:regression:${id}:1`])
    expect(expected.events.filter((e) => e === 'issue_finalized')).toHaveLength(1)
    expect(expected.evidence).toHaveLength(2)
    // hold 1 is red four times (the check and its three retries), hold 2 green once
    expect(clean.proofs).toBe(5)
    const points = never.seen
    expect(points).toBeGreaterThan(20)

    for (let at = 0; at < points; at++) {
      const issueId = await reset()
      const world = new World()
      const faults = new Faults(at)
      await run(issueId, world, faults, new OffTick()).catch((error) => {
        if (!(error instanceof Crash)) throw error
      })
      expect(faults.crashed).toBe(true)
      // The new process: what ran off the tick is gone, the world is what it was, and the events come again under their keys.
      await run(issueId, world, new Faults(Number.MAX_SAFE_INTEGER), new OffTick())
      const after = await snapshot(issueId)
      // Ids and paths follow the Issue, which each run files afresh.
      expect(JSON.stringify(after).replaceAll(`${issueId}`, 'N')).toEqual(
        JSON.stringify(expected).replaceAll(`${id}`, 'N'),
      )
      expect(world.closed.size).toBe(1)
      expect(world.removed.size).toBe(1)
      expect(world.copied.size).toBe(1)
    }
  }, 180_000)
})

describe('the CLI', () => {
  const CLI = join(import.meta.dir, '..', '..', 'cli', 'bin', 'factory.ts')
  async function factory(env: Record<string, string>, input: string | undefined, ...args: string[]) {
    const proc = Bun.spawn(['bun', CLI, ...args], {
      env: {
        ...process.env,
        FACTORY_URL: app.url.href,
        FACTORY_TOKEN: TEST_TOKEN,
        FACTORY_SOCKET: '/nonexistent',
        ...env,
      },
      stdin: input === undefined ? 'ignore' : Buffer.from(input),
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const [stdout, stderr, code] = await Promise.all([proc.stdout.text(), proc.stderr.text(), proc.exited])
    return { stdout, stderr, code }
  }

  test('ship exits non-zero and says what is missing; evidence and a second ship go through', async () => {
    const { id, key } = await lead()
    const env = { FACTORY_SESSION: key }
    const refused = await factory(env, undefined, 'issue', 'ship', String(id), '--summary', 's', '--commit', SHA)
    expect(refused.code).toBe(5)
    expect(refused.stderr).toContain('evidence missing')
    expect(refused.stderr).toContain('service')

    const filed = await factory(
      env,
      'the numbers are fine',
      'issue',
      'evidence',
      String(id),
      '--kind',
      'service',
      '--stdin',
    )
    expect(filed.code).toBe(0)
    expect((await evidence(id))[0]?.payload).toEqual({ text: 'the numbers are fine' })

    const accepted = await factory(env, undefined, 'issue', 'ship', String(id), '--summary', 's', '--commit', SHA)
    expect(accepted.code).toBe(0)
    expect((await issue(id)).state).toBe('watching')
  }, 20_000)

  test('stop takes the token and never falls back to the socket; a refusal exits 5', async () => {
    const id = await file(newRepo(SERVICE))
    expect((await factory({}, undefined, 'issue', 'stop', String(id))).code).toBe(2)
    const noToken = await factory({ FACTORY_TOKEN: '' }, undefined, 'issue', 'stop', String(id), '--reason', 'x')
    expect(noToken.code).toBe(3)
    expect((await issue(id)).state).toBe('queued')
    const stopped = await factory(
      {},
      undefined,
      'issue',
      'stop',
      String(id),
      '--reason',
      'a door proof',
      '--format',
      'plain',
    )
    expect(stopped.code).toBe(0)
    expect(stopped.stdout).toContain(`${id}\tclosed\tdropped`)
    expect((await factory({}, undefined, 'issue', 'stop', String(id), '--reason', 'x')).code).toBe(5)
  })

  test('the flags of evidence, ship, reopen and resume', async () => {
    const { id, key } = await lead()
    const env = { FACTORY_SESSION: key }
    expect((await factory(env, undefined, 'issue', 'ship', String(id), '--summary', 's')).code).toBe(2)
    expect((await factory(env, undefined, 'issue', 'evidence', String(id), '--kind', 'ui')).code).toBe(2)
    const two = await factory(env, undefined, 'issue', 'evidence', String(id), '--kind', 'ui', '--link', 'x', '--stdin')
    expect(two.code).toBe(2)
    const dir = mkdtempSync('/tmp/factory-evidence-file-')
    const large = join(dir, 'large.txt')
    writeFileSync(large, 'x'.repeat(32 * 1024 + 1))
    const tooLarge = await factory(env, undefined, 'issue', 'evidence', String(id), '--kind', 'ui', '--file', large)
    expect(tooLarge.code).toBe(2)
    expect(tooLarge.stderr).toContain('larger than')
    const small = join(dir, 'small.txt')
    writeFileSync(small, 'all good')
    expect((await factory(env, undefined, 'issue', 'evidence', String(id), '--kind', 'ui', '--file', small)).code).toBe(
      0,
    )
    rmSync(dir, { recursive: true, force: true })

    expect((await factory({}, undefined, 'issue', 'reopen', String(id))).code).toBe(2)
    expect((await factory({}, undefined, 'issue', 'reopen', String(id), '--reason', 'x')).code).toBe(5)
    expect((await factory({}, undefined, 'issue', 'resume', String(id))).code).toBe(5)
  }, 20_000)
})
