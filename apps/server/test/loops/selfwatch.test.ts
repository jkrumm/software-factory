import { expect, test } from 'bun:test'
import { loadLoopSettings } from '../../src/app/loops/settings.ts'
import { fingerprintOf } from '../../src/domains/intake/rules.ts'
import {
  ciFindings,
  evidenceHash,
  heartbeatFindings,
  idleFindings,
  inertRegressionFindings,
  migrationFindings,
  planSelfwatch,
  signalText,
  waitFindings,
} from '../../src/domains/loops/selfwatch.ts'
import type { CiRun, Finding, SelfwatchRow } from '../../src/domains/loops/selfwatch-model.ts'
import { isInert } from '../../src/domains/quality/evidence.ts'

const NOW = new Date('2026-11-08T12:00:00Z')
const minutes = (n: number) => new Date(NOW.getTime() - n * 60_000)

const run = (id: string, conclusion: string, at: string, workflow = 'CI'): CiRun => ({
  id,
  workflow,
  sha: `${id}${'a'.repeat(40)}`,
  conclusion,
  url: `https://example.com/runs/${id}`,
  at,
})

test('ci_red: the two newest runs that said something are both red', () => {
  const found = ciFindings(
    [
      run('3', 'failure', '2026-11-08T10:00:00Z'),
      run('2', 'timed_out', '2026-11-08T09:00:00Z'),
      run('1', 'success', '2026-11-08T08:00:00Z'),
    ],
    'master',
  )
  expect(found).toHaveLength(1)
  expect(found[0]?.subject).toBe('CI')
  expect(found[0]?.facts).toHaveLength(2)
  expect(found[0]?.facts[0]).toContain('run 3')
})

test('ci_red: a cancelled or skipped run neither breaks nor extends the streak', () => {
  const runs = [
    run('4', 'failure', '2026-11-08T11:00:00Z'),
    run('3', 'cancelled', '2026-11-08T10:00:00Z'),
    run('2', 'failure', '2026-11-08T09:00:00Z'),
    run('1', 'success', '2026-11-08T08:00:00Z'),
  ]
  expect(ciFindings(runs, 'master')).toHaveLength(1)
  // one red between a success and a skipped run is not two in a row
  expect(
    ciFindings([run('2', 'failure', '2026-11-08T11:00:00Z'), run('1', 'success', '2026-11-08T08:00:00Z')], 'master'),
  ).toEqual([])
  expect(
    ciFindings([run('2', 'skipped', '2026-11-08T11:00:00Z'), run('1', 'failure', '2026-11-08T08:00:00Z')], 'master'),
  ).toEqual([])
})

test('ci_red: a workflow is judged on its own runs', () => {
  const runs = [
    run('4', 'failure', '2026-11-08T11:00:00Z', 'CI'),
    run('3', 'failure', '2026-11-08T10:00:00Z', 'CI'),
    run('2', 'failure', '2026-11-08T11:00:00Z', 'Docs'),
    run('1', 'success', '2026-11-08T10:00:00Z', 'Docs'),
  ]
  expect(ciFindings(runs, 'master').map((f) => f.subject)).toEqual(['CI'])
})

test('migration_clash: one number on two names, from the base and from any ref, except the shared numbers', () => {
  const found = migrationFindings(
    {
      base: ['0001_a.sql', '0993_x.sql', '0993_y.sql'],
      refs: [
        { ref: 'factory/1-1', added: ['0997_one.sql'] },
        { ref: 'origin/factory/2-1', added: ['0997_two.sql', '0001_a.sql'] },
        { ref: 'factory/3-1', added: ['0997_one.sql'] },
      ],
      unchecked: [],
    },
    new Set(['0993']),
  )
  expect(found.map((f) => f.subject)).toEqual(['0997'])
  expect(found[0]?.facts.join('\n')).toContain('0997_one.sql on factory/1-1, factory/3-1')
  expect(found[0]?.facts.join('\n')).toContain('0997_two.sql on origin/factory/2-1')
  expect(found[0]?.title).toContain('0997_one.sql and 0997_two.sql')
})

test('migration_clash: the same file on many refs is no clash', () => {
  expect(
    migrationFindings(
      {
        base: [],
        refs: [
          { ref: 'a', added: ['0998_same.sql'] },
          { ref: 'b', added: ['0998_same.sql'] },
        ],
        unchecked: [],
      },
      new Set(),
    ),
  ).toEqual([])
})

test('migration_clash: refs past the limit are one finding of their own, absent when none went unchecked', () => {
  const none = migrationFindings({ base: [], refs: [], unchecked: [] }, new Set())
  expect(none).toEqual([])

  const unchecked = ['zeta', 'factory/9-1', 'alpha', 'origin/beta']
  const [found, ...more] = migrationFindings({ base: [], refs: [], unchecked }, new Set())
  expect(more).toEqual([])
  expect(found?.kind).toBe('migration_clash')
  expect(found?.subject).toBe('refs-unchecked')
  expect(found?.title).toBe('Self-watch: migration check skipped 4 refs over its limit')
  expect(found?.facts).toEqual(['refs over the comparison limit were not compared with origin/master'])
  expect(found?.context[0]).toContain('4 refs')
  expect(found?.context.join('\n')).toContain('unchecked: alpha')
  expect(found?.reproduce).toContain('git for-each-ref')
  // the count moves between passes, the fingerprint does not
  const [fewer] = migrationFindings({ base: [], refs: [], unchecked: unchecked.slice(1) }, new Set())
  expect(fingerprintOf(null, `${fewer?.title}`)).toBe(fingerprintOf(null, `${found?.title}`))
})

const timer = (until: Date) => ({
  issue: 'issue_7',
  title: 'Wait for the window',
  reason: 'timer' as const,
  since: 4,
  sinceAt: minutes(300),
  until: until.toISOString(),
  after: [],
})

test('wait_overdue: a timer past its time by more than the grace', () => {
  expect(waitFindings([timer(minutes(11))], NOW, 10 * 60_000)).toHaveLength(1)
  expect(waitFindings([timer(minutes(9))], NOW, 10 * 60_000)).toEqual([])
  expect(waitFindings([timer(minutes(-30))], NOW, 10 * 60_000)).toEqual([])
  const [found] = waitFindings([timer(minutes(11))], NOW, 10 * 60_000)
  expect(found?.subject).toBe('issue_7:timer')
  expect(found?.facts.join('\n')).toContain('until:')
})

test('wait_overdue: a dependency once every Issue it is after closed more than the grace ago', () => {
  const wait = (closes: (number | null)[]) => ({
    issue: 'issue_8',
    title: 'Needs two others',
    reason: 'dependency' as const,
    since: 2,
    sinceAt: minutes(600),
    until: null,
    after: closes.map((c, i) => ({ issue: `issue_${i + 1}`, closedAt: c === null ? null : minutes(c) })),
  })
  expect(waitFindings([wait([60, 30])], NOW, 10 * 60_000)).toHaveLength(1)
  // the last close decides
  expect(waitFindings([wait([60, 5])], NOW, 10 * 60_000)).toEqual([])
  // one still open: the wait is not over
  expect(waitFindings([wait([60, null])], NOW, 10 * 60_000)).toEqual([])
})

test('lead_idle: idle past the threshold only', () => {
  const lead = (idle: number) => ({ issue: 'issue_3', title: 'Slow work', lead: 'lead-3-1', idleSince: minutes(idle) })
  const found = idleFindings([lead(25), lead(5)], NOW, 20 * 60_000)
  expect(found).toHaveLength(1)
  expect(found[0]?.subject).toBe('lead-3-1')
  expect(found[0]?.facts.join('\n')).toContain('threshold: 20 min')
})

test('inert_regression: only a ship whose stored paths are all inert', () => {
  const reg = (ship: { commits: string[]; paths: string[]; deploys: boolean } | null) => ({
    issue: 'issue_5',
    title: 'Docs ship',
    detail: 'verify red',
    ship,
  })
  const inert = { commits: ['a'.repeat(40)], paths: ['docs/x.md', 'apps/server/test/a.test.ts'], deploys: false }
  const found = inertRegressionFindings([reg(inert)], isInert)
  expect(found).toHaveLength(1)
  expect(found[0]?.facts.join('\n')).toContain('docs/x.md')
  expect(inertRegressionFindings([reg({ ...inert, paths: ['docs/x.md', 'apps/server/src/a.ts'] })], isInert)).toEqual(
    [],
  )
  expect(inertRegressionFindings([reg({ ...inert, deploys: true })], isInert)).toEqual([])
  expect(inertRegressionFindings([reg({ ...inert, paths: [] })], isInert)).toEqual([])
  expect(inertRegressionFindings([reg(null)], isInert)).toEqual([])
})

test('heartbeat_stale: a class per reason, never while ok', () => {
  expect(heartbeatFindings({ ok: true, reason: null, tickAt: null, queueMovedAt: null }, NOW)).toEqual([])
  const tick = heartbeatFindings(
    { ok: false, reason: 'the last successful tick was 400 s ago', tickAt: '2026-11-08T11:50:00Z', queueMovedAt: null },
    NOW,
  )
  expect(tick.map((f) => f.subject)).toEqual(['tick'])
  const later = heartbeatFindings(
    { ok: false, reason: 'the last successful tick was 700 s ago', tickAt: '2026-11-08T11:50:00Z', queueMovedAt: null },
    new Date(NOW.getTime() + 300_000),
  )
  // the seconds in the reason and the clock are context: the evidence is the same
  expect(evidenceHash(later[0] as Finding)).toBe(evidenceHash(tick[0] as Finding))
  const database = heartbeatFindings({ ok: false, reason: 'connection refused', tickAt: null, queueMovedAt: null }, NOW)
  expect(database.map((f) => f.subject)).toEqual(['database'])
})

test('a signal text is at most eight lines', () => {
  const [found] = migrationFindings(
    { base: Array.from({ length: 12 }, (_, i) => `0997_${i}.sql`), refs: [], unchecked: [] },
    new Set(),
  )
  expect(signalText(found as Finding, 'software-factory').split('\n').length).toBeLessThanOrEqual(8)
})

const finding = (subject: string, facts: string[]): Finding => ({
  kind: 'ci_red',
  subject,
  title: `Self-watch: CI is red for ${subject}`,
  facts,
  context: [],
  reproduce: 'make check',
})

const rowOf = (f: Finding, over: Partial<SelfwatchRow> = {}): SelfwatchRow => ({
  subjectKey: `${f.kind}:${f.subject}`,
  kind: f.kind,
  firstSeenAt: minutes(60),
  lastSeenAt: minutes(5),
  evidenceHash: evidenceHash(f),
  lastFiledAt: minutes(60),
  signalId: null,
  clearedAt: null,
  ...over,
})

test('plan: a new subject is filed', () => {
  const f = finding('CI', ['run 1'])
  const plan = planSelfwatch([f], [], NOW)
  expect(plan.file.map((a) => a.why)).toEqual(['new'])
  expect(plan.touch).toEqual([])
  expect(plan.clear).toEqual([])
})

test('plan: an open subject with the same evidence is only seen again', () => {
  const f = finding('CI', ['run 1'])
  const plan = planSelfwatch([f], [rowOf(f)], NOW)
  expect(plan.file).toEqual([])
  expect(plan.touch).toEqual(['ci_red:CI'])
})

test('plan: changed evidence files again under the same title and keeps the episode start', () => {
  const before = finding('CI', ['run 1'])
  const after = finding('CI', ['run 2'])
  const plan = planSelfwatch([after], [rowOf(before)], NOW)
  expect(plan.file).toHaveLength(1)
  expect(plan.file[0]?.why).toBe('changed')
  expect(plan.file[0]?.finding.title).toBe(before.title)
  expect(plan.file[0]?.firstSeenAt).toEqual(minutes(60))
})

test('plan: an absent subject is cleared once, and files anew when it reappears', () => {
  const f = finding('CI', ['run 1'])
  const gone = planSelfwatch([], [rowOf(f)], NOW)
  expect(gone.clear).toEqual(['ci_red:CI'])
  expect(planSelfwatch([], [rowOf(f, { clearedAt: minutes(1) })], NOW).clear).toEqual([])
  const back = planSelfwatch([f], [rowOf(f, { clearedAt: minutes(1) })], NOW)
  expect(back.file.map((a) => a.why)).toEqual(['reappeared'])
  expect(back.file[0]?.firstSeenAt).toEqual(NOW)
})

test('plan: a source that was not read clears nothing', () => {
  const f = finding('CI', ['run 1'])
  expect(planSelfwatch([], [rowOf(f)], NOW, new Set(['ci_red'])).clear).toEqual([])
})

test('titles of different subjects have different fingerprints, and one subject keeps its own', () => {
  const titles = [
    ...ciFindings(
      [
        run('2', 'failure', '2026-11-08T11:00:00Z', 'CI'),
        run('1', 'failure', '2026-11-08T10:00:00Z', 'CI'),
        run('4', 'failure', '2026-11-08T11:00:00Z', 'Deploy'),
        run('3', 'failure', '2026-11-08T10:00:00Z', 'Deploy'),
      ],
      'master',
    ),
    ...migrationFindings(
      {
        base: [],
        refs: [{ ref: 'a', added: ['0997_alpha.sql', '0997_beta.sql', '0998_gamma.sql', '0998_delta.sql'] }],
        unchecked: [],
      },
      new Set(),
    ),
    ...waitFindings(
      [
        { ...timer(minutes(30)), issue: 'issue_1', title: 'Alpha work' },
        { ...timer(minutes(30)), issue: 'issue_2', title: 'Beta work' },
      ],
      NOW,
      0,
    ),
    ...idleFindings(
      [
        { issue: 'issue_1', title: 'Alpha work', lead: 'lead-1-1', idleSince: minutes(90) },
        { issue: 'issue_2', title: 'Beta work', lead: 'lead-2-1', idleSince: minutes(90) },
      ],
      NOW,
      60_000,
    ),
    ...heartbeatFindings({ ok: false, reason: 'no tick has succeeded yet', tickAt: null, queueMovedAt: null }, NOW),
  ].map((f) => fingerprintOf('software-factory', f.title))
  expect(new Set(titles).size).toBe(titles.length)

  const [a] = waitFindings([timer(minutes(30))], NOW, 0)
  const [b] = waitFindings([timer(minutes(30))], new Date(NOW.getTime() + 3_600_000), 0)
  expect(fingerprintOf('software-factory', (a as Finding).title)).toBe(
    fingerprintOf('software-factory', (b as Finding).title),
  )
})

test('settings: the loop is every five minutes at least, off when the tick is off, and the keys are read', () => {
  expect(loadLoopSettings({}).intervalMs.selfwatch).toBe(5 * 60_000)
  expect(loadLoopSettings({ FACTORY_TICK_MS: '0' }).intervalMs.selfwatch).toBe(0)
  const set = loadLoopSettings({
    FACTORY_LOOP_SELFWATCH_MS: '1000',
    FACTORY_SELFWATCH_GRACE_MS: '5000',
    FACTORY_SELFWATCH_BRANCH: 'scratch',
  })
  expect(set.intervalMs.selfwatch).toBe(1000)
  expect(set.selfwatchGraceMs).toBe(5000)
  expect(set.selfwatchBranch).toBe('scratch')
  expect(loadLoopSettings({}).selfwatchGraceMs).toBe(10 * 60_000)
})
