import { afterAll, beforeAll, expect, test } from 'bun:test'
import { join } from 'node:path'
import { hook, must, sessionOf } from '../flow.ts'
import { type Lab, startLab } from '../planning/lab.ts'
import { runLoop, working } from './support.ts'

/**
 * The self-watch loop against the real server and Postgres: the repo it watches is `software-factory`, a real git repo of
 * the lab. GitHub is a local fake (`FACTORY_GITHUB_API_URL`), the migration files are read by real git from the lab's
 * checkout, the waits, the leads and the regression are the factory's own Issues. Every pass is driven through
 * `factory loop run selfwatch`; the intervals are off. A second server (`beat`) has a leads loop that never ran, to show a
 * stale heartbeat.
 */
const REPO = 'software-factory'
const GRACE_MS = 1500
const IDLE_MS = 1000
const PROJECT = `apiVersion: factory/v2\nname: ${REPO}\nleads: 8\n`

let lab: Lab
let beat: Lab
let github: FakeCi

interface Run {
  id: number
  name: string
  conclusion: string | null
  head_sha: string
  created_at: string
}

interface FakeCi {
  url: string
  runs: Run[]
  requests: string[]
  stop(): void
}

/** The two routes the CI reader calls: the repository (its default branch) and the completed workflow runs of a branch. */
function fakeCi(): FakeCi {
  const state: FakeCi = { url: '', runs: [], requests: [], stop: () => undefined }
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch(req) {
      const url = new URL(req.url)
      state.requests.push(`${url.pathname}${url.search}`)
      if (url.pathname === `/repos/o/${REPO}`) return Response.json({ default_branch: 'master' })
      if (url.pathname === `/repos/o/${REPO}/actions/runs`)
        return Response.json({ workflow_runs: state.runs.map(shape) })
      return new Response('not found', { status: 404 })
    },
  })
  state.url = `http://127.0.0.1:${server.port}`
  state.stop = () => void server.stop(true)
  return state
}

const shape = (run: Run) => ({ ...run, html_url: `https://example.com/runs/${run.id}` })

let runs = 0
const ci = (name: string, conclusion: string, minutesAgo: number, id = 1000 + ++runs): Run => ({
  id,
  name,
  conclusion,
  head_sha: `${id}`.padEnd(40, 'a'),
  created_at: new Date(Date.now() - minutesAgo * 60_000).toISOString(),
})

const git = async (cwd: string, ...args: string[]): Promise<string> => {
  const proc = Bun.spawn(['git', '-C', cwd, '-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], {
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' },
  })
  const [out, err, code] = await Promise.all([proc.stdout.text(), proc.stderr.text(), proc.exited])
  if (code !== 0) throw new Error(`git ${args.join(' ')}: ${err}`)
  return out.trim()
}

const checkout = () => join(lab.root, REPO)
const MIGRATIONS = 'apps/server/migrations'

beforeAll(async () => {
  github = fakeCi()
  lab = await startLab({
    leads: true,
    repos: { [REPO]: { project: PROJECT } },
    env: {
      FACTORY_LEADS_PER_ACCOUNT: '16',
      FACTORY_GITHUB_TOKEN: 'ghp_fake_0123456789',
      FACTORY_GITHUB_API_URL: github.url,
      FACTORY_SELFWATCH_GRACE_MS: String(GRACE_MS),
      FACTORY_STEWARD_IDLE_MS: String(IDLE_MS),
    },
  })
  // a leads loop with an interval that never fires in a test, and a tick judged stale after three seconds
  beat = await startLab({
    repos: { [REPO]: { project: PROJECT } },
    env: { FACTORY_LOOP_LEADS_MS: '3600000', FACTORY_HEARTBEAT_STALE_MS: '3000' },
  })
  expect((await lab.cli(['project', 'sync'])).code).toBe(0)
  expect((await beat.cli(['project', 'sync'])).code).toBe(0)

  // origin/master with a pair of applied twins (0993) and one migration
  await lab.commit(REPO, {
    [`${MIGRATIONS}/0993_x.sql`]: '-- x',
    [`${MIGRATIONS}/0993_y.sql`]: '-- y',
    [`${MIGRATIONS}/0997_a.sql`]: '-- a',
  })
  await git(checkout(), 'update-ref', 'refs/remotes/origin/master', 'HEAD')
})

afterAll(async () => {
  await lab.stop()
  await beat.stop()
  github.stop()
})

const sql = () => lab.world.db.sql

interface Filed {
  title: string
  text: string
  repo: string
  issue_id: string | null
}

/** The signals the loop sent for a kind, oldest first. */
const signalsOf = async (kind: string, on: Lab = lab): Promise<Filed[]> =>
  (await on.world.db.sql`
    SELECT title, text, repo, issue_id FROM factory.intake_signals
    WHERE source = ${`agent:${REPO}`} AND text LIKE ${`Self-watch ${kind} (%`} ORDER BY received_at, id`) as Filed[]

const rowOf = async (key: string) =>
  (
    (await sql()`SELECT * FROM factory.selfwatch_findings WHERE subject_key = ${key}`) as {
      cleared_at: Date | null
      first_seen_at: Date
      evidence_hash: string
    }[]
  )[0]

const notesOf = async (issue: string): Promise<number> =>
  Number(
    (
      await sql()`SELECT count(*) AS n FROM factory.issue_events WHERE issue_id = ${issue} AND kind = 'noted' AND result = 'applied'`
    )[0].n,
  )

const pass = async (on: Lab = lab) => {
  const ran = await runLoop(on, 'selfwatch')
  expect(ran.error).toBeNull()
  return ran.summary ?? ''
}

/** The repo's origin is a github.com address while `fn` runs (the CI reader names the repository by it), the bare repo after. */
async function onGithub<T>(fn: () => Promise<T>): Promise<T> {
  const bare = await git(checkout(), 'remote', 'get-url', 'origin')
  await git(checkout(), 'remote', 'set-url', 'origin', `https://github.com/o/${REPO}.git`)
  try {
    return await fn()
  } finally {
    await git(checkout(), 'remote', 'set-url', 'origin', bare)
  }
}

const passOnGithub = () => onGithub(() => pass())

test('ci_red: two red runs file one signal naming the workflow and both runs; red then green, one red, and a cancelled run in between', async () => {
  // one red run, or red then green: nothing
  github.runs = [ci('Deploy', 'failure', 10, 2001)]
  await passOnGithub()
  expect(await signalsOf('ci_red')).toEqual([])
  github.runs = [
    ci('Deploy', 'failure', 10, 2002),
    ci('Deploy', 'success', 20, 2003),
    ci('Deploy', 'failure', 30, 2004),
  ]
  await passOnGithub()
  expect(await signalsOf('ci_red')).toEqual([])
  // the default branch is asked for, then that branch's runs
  expect(github.requests.some((r) => r.includes('branch=master'))).toBe(true)

  // two red runs with a cancelled one between them
  github.runs = [
    ci('Deploy', 'failure', 10, 2011),
    ci('Deploy', 'cancelled', 20, 2012),
    ci('Deploy', 'timed_out', 30, 2013),
  ]
  await passOnGithub()
  const [filed, ...more] = await signalsOf('ci_red')
  expect(more).toEqual([])
  expect(filed?.repo).toBe(REPO)
  expect(filed?.title).toContain('CI is red')
  expect(filed?.title).toContain('Deploy')
  expect(filed?.text).toContain('run 2011')
  expect(filed?.text).toContain('run 2013')
  expect(filed?.text).not.toContain('run 2012')
  expect(filed?.text).toContain('Reproduce:')
  expect(filed?.issue_id).toMatch(/^issue_/)
})

test('once per subject: the same evidence files nothing, a third red run amends the open Issue, a cleared condition that returns is filed anew', async () => {
  const [first] = await signalsOf('ci_red')
  const issue = first?.issue_id as string
  const before = await signalsOf('ci_red')
  const notes = await notesOf(issue)
  const issues = Number((await sql()`SELECT count(*) AS n FROM factory.issues WHERE repo = ${REPO}`)[0].n)

  // an unchanged condition: nothing more
  expect(await passOnGithub()).toContain('filed 0')
  expect(await signalsOf('ci_red')).toHaveLength(before.length)
  expect(await notesOf(issue)).toBe(notes)

  // a newer red run changes the evidence: filed again under the same title, intake amends the open Issue
  github.runs = [ci('Deploy', 'failure', 1, 2021), ...github.runs]
  expect(await passOnGithub()).toContain('filed 1')
  const after = await signalsOf('ci_red')
  const amended = after.at(-1)
  expect(amended?.text).toContain('run 2021')
  expect(amended?.title).toBe(first?.title)
  expect(Number((await sql()`SELECT count(*) AS n FROM factory.issues WHERE repo = ${REPO}`)[0].n)).toBe(issues)
  const amendedIssue = amended?.issue_id ?? issue
  expect(amendedIssue).toBe(issue)
  expect(await notesOf(issue)).toBeGreaterThan(notes)

  // the workflow goes green: the row is cleared, nothing is filed
  const open = await rowOf('ci_red:Deploy')
  expect(open?.cleared_at).toBeNull()
  github.runs = [ci('Deploy', 'success', 1, 2031), ...github.runs]
  expect(await passOnGithub()).toContain('cleared 1')
  expect((await rowOf('ci_red:Deploy'))?.cleared_at).not.toBeNull()
  expect(await signalsOf('ci_red')).toHaveLength(after.length)

  // two red runs again: the subject is filed anew (the first Issue is still open, so intake takes it as a repeat of it)
  github.runs = [ci('Deploy', 'failure', 0, 2041), ci('Deploy', 'failure', 1, 2042), ...github.runs]
  expect(await passOnGithub()).toContain('filed 1')
  const again = await rowOf('ci_red:Deploy')
  expect(again?.cleared_at).toBeNull()
  expect(again?.first_seen_at.getTime() ?? 0).toBeGreaterThan(open?.first_seen_at.getTime() ?? Number.POSITIVE_INFINITY)
  expect((await signalsOf('ci_red')).at(-1)?.text).toContain('run 2041')

  // the CI is green: the subject is gone
  github.runs = [ci('Deploy', 'success', 0, 2051), ci('Deploy', 'success', 1, 2052)]
  await passOnGithub()
  expect((await rowOf('ci_red:Deploy'))?.cleared_at).not.toBeNull()
})

const withBranch = async (name: string, files: Record<string, string>): Promise<void> => {
  await git(checkout(), 'checkout', '-q', '-b', name, 'refs/remotes/origin/master')
  for (const [file, text] of Object.entries(files)) await Bun.write(join(checkout(), file), text)
  await git(checkout(), 'add', '-A')
  await git(checkout(), 'commit', '-q', '-m', name)
  await git(checkout(), 'checkout', '-q', 'main')
}

test('migration_clash: a branch adding a second file of a number master holds files one signal naming both; the shared 0993 does not', async () => {
  expect(await pass()).toContain('filed 0')
  expect(await signalsOf('migration_clash')).toEqual([])

  await withBranch('clash-one', { [`${MIGRATIONS}/0997_b.sql`]: '-- b', [`${MIGRATIONS}/0993_z.sql`]: '-- z' })
  await pass()
  const [filed, ...more] = await signalsOf('migration_clash')
  expect(more).toEqual([])
  expect(filed?.repo).toBe(REPO)
  expect(filed?.title).toContain('0997_a.sql')
  expect(filed?.title).toContain('0997_b.sql')
  expect(filed?.text).toContain('0997_a.sql on origin/master')
  expect(filed?.text).toContain('0997_b.sql on clash-one')
  expect(filed?.text).not.toContain('0993')
  expect(filed?.issue_id).toMatch(/^issue_/)

  // the same condition again: nothing
  await pass()
  expect(await signalsOf('migration_clash')).toHaveLength(1)
})

test('two clashing numbers are two subjects, two signals, not collapsed into one Issue', async () => {
  await Bun.write(join(checkout(), `${MIGRATIONS}/0995_gamma.sql`), '-- gamma')
  await git(checkout(), 'add', '-A')
  await git(checkout(), 'commit', '-q', '-m', 'gamma')
  await git(checkout(), 'update-ref', 'refs/remotes/origin/master', 'HEAD')
  // the first branch now sits behind the new base: 0997_a on master clashes with 0997_b as before
  await withBranch('clash-two', { [`${MIGRATIONS}/0995_delta.sql`]: '-- delta' })
  await pass()
  const all = await signalsOf('migration_clash')
  expect(all).toHaveLength(2)
  const second = all.find((s) => s.text.includes('0995_delta.sql'))
  expect(second?.title).toContain('0995_gamma.sql')
  expect(new Set(all.map((s) => s.issue_id)).size).toBe(2)
  expect(await rowOf('migration_clash:0997')).toBeDefined()
  expect(await rowOf('migration_clash:0995')).toBeDefined()

  // the branches go: both subjects are cleared
  await git(checkout(), 'branch', '-q', '-D', 'clash-one', 'clash-two')
  expect(await pass()).toContain('cleared 2')
  expect((await rowOf('migration_clash:0997'))?.cleared_at).not.toBeNull()
  expect((await rowOf('migration_clash:0995'))?.cleared_at).not.toBeNull()
})

test('wait_overdue: a timer and a dependency wait past their exit and grace are filed; one before its exit is not', async () => {
  const soon = await working(lab, REPO, 'sleeps a short while')
  const later = await working(lab, REPO, 'sleeps for an hour')
  const waiting = await working(lab, REPO, 'waits for its dependency')
  const open = await working(lab, REPO, 'waits for a dependency that stays open')
  const closing = await must(lab, [
    'issue',
    'new',
    '--repo',
    REPO,
    '--title',
    'the dependency that is dropped',
    '--key',
    'sw-dep-1',
  ])
  const open2 = await must(lab, [
    'issue',
    'new',
    '--repo',
    REPO,
    '--title',
    'the dependency that stays',
    '--key',
    'sw-dep-2',
  ])
  const dep = (closing.json as { issue: string }).issue
  const stays = (open2.json as { issue: string }).issue

  const defer = (issue: string, ...args: string[]) =>
    must(lab, ['issue', 'defer', issue, '--attempt', '1', ...args], 'agent')
  await defer(soon, '--until', new Date(Date.now() + 1200).toISOString())
  await defer(later, '--until', new Date(Date.now() + 3_600_000).toISOString())
  await defer(waiting, '--after', dep)
  await defer(open, '--after', stays)
  await must(lab, ['issue', 'cancel', dep, '--reason', 'not needed'])

  // before the exit and its grace: nothing
  await pass()
  expect(await signalsOf('wait_overdue')).toEqual([])

  await Bun.sleep(1200 + GRACE_MS + 300)
  await pass()
  const filed = await signalsOf('wait_overdue')
  expect(filed).toHaveLength(2)
  expect(filed.every((s) => s.text.startsWith('Self-watch wait_overdue ('))).toBe(true)
  const timer = filed.find((s) => s.text.includes(`${soon}:timer`))
  expect(timer?.title).toContain('timer wait overdue for')
  expect(timer?.text).toContain('until:')
  const dependency = filed.find((s) => s.text.includes(`${waiting}:dependency`))
  expect(dependency?.text).toContain(`after: ${dep} closed`)
  expect(dependency?.repo).toBe(REPO)
  expect(filed.some((s) => s.text.includes(later) || s.text.includes(open))).toBe(false)

  // the planning loop wakes both: the condition clears
  await must(lab, ['issue', 'cancel', soon, '--reason', 'done'])
  await must(lab, ['issue', 'cancel', waiting, '--reason', 'done'])
  expect(await pass()).toContain('cleared 2')
  await must(lab, ['issue', 'cancel', later, '--reason', 'done'])
  await must(lab, ['issue', 'cancel', open, '--reason', 'done'])
  await must(lab, ['issue', 'cancel', stays, '--reason', 'done'])
})

test('lead_idle: a lead quiet past the steward threshold is filed, a lead in its turn is not', async () => {
  const busy = await working(lab, REPO, 'the lead that is busy')
  const quiet = await working(lab, REPO, 'the lead that went quiet')
  for (const issue of [busy, quiet]) {
    const session = sessionOf(issue)
    await hook(lab.world, 'session-start', session, { source: 'startup', session_id: `c-${issue}` })
    await hook(lab.world, 'user-prompt-submit', session, { session_id: `c-${issue}` })
  }
  await hook(lab.world, 'stop', sessionOf(quiet), {
    stop_hook_active: false,
    background_tasks: [{ status: 'running' }],
  })

  await Bun.sleep(IDLE_MS + 300)
  await pass()
  const [filed, ...more] = await signalsOf('lead_idle')
  expect(more).toEqual([])
  expect(filed?.repo).toBe(REPO)
  expect(filed?.title).toContain('idle past the steward')
  expect(filed?.text).toContain('went quiet')
  expect(filed?.text).toContain(`${quiet} (`)
  expect(filed?.text).toContain('idle since')
  expect(filed?.text).not.toContain(busy)

  // the lead takes a new turn: the condition clears
  await hook(lab.world, 'user-prompt-submit', sessionOf(quiet), { session_id: 'again' })
  expect(await pass()).toContain('cleared 1')
  await must(lab, ['issue', 'cancel', busy, '--reason', 'done'])
  await must(lab, ['issue', 'cancel', quiet, '--reason', 'done'])
})

/** An Issue that regressed after its ship: the ship's stored commits evidence says what the ship carried. */
async function regressed(title: string, ship: { paths: string[]; deploys: boolean }): Promise<string> {
  const issue = await working(lab, REPO, title)
  const [row] = await sql()`SELECT version FROM factory.issues WHERE id = ${issue}`
  const version = (row.version as number) + 1
  const key = `sw-ship-${issue}`
  await sql()`
    INSERT INTO factory.issue_events (id, issue_id, key, kind, payload, actor, at, result, version, from_state, to_state, wait)
    VALUES (${`evt-${key}`}, ${issue}, ${key}, 'regressed', ${{ watch: null, detail: 'verify went red' }}::jsonb, 'factory', now(),
      'applied', ${version}, 'watching', 'waiting', ${{ since: version, reason: 'regressed', detail: 'regressed 3 times: verify went red' }}::jsonb)`
  await sql()`UPDATE factory.issues SET state = 'waiting', wait_reason = 'regressed', version = ${version} WHERE id = ${issue}`
  await sql()`
    INSERT INTO factory.quality_ships (id, issue_id, attempt, event_key, at, result, reported)
    VALUES (${`ship-${key}`}, ${issue}, 1, ${key}, now(), 'accepted', '[]'::jsonb)`
  await sql()`
    INSERT INTO factory.quality_evidence (id, issue_id, attempt, source_key, kind, at, payload)
    VALUES (${`ev-${key}`}, ${issue}, 1, ${key}, 'commits', now(),
      ${{ commits: ['c0ffee1'.padEnd(40, '0')], landedAt: null, mergedAt: null, deploys: ship.deploys, paths: ship.paths }}::jsonb)`
  return issue
}

test('inert_regression: a regression whose ship held only inert paths is filed; one with a path a deploy carries is not', async () => {
  const docs = await regressed('docs only ship', {
    paths: ['docs/guide.md', 'apps/server/test/a.test.ts'],
    deploys: false,
  })
  const code = await regressed('code ship', { paths: ['docs/guide.md', 'apps/server/src/main.ts'], deploys: true })
  await pass()
  const [filed, ...more] = await signalsOf('inert_regression')
  expect(more).toEqual([])
  expect(filed?.repo).toBe(REPO)
  expect(filed?.text).toContain('docs only ship')
  expect(filed?.text).toContain(`${docs} (`)
  expect(filed?.text).toContain('docs/guide.md')
  expect(filed?.text).toContain('c0ffee1')
  expect(filed?.text).not.toContain(code)

  // a path a deploy carries, without the deploys flag, is no inert ship either
  await sql()`UPDATE factory.quality_evidence SET payload = jsonb_set(payload, '{paths}', '["apps/server/src/main.ts"]') WHERE issue_id = ${docs}`
  expect(await pass()).toContain('cleared 1')
})

test('heartbeat_stale: a leads tick that never ran is filed once the limit passes; a healthy heartbeat files nothing', async () => {
  // the leads loop ran: healthy, whatever the age of the server
  await runLoop(beat, 'leads')
  await pass(beat)
  expect(await signalsOf('heartbeat_stale', beat)).toEqual([])

  // the tick is older than the limit
  await Bun.sleep(3500)
  await pass(beat)
  const [filed, ...more] = await signalsOf('heartbeat_stale', beat)
  expect(more).toEqual([])
  expect(filed?.repo).toBe(REPO)
  expect(filed?.title).toContain('heartbeat is stale')
  expect(filed?.text).toContain('heartbeat class: tick')
  expect(filed?.text).toContain('tickAt:')
  expect(filed?.text).toContain('the last successful tick')

  // once per subject: the seconds in the reason move, the evidence of the class does not
  await pass(beat)
  expect(await signalsOf('heartbeat_stale', beat)).toHaveLength(1)

  // a tick: healthy again, the row is cleared
  await runLoop(beat, 'leads')
  await pass(beat)
  const [row] = await beat.world.db
    .sql`SELECT cleared_at FROM factory.selfwatch_findings WHERE subject_key = 'heartbeat_stale:tick'`
  expect(row?.cleared_at).not.toBeNull()
})

test('a lab with a plain heartbeat files none', async () => {
  await pass()
  expect(await signalsOf('heartbeat_stale')).toEqual([])
})
