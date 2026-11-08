import { afterAll, beforeAll, expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { type Lab, startLab } from '../planning/lab.ts'
import { callsOf, runLoop, script } from './support.ts'

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
const PROJECTS = ['h1', 'h2', 'h3', 'h4']
const FAKE_RETRY_MS = 3_600_000

const projectFile = (name: string) => `apiVersion: factory/v2\nname: ${name}\nleads: 2\n`
const mark = (repo: string) => join(dir, `${repo}.mark`)
const sweepsOf = (repo: string): number =>
  existsSync(mark(repo)) ? readFileSync(mark(repo), 'utf8').split('\n').filter(Boolean).length : 0

/** A document long enough to count as edited lately, with `links` broken links on its first lines. */
const doc = (links: number): string =>
  [
    ...Array.from({ length: links }, (_, i) => `See [page ${i}](missing-${i}.md).`),
    ...Array.from({ length: 16 }, (_, i) => `Line ${i} of the document.`),
  ].join('\n')

const makefile = (repo: string) => `check:\n\t@echo run >> ${mark(repo)}\n\t@echo the gate is red\n\t@exit 1\n`

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
      FACTORY_FAKE_HYGIENE_SCRIPT: hygieneScript,
      FACTORY_HYGIENE_EVERY_MS: String(7 * 24 * 3_600_000),
      FACTORY_HYGIENE_RETRY_MS: String(FAKE_RETRY_MS),
    },
  })
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
  report: { runs: { probe: string; outcome: string }[]; findings: { key: string }[] }
  judgment: { outcome: string; attempts: number; judgedAt: string | null; reason: string; findings: { path: string }[] }
  filed: { key: string; title: string }[]
  over_budget: { key: string; title: string }[]
  failed: { key: string; reason: string }[]
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
  expect(ran.summary).toMatch(/^swept h1 @[0-9a-f]{7}: filed 3 signal\(s\), 0 over budget; judgment answered$/)

  const signals = await signalsFrom('h1')
  expect(signals.map((s) => s.title)).toEqual(
    [
      'Hygiene: broken links in docs/guide.md',
      'Hygiene: make check is red on the default branch',
      'Hygiene: slop document docs/guide.md',
    ].sort(),
  )
  expect(signals.every((s) => s.repo === 'h1')).toBe(true)
  const check = signals.find((s) => s.title.includes('make check'))
  expect(check?.text).toContain('Swept: h1 @ ')
  expect(check?.text).toContain('the gate is red')
  expect(check?.text).toContain('Reproduce: make check')
  expect(signals.find((s) => s.title.includes('broken links'))?.text).toContain('missing-0.md')
  const judged = signals.find((s) => s.title.includes('slop document'))
  expect(judged?.text).toContain('Finding: The guide repeats itself')
  expect(judged?.text).toContain('Fix: Cut the repeated lines.')
  expect(judged?.text).toContain('Evidence: docs/guide.md repeats itself')

  const [ask, ...more] = await asksFor('h1')
  expect(more).toEqual([])
  expect(String(ask?.input.cwd)).toMatch(/factory-hygiene\/h1-[0-9a-f]{7}-/)
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
  expect(await issuesOf('h1')).toBe(3)

  expect(existsSync(String(ask?.input.cwd))).toBe(false)
  expect(await worktrees('h1')).toEqual([`worktree ${join(lab.root, 'h1')}`])
  expect(sweepsOf('h1')).toBe(1)
})

test('not due again in the window; a week on it is swept again and intake dedups what is still open', async () => {
  const again = await sweep('h1')
  expect(again.summary).toBe('not due')
  expect(await signalsFrom('h1')).toHaveLength(3)
  expect(await passes('h1')).toHaveLength(1)

  await sql()`UPDATE factory.hygiene_passes SET at = at - interval '8 days' WHERE repo = 'h1'`
  const later = await sweep('h1')
  expect(later.error).toBeNull()
  expect(later.summary).toMatch(/^swept h1 @[0-9a-f]{7}: filed 3 signal\(s\), 0 over budget; judgment answered$/)
  expect(await passes('h1')).toHaveLength(2)
  expect(await issuesOf('h1')).toBe(3)
  expect(sweepsOf('h1')).toBe(2)
})

test('more findings than the budget: five are filed, the rest are named in the record', async () => {
  const docs = [1, 2, 3, 4].map((n): [string, string] => [`docs/d${n}.md`, `Document ${n} repeats itself`])
  await script(hygieneScript, answer('h2', ...docs))
  const ran = await sweep('h2')
  expect(ran.error).toBeNull()
  expect(ran.summary).toMatch(/filed 5 signal\(s\), 5 over budget; judgment answered$/)

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
  expect(await signalsFrom('h2')).toHaveLength(5)
})

test('a failed judgment keeps the deterministic signals and is retried at the stored commit, with no new sweep', async () => {
  await script(hygieneScript, [{ match: '"repo":"h3"', answer: null, fail: true }])
  const ran = await sweep('h3')
  expect(ran.error).toBeNull()
  expect(ran.summary).toMatch(/filed 1 signal\(s\), 0 over budget; judgment failed$/)
  const [first] = await passes('h3')
  expect(first?.judgment).toMatchObject({ outcome: 'failed', attempts: 1 })
  expect(first?.filed.map((f) => f.key)).toEqual(['check'])

  expect((await sweep('h3')).summary).toBe('not due')

  await script(hygieneScript, answer('h3', ['docs/guide.md', 'The guide repeats itself']))
  await judgedAgo('h3', '2 hours')
  const retried = await sweep('h3')
  expect(retried.error).toBeNull()
  expect(retried.summary).toMatch(
    /^judged again h3 @[0-9a-f]{7}: filed 1 signal\(s\), 0 over budget; judgment answered$/,
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
