import { expect, test } from 'bun:test'
import { MAX_SIGNALS_PER_PASS } from '../../src/domains/loops/budget.ts'
import { loadLoopSettings } from '../../src/app/loops/settings.ts'
import type { HygieneAnswer, HygieneRequest } from '@software-factory/contract'
import {
  checkAnswer,
  judgmentBudget,
  judgmentKey,
  judgmentSignalText,
  judgmentTitle,
  MAX_PROBE_SIGNALS,
  NO_REF,
  planHygiene,
  probeBudget,
  probeSignalText,
  rankProbeFindings,
  requestOf,
  skipped,
} from '../../src/domains/loops/hygiene.ts'
import type {
  FixEntry,
  HygieneChecker,
  Probe,
  ProbeFinding,
  ProbeRun,
  Scope,
} from '../../src/domains/loops/hygiene-model.ts'
import type { ClassIssue } from '../../src/domains/loops/classes.ts'
import type { FindingIssue, LifecycleStep } from '../../src/domains/loops/hygiene-lifecycle.ts'
import type { HygienePassRecord, LoopReads, LoopStore } from '../../src/domains/loops/ports.ts'
import { hygieneSummary, hygienePass, type HygieneDeps } from '../../src/app/loops/hygiene.ts'
import { planLifecycle, REOPEN_WINDOW_MS } from '../../src/domains/loops/hygiene-lifecycle.ts'
import { REOPEN_WINDOW_MS as MACHINE_REOPEN_WINDOW_MS } from '../../src/domains/work/issue.ts'
import type { StoredProject } from '../../src/domains/planning/sync.ts'
import { sequentialIds } from '../../src/kernel/ids.ts'
import { err, ok, portError } from '../../src/kernel/result.ts'

const finding = (probe: Probe, key: string, count: number): ProbeFinding => ({
  probe,
  key,
  title: `title of ${key}`,
  lines: ['a line'],
  count,
})

test('probe findings rank in probe order, then count descending, then key', () => {
  const ranked = rankProbeFindings([
    finding('cochange', 'cochange:a', 9),
    finding('links', 'links:b.md', 2),
    finding('links', 'links:a.md', 2),
    finding('links', 'links:c.md', 5),
    finding('check', 'check', 1),
  ])
  expect(ranked.map((f) => f.key)).toEqual(['check', 'links:c.md', 'links:a.md', 'links:b.md', 'cochange:a'])
})

test('the probes take three slots, the rest is named, and the judgment keeps at least two', () => {
  const many = Array.from({ length: 5 }, (_, i) => finding('links', `links:${i}.md`, 5 - i))
  const { file, overBudget } = probeBudget(rankProbeFindings(many))
  expect(file).toHaveLength(MAX_PROBE_SIGNALS)
  expect(overBudget.map((f) => f.key)).toEqual(['links:3.md', 'links:4.md'])
  expect(judgmentBudget(0)).toBe(MAX_SIGNALS_PER_PASS)
  expect(judgmentBudget(1)).toBe(4)
  expect(judgmentBudget(3)).toBe(2)
})

const report = {
  stale: [{ path: 'docs/a.md', why: 'old' }],
  slop: [
    { path: 'docs/a.md', why: 'recent' },
    { path: 'README.md', why: 'recent' },
  ],
}

test('the request lists each document once and is null with nothing to read or no budget', () => {
  const request = requestOf({ repo: 'app', cwd: '/tmp/x', ref: 'abcdef1234', report, max: 3 })
  expect(request?.stale.map((c) => c.path)).toEqual(['docs/a.md'])
  expect(request?.slop.map((c) => c.path)).toEqual(['README.md'])
  expect(
    requestOf({ repo: 'app', cwd: '/tmp/x', ref: 'abcdef1234', report: { stale: [], slop: [] }, max: 3 }),
  ).toBeNull()
  expect(requestOf({ repo: 'app', cwd: '/tmp/x', ref: 'abcdef1234', report, max: 0 })).toBeNull()
})

const answerOf = (...paths: [HygieneAnswer['findings'][number]['kind'], string][]): HygieneAnswer => ({
  findings: paths.map(([kind, path], i) => ({ kind, path, title: `t${i}`, evidence: 'e', fix: 'f' })),
  read: 2,
  reason: 'r',
})

test('an answer is checked again: unknown paths and repeats are dropped, the excess is named', () => {
  const request = requestOf({ repo: 'app', cwd: '/tmp/x', ref: 'abcdef1234', report, max: 2 }) as HygieneRequest
  const checked = checkAnswer(
    answerOf(
      ['stale', 'docs/a.md'],
      ['stale', 'docs/a.md'],
      ['stale', 'elsewhere.md'],
      ['slop', 'docs/a.md'],
      ['slop', 'README.md'],
    ),
    request,
  )
  expect(checked.findings.map((f) => `${f.kind}:${f.path}`)).toEqual(['stale:docs/a.md', 'slop:docs/a.md'])
  expect(checked.rejected).toHaveLength(2)
  expect(checked.overBudget.map((f) => f.path)).toEqual(['README.md'])
})

test('signal titles carry no counts and the text names what was swept, the evidence and how to look again', () => {
  const a = probeSignalText(finding('links', 'links:docs/a.md', 3), { repo: 'app', ref: '0123456789abcdef' })
  expect(a).toContain('Swept: app @ 0123456')
  expect(a).toContain('a line')
  expect(a).toContain('Sweep: factory read loops')
  expect(probeSignalText(finding('check', 'check', 1), { repo: 'app', ref: '0123456789' })).toContain(
    'Reproduce: make check',
  )
  const f = { kind: 'stale' as const, path: 'docs/a.md', title: 'The doc is behind', evidence: 'ev', fix: 'fx' }
  expect(judgmentTitle(f)).toBe(`Hygiene: ${f.kind} document ${f.path}`)
  expect(judgmentKey(f)).toBe('judgment:stale:docs/a.md')
  const text = judgmentSignalText(f, { repo: 'app', ref: '0123456789' })
  for (const part of ['app @ 0123456', 'Evidence: ev', 'Fix: fx', 'Reproduce:']) expect(text).toContain(part)
})

const HOUR = 3_600_000
const DAY = 24 * HOUR
const now = new Date('2026-11-20T12:00:00Z')
const ago = (ms: number) => new Date(now.getTime() - ms)
const row = (repo: string, at: Date, judgment: Partial<HygienePassRecord['judgment']> = {}): HygienePassRecord => ({
  id: `hygiene_${repo}`,
  repo,
  at,
  ref: 'abcdef1234',
  report: { ref: 'abcdef1234', runs: [], findings: [], stale: [], slop: [] },
  fixes: [],
  judgment: { ...skipped('none'), ...judgment },
  filed: [],
  overBudget: [],
  failed: [],
  lifecycle: [],
})
const plan = (rows: HygienePassRecord[], over: { allow?: string[] | null; projects?: string[] } = {}) =>
  planHygiene({
    projects: over.projects ?? ['a', 'b', 'c'],
    rows,
    now,
    everyMs: 7 * DAY,
    retryMs: 6 * HOUR,
    allow: over.allow ?? null,
  })

test('a project never swept comes first, then the oldest pass, and nothing when all are fresh', () => {
  expect(plan([row('a', ago(8 * DAY)), row('b', ago(9 * DAY))])).toEqual({ kind: 'full', repo: 'c' })
  expect(plan([row('a', ago(8 * DAY)), row('b', ago(9 * DAY)), row('c', ago(1 * DAY))])).toEqual({
    kind: 'full',
    repo: 'b',
  })
  expect(plan([row('a', ago(DAY)), row('b', ago(DAY)), row('c', ago(DAY))])).toEqual({ kind: 'none' })
})

// ---- cadence by activity ----------------------------------------------------------------------------------------------------

const activeRow = (repo: string, at: Date, lastCommitAgo: number, scope: 'full' | 'steady' | 'daily' = 'full') => ({
  ...row(repo, at),
  report: { ...row(repo, at).report, scope, lastCommitAt: ago(lastCommitAgo).toISOString() },
})

test('an idle repo (no commit for 30 days) gets its full pass monthly and a steady one weekly; an active one stays weekly', () => {
  const others = [row('b', ago(DAY)), row('c', ago(DAY))]
  const run = (rows: HygienePassRecord[]) => plan([...rows, ...others])
  // full 10 days ago: not due for a full pass, but its weekly pass is a steady one
  expect(run([activeRow('a', ago(10 * DAY), 40 * DAY)])).toEqual({ kind: 'steady', repo: 'a' })
  // a steady pass 2 days ago after a full one 10 days ago: nothing is due
  expect(run([activeRow('a', ago(10 * DAY), 40 * DAY), activeRow('a', ago(2 * DAY), 40 * DAY, 'steady')])).toEqual({
    kind: 'none',
  })
  // the same, 8 days on: steady again
  expect(run([activeRow('a', ago(10 * DAY), 40 * DAY), activeRow('a', ago(8 * DAY), 40 * DAY, 'steady')])).toEqual({
    kind: 'steady',
    repo: 'a',
  })
  // 31 days since the last full pass: the monthly one, the deps refresh and the judgment with it
  expect(run([activeRow('a', ago(31 * DAY), 40 * DAY), activeRow('a', ago(2 * DAY), 40 * DAY, 'steady')])).toEqual({
    kind: 'full',
    repo: 'a',
  })
  // an active repo: a full pass every week, never a steady one
  expect(run([activeRow('a', ago(10 * DAY), 3 * DAY)])).toEqual({ kind: 'full', repo: 'a' })
  expect(run([activeRow('a', ago(5 * DAY), 3 * DAY)])).toEqual({ kind: 'none' })
})

test('a project that says it is never idle, or idle sooner, is read as it says', () => {
  const rows = [activeRow('a', ago(10 * DAY), 20 * DAY), row('b', ago(DAY)), row('c', ago(DAY))]
  const planWith = (idleAfterDays: number) =>
    planHygiene({
      projects: ['a', 'b', 'c'],
      rows,
      now,
      everyMs: 7 * DAY,
      retryMs: 6 * HOUR,
      allow: null,
      idleAfterDays: (repo) => (repo === 'a' ? idleAfterDays : undefined),
    })
  expect(planWith(14)).toEqual({ kind: 'steady', repo: 'a' })
  expect(planWith(0)).toEqual({ kind: 'full', repo: 'a' })
  expect(plan(rows)).toEqual({ kind: 'full', repo: 'a' })
})

test('the allow-list narrows the projects', () => {
  expect(plan([], { allow: ['b'] })).toEqual({ kind: 'full', repo: 'b' })
  expect(plan([row('b', ago(DAY))], { allow: ['b'] })).toEqual({ kind: 'none' })
})

test('a failed judgment is retried after the gap while attempts remain; a full pass comes before a retry', () => {
  const fresh = [row('b', ago(DAY)), row('c', ago(DAY))]
  const failed = (attempts: number, judgedAgo: number) =>
    row('a', ago(DAY), { outcome: 'failed', attempts, judgedAt: ago(judgedAgo) })
  expect(plan([failed(1, 7 * HOUR), ...fresh])).toMatchObject({ kind: 'retry', repo: 'a' })
  expect(plan([failed(1, HOUR), ...fresh])).toEqual({ kind: 'none' })
  expect(plan([failed(3, 7 * HOUR), ...fresh])).toEqual({ kind: 'none' })
  expect(plan([failed(1, 7 * HOUR), row('b', ago(DAY))])).toEqual({ kind: 'full', repo: 'c' })
  expect(plan([row('a', ago(DAY), { outcome: 'skipped' }), ...fresh])).toEqual({ kind: 'none' })
})

// ---- a checkout that cannot be made ---------------------------------------------------------------------------------------

const project = (
  name: string,
  hygiene: { check: boolean; reason?: string; probes?: { name: string; target: string }[] } = { check: true },
) =>
  ({
    name,
    repo: `/src/${name}`,
    source: 'file',
    project: { hygiene, ship: [{ via: 'push' }] },
  }) as unknown as StoredProject

interface Extra {
  findings?: ProbeFinding[]
  classes?: Record<string, ClassIssue[]>
  /** the newest Issue of each finding key the project filed before (`LoopReads.findingIssues`) */
  issues?: FindingIssue[]
  /** the runs a sweep reports */
  runs?: ProbeRun[]
  /** commits since the last full pass */
  commits?: number | null
  /** the scripted fix of the checker; absent: the checker has none */
  fix?: HygieneChecker['fix']
  /** the commit each checkout is at, in the order they are made (the last repeats); absent: one commit throughout */
  refs?: string[]
  /** what a sweep reports once the first has run: the findings and runs of a second reading of `only` probes */
  again?: { findings: ProbeFinding[]; runs: ProbeRun[] }
}

function world(
  names: string[],
  broken: Set<string>,
  projects: StoredProject[] = names.map((n) => project(n)),
  extra: Extra = {},
) {
  const recorded: { issue: string; class: string; key: string; repo: string }[] = []
  const filedBodies: string[] = []
  const rows: HygienePassRecord[] = []
  let at = now
  const sweeps: string[] = []
  const skips: (string | undefined)[] = []
  const probes: (readonly { name: string; target: string }[] | undefined)[] = []
  const loops = {
    hygienePasses: async () => {
      const newest = new Map<string, HygienePassRecord>()
      for (const r of rows) if (!newest.has(r.repo) || (newest.get(r.repo)?.at ?? r.at) <= r.at) newest.set(r.repo, r)
      return [...newest.values()]
    },
    recordHygienePass: async (r: HygienePassRecord) => void rows.push(r),
    recordFinding: async (f: { issue: string; class: string; key: string; repo: string }) => {
      if (!recorded.some((r) => r.issue === f.issue)) recorded.push(f)
    },
  } as unknown as LoopStore
  const loopReads = {
    classIssues: async () => extra.classes ?? {},
    findingIssues: async () => extra.issues ?? [],
  } as unknown as LoopReads
  const steps: LifecycleStep[] = []
  const scopes: (Scope | undefined)[] = []
  const onlys: (readonly Probe[] | undefined)[] = []
  let made = 0
  const checker: HygieneChecker = {
    withCheckout: async (repo, _ref, use) => {
      if (broken.has(repo)) return err(portError('gone', 'fetch failed'))
      const refs = extra.refs ?? ['abcdef1234abcdef']
      const ref = refs[Math.min(made++, refs.length - 1)] ?? 'abcdef1234abcdef'
      return ok(await use({ path: '/tmp/x', ref, source: '/tmp/src' }))
    },
    commitsSince: async () => extra.commits ?? null,
    ...(extra.fix ? { fix: extra.fix } : {}),
    sweep: async (co, options) => {
      scopes.push(options?.scope)
      sweeps.push(co.ref)
      skips.push(options?.skipCheck)
      probes.push(options?.probes)
      onlys.push(options?.only)
      const second = options?.only && extra.again
      return {
        ref: co.ref,
        scope: options?.scope ?? 'full',
        runs: (second ? extra.again?.runs : extra.runs) ?? [],
        findings: (second ? extra.again?.findings : extra.findings) ?? [],
        stale: [],
        slop: [],
      }
    },
  }
  const deps: HygieneDeps = {
    uow: {
      run: async (work) =>
        work({ loops, loopReads, planning: { projects: async () => projects } as never, work: {} as never }),
      inTransaction: () => false,
    },
    clock: { now: () => at },
    ids: sequentialIds(),
    checker,
    workflow: { ask: async () => err(portError('gone', 'not asked')) },
    file: async (body) => {
      if (!extra.findings) return err({ kind: 'refused' } as never)
      filedBodies.push(body.title)
      return ok({
        outcome: 'filed',
        detail: 'new',
        issue: `issue_${filedBodies.length}`,
        signal: null,
        reason: null,
      } as never)
    },
    everyMs: 7 * DAY,
    dailyMs: DAY,
    retryMs: 6 * HOUR,
    repos: null,
    apply: async (step, at, _reopens) => {
      steps.push(step)
      return { key: step.key, issue: step.issue, action: step.action, why: step.why, at }
    },
  }
  return {
    steps,
    scopes,
    deps,
    rows,
    sweeps,
    skips,
    probes,
    onlys,
    recorded,
    filedBodies,
    advance: (ms: number) => (at = new Date(at.getTime() + ms)),
  }
}

test('a checkout that fails records a pass, is not due before the retry gap, and the next project is swept meanwhile', async () => {
  const w = world(['a', 'b'], new Set(['a']))
  const first = await hygienePass(w.deps)
  expect(first.ok).toBe(true)
  expect(w.rows).toHaveLength(1)
  expect(w.rows[0]).toMatchObject({ repo: 'a', ref: NO_REF, judgment: { outcome: 'skipped', reason: 'no checkout' } })
  expect(w.rows[0]?.failed[0]).toMatchObject({ key: 'checkout' })

  // the second tick takes the project that was never swept, not the one that failed
  expect(await hygienePass(w.deps)).toMatchObject({ ok: true, value: { due: true, record: { repo: 'b' } } })
  expect(await hygienePass(w.deps)).toEqual(ok({ due: false }))

  w.advance(HOUR)
  expect(await hygienePass(w.deps)).toEqual(ok({ due: false }))
  w.advance(6 * HOUR)
  expect(await hygienePass(w.deps)).toMatchObject({ ok: true, value: { due: true, record: { repo: 'a' } } })
  expect(w.rows.filter((r) => r.repo === 'a')).toHaveLength(2)
})

test('a project with hygiene.check false is swept with its reason; the default asks for the check', async () => {
  const reason = 'needs the owner photo library'
  const w = world([], new Set(), [project('lab', { check: false, reason }), project('plain')])
  expect(await hygienePass(w.deps)).toMatchObject({ ok: true, value: { due: true, record: { repo: 'lab' } } })
  expect(await hygienePass(w.deps)).toMatchObject({ ok: true, value: { due: true, record: { repo: 'plain' } } })
  expect(w.skips).toEqual([reason, undefined])
})

test("a red doctor skips the project's check with its lines, so hygiene.check needs no switching off; a green one and no doctor do not", async () => {
  const withDoctor = (name: string) =>
    ({
      ...project(name),
      project: { hygiene: { check: true }, doctor: 'make doctor', ship: [{ via: 'push' }] },
    }) as unknown as StoredProject
  const w = world([], new Set(), [
    withDoctor('a-red'),
    withDoctor('b-green'),
    withDoctor('c-unknown'),
    project('d-plain'),
  ])
  const readings: Record<string, { ok: boolean; lines: string[]; at: Date } | null> = {
    'a-red': { ok: false, lines: ['lab seed missing; fix: rsync it'], at: now },
    'b-green': { ok: true, lines: [], at: now },
    'c-unknown': null,
  }
  w.deps.doctor = { read: async ({ project: name }) => readings[name] ?? null }
  for (let i = 0; i < 4; i++) await hygienePass(w.deps)
  expect(w.skips).toEqual([
    'a-red cannot run on this host: lab seed missing; fix: rsync it',
    undefined,
    undefined,
    undefined,
  ])
})

test('the probes a project declares are handed to its sweep; one that declares none passes none', async () => {
  const declared = [{ name: 'demo', target: 'demo-check' }]
  const w = world([], new Set(), [project('lab', { check: true, probes: declared }), project('plain')])
  await hygienePass(w.deps)
  await hygienePass(w.deps)
  expect(w.probes).toEqual([declared, undefined])
})

test('a declared probe is ranked after every built-in probe', () => {
  const ranked = rankProbeFindings([finding('probe', 'probe:demo', 9), finding('runrules', 'runrules:x', 1)])
  expect(ranked.map((f) => f.key)).toEqual(['runrules:x', 'probe:demo'])
})

test('a project that says work: true is never swept', async () => {
  const closed = { ...project('closed'), project: { hygiene: { check: true }, work: true } } as unknown as StoredProject
  const w = world([], new Set(), [closed, project('open')])
  expect(await hygienePass(w.deps)).toMatchObject({ ok: true, value: { due: true, record: { repo: 'open' } } })
  expect(await hygienePass(w.deps)).toMatchObject({ ok: true, value: { due: false } })
  expect(w.rows.map((r) => r.repo)).toEqual(['open'])
})

test('planHygiene treats a no-checkout row as due after the retry gap, not after the week', () => {
  const failedRow = { ...row('a', ago(7 * HOUR)), ref: NO_REF }
  expect(plan([failedRow, row('b', ago(DAY)), row('c', ago(DAY))])).toEqual({ kind: 'full', repo: 'a' })
  const recent = { ...row('a', ago(HOUR)), ref: NO_REF }
  expect(plan([recent, row('b', ago(DAY)), row('c', ago(DAY))])).toEqual({ kind: 'none' })
})

test('the loop ticks every 15 minutes at most, is off with the tick, and a setting wins', () => {
  expect(loadLoopSettings({}).intervalMs.hygiene).toBe(15 * 60_000)
  expect(loadLoopSettings({}).intervalMs.friction).toBe(10_000)
  expect(loadLoopSettings({ FACTORY_TICK_MS: '0' }).intervalMs.hygiene).toBe(0)
  expect(loadLoopSettings({ FACTORY_TICK_MS: '3600000' }).intervalMs.hygiene).toBe(3_600_000)
  expect(loadLoopSettings({ FACTORY_LOOP_HYGIENE_MS: '60000' }).intervalMs.hygiene).toBe(60_000)
})

// ---- finding classes ------------------------------------------------------------------------------------------------------

const noisy = (n: number): ClassIssue[] =>
  Array.from({ length: n }, (_, i) => ({
    issue: `issue_${i + 100}`,
    filedAt: ago(40 * DAY + i * DAY),
    closedAt: ago(30 * DAY - i * DAY),
    outcome: 'dropped' as const,
  }))

test('a held class files nothing and is named; the rest of the budget is still used; filed findings are recorded once', async () => {
  const findings = [
    finding('cochange', 'cochange:a|b', 9),
    finding('cochange', 'cochange:c|d', 8),
    finding('links', 'links:x.md', 1),
    finding('links', 'links:y.md', 1),
    finding('links', 'links:z.md', 1),
  ]
  // the class was held 2 days ago: its newest Issue closed lately
  const held = noisy(5).map((i, n) => ({ ...i, closedAt: ago(DAY + n * HOUR) }))
  const w = world(['a'], new Set(), undefined, { findings, classes: { cochange: held } })
  const pass = await hygienePass(w.deps)
  expect(pass.ok).toBe(true)
  // the three links fill the three probe slots; the held class does not take one
  expect(w.filedBodies).toHaveLength(3)
  expect(w.rows[0]?.filed.map((f) => f.key)).toEqual(['links:x.md', 'links:y.md', 'links:z.md'])
  expect(w.rows[0]?.overBudget.map((f) => f.key).sort()).toEqual(['cochange:a|b', 'cochange:c|d'])
  expect(w.recorded.map((r) => [r.class, r.key])).toEqual([
    ['links', 'links:x.md'],
    ['links', 'links:y.md'],
    ['links', 'links:z.md'],
  ])
})

test('a class on probation files one finding in the pass', async () => {
  const findings = [finding('cochange', 'cochange:a|b', 9), finding('cochange', 'cochange:c|d', 8)]
  const w = world(['a'], new Set(), undefined, { findings, classes: { cochange: noisy(5) } })
  await hygienePass(w.deps)
  expect(w.rows[0]?.filed.map((f) => f.key)).toEqual(['cochange:a|b'])
  expect(w.rows[0]?.overBudget.map((f) => f.key)).toEqual(['cochange:c|d'])
})

test('a class held by noise from other repos holds in this repo too; its repo is still stored', async () => {
  const findings = [finding('cochange', 'cochange:a|b', 9), finding('links', 'links:x.md', 1)]
  // four noise Issues, filed two each by the sweeps of two other repos: the class is judged across all of them
  const held = noisy(4).map((i, n) => ({ ...i, closedAt: ago(DAY + n * HOUR) }))
  const w = world(['third'], new Set(), undefined, { findings, classes: { cochange: held } })
  await hygienePass(w.deps)
  expect(w.rows[0]?.filed.map((f) => f.key)).toEqual(['links:x.md'])
  expect(w.rows[0]?.overBudget.map((f) => f.key)).toEqual(['cochange:a|b'])
  expect(w.recorded.map((r) => [r.class, r.repo])).toEqual([['links', w.rows[0]?.repo ?? '']])
})

// ---- the lifecycle: a finding heals, a closed one that is red again reopens ------------------------------------------------

const issueOf = (key: string, over: Partial<FindingIssue> = {}): FindingIssue => ({
  key,
  issue: `issue_${key.length}`,
  state: 'queued',
  outcome: null,
  closedAt: null,
  reopens: 0,
  ...over,
})
const run = (covers: string, outcome: ProbeRun['outcome'] = 'clean'): ProbeRun => ({
  probe: covers.split(':')[0] as Probe,
  outcome,
  detail: `ran ${covers}`,
  covers,
})
const lifecycle = (input: { red?: ProbeFinding[]; runs?: ProbeRun[]; issues: FindingIssue[] }) =>
  planLifecycle({ red: [], runs: [], now, swept: 'app @ abc1234', ...input })

test('a finding its probe no longer raises: an Issue no lead has started is closed healed, a lead at work is told, a watch is left alone', () => {
  const issues = [
    issueOf('links:a.md', { issue: 'issue_1', state: 'settling' }),
    issueOf('links:b.md', { issue: 'issue_2', state: 'queued' }),
    issueOf('links:c.md', { issue: 'issue_3', state: 'working' }),
    issueOf('links:d.md', { issue: 'issue_4', state: 'waiting' }),
    issueOf('links:e.md', { issue: 'issue_5', state: 'watching' }),
  ]
  const plan = lifecycle({ issues, runs: [run('links')] })
  expect(plan.steps.map((s) => [s.issue, s.action])).toEqual([
    ['issue_1', 'healed'],
    ['issue_2', 'healed'],
    ['issue_3', 'noted'],
    ['issue_4', 'noted'],
  ])
  expect(plan.steps[0]?.why).toContain('ran links')
  expect(plan.suppress.size).toBe(0)
})

test('only a run with a verdict speaks for a key: skipped, failed and a run of another probe heal nothing', () => {
  const issues = [issueOf('links:a.md', { state: 'queued' })]
  expect(lifecycle({ issues, runs: [run('links', 'skipped')] }).steps).toEqual([])
  expect(lifecycle({ issues, runs: [run('links', 'failed')] }).steps).toEqual([])
  expect(lifecycle({ issues, runs: [run('deps')] }).steps).toEqual([])
  expect(lifecycle({ issues, runs: [] }).steps).toEqual([])
  // a run that found other things is still a verdict on the keys it did not raise
  expect(lifecycle({ issues, runs: [run('links', 'found')] }).steps.map((s) => s.action)).toEqual(['healed'])
  // a key is covered by a run of its own name or under it, never by a longer name that merely starts alike
  expect(lifecycle({ issues: [issueOf('check', { state: 'queued' })], runs: [run('check')] }).steps).toHaveLength(1)
  expect(lifecycle({ issues: [issueOf('deps:cargo', { state: 'queued' })], runs: [run('deps')] }).steps).toHaveLength(1)
  expect(
    lifecycle({ issues: [issueOf('probe:demo-2', { state: 'queued' })], runs: [run('probe:demo')] }).steps,
  ).toEqual([])
})

test('a run that left a key unjudged does not heal it, though its probe ran', () => {
  const issues = [
    issueOf('deps:cargo', { issue: 'issue_1', state: 'queued' }),
    issueOf('deps:python', { issue: 'issue_2', state: 'queued' }),
    issueOf('deps', { issue: 'issue_3', state: 'queued' }),
  ]
  const partial: ProbeRun = { ...run('deps'), unjudged: ['deps:cargo', 'deps'] }
  expect(lifecycle({ issues, runs: [partial] }).steps.map((s) => [s.issue, s.action])).toEqual([['issue_2', 'healed']])
})

test('the document judgment is never healed: it read a few documents, absence proves nothing', () => {
  const issues = [issueOf('judgment:slop:docs/a.md', { state: 'queued' })]
  expect(lifecycle({ issues, runs: [run('judgment')] }).steps).toEqual([])
})

test('a finding that is red again: an open Issue is its life (nothing filed, no note a day); closed done reopens; reopened twice is left to a person', () => {
  const red = [finding('links', 'links:a.md', 2), finding('links', 'links:b.md', 1), finding('links', 'links:c.md', 1)]
  const closedDone = (days: number, reopens = 0) =>
    ({ state: 'closed', outcome: 'done', closedAt: ago(days * DAY), reopens }) as const
  const plan = lifecycle({
    red,
    issues: [
      issueOf('links:a.md', { issue: 'issue_1', state: 'working' }),
      issueOf('links:b.md', { issue: 'issue_2', ...closedDone(3) }),
      issueOf('links:c.md', { issue: 'issue_3', ...closedDone(3, 2) }),
    ],
  })
  expect(plan.steps.map((s) => [s.issue, s.action])).toEqual([
    ['issue_2', 'reopened'],
    ['issue_3', 'kept'],
  ])
  expect(plan.steps[0]?.why).toContain('red again at app @ abc1234')
  expect(plan.steps[0]?.why).toContain('a line')
  expect([...plan.suppress].sort()).toEqual(['links:a.md', 'links:b.md', 'links:c.md'])
})

test('a finding red again after the reopen window, healed, dropped or cancelled is filed anew, not reopened', () => {
  const red = [finding('links', 'links:a.md', 1)]
  for (const closed of [
    { state: 'closed', outcome: 'done', closedAt: ago(40 * DAY) },
    { state: 'closed', outcome: 'healed', closedAt: ago(3 * DAY) },
    { state: 'closed', outcome: 'dropped', closedAt: ago(3 * DAY) },
    { state: 'closed', outcome: 'cancelled', closedAt: ago(3 * DAY) },
  ] as const) {
    const plan = lifecycle({ red, issues: [issueOf('links:a.md', closed)] })
    expect(plan.steps).toEqual([])
    expect(plan.suppress.size).toBe(0)
  }
})

test('a pass reopens the closed finding instead of filing it, and records what it did', async () => {
  const findings = [finding('links', 'links:a.md', 1), finding('links', 'links:b.md', 1)]
  const issues = [issueOf('links:a.md', { issue: 'issue_9', state: 'closed', outcome: 'done', closedAt: ago(2 * DAY) })]
  const w = world(['app'], new Set(), undefined, { findings, issues, runs: [run('links', 'found')] })
  await hygienePass(w.deps)
  expect(w.steps.map((s) => [s.issue, s.action])).toEqual([['issue_9', 'reopened']])
  // only the finding with no Issue is filed
  expect(w.filedBodies).toEqual(['title of links:b.md'])
  expect(w.rows[0]?.lifecycle.map((e) => [e.key, e.action])).toEqual([['links:a.md', 'reopened']])
  expect(w.rows[0]?.filed.map((f) => f.key)).toEqual(['links:b.md'])
})

test('a pass heals the finding whose probe ran green and files nothing', async () => {
  const issues = [issueOf('links:a.md', { issue: 'issue_7', state: 'queued' })]
  const w = world(['app'], new Set(), undefined, { findings: [], issues, runs: [run('links')] })
  const pass = await hygienePass(w.deps)
  expect(w.steps.map((s) => [s.issue, s.action])).toEqual([['issue_7', 'healed']])
  expect(w.filedBodies).toEqual([])
  expect(w.rows[0]?.lifecycle[0]).toMatchObject({ key: 'links:a.md', issue: 'issue_7', action: 'healed' })
  expect(pass.ok && pass.value.due && hygieneSummary(pass.value)).toMatch(/; healed 1$/)
})

// ---- cadence: weekly full pass, daily cheap pass, busy repo ------------------------------------------------------------------

const planDaily = (rows: HygienePassRecord[], over: { projects?: string[] } = {}) =>
  planHygiene({
    projects: over.projects ?? ['a', 'b'],
    rows,
    now,
    everyMs: 7 * DAY,
    dailyMs: DAY,
    retryMs: 6 * HOUR,
    allow: null,
  })
const dailyRow = (repo: string, at: Date): HygienePassRecord => {
  const base = row(repo, at)
  return { ...base, report: { ...base.report, scope: 'daily' } }
}

test('a full pass is due after the week, a daily one after the day, and a daily pass does not move the week', () => {
  // never swept: full
  expect(planDaily([])).toEqual({ kind: 'full', repo: 'a' })
  // a full pass 2 days ago and nothing since: a daily pass is due, carrying the last full pass
  const full = row('a', ago(2 * DAY))
  expect(planDaily([full, row('b', ago(HOUR))])).toEqual({ kind: 'daily', repo: 'a', lastFull: full })
  // a daily pass an hour ago holds the day; the full pass is still 9 days old, so the week is due
  expect(planDaily([row('a', ago(9 * DAY)), dailyRow('a', ago(HOUR)), row('b', ago(HOUR))])).toEqual({
    kind: 'full',
    repo: 'a',
  })
  expect(planDaily([row('a', ago(3 * DAY)), dailyRow('a', ago(HOUR)), row('b', ago(HOUR))])).toEqual({ kind: 'none' })
  // a full pass comes before a daily one
  expect(planDaily([row('a', ago(2 * DAY)), row('b', ago(8 * DAY))])).toMatchObject({ kind: 'full', repo: 'b' })
  // daily passes off: only the week counts
  expect(plan([row('a', ago(2 * DAY)), row('b', ago(2 * DAY)), row('c', ago(2 * DAY))])).toEqual({ kind: 'none' })
})

test('a judgment retry belongs to the newest full pass, not to a daily one', () => {
  const failedFull = row('a', ago(2 * DAY), { outcome: 'failed', attempts: 1, judgedAt: ago(7 * HOUR) })
  const rows = [failedFull, dailyRow('a', ago(HOUR)), row('b', ago(HOUR))]
  expect(planDaily(rows)).toMatchObject({ kind: 'retry', repo: 'a' })
})

test('a daily pass runs the cheap scope; a busy repo is promoted to a full pass, a quiet one is not', async () => {
  const quiet = world(['app'], new Set(), undefined, { findings: [], commits: 5 })
  quiet.rows.push({ ...row('app', ago(3 * DAY)), ref: 'abc123def456abc123def456abc123def456abcd' })
  const first = await hygienePass(quiet.deps)
  expect(first).toMatchObject({ ok: true, value: { due: true, mode: 'daily' } })
  expect(quiet.scopes).toEqual(['daily'])
  expect(quiet.rows.at(-1)?.judgment.reason).toContain('daily pass')

  const busy = world(['app'], new Set(), undefined, { findings: [], commits: 80 })
  busy.rows.push({ ...row('app', ago(3 * DAY)), ref: 'abc123def456abc123def456abc123def456abcd' })
  expect(await hygienePass(busy.deps)).toMatchObject({ ok: true, value: { due: true, mode: 'full' } })
  expect(busy.scopes).toEqual(['full'])

  // not busy enough for a repo whose last full pass is young: commits alone do not promote it
  const young = world(['app'], new Set(), undefined, { findings: [], commits: 80 })
  young.rows.push({ ...row('app', ago(DAY + HOUR)), ref: 'abc123def456abc123def456abc123def456abcd' })
  await hygienePass(young.deps)
  expect(young.scopes).toEqual(['daily'])
})

test("the pass's reopen window stays a day inside the machine's, so a reopen it asks for is never refused for age", () => {
  expect(MACHINE_REOPEN_WINDOW_MS - REOPEN_WINDOW_MS).toBe(DAY)
})

// ---- scripted fixes ---------------------------------------------------------------------------------------------------------

const stale = finding('stale', 'stale:branches', 3)
const fixedBranches: FixEntry = { key: 'stale:branches', outcome: 'fixed', detail: 'deleted 3 merged remote branches' }

test('a finding the script fixed files nothing and the pass records the fix', async () => {
  const seen: unknown[] = []
  const w = world(['a'], new Set(), undefined, {
    findings: [stale],
    fix: async (_co, report, options) => {
      seen.push(options.landing)
      return { report: { ...report, findings: [] }, fixes: [fixedBranches] }
    },
  })
  const pass = await hygienePass({ ...w.deps, fixes: true })
  expect(pass).toMatchObject({ ok: true, value: { due: true, filedNow: 0 } })
  expect(w.filedBodies).toEqual([])
  expect(w.rows[0]?.fixes).toEqual([{ ...fixedBranches, at: now }])
  expect(seen).toEqual(['push'])
})

test('a finding whose fix failed is filed as it stands, and a fix that could not start holds it back one pass', async () => {
  const failedFix: FixEntry = {
    key: 'stale:branches',
    outcome: 'failed',
    detail: 'refused',
    output: ['protected branch'],
  }
  const failed = world(['a'], new Set(), undefined, {
    findings: [stale],
    fix: async (_co, report) => ({ report, fixes: [failedFix] }),
  })
  await hygienePass({ ...failed.deps, fixes: true })
  expect(failed.filedBodies).toEqual(['title of stale:branches'])
  expect(failed.rows[0]?.fixes[0]).toMatchObject({ outcome: 'failed', output: ['protected branch'] })

  const deferred = world(['a'], new Set(), undefined, {
    findings: [stale],
    fix: async (_co, report) => ({
      report,
      fixes: [{ key: 'stale:branches', outcome: 'deferred', detail: 'no test slot came in time' }],
    }),
  })
  await hygienePass({ ...deferred.deps, fixes: true })
  expect(deferred.filedBodies).toEqual([])
  expect(deferred.rows[0]?.fixes[0]).toMatchObject({ outcome: 'deferred' })
})

test('no fix runs when the switch is off, and a repo that ships by pull request is told so', async () => {
  let calls = 0
  const off = world(['a'], new Set(), undefined, {
    findings: [stale],
    fix: async (_co, report) => {
      calls++
      return { report, fixes: [] }
    },
  })
  await hygienePass({ ...off.deps, fixes: false })
  expect(calls).toBe(0)
  expect(off.filedBodies).toHaveLength(1)

  const landings: string[] = []
  const viaPr = {
    ...project('pr'),
    project: { hygiene: { check: true }, ship: [{ via: 'push' }, { via: 'pr' }] },
  } as unknown as StoredProject
  const pr = world([], new Set(), [viaPr], {
    findings: [stale],
    fix: async (_co, report, options) => {
      landings.push(options.landing)
      return { report, fixes: [] }
    },
  })
  await hygienePass({ ...pr.deps, fixes: true })
  expect(landings).toEqual(['pr'])
})

test('a deferred fix does not reopen the closed Issue of its key', async () => {
  const closed: FindingIssue = {
    key: 'stale:branches',
    issue: 'issue_9',
    state: 'closed',
    outcome: 'done',
    closedAt: new Date(now.getTime() - 3 * DAY),
    reopens: 0,
  }
  const w = world(['a'], new Set(), undefined, {
    findings: [stale],
    issues: [closed],
    fix: async (_co, report) => ({
      report,
      fixes: [{ key: 'stale:branches', outcome: 'deferred', detail: 'no test slot came in time' }],
    }),
  })
  await hygienePass({ ...w.deps, fixes: true })
  expect(w.steps).toEqual([])
  expect(w.filedBodies).toEqual([])
})

// ---- read again before filing ----------------------------------------------------------------------------------------------

const imports = finding('agentsmd', 'agentsmd:imports', 1)
const importsRun = (outcome: ProbeRun['outcome']): ProbeRun => ({
  probe: 'agentsmd',
  outcome,
  detail: 'one AGENTS.md',
  covers: 'agentsmd',
})

test('a default branch that moved during the sweep: the file probes are read again at the new head and a finding it no longer raises is not filed', async () => {
  const w = world(['a'], new Set(), undefined, {
    findings: [imports],
    runs: [importsRun('found')],
    refs: ['aaaaaaa1', 'bbbbbbb2'],
    again: { findings: [], runs: [importsRun('clean')] },
  })
  const pass = await hygienePass(w.deps)
  expect(pass).toMatchObject({ ok: true, value: { due: true, filedNow: 0 } })
  expect(w.filedBodies).toEqual([])
  expect(w.onlys).toEqual([undefined, ['agentsmd']])
  const run = w.rows[0]?.report.runs.find((r) => r.probe === 'agentsmd')
  expect(run).toMatchObject({ outcome: 'clean' })
  expect(run?.detail).toContain('read again at bbbbbbb before filing')
  expect(w.rows[0]?.report.findings).toEqual([])
})

test('a finding the new head still raises is filed once, and a default branch that did not move reads nothing again', async () => {
  const moved = world(['a'], new Set(), undefined, {
    findings: [imports],
    runs: [importsRun('found')],
    refs: ['aaaaaaa1', 'bbbbbbb2'],
    again: { findings: [imports], runs: [importsRun('found')] },
  })
  await hygienePass(moved.deps)
  expect(moved.filedBodies).toHaveLength(1)
  expect(moved.rows[0]?.report.runs.find((r) => r.probe === 'agentsmd')?.detail).toBe('one AGENTS.md')
  const still = world(['a'], new Set(), undefined, { findings: [imports], runs: [importsRun('found')] })
  await hygienePass(still.deps)
  expect(still.filedBodies).toHaveLength(1)
  expect(still.onlys).toEqual([undefined])
})

test('a second reading that could not run (a failed probe) keeps the first: the finding is filed, nothing heals', async () => {
  const w = world(['a'], new Set(), undefined, {
    findings: [imports],
    runs: [importsRun('found')],
    refs: ['aaaaaaa1', 'bbbbbbb2'],
    again: { findings: [], runs: [importsRun('failed')] },
  })
  await hygienePass(w.deps)
  expect(w.filedBodies).toHaveLength(1)
  expect(w.rows[0]?.report.runs.find((r) => r.probe === 'agentsmd')).toMatchObject({ outcome: 'found' })
})

test("a re-read keeps the note a scripted fix put on the finding's plan", async () => {
  const fixed = { ...finding('stale', 'stale:branches', 2), plan: ['A scripted fix ran and the probe is still red'] }
  const w = world(['a'], new Set(), undefined, {
    findings: [fixed],
    runs: [{ probe: 'stale', outcome: 'found', detail: 'two', covers: 'stale' }],
    refs: ['aaaaaaa1', 'bbbbbbb2'],
    again: {
      findings: [finding('stale', 'stale:branches', 2)],
      runs: [{ probe: 'stale', outcome: 'found', detail: 'two', covers: 'stale' }],
    },
  })
  await hygienePass(w.deps)
  expect(w.filedBodies).toHaveLength(1)
  expect(w.rows[0]?.report.findings[0]?.plan).toEqual(['A scripted fix ran and the probe is still red'])
})

test('only the probes that read files are read again: a red check or a deps refresh is filed as swept', async () => {
  const w = world(['a'], new Set(), undefined, {
    findings: [finding('check', 'check', 1), finding('deps', 'deps', 3)],
    refs: ['aaaaaaa1', 'bbbbbbb2'],
  })
  await hygienePass(w.deps)
  expect(w.onlys).toEqual([undefined])
  expect(w.filedBodies).toHaveLength(2)
})
