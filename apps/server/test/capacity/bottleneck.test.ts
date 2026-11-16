import { describe, expect, test } from 'bun:test'
import {
  type AdmissionInputs,
  checkAdmission,
  lineRefusal,
  type TestLine,
} from '../../src/domains/capacity/admission.ts'
import { learnedCores, learnedRunMs } from '../../src/domains/capacity/costs.ts'
import { loadTrip } from '../../src/domains/capacity/host.ts'
import {
  lineOrder,
  releaseSlot,
  type SlotFit,
  type SlotRow,
  stepClassOf,
  testLineOf,
  touchSlots,
} from '../../src/domains/capacity/slots.ts'
import type { IssueId } from '../../src/kernel/ids.ts'

const T = new Date('2026-11-16T21:34:00Z')
const ago = (minutes: number) => new Date(T.getTime() - minutes * 60_000)
const id = (n: number) => `issue_${n}` as IssueId

const reading = (account: string) => ({
  account,
  readAt: T,
  sampledAt: ago(2),
  enabled: true,
  authOk: true,
  fiveHourUsed: 20,
  weeklyUsed: 40,
  fiveHourResetsAt: new Date(T.getTime() + 3_600_000),
  weeklyResetsAt: new Date(T.getTime() + 2 * 86_400_000),
  exhaustedUntil: null,
})

/** The accounts and their caps as they stood (`FACTORY_ACCOUNT_LEADS=iu=20,me=10,me2=10`, 16 for any other). */
const ACCOUNTS = ['iu', 'me', 'me2'].map(reading)
const CAPS = new Map([
  ['iu', 20],
  ['me', 10],
  ['me2', 10],
])

/** Spreads `n` running leads over the accounts the way the picker filled them: iu first, then the others. */
const leadsByAccount = (n: number) => {
  const iu = Math.min(n, 20)
  const me = Math.min(n - iu, 10)
  return new Map([
    ['iu', iu],
    ['me', me],
    ['me2', n - iu - me],
  ])
}

/**
 * The host at 2026-11-16 21:34 UTC as the owner measured it: 24 leads hold claims, 2 steps run in the test slots and 14
 * wait (8 of basalt-ui, 3 software-factory check-fast, iris, dotfiles), the 1-minute load 30.7 under the ceiling of 36,
 * memory pressure normal, swap 2.4 %. The waits are spread up to the 13.4 minutes the oldest had waited (`slot_waits`),
 * and a step took 24.6 s, the median of the day's runs (`step_costs`).
 */
const WAITED_MIN = [13.4, 13.0, 11.6, 10.2, 9.0, 8.1, 7.0, 6.2, 5.0, 4.1, 3.0, 2.2, 1.0, 0.1]
const replayed = (running: number, line: TestLine | null, load = 30.7): AdmissionInputs => ({
  now: T,
  state: 'run',
  leads: 40,
  holders: Array.from({ length: Math.min(running, 39) }, (_, i) => ({ issue: id(i + 100), urgent: false })),
  owed: [],
  candidate: { issue: id(1), urgent: false, since: null },
  lane: null,
  load,
  loadCeiling: 36,
  loadTrip: { tripped: false },
  memory: { swapoutMbPer300s: 0, swapUsedPct: 2.4 },
  memoryCeilings: { swapoutMbPer300s: 2048, swapUsedPct: 75 },
  reserved: null,
  tests: line,
  accounts: ACCOUNTS,
  loaded: new Set(),
  leadsByAccount: leadsByAccount(running),
  leadsPerAccount: 16,
  accountLeads: CAPS,
})

const slotRow = (name: string, over: Partial<SlotRow> = {}): SlotRow => ({
  id: name,
  name,
  requestedAt: T,
  seenAt: T,
  slot: null,
  leasedUntil: null,
  grantedAt: null,
  runMs: null,
  rssMib: null,
  peakRssMib: null,
  why: null,
  cwd: null,
  passedAt: null,
  passedBy: null,
  whyKind: null,
  waitSplit: {},
  ...over,
})
const holder = (name: string, slot: number) =>
  slotRow(name, { slot, leasedUntil: new Date(T.getTime() + 30_000), grantedAt: ago(2) })
const waiter = (name: string, minutes: number) => slotRow(name, { requestedAt: ago(minutes) })

describe('the lead admission follows the test line', () => {
  const rows = [
    holder('agent-workflows make check', 1),
    holder('iris make check-fast', 2),
    ...WAITED_MIN.map((m, i) => waiter(`step-${i}`, m)),
  ]
  const line = { ...testLineOf(rows, T), stepMs: 24_610 }

  test('the state of 2026-11-16 21:34 UTC replayed: 24 leads, 14 steps waiting, 2 running: no further lead', () => {
    expect(line).toMatchObject({ waiters: 14, holders: 2 })
    const verdict = checkAdmission(replayed(24, line))
    expect(verdict).toMatchObject({ admit: false, refusal: { kind: 'tests' } })
    if (!verdict.admit)
      expect(verdict.refusal.message).toBe(
        'the test line is long: 14 steps wait for a slot beside 2 running, half of them for over 6.2 min, longer than the 0.4 min a step takes (median of the last day)',
      )
  })

  test('it stays shut while the line drains and opens once fewer wait than run', () => {
    // the oldest waiters are served first, two at a time: the line shortens, its median wait falls
    let waiting = [...WAITED_MIN]
    const verdicts: boolean[] = []
    while (waiting.length > 0) {
      const drained = { waiters: waiting.length, holders: 2, medianWaitMs: median(waiting) * 60_000, stepMs: 24_610 }
      verdicts.push(checkAdmission(replayed(24, drained)).admit)
      waiting = waiting.slice(2)
    }
    verdicts.push(checkAdmission(replayed(24, { waiters: 0, holders: 2, medianWaitMs: 0, stepMs: 24_610 })).admit)
    // 14, 12, 10, 8, 6, 4 waiting: shut; 2 waiting beside 2 running: open; empty: open
    expect(verdicts).toEqual([false, false, false, false, false, false, true, true])
  })

  test('steps held back by their host-wide class are not the test line', () => {
    const apple = [
      holder('iris-apple', 1),
      ...['shutterflow-apple', 'ntfy-mac-apple', 'weatherorb apple'].map((name) => ({
        ...waiter(name, 5),
        whyKind: 'class' as const,
      })),
    ]
    expect(testLineOf(apple, T)).toEqual({ waiters: 0, holders: 1, medianWaitMs: 0 })
  })

  test('a fix is never kept out by the line', () => {
    const urgent = { ...replayed(24, line), candidate: { issue: id(1), urgent: true, since: null } }
    expect(checkAdmission(urgent).admit).toBe(true)
  })

  test('with an empty line and an idle host it admits beyond the 24 of that evening, up to the accounts', () => {
    const empty = { waiters: 0, holders: 0, medianWaitMs: 0, stepMs: 24_610 }
    let running = 24
    while (checkAdmission(replayed(running, empty, 2)).admit && running < 60) running += 1
    expect(running).toBe(40)
  })

  test('a short line, or waits shorter than a step, keep nobody out', () => {
    expect(lineRefusal({ waiters: 3, holders: 3, medianWaitMs: 600_000, stepMs: 30_000 })).toBeNull()
    expect(lineRefusal({ waiters: 9, holders: 2, medianWaitMs: 20_000, stepMs: 30_000 })).toBeNull()
    expect(lineRefusal({ waiters: 9, holders: 2, medianWaitMs: 600_000, stepMs: null })).toBeNull()
    expect(lineRefusal({ waiters: 3, holders: 2, medianWaitMs: 31_000, stepMs: 30_000 })).not.toBeNull()
  })
})

describe('the load tripwire', () => {
  const samples = (loads: (number | null)[], gapMin = 1) =>
    loads.map((load, i) => ({ at: new Date(T.getTime() - i * gapMin * 60_000), load }))

  test('trips after five minute samples on end over the ceiling, and the reading now still over it', () => {
    expect(loadTrip(samples([41, 40, 39, 38, 37]), 36, T, 42)).toEqual({ tripped: true, loads: [41, 40, 39, 38, 37] })
    expect(loadTrip(samples([41, 40, 39, 38, 37]), 36, T, 20)).toEqual({ tripped: false })
  })

  test('a peak, or four minutes over it, trips nothing: the longest run over the ceiling in three days was four', () => {
    expect(loadTrip(samples([68, 20, 18, 15, 12]), 36, T, 68)).toEqual({ tripped: false })
    expect(loadTrip(samples([48, 45, 40, 39, 30]), 36, T, 48)).toEqual({ tripped: false })
  })

  test('too few or stale samples are no reading: the caller falls back to the instant', () => {
    expect(loadTrip(samples([41, 40, 39, 38]), 36, T, 42)).toBeNull()
    expect(loadTrip(samples([41, 40, 39, 38, 37], 3), 36, T, 42)).toBeNull()
    expect(loadTrip(samples([41, 40, null, 38, 37]), 36, T, 42)).toBeNull()
  })

  test('the lead admission waits on a trip, not on one peak', () => {
    const idle = { waiters: 0, holders: 0, medianWaitMs: 0, stepMs: 24_610 }
    expect(checkAdmission({ ...replayed(10, idle, 66), loadTrip: { tripped: false } }).admit).toBe(true)
    const tripped = checkAdmission({
      ...replayed(10, idle, 66),
      loadTrip: { tripped: true, loads: [66, 50, 48, 40, 37] },
    })
    expect(tripped).toMatchObject({ admit: false, refusal: { kind: 'load' } })
    // no samples: the instant against the ceiling, as before
    expect(checkAdmission({ ...replayed(10, idle, 66), loadTrip: null }).admit).toBe(false)
  })
})

describe('the slot grant packs by measured cores and memory', () => {
  /** 12 cores, base 2 and up to 8 slots under the aim, 20 GiB free */
  const fit = (over: Partial<SlotFit> = {}): SlotFit => ({
    peakMib: 512,
    freeMib: 20_480,
    growthMib: 0,
    max: 8,
    loadOk: true,
    headroomMib: 2_621,
    cores: 12,
    ...over,
  })
  const size = {
    heavy: { mib: 7_546, cores: 9 },
    light: { mib: 512, cores: 0.5 },
  }
  const sized = (names: Record<string, keyof typeof size>) => ({
    peaksByName: new Map(Object.entries(names).map(([name, kind]) => [name, size[kind].mib])),
    coresByName: new Map(Object.entries(names).map(([name, kind]) => [name, size[kind].cores])),
  })
  const names = { heavy2: 'heavy', l1: 'light', l2: 'light', l3: 'light' } as const

  test('several light steps run beside one heavy one; a second heavy one waits for cores and is passed', () => {
    // running: one heavy step (9 cores) and one light (0.5)
    const rows = [
      holder('heavy1', 1),
      holder('light0', 2),
      waiter('heavy2', 3),
      waiter('l1', 2),
      waiter('l2', 1),
      waiter('l3', 0.5),
    ]
    const call = (name: keyof typeof names, held: number, list: SlotRow[]) =>
      touchSlots(
        list,
        {
          id: name,
          name,
          slots: 2,
          runMs: 1_800_000,
          fit: fit({
            ...sized(names),
            peakMib: size[names[name]].mib,
            stepCores: size[names[name]].cores,
            heldCores: held,
          }),
        },
        T,
      )
    const heavy = call('heavy2', 9.5, rows)
    expect(heavy.view).toMatchObject({ granted: false })
    expect(heavy.view.why).toBe(
      'waiting for cores: needs 9, the 2 running steps are learned to take 9.5 of the 12 cores',
    )
    let list = heavy.rows
    let held = 9.5
    for (const name of ['l1', 'l2', 'l3'] as const) {
      const light = call(name, held, list)
      expect(light.view).toMatchObject({ granted: true })
      list = light.rows
      held += 0.5
    }
    expect(list.filter((r) => r.slot !== null).map((r) => r.name)).toEqual(['heavy1', 'light0', 'l1', 'l2', 'l3'])
    // the heavy step that was passed is marked so: it holds the line once the window is over
    expect(list.find((r) => r.name === 'heavy2')?.passedBy).toBe('l1')
  })

  test('memory is packed too: a light step that does not fit the free memory waits for it', () => {
    const rows = [holder('heavy1', 1), holder('light0', 2), waiter('big', 1)]
    const big = touchSlots(
      rows,
      {
        id: 'big',
        name: 'big',
        slots: 2,
        runMs: 1_800_000,
        fit: fit({ peakMib: 19_000, stepCores: 0.5, heldCores: 1 }),
      },
      T,
    )
    expect(big.view).toMatchObject({ granted: false })
    expect(big.view.why).toContain('waiting for memory')
  })

  test('the base slots are kept whatever the cores: the first two steps always run', () => {
    const one = touchSlots(
      [holder('heavy1', 1)],
      {
        id: 'heavy2',
        name: 'heavy2',
        slots: 2,
        runMs: 1_800_000,
        fit: fit({ peakMib: 7_546, stepCores: 9, heldCores: 9 }),
      },
      T,
    )
    expect(one.view.granted).toBe(true)
  })

  test('learned cores are the p80 of the runs, the learned run their median', () => {
    const runs = [1, 2, 3, 4, 10].map((cores, i) => ({ cores, durationMs: (i + 1) * 60_000 }))
    expect(learnedCores(runs)).toBe(4)
    expect(learnedRunMs(runs)).toBe(180_000)
    expect(learnedCores([{ cores: null }])).toBeNull()
  })
})

describe('the Apple build is one host-wide class', () => {
  const call = (list: SlotRow[], name: string, cwd: string, at = T) =>
    touchSlots(
      list,
      {
        id: name,
        name,
        cwd,
        slots: 4,
        runMs: 1_800_000,
        fit: { peakMib: 2_048, freeMib: 20_480, growthMib: 0, max: 8, loadOk: true, headroomMib: 2_621 },
      },
      at,
    )

  test('the names the Apple slot gives every xcodebuild are the class; nothing else is', () => {
    expect(['iris-apple', 'shutterflow-apple', 'ntfy-mac-apple', 'weatherorb apple'].map(stepClassOf)).toEqual([
      'apple',
      'apple',
      'apple',
      'apple',
    ])
    expect(['shutterflow cargo test', 'pineapple', 'basalt-ui unit'].map(stepClassOf)).toEqual([null, null, null])
  })

  test("iris's and shutterflow's Apple builds draw from one class: the second waits while others pass it, and runs once the first ends", () => {
    const iris = call([], 'iris-apple', '/src/iris')
    expect(iris.view.granted).toBe(true)
    const shutterflow = call(iris.rows, 'shutterflow-apple', '/src/shutterflow')
    expect(shutterflow.view).toMatchObject({ granted: false })
    expect(shutterflow.view.why).toBe(
      'a step of the host-wide class apple holds a slot: one at a time, whichever repo runs it',
    )
    // a slot is free: a step that asked after it passes it
    const unit = call(shutterflow.rows, 'basalt-ui unit', '/src/basalt-ui', new Date(T.getTime() + 1000))
    expect(unit.view.granted).toBe(true)
    // and goes on passing it past the pass window: the line standing still frees the class no sooner
    const longPassed = [
      holder('iris-apple', 1),
      slotRow('shutterflow-apple', { requestedAt: ago(12), passedAt: ago(11), passedBy: 'basalt-ui unit' }),
    ]
    expect(call(longPassed, 'dotfiles make check', '/src/dotfiles').view.granted).toBe(true)
    const after = call(
      releaseSlot(unit.rows, 'iris-apple').rows,
      'shutterflow-apple',
      '/src/shutterflow',
      new Date(T.getTime() + 2000),
    )
    expect(after.view.granted).toBe(true)
  })
})

describe('the line is ordered for throughput', () => {
  test('a short step passes a long one that asked a little earlier; one that asked long before is not passed', () => {
    const runs = new Map<string, number | null>([
      ['long', 10 * 60_000],
      ['short', 30_000],
      ['early-long', 10 * 60_000],
    ])
    const order = lineOrder([waiter('long', 2), waiter('short', 1)], runs).map((r) => r.name)
    expect(order).toEqual(['short', 'long'])
    // asked 12 minutes ago for a 10-minute step: its place (2 min ago) is before anything that asks now
    const aged = lineOrder([waiter('early-long', 12), waiter('short', 0)], runs).map((r) => r.name)
    expect(aged).toEqual(['early-long', 'short'])
  })

  test('a step with no learned run takes the median of the line; with none learned the order is the order of asking', () => {
    const runs = new Map<string, number | null>([
      ['a', 60_000],
      ['b', 120_000],
      ['c', 600_000],
    ])
    const order = lineOrder([waiter('new', 3), waiter('a', 1), waiter('b', 2.5), waiter('c', 4)], runs).map(
      (r) => r.name,
    )
    // places: new -3+2 = -1, a -1+1 = 0, b -2.5+2 = -0.5, c -4+10 = 6
    expect(order).toEqual(['new', 'b', 'a', 'c'])
    expect(lineOrder([waiter('y', 1), waiter('x', 2)]).map((r) => r.name)).toEqual(['x', 'y'])
  })
})

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.floor((sorted.length - 1) / 2)] ?? 0
}
