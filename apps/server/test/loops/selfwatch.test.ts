import { expect, test } from 'bun:test'
import { loadLoopSettings } from '../../src/app/loops/settings.ts'
import { fingerprintOf } from '../../src/domains/intake/rules.ts'
import {
  ciFindings,
  confirmedHeartbeat,
  DATABASE_RECHECK_GAP_MS,
  DATABASE_RECHECKS,
  evidenceHash,
  heartbeatFindings,
  idleFindings,
  inertRegressionFindings,
  migrationFindings,
  planSelfwatch,
  processGrowthFindings,
  processStormFindings,
  signalText,
  swapGrowthFindings,
  waitFindings,
} from '../../src/domains/loops/selfwatch.ts'
import type {
  CiRun,
  Finding,
  HeartbeatFact,
  HostMinute,
  ProcessMinute,
  SelfwatchRow,
} from '../../src/domains/loops/selfwatch-model.ts'
import { isBuiltinInert } from '../../src/domains/quality/evidence.ts'

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
  const lead = (idle: number) => ({
    issue: 'issue_3',
    title: 'Slow work',
    lead: 'lead-3-1',
    idleSince: minutes(idle),
    background: false,
  })
  const found = idleFindings([lead(25), lead(5)], NOW, { idleLeadMs: 20 * 60_000, idleBackgroundMs: 90 * 60_000 })
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
  const found = inertRegressionFindings([reg(inert)], isBuiltinInert)
  expect(found).toHaveLength(1)
  expect(found[0]?.facts.join('\n')).toContain('docs/x.md')
  expect(
    inertRegressionFindings([reg({ ...inert, paths: ['docs/x.md', 'apps/server/src/a.ts'] })], isBuiltinInert),
  ).toEqual([])
  expect(inertRegressionFindings([reg({ ...inert, deploys: true })], isBuiltinInert)).toEqual([])
  expect(inertRegressionFindings([reg({ ...inert, paths: [] })], isBuiltinInert)).toEqual([])
  expect(inertRegressionFindings([reg(null)], isBuiltinInert)).toEqual([])
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
  // a restart: no tick yet is the same episode, not changed evidence
  const restarted = heartbeatFindings(
    { ok: false, reason: 'no tick has succeeded yet', tickAt: null, queueMovedAt: null },
    NOW,
  )
  expect(evidenceHash(restarted[0] as Finding)).toBe(evidenceHash(tick[0] as Finding))
  const database = heartbeatFindings({ ok: false, reason: 'connection refused', tickAt: null, queueMovedAt: null }, NOW)
  expect(database.map((f) => f.subject)).toEqual(['database'])
})

const beat = (reason: string | null): HeartbeatFact => ({
  ok: reason === null,
  reason,
  tickAt: null,
  queueMovedAt: null,
})

test('confirmedHeartbeat: one slow database answer on a loaded host is not a stale heartbeat', async () => {
  const slow = beat('the database did not answer within 2000 ms')
  const reads = [slow, beat(null)]
  const pauses: number[] = []
  const got = await confirmedHeartbeat(
    async () => reads.shift() as HeartbeatFact,
    async (ms) => void pauses.push(ms),
  )
  expect(got.ok).toBe(true)
  expect(pauses).toEqual([DATABASE_RECHECK_GAP_MS])
})

test('confirmedHeartbeat: a database that misses every read stays stale, after a bounded number of reads', async () => {
  let reads = 0
  const got = await confirmedHeartbeat(
    async () => {
      reads++
      return beat('the database did not answer within 2000 ms')
    },
    async () => {},
  )
  expect(got.ok).toBe(false)
  expect(reads).toBe(1 + DATABASE_RECHECKS)
})

test('confirmedHeartbeat: a tick problem or a healthy beat is read once', async () => {
  for (const reason of ['no tick has succeeded yet', 'the last successful tick was 400 s ago', null]) {
    let reads = 0
    await confirmedHeartbeat(
      async () => {
        reads++
        return beat(reason)
      },
      async () => {},
    )
    expect(reads).toBe(1)
  }
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
        { issue: 'issue_1', title: 'Alpha work', lead: 'lead-1-1', idleSince: minutes(90), background: false },
        { issue: 'issue_2', title: 'Beta work', lead: 'lead-2-1', idleSince: minutes(90), background: false },
      ],
      NOW,
      { idleLeadMs: 60_000, idleBackgroundMs: 60_000 },
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

const proc = (minutesAgo: number, footprintMib: number, pid = 410, name = 'fseventsd'): ProcessMinute => ({
  at: minutes(minutesAgo),
  pid,
  name,
  class: 'system',
  footprintMib,
})

test('process_growth: more than 1 GiB in the last hour of a process still there, once per process', () => {
  const growing = [proc(60, 800), proc(30, 1300), proc(1, 1900)]
  const found = processGrowthFindings(growing, NOW)
  expect(found.map((f) => f.subject)).toEqual(['fseventsd:410'])
  expect(found[0]?.title).toContain('fseventsd')
  // the figures move every minute: the evidence of the same episode does not
  const later = processGrowthFindings([proc(60, 800), proc(30, 1300), proc(1, 2400)], NOW)
  expect(evidenceHash(later[0] as Finding)).toBe(evidenceHash(found[0] as Finding))
  // exactly the limit, a short life, a process that ended, an old sample and a shrinking one are no finding
  expect(processGrowthFindings([proc(60, 800), proc(1, 1824)], NOW)).toEqual([])
  expect(processGrowthFindings([proc(20, 100), proc(1, 3000)], NOW)).toEqual([])
  expect(processGrowthFindings([proc(60, 800), proc(10, 3000)], NOW)).toEqual([])
  expect(processGrowthFindings([proc(90, 100), proc(80, 3000)], NOW)).toEqual([])
  expect(processGrowthFindings([proc(60, 3000), proc(1, 1000)], NOW)).toEqual([])
  // two processes of one name are two subjects; a pid reuse under another name is a third
  const two = processGrowthFindings(
    [...growing, ...growing.map((m) => ({ ...m, pid: 411 })), ...growing.map((m) => ({ ...m, name: 'mds' }))],
    NOW,
  )
  expect(two.map((f) => f.subject)).toEqual(['fseventsd:410', 'fseventsd:411', 'mds:410'])
})

const swap = (rises: (number | null)[], processes: number | null = null): HostMinute[] =>
  rises.map((swapUsedPct, i) => ({ at: minutes(rises.length - 1 - i), swapUsedPct, processes }))

test('swap_growth: 15 minutes in a row that never fell and ended higher', () => {
  const rising = Array.from({ length: 16 }, (_, i) => 20 + i * 0.5)
  expect(swapGrowthFindings(swap(rising), NOW).map((f) => f.subject)).toEqual(['host'])
  // equal minutes in between still count, a fall, a missing reading or too few minutes do not
  const plateau = rising.map((v, i) => (i === 7 ? (rising[6] as number) : v))
  expect(swapGrowthFindings(swap(plateau), NOW)).toHaveLength(1)
  expect(swapGrowthFindings(swap(rising.map((v, i) => (i === 8 ? 1 : v))), NOW)).toEqual([])
  expect(swapGrowthFindings(swap(rising.map((v, i) => (i === 8 ? null : v))), NOW)).toEqual([])
  expect(swapGrowthFindings(swap(rising.slice(1)), NOW)).toEqual([])
  // swap that sits at one level, or rises by noise, is not growth
  expect(swapGrowthFindings(swap(rising.map(() => 40)), NOW)).toEqual([])
  expect(swapGrowthFindings(swap(rising.map((_, i) => 40 + i * 0.01)), NOW)).toEqual([])
  // a gap in the minutes breaks the run; a host loop that stopped is no growth now
  const gap = swap(rising).map((m, i) => (i < 8 ? { ...m, at: new Date(m.at.getTime() - 300_000) } : m))
  expect(swapGrowthFindings(gap, NOW)).toEqual([])
  expect(swapGrowthFindings(swap(rising), new Date(NOW.getTime() + 600_000))).toEqual([])
  // the run is the tail: a longer rise is the same evidence
  const longer = [10, 12, ...rising]
  expect(evidenceHash(swapGrowthFindings(swap(longer), NOW)[0] as Finding)).toBe(
    evidenceHash(swapGrowthFindings(swap(rising), NOW)[0] as Finding),
  )
})

test('process_storm: the count over the cap for three samples in a row, with a reading', () => {
  const count = (...counts: (number | null)[]) =>
    swap(
      counts.map(() => 1),
      null,
    ).map((m, i) => ({ ...m, processes: counts[i] ?? null }))
  expect(processStormFindings(count(600, 3000, 3100, 3200), 2500, NOW).map((f) => f.subject)).toEqual(['host'])
  expect(processStormFindings(count(3000, 3100, 2500), 2500, NOW)).toEqual([])
  expect(processStormFindings(count(3000, null, 3200), 2500, NOW)).toEqual([])
  expect(processStormFindings(count(3000, 3100), 2500, NOW)).toEqual([])
  expect(processStormFindings(count(3000, 3100, 3200), 2500, new Date(NOW.getTime() + 600_000))).toEqual([])
})
