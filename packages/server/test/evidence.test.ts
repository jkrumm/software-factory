/* oxlint-disable typescript/await-thenable -- bun types the `rejects` matchers as void; they return a promise */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { defaultManifest, IssueEvidenceAck, type ProjectManifest, Spawn } from '@software-factory/contract'
import { serveHooks } from '../src/http.ts'
import { FileTranscripts } from '../src/issues/archive.ts'
import { Classification } from '../src/issues/classify.ts'
import { type CommitRead, type Commits, GitCommits } from '../src/issues/commits.ts'
import { createIssue } from '../src/issues/create.ts'
import { type Effect, type EffectPorts } from '../src/issues/effects.ts'
import { kindOfPath, requiredEvidence } from '../src/issues/evidence.ts'
import { finalizePorts } from '../src/issues/finalize.ts'
import { type HoldCheck, holdPorts, MakeAndProbes, type Proof, VERIFY_SETTLE_MS } from '../src/issues/hold.ts'
import { enqueue } from '../src/issues/inbox.ts'
import { leadPorts } from '../src/issues/lead.ts'
import { WorktreeMaker } from '../src/issues/leadtree.ts'
import { DEFAULT_HOLD_MS, REOPEN_WINDOW_MS } from '../src/issues/lifecycle.ts'
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
  async read({ reported }: { reported: readonly string[] }): Promise<CommitRead> {
    this.calls++
    if (this.failure) throw this.failure
    return { commits: [...reported, ...this.branch], paths: this.paths, mergedAt: this.mergedAt }
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
  proof = new FakeProof()
  worktrees = new FakeWorktrees()
  maker = new WorktreeMaker({ sql: db.sql, worktrees, now: () => clock.now() })
  runner = new PaneRunner()
  offTick = new OffTick()
  classification = new Classification({
    sql: db.sql,
    classifier: new FakeClassifier(),
    roles: TEST_ROLES,
    now: () => clock.now(),
  })
  sync = new ProjectSync({ sql: db.sql, roots: [fixture.root], now: () => clock.now() })
  archive = mkdtempSync('/tmp/factory-archive-')
  copied = []
  await app?.stop()
  app = startApp({ sql: db.sql, clock, commits, repoRoots: [fixture.root] })
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

  test('the same call again gets the same answer; a new one after the evidence is accepted', async () => {
    const { id, key } = await lead()
    await ship(id, key, { id: 's1' })
    expect(commits.calls).toBe(1)
    expect((await ship(id, key, { id: 's1' })).status).toBe(409)
    expect(commits.calls).toBe(1)
    await prove(id, key, 'service')
    expect((await ship(id, key, { id: 's2' })).status).toBe(201)
    expect((await issue(id)).state).toBe('watching')
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
    expect(worktrees.removed).toEqual([{ repo, branch: `factory/${id}-1` }])
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
    expect(proof.runs).toBe(2)
    expect(await notes(key)).toHaveLength(1)
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
      Makefile: 'verify:\n\t@echo the deployed service is broken; exit 3\n',
    })
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
    expect((await issue(id)).state).toBe('working')
    const sent = await notes(key)
    expect(sent).toHaveLength(1)
    expect(sent[0]?.text).toContain('the deployed service is broken')
    expect(sent[0]?.text).toContain('Error 3')
    expect(runner.typed.filter((t) => t.text.includes('the deployed service is broken'))).toHaveLength(1)
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
    const status = (await (await app.get('/status')).json()) as { attention: string[] }
    expect(status.attention).toContain(`Issue ${id}: its worktree was kept (it has uncommitted changes): /work/tree`)
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
    const status = (await (await app.get('/status')).json()) as { attention: string[] }
    expect(status.attention).toContain(`Issue ${id}: it cannot be finalized: hc is down`)
    expect(await trail(id)).not.toContain('issue_finalized')
    runner.failure = undefined
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

  test('the place is back on the tick, whatever fills the off-tick jobs', async () => {
    const { id, key } = await lead()
    offTick = new OffTick(0)
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
    expect(await store.copy({ from, to })).toBe(true)
    expect(await store.copy({ from, to })).toBe(true)
    expect(readFileSync(to, 'utf8')).toBe('{"not":"parsed"}\n')
    expect(existsSync(join(archive, '1', '1', 'abc', 'subagents', 'one.jsonl'))).toBe(true)
    expect(await store.copy({ from: join(dir, 'gone.jsonl'), to })).toBe(false)
    expect(await store.copy({ from: join(dir, 'abc'), to })).toBe(false)
    rmSync(dir, { recursive: true, force: true })
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
    expect(worktrees.removed).toEqual([{ repo, branch: `factory/${id}-1` }])
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
    expect(worktrees.removed).toEqual([{ repo, branch: `factory/${id}-1` }])
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
    for (let i = 0; i < 8; i++) await pass()
    await notifyFailures(db.sql, clock.now())
    await notifyFailures(db.sql, clock.now())
    const [effect] = await db.sql`SELECT key FROM factory.issue_effects WHERE kind = 'finalize' AND issue_id = ${id}`
    expect(await sent(id)).toEqual([`notify:failed:finalize:${effect?.key}`])
    const [row] = await db.sql`SELECT text FROM factory.notifications WHERE issue_id = ${id}`
    expect(row?.text).toContain('hc is down')
  })

  test('one failed finalize is unlucky, however long it waited before: nothing is sent', async () => {
    const { id, key } = await lead()
    offTick = new OffTick(0)
    await post(id, 'drop', { reason: 'no', session: key })
    for (let i = 0; i < 6; i++) await pass()
    const [waited] =
      await db.sql`SELECT attempts FROM factory.issue_effects WHERE kind = 'finalize' AND issue_id = ${id}`
    expect(waited?.attempts).toBe(0)
    offTick = new OffTick()
    runner.failure = new Error('hc blinked')
    for (let i = 0; i < 2; i++) await pass()
    await notifyFailures(db.sql, clock.now())
    runner.failure = undefined
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
    expect(worktrees.removed).toEqual([{ repo, branch: `factory/${id}-1` }])
    expect(await db.sql`SELECT 1 FROM factory.claims WHERE issue_id = ${id}`).toHaveLength(0)
  })

  test('red goes back to its lead as one note and one message, with no ship gate in the way', async () => {
    const { id, key } = await legacy()
    proof.checks = [{ name: 'make verify', ok: false, detail: 'exit 2' }]
    await drive(4)
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
    expect(spawn).toMatchObject({ key: `resume-${id}-1-r1`, repo, role: 'lead', placement: 'tab' })
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
    for (let i = 0; i < 4; i++) await passWith(world, faults, jobs)
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
    expect(clean.proofs).toBe(2)
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
  })

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
  })
})
