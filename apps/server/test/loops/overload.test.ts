import { expect, test } from 'bun:test'
import {
  type Admission,
  type AdmissionRules,
  gatesPassedFindings,
  LOAD_SAMPLES,
  loadOverCeilingFindings,
  OVERLOAD_KINDS,
  overloadEvidence,
  cpuAccountingLine,
  parsePs,
  priorityLine,
  ROUTE_MIN_SAMPLES,
  routesSlowFindings,
  SLOT_EMPTY_MINUTES,
  SLOT_WAIT_MINUTES,
  SLOT_WAITERS,
  slotLineFindings,
} from '../../src/domains/loops/overload.ts'
import { evidenceHash, signalText } from '../../src/domains/loops/selfwatch.ts'
import type { CapacityMinute, Finding, SlotMinute } from '../../src/domains/loops/selfwatch-model.ts'

const NOW = new Date('2026-11-14T20:00:00Z')
const ago = (n: number) => new Date(NOW.getTime() - n * 60_000)
const RULES: AdmissionRules = {
  overLoad: (load, ceiling) => load > ceiling,
  sustainedLoad: { samples: 5, spanMs: 6 * 60_000 },
  overMemory: (reading) => reading.swapoutMbPer300s > 2048 || reading.swapUsedPct > 75,
}
const overCeiling = (minutes: CapacityMinute[], now: Date) => loadOverCeilingFindings(minutes, RULES, now)

const minute = (over: Partial<CapacityMinute> & { at: Date }): CapacityMinute => ({
  load: 10,
  loadCeiling: 60,
  leads: 3,
  seats: 20,
  memoryUsedPct: 50,
  swapUsedPct: 10,
  swapoutMbPer300s: 0,
  compressorMib: 1000,
  pressureLevel: 1,
  ...over,
})

/** `loads[i]` is the load `loads.length - 1 - i` minutes ago: the last entry is the newest sample. */
const loads = (values: (number | null)[], ceiling: number | null = 60): CapacityMinute[] =>
  values.map((load, i) => minute({ at: ago(values.length - 1 - i), load, loadCeiling: ceiling }))

// ---- load_over_ceiling ------------------------------------------------------------------------------------------------------

test('load_over_ceiling: ten consecutive samples over the ceiling fire once, with the figures as context', () => {
  const found = overCeiling(loads(Array(LOAD_SAMPLES).fill(200)), NOW)
  expect(found).toHaveLength(1)
  expect(found[0]?.kind).toBe('load_over_ceiling')
  expect(found[0]?.subject).toBe('host')
  expect(found[0]?.context.join('\n')).toContain('10 samples in a row')
  // a longer run is the same evidence: one signal until it clears
  const longer = overCeiling(loads(Array(25).fill(150)), NOW)
  expect(evidenceHash(longer[0] as Finding)).toBe(evidenceHash(found[0] as Finding))
})

test('load_over_ceiling: nine samples, a dip, a missing reading, a gap or a stale host do not fire (and a falling load clears)', () => {
  expect(overCeiling(loads(Array(LOAD_SAMPLES - 1).fill(200)), NOW)).toEqual([])
  // the ceiling is a strict bound: a load equal to it is not over it
  expect(overCeiling(loads(Array(LOAD_SAMPLES).fill(60)), NOW)).toEqual([])
  // one sample under the ceiling in the middle breaks the run; only the tail counts
  const dip = Array(15).fill(200)
  dip[8] = 20
  expect(overCeiling(loads(dip), NOW)).toEqual([])
  expect(overCeiling(loads(Array(20).fill(null)), NOW)).toEqual([])
  expect(overCeiling(loads(Array(LOAD_SAMPLES).fill(200), null), NOW)).toEqual([])
  const gap = loads(Array(LOAD_SAMPLES).fill(200)).map((m, i) =>
    i < 5 ? { ...m, at: new Date(m.at.getTime() - 600_000) } : m,
  )
  expect(overCeiling(gap, NOW)).toEqual([])
  // the host loop stopped: the newest sample is not now
  expect(overCeiling(loads(Array(LOAD_SAMPLES).fill(200)), new Date(NOW.getTime() + 600_000))).toEqual([])
  // cleared: the newest sample is back under the ceiling
  expect(overCeiling(loads([...Array(12).fill(200), 30]), NOW)).toEqual([])
})

// ---- slot_line --------------------------------------------------------------------------------------------------------------

const slots = (n: number, over: Partial<SlotMinute> = {}): SlotMinute[] =>
  Array.from({ length: n }, (_, i) => ({
    at: ago(n - 1 - i),
    liveSlots: 2,
    aimSlots: 2,
    holders: 2,
    waiters: 0,
    ...over,
  }))

test('slot_line: more callers than eight waiting for fifteen minutes fires, and clears the minute the line shortens', () => {
  const found = slotLineFindings(slots(SLOT_WAIT_MINUTES, { waiters: SLOT_WAITERS + 1 }), NOW)
  expect(found.map((f) => f.subject)).toEqual(['waiting'])
  expect(found[0]?.title).toContain('more than eight callers')
  // the line of exactly eight, fourteen minutes of nine, or a break in it do not fire
  expect(slotLineFindings(slots(SLOT_WAIT_MINUTES, { waiters: SLOT_WAITERS }), NOW)).toEqual([])
  expect(slotLineFindings(slots(SLOT_WAIT_MINUTES - 1, { waiters: 20 }), NOW)).toEqual([])
  const broken = slots(20, { waiters: 20 })
  broken[10] = { ...(broken[10] as SlotMinute), waiters: 0 }
  expect(slotLineFindings(broken, NOW)).toEqual([])
  // cleared: the newest minute has a short line
  const clearing = slots(20, { waiters: 20 })
  clearing[19] = { ...(clearing[19] as SlotMinute), waiters: 1, holders: 2 }
  expect(slotLineFindings(clearing, NOW)).toEqual([])
  // and a slot minute from before the host loop stopped says nothing about now
  expect(slotLineFindings(slots(SLOT_WAIT_MINUTES, { waiters: 20 }), new Date(NOW.getTime() + 600_000))).toEqual([])
})

test('slot_line: a base slot empty while callers wait fires after five minutes, once per condition, and clears when the slot is taken', () => {
  const empty = slots(SLOT_EMPTY_MINUTES, { holders: 1, waiters: 2 })
  const found = slotLineFindings(empty, NOW)
  expect(found.map((f) => f.subject)).toEqual(['base_empty'])
  expect(found[0]?.title).toContain('empty')
  // both conditions at once are two subjects, each with its own title
  const both = slotLineFindings(slots(SLOT_WAIT_MINUTES, { holders: 1, waiters: 12 }), NOW)
  expect(both.map((f) => f.subject).sort()).toEqual(['base_empty', 'waiting'])
  // four minutes, nobody waiting, or every base slot held: no finding
  expect(slotLineFindings(slots(SLOT_EMPTY_MINUTES - 1, { holders: 1, waiters: 2 }), NOW)).toEqual([])
  expect(slotLineFindings(slots(10, { holders: 1, waiters: 0 }), NOW)).toEqual([])
  expect(slotLineFindings(slots(10, { holders: 2, waiters: 5 }), NOW)).toEqual([])
  // cleared: the slot was granted in the newest minute
  const granted = slots(10, { holders: 1, waiters: 2 })
  granted[9] = { ...(granted[9] as SlotMinute), holders: 2 }
  expect(slotLineFindings(granted, NOW)).toEqual([])
})

test('slot_line: the base is the aim, so one holder of an aim of 1 is no empty slot (issue 1556)', () => {
  // the aim lowered the base to 1: callers were told "all 1 slots are busy", which is the rule working
  const aimed = slots(10, { holders: 1, waiters: 13, aimSlots: 1 })
  expect(slotLineFindings(aimed, NOW)).toEqual([])
  // an aim of 1 with nobody holding is still an empty base slot, and the context names the base callers had
  const idle = slotLineFindings(slots(SLOT_EMPTY_MINUTES, { holders: 0, waiters: 3, aimSlots: 1 }), NOW)
  expect(idle.map((f) => f.subject)).toEqual(['base_empty'])
  expect(idle[0]?.context.join(' ')).toContain('0 of 1 base slots held')
  // an aim above FACTORY_SLOTS never raises the base the memory rule judges
  expect(slotLineFindings(slots(10, { holders: 2, waiters: 5, aimSlots: 4 }), NOW)).toEqual([])
})

// ---- gates_passed -----------------------------------------------------------------------------------------------------------

const admit = (minutesAgo: number, issue = 'issue_1'): Admission => ({
  at: new Date(ago(minutesAgo).getTime() + 30_000),
  issue,
})

test('gates_passed: a lead admitted between two samples that both read the load over the ceiling passed the load rule', () => {
  const rows = [
    minute({ at: ago(3), load: 180, leads: 4 }),
    minute({ at: ago(2), load: 190, leads: 5 }),
    minute({ at: ago(1), load: 200, leads: 5 }),
    minute({ at: ago(0), load: 200, leads: 5 }),
  ]
  const found = gatesPassedFindings(rows, [admit(3)], RULES, NOW)
  expect(found).toHaveLength(1)
  expect(found[0]?.facts).toEqual(['a lead was admitted while the load was over its ceiling'])
  expect(found[0]?.context.join('\n')).toContain('issue_1 admitted at')
  // a load under the ceiling in the sample before: the rule had room, it let the lead in
  const under = rows.map((m, i) => (i === 0 ? { ...m, load: 10 } : m))
  expect(gatesPassedFindings(under, [admit(3)], RULES, NOW)).toEqual([])
  // no admission, no finding: leads that rose with no `admitted` event are a lead resuming from a wait, which asks no gate
  expect(gatesPassedFindings(rows, [], RULES, NOW)).toEqual([])
  // an admission with no sample on either side within a minute and a half cannot be judged
  expect(
    gatesPassedFindings(
      rows,
      [admit(3)].map((a) => ({ ...a, at: ago(40) })),
      RULES,
      NOW,
    ),
  ).toEqual([])
})

test('gates_passed: the load rule is the tripwire: a lead admitted under a short peak was let in by the rule, only a sustained overshoot is a passed gate', () => {
  // the load over the ceiling for the sample before and the one after, but not five in a row: the tripwire (five in a row) is not tripped, the rule admits (issue 2208)
  const peak = loads([10, 10, 10, 10, 10, 51.6, 51.6, 51.6], 36)
  expect(gatesPassedFindings(peak, [admit(2)], RULES, NOW)).toEqual([])
  // five samples in a row over at the admission, and over in the sample after: the rule refused and the lead came in anyway
  const sustained = loads([10, 50, 50, 50, 50, 50, 51.6, 51.6], 36)
  const found = gatesPassedFindings(sustained, [admit(2)], RULES, NOW)
  expect(found).toHaveLength(1)
  expect(found[0]?.facts).toEqual(['a lead was admitted while the load was over its ceiling'])
  // the load fell under the ceiling by the sample after: a lead the rule let in
  expect(gatesPassedFindings(loads([50, 50, 50, 50, 50, 50, 10, 10], 36), [admit(2)], RULES, NOW)).toEqual([])
  // a gap in the minute samples is no reading of five in a row: the instant decides, as admission does
  const gap = [minute({ at: ago(30), load: 50, loadCeiling: 36 }), ...loads([50, 50, 50], 36)]
  expect(gatesPassedFindings(gap, [admit(2)], RULES, NOW)).toHaveLength(1)
})

test('gates_passed: the reading admission recorded decides, a live reading under the ceiling clears a tripped tripwire (issue 2626)', () => {
  // five samples over the ceiling in a row, and 49.2 in the sample after: by the samples alone the rule refused
  const sustained = loads([10, 50, 50, 50, 50, 50, 49.2, 49.2], 36)
  expect(gatesPassedFindings(sustained, [admit(2)], RULES, NOW)).toHaveLength(1)
  // admission read 35.1 live (the sample before was 36.1) and cleared the trip, as designed: the load of the next minute is not its reading
  expect(gatesPassedFindings(sustained, [{ ...admit(2), load: 35.1 }], RULES, NOW)).toEqual([])
  // admission read the load over the ceiling and let the lead in: a passed gate
  const read = gatesPassedFindings(sustained, [{ ...admit(2), load: 49 }], RULES, NOW)
  expect(read).toHaveLength(1)
  expect(read[0]?.context.join('\n')).toContain('load 49.0 at admission')
  // no reading recorded (null): the sample after stands in
  expect(gatesPassedFindings(sustained, [{ ...admit(2), load: null }], RULES, NOW)).toHaveLength(1)
  // the tripwire not tripped (a short peak): the rule admits whatever the reading
  expect(
    gatesPassedFindings(loads([10, 10, 10, 10, 10, 51.6, 51.6, 51.6], 36), [{ ...admit(2), load: 51 }], RULES, NOW),
  ).toEqual([])
})

test('gates_passed: the memory rule is its own fact of the one signal, and it clears when the window passes', () => {
  const swap = [
    minute({ at: ago(2), swapUsedPct: 80, leads: 2 }),
    minute({ at: ago(1), swapUsedPct: 82, leads: 3 }),
    minute({ at: ago(0), swapUsedPct: 82, leads: 3 }),
  ]
  expect(gatesPassedFindings(swap, [admit(2)], RULES, NOW)[0]?.facts).toEqual([
    'a lead was admitted while swap was over its ceiling',
  ])
  const swapouts = swap.map((m) => ({ ...m, swapUsedPct: 10, swapoutMbPer300s: 5000 }))
  expect(gatesPassedFindings(swapouts, [admit(2)], RULES, NOW)).toHaveLength(1)

  // the seat cap is not judged: the idle host's seat bonus lets leads exceed the seats by the rule
  const seats = [minute({ at: ago(1), leads: 4, seats: 4 }), minute({ at: ago(0), leads: 5, seats: 4 })]
  expect(gatesPassedFindings(seats, [admit(1)], RULES, NOW)).toEqual([])

  // every gate together keeps one signal; the facts are stable, no clock in them
  const all = [
    minute({ at: ago(2), load: 100, swapUsedPct: 90, leads: 3, seats: 4 }),
    minute({ at: ago(1), load: 100, swapUsedPct: 90, leads: 9, seats: 4 }),
    minute({ at: ago(0), load: 100, swapUsedPct: 90, leads: 9, seats: 4 }),
  ]
  const both = gatesPassedFindings(all, [admit(2), admit(1, 'issue_2')], RULES, NOW)
  expect(both).toHaveLength(1)
  expect(both[0]?.facts).toHaveLength(2)

  // cleared: the admission is older than the ten-minute window of the newest sample
  const old = [
    minute({ at: ago(30), load: 100, leads: 3 }),
    minute({ at: ago(29), load: 100, leads: 9 }),
    minute({ at: ago(0), load: 5, leads: 9 }),
  ]
  expect(gatesPassedFindings(old, [admit(30)], RULES, NOW)).toEqual([])
  // under every ceiling and inside the seats: nothing, and a stale host says nothing
  expect(gatesPassedFindings([minute({ at: ago(1) }), minute({ at: ago(0) })], [admit(1)], RULES, NOW)).toEqual([])
  expect(gatesPassedFindings(seats, [admit(1)], RULES, new Date(NOW.getTime() + 600_000))).toEqual([])
  expect(gatesPassedFindings([], [admit(1)], RULES, NOW)).toEqual([])
})

// ---- routes_slow ------------------------------------------------------------------------------------------------------------

test('routes_slow: a p95 over two seconds with enough requests fires, a quiet or fast server clears it', () => {
  const window = 300_000
  const found = routesSlowFindings({ p95Ms: 2500, samples: 40, windowMs: window }, NOW)
  expect(found).toHaveLength(1)
  expect(found[0]?.subject).toBe('routes')
  expect(found[0]?.context[0]).toContain('p95 2500 ms over 40 requests')
  expect(routesSlowFindings({ p95Ms: 2000, samples: 40, windowMs: window }, NOW)).toEqual([])
  expect(routesSlowFindings({ p95Ms: 900, samples: 400, windowMs: window }, NOW)).toEqual([])
  // a few answers after a restart are not a p95: below 20 the nearest-rank p95 is the one slowest answer
  expect(ROUTE_MIN_SAMPLES).toBe(20)
  expect(routesSlowFindings({ p95Ms: 9000, samples: ROUTE_MIN_SAMPLES - 1, windowMs: window }, NOW)).toEqual([])
  // the slowest routes are named in the finding
  const named = routesSlowFindings(
    { p95Ms: 2500, samples: 40, windowMs: window, slowest: [{ route: 'GET /v1/issues', ms: 4100.4 }] },
    NOW,
  )[0] as Finding
  expect(named.context).toContain('Slowest: GET /v1/issues 4100 ms')
  expect(routesSlowFindings({ p95Ms: null, samples: 0, windowMs: window }, NOW)).toEqual([])
  // the figure moves, the evidence does not: one signal until it clears
  const a = routesSlowFindings({ p95Ms: 2500, samples: 40, windowMs: window }, NOW)[0] as Finding
  const b = routesSlowFindings({ p95Ms: 31_000, samples: 90, windowMs: window }, NOW)[0] as Finding
  expect(evidenceHash(a)).toBe(evidenceHash(b))
})

// ---- the evidence block ----------------------------------------------------------------------------------------------------

const PS = [
  '    1  31  0.0   9000 /sbin/launchd',
  '  411  31 45.2 420000 /opt/homebrew/opt/postgresql@17/bin/postgres -D /opt/homebrew/var/postgresql@17',
  '  412  20  1.0  80000 postgres: factory factory 127.0.0.1(5) idle',
  '  900  31 12.5 300000 bun /Users/x/.software-factory/releases/abc/apps/door/src/main.ts',
  '  777  31 60.0 700000 bun run apps/server/src/main.ts',
  ' 5001  46 80.0 900000 /Users/x/.local/share/claude/versions/2.1/claude --dangerously-skip-permissions',
  ' 5002  46  2.0  50000 git status --porcelain',
  'junk line that is no process',
].join('\n')

test('parsePs reads the priority, the CPU share and the size, and skips what is no process line', () => {
  const rows = parsePs(PS)
  expect(rows).toHaveLength(7)
  expect(rows[1]).toEqual({
    pid: 411,
    pri: 31,
    pcpu: 45.2,
    rssMib: Math.round(420000 / 1024),
    command: '/opt/homebrew/opt/postgresql@17/bin/postgres -D /opt/homebrew/var/postgresql@17',
  })
})

test('priorityLine sets the server, the door and Postgres against a lead, and says what it did not find', () => {
  const line = priorityLine(parsePs(PS), 777)
  expect(line).toContain('the server: 31')
  expect(line).toContain('the door: 31')
  expect(line).toContain('postgres: 20/31 (2 processes)')
  expect(line).toContain("a lead's claude: 46")
  expect(priorityLine(parsePs(PS), 12345)).toContain('the server: not found')
  expect(priorityLine([], 1)).toContain('the door: not found')
})

test('overloadEvidence: slot lines with reasons, queue by reason, host memory, the busiest processes, priorities, deploys', () => {
  const lines = overloadEvidence({
    now: NOW,
    slotLines: [
      'test slot wait "make check": waiting for memory: needs 6.0 GiB',
      'test slot 1 held by "make e2e" for 20 min, limit 30 min',
    ],
    queue: [
      { kind: 'memory', count: 3, since: ago(40) },
      { kind: 'load', count: 2, since: ago(5) },
    ],
    cpu: {
      minutes: 10,
      rows: [
        { class: 'step', repo: 'shutterflow', cpuMs: 600_000 },
        { class: 'lead', repo: 'shutterflow', cpuMs: 3_000_000 },
        { class: 'system', repo: null, cpuMs: 1_200_000 },
      ],
      host: { samples: 10, idlePct: 5, userPct: 80, sysPct: 15 },
    },
    cores: 12,
    host: minute({
      at: ago(1),
      load: 187.5,
      memoryUsedPct: 91,
      compressorMib: 9120,
      swapUsedPct: 62,
      swapoutMbPer300s: 3100,
    }),
    ps: { output: PS },
    serverPid: 777,
    deployLines: ['2026-11-14T19:00:00Z start pid=1', '2026-11-14T19:03:00Z end pid=1 rc=0 unreachable_s=40'],
  })
  const text = lines.join('\n')
  expect(text).toContain('Test slot lines (2):')
  expect(text).toContain('waiting for memory: needs 6.0 GiB')
  expect(text).toContain('Queue by reason: memory 3 (oldest 40 min), load 2 (oldest 5 min)')
  expect(text).toContain('load 187.5 (ceiling 60)')
  expect(text).toContain('memory used 91%')
  expect(text).toContain('compressor 9120 MiB')
  expect(text).toContain('swap 62%')
  // the groups ranked by CPU, as cores over the window: 3 000 000 ms over 10 minutes is 5 cores
  expect(text).toContain('over the last 10 host minutes')
  expect(text).toContain('lead shutterflow 5 cores, system 2 cores, step shutterflow 1 cores')
  // busy 95 % of 12 cores is 11.4; the groups account for 8 (4 800 000 ms over 10 minutes); the 3.4 left are unattributed
  expect(text).toContain(
    'CPU accounting: host 95% busy (user 80%, system 15%, idle 5%) over 10 host minutes = 11.4 of 12 cores; the sampled processes account for 8 cores, 3.4 cores (30%) are unattributed',
  )
  expect(text).toContain('The 7 busiest processes of 7')
  expect(text).toContain('Scheduling priority (ps -o pri')
  expect(text).toContain('unreachable_s=40')
  // the busiest first: the lead's claude (80 %) before postgres (45 %)
  expect(text.indexOf('pid=5001 pri=46 cpu=80%')).toBeLessThan(text.indexOf('pid=411 pri=31 cpu=45.2%'))
  // never more than fifteen processes, and a ps that failed is said, not hidden
  const many = Array.from({ length: 40 }, (_, i) => `${100 + i} 31 ${i}.0 1024 proc${i}`).join('\n')
  const capped = overloadEvidence({
    now: NOW,
    slotLines: [],
    queue: [],
    cpu: null,
    host: null,
    ps: { output: many },
    serverPid: 1,
    deployLines: [],
  })
  expect(capped.filter((line) => line.startsWith('- process pid='))).toHaveLength(15)
  const failed = overloadEvidence({
    now: NOW,
    slotLines: [],
    queue: [],
    cpu: null,
    host: null,
    ps: { failure: 'ps took longer than 20 s' },
    serverPid: 1,
    deployLines: [],
  })
  expect(failed.join('\n')).toContain('Processes: not read: ps took longer than 20 s')
  expect(failed.join('\n')).toContain('Queue by reason: nothing queued')
  expect(failed.join('\n')).toContain('Host: no sample')
  expect(failed.join('\n')).toContain('CPU by class and repo: no host minutes read')
  expect(failed.join('\n')).toContain('CPU accounting: no host CPU split read')
})

test('cpuAccountingLine: the remainder never goes negative, and an unknown core count is said', () => {
  const window = {
    minutes: 2,
    rows: [{ class: 'lead', repo: 'app', cpuMs: 600_000 }],
    host: { samples: 2, idlePct: 90, userPct: 8, sysPct: 2 },
  }
  // 10 % of 4 cores is 0.4 busy against 5 attributed: 0 unattributed
  expect(cpuAccountingLine(window, 4)).toContain('0 cores (0%) are unattributed')
  expect(cpuAccountingLine(window, undefined)).toContain('the core count is unknown')
  expect(cpuAccountingLine({ ...window, host: null }, 4)).toBe('- CPU accounting: no host CPU split read')
  // no class minute in the window: nothing to net the host's busy CPU against, never "everything unattributed"
  expect(cpuAccountingLine({ ...window, minutes: 0, rows: [] }, 4)).toBe('- CPU accounting: no host CPU split read')
  // class minutes whose rows carry no CPU (the first snapshot after a restart): the same
  expect(cpuAccountingLine({ ...window, minutes: 1, rows: [] }, 4)).toBe('- CPU accounting: no host CPU split read')
})

test('a signal carries the evidence block after the eight lines, which never move the evidence hash', () => {
  const [found] = overCeiling(loads(Array(LOAD_SAMPLES).fill(200)), NOW)
  const finding = found as Finding
  const withEvidence: Finding = { ...finding, evidence: ['Evidence at the time of filing:', '  a line'] }
  expect(evidenceHash(withEvidence)).toBe(evidenceHash(finding))
  const text = signalText(withEvidence, 'software-factory')
  expect(text).toContain('Evidence at the time of filing:')
  expect(text.indexOf('Reproduce:')).toBeLessThan(text.indexOf('Evidence at the time of filing:'))
  expect(signalText(finding, 'software-factory')).not.toContain('Evidence at the time')
  expect(OVERLOAD_KINDS.has(finding.kind)).toBe(true)
  expect(OVERLOAD_KINDS.has('ci_red')).toBe(false)
})

test('overloadEvidence: a credential in a command line or a log line never reaches the signal text', () => {
  const text = overloadEvidence({
    now: NOW,
    slotLines: [],
    queue: [],
    cpu: null,
    host: null,
    ps: {
      output:
        ' 900 31 5.0 1024 curl -H Authorization: Bearer abcdef0123456789abcdef --token=hunter2hunter2 https://u:pw@example.com',
    },
    serverPid: 1,
    deployLines: ['2026-11-14T19:00:00Z start pid=1 API_KEY=sk-abcdefghijklmnop'],
  }).join('\n')
  expect(text).toContain('pid=900')
  expect(text).not.toContain('abcdef0123456789abcdef')
  expect(text).not.toContain('hunter2hunter2')
  expect(text).not.toContain('u:pw@')
  expect(text).not.toContain('sk-abcdefghijklmnop')
})
