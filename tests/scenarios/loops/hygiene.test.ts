import { afterAll, beforeAll, expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { type Lab, startLab } from '../planning/lab.ts'
import { admitted, must, tick } from '../flow.ts'
import { callsOf, runLoop, script, state } from './support.ts'

/**
 * The hygiene loop against the real server and Postgres, the real checker and real git: every project is a small repo with
 * a bare origin made by the lab, a `Makefile` whose `check` is red (and leaves a mark, so a sweep can be counted) and
 * documents with broken links. `factory-hygiene` is the fake agw, scripted per repo (`"repo":"<name>"` in its input).
 * Every pass is driven through `factory loop run hygiene` (the intervals are off); the other projects are set aside with a
 * fresh row so the one under test is the one that is due.
 */
let lab: Lab
let dir: string
let hygieneScript: string
const PROJECTS = ['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'h7']
const FAKE_RETRY_MS = 3_600_000

const projectFile = (name: string) =>
  `apiVersion: factory/v2\nname: ${name}\nleads: 2 # a lab repo: two leads are plenty\n`
const mark = (repo: string) => join(dir, `${repo}.mark`)
const sweepsOf = (repo: string): number =>
  existsSync(mark(repo)) ? readFileSync(mark(repo), 'utf8').split('\n').filter(Boolean).length : 0

/** A document long enough to count as edited lately, with `links` broken links on its first lines. */
const doc = (links: number): string =>
  [
    ...Array.from({ length: links }, (_, i) => `See [page ${i}](missing-${i}.md).`),
    ...Array.from({ length: 16 }, (_, i) => `Line ${i} of the document.`),
  ].join('\n')

// the mark is left by the throwaway checkout only: the confirming run in the project's own checkout is not a sweep
const makefile = (repo: string) =>
  `check:\n\t@case "$$(pwd)" in */hygiene/*) echo run >> ${mark(repo)} ;; esac\n\t@echo the gate is red\n\t@exit 1\n`

beforeAll(async () => {
  dir = await mkdtemp('/tmp/factory-hygiene-scenario-')
  hygieneScript = join(dir, 'hygiene.json')
  await script(hygieneScript, [])
  lab = await startLab({
    leads: true,
    repos: {
      ...Object.fromEntries(PROJECTS.map((name) => [name, { project: projectFile(name) }])),
      work: {},
    },
    env: {
      FACTORY_DATA_DIR: join(dir, 'data'),
      FACTORY_FAKE_HYGIENE_SCRIPT: hygieneScript,
      FACTORY_HYGIENE_EVERY_MS: String(7 * 24 * 3_600_000),
      FACTORY_HYGIENE_RETRY_MS: String(FAKE_RETRY_MS),
    },
  })
  // the check probe runs the gate in a test slot (`factory slot run … -- <command>`): here the slot is the command itself
  const slot = join(lab.world.bin, 'factory')
  await writeFile(slot, '#!/bin/sh\nwhile [ "$1" != "--" ]; do shift; done\nshift\nexec "$@"\n')
  await chmod(slot, 0o755)
  for (const name of [...PROJECTS, 'work']) await lab.commit(name, { Makefile: makefile(name) })
  await lab.commit('h1', { 'docs/guide.md': doc(1) })
  await lab.commit('h2', Object.fromEntries([1, 2, 3, 4, 5].map((n) => [`docs/d${n}.md`, doc(n)])))
  await lab.commit('h3', { 'docs/guide.md': doc(0) })
  await lab.commit('h4', { 'docs/guide.md': doc(0) })
  await lab.commit('work', { 'docs/guide.md': doc(2) })
  expect((await lab.cli(['project', 'sync'])).code).toBe(0)
})

afterAll(async () => {
  await lab.stop()
  await rm(dir, { recursive: true, force: true })
})

const sql = () => lab.world.db.sql

/** Every other project gets a fresh row (when it has none), and this one's placeholder row goes: it alone is due. */
const isolate = async (repo: string) => {
  await sql()`DELETE FROM factory.hygiene_passes WHERE repo = ${repo} AND id LIKE 'hygiene_aside_%'`
  for (const other of PROJECTS.filter((name) => name !== repo)) {
    await sql()`
      INSERT INTO factory.hygiene_passes (id, repo, at, ref, report, judgment, filed, over_budget, failed)
      SELECT ${`hygiene_aside_${other}`}, ${other}, now(), 'aside',
        '{"ref":"aside","runs":[],"findings":[],"stale":[],"slop":[]}'::jsonb,
        '{"outcome":"skipped","attempts":0,"judgedAt":null,"reason":"aside","findings":[]}'::jsonb,
        '[]'::jsonb, '[]'::jsonb, '[]'::jsonb
      WHERE NOT EXISTS (SELECT 1 FROM factory.hygiene_passes WHERE repo = ${other})`
  }
}

const sweep = async (repo: string) => {
  await isolate(repo)
  return runLoop(lab, 'hygiene')
}

const json = <T>(value: unknown): T => (typeof value === 'string' ? (JSON.parse(value) as T) : (value as T))

interface Pass {
  id: string
  repo: string
  at: Date
  ref: string
  report: { runs: { probe: string; outcome: string; covers?: string }[]; findings: { key: string }[] }
  judgment: { outcome: string; attempts: number; judgedAt: string | null; reason: string; findings: { path: string }[] }
  filed: { key: string; title: string }[]
  over_budget: { key: string; title: string }[]
  failed: { key: string; reason: string }[]
  lifecycle: { key: string; issue: string; action: string; why: string }[]
}

const passes = async (repo: string): Promise<Pass[]> => {
  const rows: Record<string, unknown>[] =
    await sql()`SELECT * FROM factory.hygiene_passes WHERE repo = ${repo} AND id NOT LIKE 'hygiene_aside_%' ORDER BY at`
  return rows.map((row) => ({
    id: row.id as string,
    repo: row.repo as string,
    at: row.at as Date,
    ref: row.ref as string,
    report: json(row.report),
    judgment: json(row.judgment),
    filed: json(row.filed),
    over_budget: json(row.over_budget),
    failed: json(row.failed),
    lifecycle: json(row.lifecycle),
  }))
}

const signalsFrom = async (repo: string) =>
  (await sql()`SELECT title, text, repo FROM factory.intake_signals WHERE source = ${`agent:${repo}`} ORDER BY title`) as {
    title: string
    text: string
    repo: string
  }[]

const issuesOf = async (repo: string): Promise<number> =>
  Number((await sql()`SELECT count(*) AS n FROM factory.issues WHERE repo = ${repo}`)[0].n)

const asksFor = async (repo: string) => (await callsOf(lab, 'factory-hygiene')).filter((c) => c.input.repo === repo)

const answer = (repo: string, ...findings: [string, string][]) => [
  {
    match: `"repo":"${repo}"`,
    answer: {
      findings: findings.map(([path, title]) => ({
        kind: 'slop',
        path,
        title,
        evidence: `${path} repeats itself`,
        fix: 'Cut the repeated lines.',
      })),
      read: findings.length,
      reason: 'scripted',
    },
  },
]

const judgedAgo = (repo: string, interval: string) =>
  sql()`UPDATE factory.hygiene_passes
    SET judgment = jsonb_set(CASE WHEN jsonb_typeof(judgment) = 'string' THEN (judgment #>> '{}')::jsonb ELSE judgment END, '{judgedAt}',
      to_jsonb(to_char((now() - ${interval}::interval) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')))
    WHERE repo = ${repo} AND id NOT LIKE 'hygiene_aside_%'`

const worktrees = async (repo: string): Promise<string[]> => {
  const proc = Bun.spawn(['git', '-C', join(lab.root, repo), 'worktree', 'list', '--porcelain'], { stdout: 'pipe' })
  const out = await new Response(proc.stdout).text()
  await proc.exited
  return out.split('\n').filter((line) => line.startsWith('worktree '))
}

test('a due project is swept: red check and a broken link are filed, the answer is checked, the checkout is gone', async () => {
  await script(
    hygieneScript,
    answer('h1', ['docs/guide.md', 'The guide repeats itself'], ['docs/ghost.md', 'A file nobody asked about']),
  )
  const ran = await sweep('h1')
  expect(ran.error).toBeNull()
  expect(ran.summary).toMatch(
    /^swept h1 @[0-9a-f]{7}: filed 3 finding\(s\) as one signal, 0 over budget; judgment answered$/,
  )

  // the pass's findings are one signal and one Issue: a section per key, under the key
  const signals = await signalsFrom('h1')
  expect(signals).toHaveLength(1)
  const [batch] = signals
  expect(batch?.title).toBe('Hygiene: check, links, slop (h1)')
  expect(batch?.repo).toBe('h1')
  const text = batch?.text ?? ''
  expect(text.match(/^Swept: h1 @ /gm)).toHaveLength(1)
  for (const heading of ['check', 'links:docs/guide.md', 'judgment:slop:docs/guide.md'])
    expect(text).toContain(`: ${heading}`)
  expect(text).toContain('the gate is red')
  expect(text).toContain('Reproduce: make check')
  expect(text).toContain('missing-0.md')
  expect(text).toContain('Finding: The guide repeats itself')
  expect(text).toContain('Fix: Cut the repeated lines.')
  expect(text).toContain('Evidence: docs/guide.md repeats itself')

  const [ask, ...more] = await asksFor('h1')
  expect(more).toEqual([])
  expect(String(ask?.input.cwd)).toMatch(/\/hygiene\/h1-[0-9a-f]{7}-/)
  expect(String(ask?.input.ref)).toMatch(/^[0-9a-f]{40}$/)
  expect(((ask?.input.slop ?? []) as { path: string }[]).map((c) => c.path)).toContain('docs/guide.md')
  expect(ask?.input.max).toBe(3)

  const [pass] = await passes('h1')
  expect(pass?.filed.map((f) => f.key).sort()).toEqual(['check', 'judgment:slop:docs/guide.md', 'links:docs/guide.md'])
  expect(pass?.over_budget).toEqual([])
  expect(pass?.failed).toHaveLength(1)
  expect(pass?.failed[0]?.reason).toContain('docs/ghost.md')
  expect(pass?.judgment).toMatchObject({ outcome: 'answered', attempts: 1 })
  expect(pass?.judgment.findings.map((f) => f.path)).toEqual(['docs/guide.md'])
  expect(pass?.report.runs.find((r) => r.probe === 'check')?.outcome).toBe('found')
  expect(pass?.ref).toBe(String(ask?.input.ref))
  expect(await issuesOf('h1')).toBe(1)
  // and the ledger has a row per key on that one Issue
  expect(
    (await sql()`SELECT key FROM factory.loop_findings WHERE repo = 'h1' ORDER BY key`).map(
      (r: { key: string }) => r.key,
    ),
  ).toEqual(['check', 'judgment:slop:docs/guide.md', 'links:docs/guide.md'])

  expect(existsSync(String(ask?.input.cwd))).toBe(false)
  expect(await worktrees('h1')).toEqual([`worktree ${join(lab.root, 'h1')}`])
  expect(sweepsOf('h1')).toBe(1)
})

test('not due again in the window; a week on it is swept again and nothing is filed for what an open Issue holds', async () => {
  const again = await sweep('h1')
  expect(again.summary).toBe('not due')
  expect(await signalsFrom('h1')).toHaveLength(1)
  expect(await passes('h1')).toHaveLength(1)

  await sql()`UPDATE factory.hygiene_passes SET at = at - interval '8 days' WHERE repo = 'h1'`
  const later = await sweep('h1')
  expect(later.error).toBeNull()
  // every key is on the one open Issue: the pass files nothing, the judgment finding included
  expect(later.summary).toMatch(
    /^swept h1 @[0-9a-f]{7}: filed 0 finding\(s\) as one signal, 0 over budget; judgment answered$/,
  )
  expect(await passes('h1')).toHaveLength(2)
  expect(await issuesOf('h1')).toBe(1)
  expect(sweepsOf('h1')).toBe(2)
})

test('more findings than the budget: five are filed, the rest are named in the record', async () => {
  const docs = [1, 2, 3, 4].map((n): [string, string] => [`docs/d${n}.md`, `Document ${n} repeats itself`])
  await script(hygieneScript, answer('h2', ...docs))
  const ran = await sweep('h2')
  expect(ran.error).toBeNull()
  expect(ran.summary).toMatch(/filed 5 finding\(s\) as one signal, 5 over budget; judgment answered$/)

  const [pass] = await passes('h2')
  expect(pass?.filed.map((f) => f.key)).toEqual([
    'check',
    'links:docs/d5.md',
    'links:docs/d4.md',
    'judgment:slop:docs/d1.md',
    'judgment:slop:docs/d2.md',
  ])
  expect(pass?.over_budget.map((f) => f.key)).toEqual([
    'links:docs/d3.md',
    'links:docs/d2.md',
    'links:docs/d1.md',
    'judgment:slop:docs/d3.md',
    'judgment:slop:docs/d4.md',
  ])
  expect((await asksFor('h2'))[0]?.input.max).toBe(2)
  // five findings, one Issue with five sections
  const [batch2, ...rest] = await signalsFrom('h2')
  expect(rest).toEqual([])
  for (const key of pass?.filed.map((f) => f.key) ?? []) expect(batch2?.text).toContain(`: ${key}`)
  expect(await issuesOf('h2')).toBe(1)
})

test('a failed judgment keeps the deterministic signals and is retried at the stored commit, with no new sweep', async () => {
  await script(hygieneScript, [{ match: '"repo":"h3"', answer: null, fail: true }])
  const ran = await sweep('h3')
  expect(ran.error).toBeNull()
  expect(ran.summary).toMatch(/filed 1 finding\(s\) as one signal, 0 over budget; judgment failed$/)
  const [first] = await passes('h3')
  expect(first?.judgment).toMatchObject({ outcome: 'failed', attempts: 1 })
  expect(first?.filed.map((f) => f.key)).toEqual(['check'])

  expect((await sweep('h3')).summary).toBe('not due')

  await script(hygieneScript, answer('h3', ['docs/guide.md', 'The guide repeats itself']))
  await judgedAgo('h3', '2 hours')
  const retried = await sweep('h3')
  expect(retried.error).toBeNull()
  expect(retried.summary).toMatch(
    /^judged again h3 @[0-9a-f]{7}: filed 1 finding\(s\) as one signal, 0 over budget; judgment answered$/,
  )

  const all = await passes('h3')
  expect(all).toHaveLength(1)
  expect(all[0]?.id).toBe(first?.id)
  expect(all[0]?.at).toEqual(first?.at as Date)
  expect(all[0]?.report).toEqual(first?.report as Pass['report'])
  expect(all[0]?.judgment).toMatchObject({ outcome: 'answered', attempts: 2 })
  expect(all[0]?.filed.map((f) => f.key)).toEqual(['check', 'judgment:slop:docs/guide.md'])
  expect(sweepsOf('h3')).toBe(1)

  const asks = await asksFor('h3')
  expect(asks).toHaveLength(2)
  expect(asks[1]?.input.ref).toBe(first?.ref)
  const keyOf = (args: string[]) => args[args.indexOf('--idempotency-key') + 1] ?? ''
  expect(keyOf(asks[0]?.args ?? [])).toEndWith(':1')
  expect(keyOf(asks[1]?.args ?? [])).toEndWith(':2')
})

test('after three attempts the judgment is not asked again', async () => {
  await script(hygieneScript, [{ match: '"repo":"h4"', answer: null, fail: true }])
  expect((await sweep('h4')).summary).toMatch(/judgment failed$/)
  for (const attempt of [2, 3]) {
    await judgedAgo('h4', '2 hours')
    expect((await sweep('h4')).summary).toMatch(/^judged again h4 .*judgment failed$/)
    expect((await passes('h4'))[0]?.judgment.attempts).toBe(attempt)
  }
  await judgedAgo('h4', '2 hours')
  expect((await sweep('h4')).summary).toBe('not due')
  expect(await asksFor('h4')).toHaveLength(3)
  expect(sweepsOf('h4')).toBe(1)
})

test('a work repo without project.yaml is never swept', async () => {
  await sql()`DELETE FROM factory.hygiene_passes`
  const summaries: string[] = []
  for (let i = 0; i < PROJECTS.length + 1; i++) summaries.push((await runLoop(lab, 'hygiene')).summary ?? '')
  expect(summaries.slice(0, PROJECTS.length).every((s) => s.startsWith('swept h'))).toBe(true)
  expect(summaries.at(-1)).toBe('not due')
  const rows = await sql()`SELECT repo FROM factory.hygiene_passes ORDER BY repo`
  expect(rows.map((r: { repo: string }) => r.repo)).toEqual(PROJECTS)
  expect(sweepsOf('work')).toBe(0)
  expect(await signalsFrom('work')).toEqual([])
})

// ---- the lifecycle: a finding heals; a done Issue whose finding is red again is reopened, never filed twice ----------------------------

const GREEN = 'check:\n\t@true\n'
const agedWeek = (repo: string) =>
  sql()`UPDATE factory.hygiene_passes SET at = at - interval '8 days' WHERE repo = ${repo} AND id NOT LIKE 'hygiene_aside_%'`
const issueIds = async (repo: string): Promise<string[]> =>
  (await sql()`SELECT id FROM factory.issues WHERE repo = ${repo} ORDER BY id`).map((r: { id: string }) => r.id)
const closure = async (issue: string) => {
  const [row] = await sql()`SELECT state, outcome FROM factory.issues WHERE id = ${issue}`
  const events = await sql()`
    SELECT kind, actor, payload FROM factory.issue_events WHERE issue_id = ${issue} AND result = 'applied' AND kind IN ('closed', 'reopened') ORDER BY version`
  return {
    state: row.state as string,
    outcome: row.outcome as string | null,
    events: events as { kind: string; actor: string; payload: unknown }[],
  }
}

test('a probe that turns green closes its Issue as healed, with the run as the reason', async () => {
  const red = await sweep('h5')
  expect(red.error).toBeNull()
  const [issue, ...others] = await issueIds('h5')
  expect(others).toEqual([])
  expect((await state(lab, issue ?? '')).state).toBe('settling')
  expect((await passes('h5'))[0]?.filed.map((f) => f.key)).toEqual(['check'])

  await lab.commit('h5', { Makefile: GREEN })
  await agedWeek('h5')
  const green = await sweep('h5')
  expect(green.error).toBeNull()
  expect(green.summary).toMatch(
    /^swept h5 @[0-9a-f]{7}: filed 0 finding\(s\) as one signal, 0 over budget; judgment skipped; healed 1$/,
  )

  const ended = await closure(issue ?? '')
  expect(ended).toMatchObject({ state: 'closed', outcome: 'healed' })
  expect(ended.events).toHaveLength(1)
  expect(ended.events[0]).toMatchObject({ kind: 'closed', actor: 'factory' })
  expect(JSON.stringify(ended.events[0]?.payload)).toContain('make check')
  const [, newest] = await passes('h5')
  expect(newest?.report.runs.find((r) => r.probe === 'check')?.outcome).toBe('clean')
  expect(await issueIds('h5')).toEqual([issue ?? ''])
  expect(await signalsFrom('h5')).toHaveLength(1)
})

test('a still-red probe after a done Issue reopens that Issue: no second Issue, no signal, and an open one is left alone', async () => {
  expect((await sweep('h6')).error).toBeNull()
  const [issue, ...others] = await issueIds('h6')
  expect(others).toEqual([])

  // a lead takes it and closes it done; the Makefile is still red
  await admitted(lab, issue ?? '')
  await tick(lab)
  await must(
    lab,
    ['issue', 'close', issue ?? '', '--attempt', '1', '--outcome', 'done', '--reason', 'fixed it'],
    'agent',
  )
  expect(await closure(issue ?? '')).toMatchObject({ state: 'closed', outcome: 'done' })

  await agedWeek('h6')
  const again = await sweep('h6')
  expect(again.error).toBeNull()
  expect(again.summary).toMatch(
    /^swept h6 @[0-9a-f]{7}: filed 0 finding\(s\) as one signal, 0 over budget; judgment skipped; reopened 1$/,
  )
  const reopened = await closure(issue ?? '')
  expect(reopened.state).toBe('queued')
  expect(reopened.events.map((e) => [e.kind, e.actor])).toEqual([
    ['closed', 'lead'],
    ['reopened', 'factory'],
  ])
  expect(JSON.stringify(reopened.events[1]?.payload)).toContain('red again')
  expect(await issueIds('h6')).toEqual([issue ?? ''])
  expect(await signalsFrom('h6')).toHaveLength(1)
  expect((await passes('h6'))[1]?.lifecycle.map((e) => [e.key, e.action])).toEqual([['check', 'reopened']])

  // red a week later with its Issue open again: it stays the one Issue, and nothing is filed or noted
  await agedWeek('h6')
  const third = await sweep('h6')
  expect(third.summary).toMatch(/filed 0 finding\(s\) as one signal/)
  expect(await issueIds('h6')).toEqual([issue ?? ''])
  expect(await signalsFrom('h6')).toHaveLength(1)
})

test('a lead at work is told once that the probe is green: the next pass finds the note stored and records nothing', async () => {
  expect((await sweep('h7')).error).toBeNull()
  const [issue] = await issueIds('h7')
  await admitted(lab, issue ?? '')
  await tick(lab)
  expect((await state(lab, issue ?? '')).state).toBe('working')

  await lab.commit('h7', { Makefile: GREEN })
  await agedWeek('h7')
  const told = await sweep('h7')
  expect(told.summary).toMatch(/; noted 1$/)
  const notes = async () =>
    (
      await sql()`SELECT payload FROM factory.issue_events WHERE issue_id = ${issue} AND kind = 'noted' AND actor = 'factory' AND result = 'applied'`
    )
      .map((r: { payload: unknown }) => JSON.stringify(r.payload))
      .filter((text: string) => text.includes('no longer raises'))
  expect(await notes()).toHaveLength(1)

  await agedWeek('h7')
  const again = await sweep('h7')
  expect(again.summary).not.toMatch(/noted/)
  expect(await notes()).toHaveLength(1)
  expect((await passes('h7')).at(-1)?.lifecycle).toEqual([])
  expect((await state(lab, issue ?? '')).state).toBe('working')
})
