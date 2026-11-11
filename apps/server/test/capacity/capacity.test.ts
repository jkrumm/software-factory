import { describe, expect, test } from 'bun:test'
import {
  type AccountRank,
  type AccountReading,
  pickAccount,
  READING_MAX_AGE_MS,
  standing,
  WEEK_MS,
} from '../../src/domains/capacity/accounts.ts'
import { type AdmissionInputs, checkAdmission } from '../../src/domains/capacity/admission.ts'
import { type Claimant, claimRoom } from '../../src/domains/capacity/claims.ts'
import {
  describeMemory,
  memoryReadingOf,
  overLoad,
  overMemory,
  reservedOf,
  swapUsedBytes,
} from '../../src/domains/capacity/host.ts'
import { holdsClaim } from '../../src/domains/capacity/claims.ts'
import { laneRoom } from '../../src/domains/capacity/lanes.ts'
import { growthMib, learnedPeakMib } from '../../src/domains/capacity/costs.ts'
import {
  releaseSlot,
  SLOT_LEASE_MS,
  type SlotRow,
  type SlotFit,
  slotLines,
  touchSlots,
  WAITER_TTL_MS,
} from '../../src/domains/capacity/slots.ts'
import { type IssueId, issueId } from '../../src/kernel/ids.ts'

const now = new Date('2026-11-07T12:00:00Z')
const at = (ms: number) => new Date(now.getTime() + ms)
const reading = (account: string, extra: Partial<AccountReading> = {}): AccountReading => ({
  account,
  readAt: now,
  sampledAt: at(-60_000),
  enabled: true,
  authOk: true,
  fiveHourUsed: 20,
  weeklyUsed: 30,
  fiveHourResetsAt: at(3_600_000),
  weeklyResetsAt: at(WEEK_MS / 2),
  exhaustedUntil: null,
  ...extra,
})
const id = (n: number): IssueId => issueId(n)
const claimant = (n: number, urgent = false): Claimant => ({ issue: id(n), urgent })

describe('accounts and their windows', () => {
  test('an account below 85 % of its 5-hour window and 95 % of its week is open', () => {
    expect(standing(reading('a'), now)).toEqual({ open: true })
    expect(standing(reading('a', { fiveHourUsed: 85 }), now)).toMatchObject({ open: false, until: at(3_600_000) })
    expect(standing(reading('a', { weeklyUsed: 95 }), now)).toMatchObject({ open: false, until: at(WEEK_MS / 2) })
  })

  test('a window without a number counts as unused, both without is no sample; disabled and signed-out are closed', () => {
    expect(standing(reading('a', { fiveHourUsed: null }), now).open).toBe(true)
    expect(standing(reading('a', { fiveHourUsed: null, weeklyUsed: null }), now)).toMatchObject({
      open: false,
      why: 'no usage sample',
    })
    expect(standing(reading('a', { sampledAt: null }), now).open).toBe(false)
    expect(standing(reading('a', { enabled: false }), now)).toMatchObject({ open: false, why: 'disabled' })
    expect(standing(reading('a', { authOk: false }), now)).toMatchObject({ open: false, why: 'not signed in' })
    expect(standing(reading('a', { exhaustedUntil: at(60_000) }), now)).toMatchObject({
      open: false,
      until: at(60_000),
    })
  })

  test('under pace, weekly use above the elapsed share of the week closes it until the share catches up', () => {
    const r = reading('a', { weeklyUsed: 80, weeklyResetsAt: at(WEEK_MS / 2) })
    const s = standing(r, now, true)
    expect(s).toMatchObject({ open: false })
    expect(s.open ? null : s.until?.getTime()).toBe(at(WEEK_MS / 2).getTime() - WEEK_MS + 0.8 * WEEK_MS)
  })

  test('it picks the open account with the least weekly use, never one a lead started on since its sample', () => {
    const readings = [
      reading('a', { weeklyUsed: 50 }),
      reading('b', { weeklyUsed: 10 }),
      reading('c', { weeklyUsed: 90 }),
    ]
    const input = { readings, loaded: new Set<string>(), leads: new Map<string, number>(), leadsPerAccount: 2, now }
    expect(pickAccount(input)).toMatchObject({ picked: { account: 'b' } })
    expect(pickAccount({ ...input, loaded: new Set(['b']) })).toMatchObject({ picked: { account: 'a' } })
  })

  test('an account at its lead cap is passed over; with none left the reason says cap', () => {
    const readings = [reading('a'), reading('b')]
    const base = { readings, loaded: new Set<string>(), leadsPerAccount: 2, now }
    expect(pickAccount({ ...base, leads: new Map([['a', 2]]) })).toMatchObject({ picked: { account: 'b' } })
    expect(
      pickAccount({
        ...base,
        leads: new Map([
          ['a', 2],
          ['b', 2],
        ]),
      }),
    ).toMatchObject({ picked: null, capped: true })
  })

  test('never spills: with every account closed it says why and when the first one opens; stale readings admit nothing', () => {
    const closed = [reading('a', { fiveHourUsed: 90 }), reading('b', { weeklyUsed: 96, weeklyResetsAt: at(7_200_000) })]
    const pick = pickAccount({ readings: closed, loaded: new Set(), leads: new Map(), leadsPerAccount: 2, now })
    expect(pick).toMatchObject({ picked: null, opensAt: at(3_600_000), capped: false })
    expect(pick.picked === null && pick.why).toContain('a 5-hour window at 90%')
    const stale = [reading('a', { readAt: at(-11 * 60_000) })]
    expect(
      pickAccount({ readings: stale, loaded: new Set(), leads: new Map(), leadsPerAccount: 2, now }),
    ).toMatchObject({
      picked: null,
      why: 'no fresh usage reading of any account',
    })
  })
})

describe('the host', () => {
  const ceilings = { swapoutMbPer300s: 2048, swapUsedPct: 75 }

  test('either number over its ceiling keeps a new lead out, and the reason carries the numbers', () => {
    expect(overMemory({ swapoutMbPer300s: 2049, swapUsedPct: 10 }, ceilings)).toBe(true)
    expect(overMemory({ swapoutMbPer300s: 0, swapUsedPct: 75.1 }, ceilings)).toBe(true)
    expect(overMemory({ swapoutMbPer300s: 2048, swapUsedPct: 75 }, ceilings)).toBe(false)
    expect(describeMemory({ swapoutMbPer300s: 3100, swapUsedPct: 80 }, ceilings)).toBe(
      'swapouts 3100 MiB/300s (ceiling 2048), swap 80% of RAM (ceiling 75%)',
    )
    expect(overLoad(60.1, 60)).toBe(true)
    expect(overLoad(60, 60)).toBe(false)
  })

  test('vm.swapusage is read in bytes; the swapout counter gives a rate from two samples and starts over on a reboot', () => {
    expect(swapUsedBytes('total = 10240.00M  used = 9012.25M  free = 1227.75M  (encrypted)')).toBe(
      9012.25 * 1024 * 1024,
    )
    expect(swapUsedBytes('nonsense')).toBeNull()
    const base = { pageSize: 16_384, ramBytes: 32 * 1024 ** 3, swapUsedBytes: 8 * 1024 ** 3 }
    const first = memoryReadingOf({ ...base, before: null, now: { swapoutPages: 1000, at: 0 } })
    expect(first).toEqual({ swapoutMbPer300s: 0, swapUsedPct: 25 })
    // 65,536 pages x 16 KiB = 1 GiB in 150 s: 2 GiB per 300 s
    const second = memoryReadingOf({
      ...base,
      before: { swapoutPages: 1000, at: 0 },
      now: { swapoutPages: 66_536, at: 150_000 },
    })
    expect(second.swapoutMbPer300s).toBe(2048)
    const reboot = memoryReadingOf({
      ...base,
      before: { swapoutPages: 66_536, at: 0 },
      now: { swapoutPages: 5, at: 60_000 },
    })
    expect(reboot.swapoutMbPer300s).toBe(0)
  })
})

describe('claims in a repo', () => {
  test('leads: 2 claims two ordinary leads; the third has no claim and the reason names who holds them', () => {
    const holders = [claimant(1), claimant(2)]
    const third = claimRoom({ leads: 2, holders, owed: [], candidate: claimant(3) })
    expect(third).toMatchObject({ granted: false, heldBy: [id(1), id(2)] })
    expect(third.granted === false && third.message).toBe('the repo runs 2 of 2 leads (Issue 1, Issue 2)')
    expect(claimRoom({ leads: 2, holders: [claimant(1)], owed: [], candidate: claimant(3) }).granted).toBe(true)
  })

  test('a fix has one more place than leads, and never uses up an ordinary one', () => {
    const full = [claimant(1)]
    expect(claimRoom({ leads: 1, holders: full, owed: [], candidate: claimant(2) }).granted).toBe(false)
    expect(claimRoom({ leads: 1, holders: full, owed: [], candidate: claimant(2, true) }).granted).toBe(true)
    const withFix = [claimant(5, true)]
    expect(claimRoom({ leads: 1, holders: withFix, owed: [], candidate: claimant(2) }).granted).toBe(true)
    expect(
      claimRoom({ leads: 1, holders: [claimant(1), claimant(5, true)], owed: [], candidate: claimant(6, true) })
        .granted,
    ).toBe(false)
  })

  test('resumed leads without a claim are served first: a new lead never takes the place one waits for', () => {
    const owed = [claimant(1)]
    expect(claimRoom({ leads: 1, holders: [], owed, candidate: claimant(2) })).toMatchObject({ granted: false })
    expect(claimRoom({ leads: 1, holders: [], owed, candidate: claimant(1) }).granted).toBe(true)
    // the younger resumed lead waits behind the older one
    expect(claimRoom({ leads: 1, holders: [], owed: [claimant(1), claimant(4)], candidate: claimant(4) }).granted).toBe(
      false,
    )
  })

  test('owed leads are ordered by the earliest wait end, then the Issue number; none counts itself or one behind it', () => {
    const owedAt = (n: number, minute: number, urgent = false): Claimant => ({
      issue: id(n),
      urgent,
      since: at(minute * 60_000),
    })
    // 494, 495, 496 woke in the order 495, 496, 494; one place is free
    const owed = [owedAt(494, 45), owedAt(495, 0), owedAt(496, 30)]
    const granted = (n: number, holders: Claimant[] = []) =>
      claimRoom({ leads: 1, holders, owed, candidate: owed.find((o) => o.issue === id(n)) as Claimant }).granted
    expect([494, 495, 496].filter((n) => granted(n))).toEqual([495])
    // the first holds the place: the others wait, and the reason counts only those ahead of them
    const held = [claimant(495)]
    expect([494, 496].map((n) => granted(n, held))).toEqual([false, false])
    const behind = claimRoom({
      leads: 1,
      holders: held,
      owed: owed.filter((o) => o.issue !== id(495)),
      candidate: owedAt(494, 45),
    })
    expect(behind.granted === false && behind.message).toContain('1 resumed lead(s) are served first')
    // the same wait end: the lower Issue number first
    const tied = [owedAt(7, 5), owedAt(3, 5)]
    expect(claimRoom({ leads: 1, holders: [], owed: tied, candidate: tied[1] as Claimant }).granted).toBe(true)
    expect(claimRoom({ leads: 1, holders: [], owed: tied, candidate: tied[0] as Claimant }).granted).toBe(false)
    // a new lead is behind every owed lead
    expect(claimRoom({ leads: 1, holders: [], owed, candidate: claimant(1) }).granted).toBe(false)
  })

  test('property: while a place is free for the owed leads, one of them is always granted, and never more than the places', () => {
    let seed = 20_261_109
    const random = (max: number) => {
      seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648
      return seed % max
    }
    for (let round = 0; round < 500; round++) {
      const leads = 1 + random(3)
      const numbers = new Set<number>()
      while (numbers.size < 1 + random(6) + 1) numbers.add(1 + random(40))
      const [holderNumbers, owedNumbers] = [
        [...numbers].slice(0, random(leads + 2)),
        [...numbers].slice(random(leads + 2)),
      ]
      if (owedNumbers.length === 0) continue
      const holders = holderNumbers.map((n) => claimant(n, random(5) === 0))
      const owed: Claimant[] = owedNumbers.map((n) => ({
        issue: id(n),
        urgent: random(5) === 0,
        since: random(4) === 0 ? null : at(random(6) * 60_000),
      }))
      const ordinary = holders.filter((h) => !h.urgent).length
      const room = holders.length < leads + 1 && (ordinary < leads || owed.some((o) => o.urgent))
      const winners = owed.filter((o) => claimRoom({ leads, holders, owed, candidate: o }).granted)
      if (room) expect(winners.length).toBeGreaterThan(0)
      expect(winners.length).toBeLessThanOrEqual(leads + 1 - holders.length)
      // deterministic: the same inputs in another order grant the same Issues
      const shuffled = [...owed].reverse()
      expect(owed.filter((o) => claimRoom({ leads, holders, owed: shuffled, candidate: o }).granted)).toEqual(winners)
    }
  })

  test('which waits give the claim back: a person, a timer and a dependency; a stall keeps it', () => {
    for (const reason of ['decision', 'review', 'errand', 'timer', 'dependency'])
      expect(holdsClaim('waiting', reason)).toBe(false)
    for (const reason of ['wall', 'unreported', 'blocked', 'regressed'])
      expect(holdsClaim('waiting', reason)).toBe(true)
    expect(holdsClaim('working', null)).toBe(true)
    expect(holdsClaim('watching', null)).toBe(true)
    for (const state of ['settling', 'queued', 'closed']) expect(holdsClaim(state, null)).toBe(false)
  })
})

describe('admission', () => {
  const inputs = (extra: Partial<AdmissionInputs> = {}): AdmissionInputs => ({
    now,
    state: 'run',
    leads: 1,
    holders: [],
    owed: [],
    candidate: claimant(1),
    lane: null,
    reserved: null,
    load: 3,
    loadCeiling: 60,
    memory: { swapoutMbPer300s: 0, swapUsedPct: 10 },
    memoryCeilings: { swapoutMbPer300s: 2048, swapUsedPct: 75 },
    accounts: [reading('a')],
    loaded: new Set(),
    leadsByAccount: new Map(),
    leadsPerAccount: 2,
    ...extra,
  })

  test('nothing in the way admits it on an account', () => {
    expect(checkAdmission(inputs())).toMatchObject({ admit: true, account: { account: 'a' } })
  })

  test('the first rule that says no wins: drain, load, memory, claim, then the account', () => {
    const everything = inputs({
      state: 'drain',
      load: 99,
      memory: { swapoutMbPer300s: 5000, swapUsedPct: 90 },
      holders: [claimant(9)],
      accounts: [reading('a', { fiveHourUsed: 99 })],
    })
    const kind = (extra: Partial<AdmissionInputs>) => {
      const verdict = checkAdmission({ ...everything, ...extra })
      return verdict.admit ? 'admit' : verdict.refusal.kind
    }
    expect(kind({})).toBe('drain')
    expect(kind({ state: 'run' })).toBe('load')
    expect(kind({ state: 'run', load: 1 })).toBe('memory')
    expect(kind({ state: 'run', load: 1, memory: null })).toBe('claim')
    expect(kind({ state: 'run', load: 1, memory: null, holders: [] })).toBe('window')
    expect(kind({ state: 'run', load: 1, memory: null, holders: [], accounts: [reading('a')] })).toBe('admit')
  })

  test('the memory reason says memory and the numbers; a reading that could not be taken admits without it', () => {
    const held = checkAdmission(inputs({ memory: { swapoutMbPer300s: 3100, swapUsedPct: 80 } }))
    expect(held).toMatchObject({ admit: false, refusal: { kind: 'memory' } })
    expect(!held.admit && held.refusal.message).toBe(
      'the host is short of memory: swapouts 3100 MiB/300s (ceiling 2048), swap 80% of RAM (ceiling 75%)',
    )
    expect(checkAdmission(inputs({ memory: null, load: null })).admit).toBe(true)
  })

  test('pace claims one lead whatever leads says, and spends only toward the weekly pace', () => {
    expect(checkAdmission(inputs({ state: 'pace', leads: 3, holders: [claimant(9)] }))).toMatchObject({
      admit: false,
      refusal: { kind: 'claim' },
    })
    const ahead = reading('a', { weeklyUsed: 80, weeklyResetsAt: at(WEEK_MS / 2) })
    expect(checkAdmission(inputs({ state: 'pace', accounts: [ahead] }))).toMatchObject({
      admit: false,
      refusal: { kind: 'window' },
    })
  })

  test('a full lane says lane before the repo claims and the account, and names who holds it', () => {
    const full = { name: 'apple', cap: 1, holders: [id(9)] }
    const verdict = checkAdmission(inputs({ leads: 2, lane: full }))
    expect(verdict).toMatchObject({ admit: false, refusal: { kind: 'lane' } })
    expect(!verdict.admit && verdict.refusal.message).toBe('lane apple is full (1 of 1): Issue 9')
    // the sharper reason wins over a full repo; without a lane the repo's claims speak
    expect(checkAdmission(inputs({ holders: [claimant(8)], lane: full }))).toMatchObject({ refusal: { kind: 'lane' } })
    expect(checkAdmission(inputs({ holders: [claimant(8)] }))).toMatchObject({ refusal: { kind: 'claim' } })
    // the lane before the account
    expect(
      checkAdmission(inputs({ leads: 2, lane: full, accounts: [reading('a', { fiveHourUsed: 99 })] })),
    ).toMatchObject({ refusal: { kind: 'lane' } })
    expect(checkAdmission(inputs({ leads: 2, lane: { ...full, holders: [] } })).admit).toBe(true)
  })

  test('every account at its cap says cap, with the window of none', () => {
    const verdict = checkAdmission(inputs({ leadsByAccount: new Map([['a', 2]]) }))
    expect(verdict).toMatchObject({ admit: false, refusal: { kind: 'cap' } })
  })
})

describe('lanes reserve host memory', () => {
  const ceilings = { swapoutMbPer300s: 2048, swapUsedPct: 75 }
  const idle = { swapoutMbPer300s: 0, swapUsedPct: 10 }

  test('a reservation is a share of RAM, and none without a RAM reading or a memory', () => {
    expect(reservedOf(18 * 1024, 32_768)).toEqual({ mib: 18_432, pct: 56.3 })
    expect(reservedOf(0, 32_768)).toBeNull()
    expect(reservedOf(18 * 1024, null)).toBeNull()
  })

  test('the reserved share counts as swap in use, and the reason names it', () => {
    const reserved = reservedOf(2 * 18 * 1024, 32_768)
    expect(overMemory(idle, ceilings, null)).toBe(false)
    expect(overMemory(idle, ceilings, reservedOf(18 * 1024, 32_768))).toBe(false)
    expect(overMemory(idle, ceilings, reserved)).toBe(true)
    expect(describeMemory(idle, ceilings, reserved)).toBe(
      'swapouts 0 MiB/300s (ceiling 2048), swap 10% of RAM (ceiling 75%), plus 36 GiB reserved by lanes (112.5% of RAM)',
    )
  })

  test('admission says memory, with the reservation, when the lanes already fill the host', () => {
    const verdict = checkAdmission({
      now,
      state: 'run',
      leads: 2,
      holders: [],
      owed: [],
      candidate: claimant(1),
      lane: null,
      reserved: reservedOf(2 * 18 * 1024, 32_768),
      load: 3,
      loadCeiling: 60,
      memory: idle,
      memoryCeilings: ceilings,
      accounts: [reading('a')],
      loaded: new Set(),
      leadsByAccount: new Map(),
      leadsPerAccount: 2,
    })
    expect(verdict).toMatchObject({ admit: false, refusal: { kind: 'memory' } })
    expect(!verdict.admit && verdict.refusal.message).toContain('36 GiB reserved by lanes')
  })
})

describe('lanes', () => {
  test('room is left under the cap; a fix and an uncapped lane are never held', () => {
    const lane = { name: 'apple', cap: 2, holders: [id(1)] }
    expect(laneRoom({ lane, urgent: false })).toEqual({ granted: true })
    expect(laneRoom({ lane: { ...lane, holders: [id(1), id(2)] }, urgent: false })).toMatchObject({ granted: false })
    expect(laneRoom({ lane: { ...lane, holders: [id(1), id(2)] }, urgent: true })).toEqual({ granted: true })
    expect(laneRoom({ lane: null, urgent: false })).toEqual({ granted: true })
  })
})

describe('test slots', () => {
  const open: SlotFit = { peakMib: null, freeMib: null, growthMib: 0, max: 2, loadOk: true, headroomMib: 2048 }
  const call = (rows: SlotRow[], who: string, at: Date, slots = 2, fit: SlotFit = { ...open, max: slots }) =>
    touchSlots(rows, { id: who, name: who, slots, runMs: 1_800_000, fit }, at)

  test('the first callers get the slots, the third waits in line behind them', () => {
    const a = call([], 'a', now)
    const b = call(a.rows, 'b', now)
    const c = call(b.rows, 'c', now)
    expect([a.view.granted, b.view.granted, c.view.granted]).toEqual([true, true, false])
    expect([a.view.slot, b.view.slot]).toEqual([1, 2])
    expect(c.view).toMatchObject({ granted: false, ahead: 0, runMs: 1_800_000 })
  })

  test('a slot goes back, and the waiter first in line takes it on its next call', () => {
    let rows = call(call([], 'a', now).rows, 'b', now).rows
    rows = call(rows, 'c', at(1000)).rows
    rows = releaseSlot(rows, 'a').rows
    expect(call(rows, 'c', at(2000)).view).toMatchObject({ granted: true, slot: 1 })
  })

  test('waiters are served in the order they asked', () => {
    let rows = call([], 'a', now, 1).rows
    rows = call(rows, 'first', at(1000), 1).rows
    rows = call(rows, 'second', at(2000), 1).rows
    rows = releaseSlot(rows, 'a').rows
    expect(call(rows, 'second', at(3000), 1).view).toMatchObject({ granted: false, ahead: 1 })
    expect(call(rows, 'first', at(3000), 1).view).toMatchObject({ granted: true })
  })

  test('a holder that stops renewing loses its slot at the next call of anyone; a waiter that stops asking leaves the line', () => {
    const held = call([], 'a', now, 1)
    expect(call(held.rows, 'b', at(SLOT_LEASE_MS - 1), 1).view.granted).toBe(false)
    expect(call(held.rows, 'b', at(SLOT_LEASE_MS + 1), 1).view.granted).toBe(true)
    const line = call(call([], 'a', now, 1).rows, 'ghost', at(1000), 1)
    expect(call(line.rows, 'b', at(1000 + WAITER_TTL_MS + 1), 1).rows.some((r) => r.id === 'ghost')).toBe(false)
  })

  test('a renewal keeps the lease and the slot; the grant fixes the run limit', () => {
    const first = call([], 'a', now)
    const renewed = call(first.rows, 'a', at(20_000))
    expect(renewed.view).toMatchObject({ granted: true, slot: 1, runMs: 1_800_000 })
    expect(renewed.rows[0]?.leasedUntil).toEqual(at(20_000 + SLOT_LEASE_MS))
  })

  describe('the memory rule', () => {
    // two base slots, up to four; the step needs 18000 MiB, the host has 30000 free with 2048 headroom
    const fit: SlotFit = { peakMib: 18_000, freeMib: 30_000, growthMib: 0, max: 4, loadOk: true, headroomMib: 2048 }
    const withHolders = (count: number): SlotRow[] =>
      Array.from({ length: count }, (_, i) => ({
        id: `h${i}`,
        name: `h${i}`,
        requestedAt: now,
        seenAt: now,
        slot: i + 1,
        leasedUntil: at(SLOT_LEASE_MS),
        grantedAt: now,
        runMs: 1_800_000,
        rssMib: null,
        peakRssMib: null,
        why: null,
      }))
    const cases: { name: string; holders: number; fit: Partial<SlotFit>; granted: boolean; why?: string }[] = [
      { name: 'a lone step is always granted', holders: 0, fit: { freeMib: 100 }, granted: true },
      { name: 'the second step is granted while it fits', holders: 1, fit: {}, granted: true },
      {
        name: 'the second step waits when peak and growth do not fit, and says memory',
        holders: 1,
        fit: { growthMib: 10_000 },
        granted: false,
        why: 'waiting for memory: needs 17.6 GiB',
      },
      { name: 'an unknown peak grants a base slot', holders: 1, fit: { peakMib: null }, granted: true },
      { name: 'an unknown free memory grants a base slot', holders: 1, fit: { freeMib: null }, granted: true },
      {
        name: 'a slot beyond the base is granted when it fits and the load is low',
        holders: 2,
        fit: { freeMib: 60_000 },
        granted: true,
      },
      {
        name: 'a slot beyond the base needs the load to allow it',
        holders: 2,
        fit: { freeMib: 60_000, loadOk: false, load: 14, extraLoad: 12 },
        granted: false,
        why: 'load 14 is over 12',
      },
      {
        name: 'a slot beyond the base needs a known peak',
        holders: 2,
        fit: { peakMib: null, freeMib: 60_000 },
        granted: false,
        why: 'no learned peak',
      },
      {
        name: 'a slot beyond the base needs known free memory',
        holders: 2,
        fit: { freeMib: null },
        granted: false,
        why: 'free-memory',
      },
      {
        name: 'a slot beyond the base waits when it does not fit',
        holders: 2,
        fit: { freeMib: 15_000 },
        granted: false,
        why: 'waiting for memory',
      },
      { name: 'max is a hard cap', holders: 4, fit: { freeMib: 900_000 }, granted: false, why: 'all 4 slots are busy' },
    ]
    for (const c of cases) {
      test(c.name, () => {
        const asked = call(withHolders(c.holders), 'w', now, 2, { ...fit, ...c.fit })
        expect(asked.view.granted).toBe(c.granted)
        if (c.why) expect(asked.view.why).toContain(c.why)
        else if (c.granted) expect(asked.view.why).toBeNull()
      })
    }

    test('the reason is a line of the view while the waiter asks, and a grant clears it', () => {
      const held = withHolders(1)
      const waiting = call(held, 'w', now, 2, { ...fit, growthMib: 10_000 })
      expect(slotLines(waiting.rows, now)).toEqual([`test slot wait "w": ${waiting.view.why}`])
      expect(slotLines(waiting.rows, at(WAITER_TTL_MS + 1))).toEqual([])
      const later = call(waiting.rows, 'w', at(1000), 2, fit)
      expect(later.view).toMatchObject({ granted: true, why: null })
    })

    test('a renewal saves the size of the holder and keeps its peak', () => {
      const first = call([], 'a', now)
      const input = { id: 'a', name: 'a', slots: 2, runMs: 1, fit: open }
      const sized = touchSlots(first.rows, { ...input, rssMib: 900, peakRssMib: 900 }, at(1000))
      const smaller = touchSlots(sized.rows, { ...input, rssMib: 400, peakRssMib: 400 }, at(2000))
      expect(smaller.rows[0]).toMatchObject({ rssMib: 400, peakRssMib: 900 })
    })
  })

  describe('the ledger', () => {
    test('the learned peak is the largest of the 8 newest measured peaks', () => {
      expect(learnedPeakMib([])).toBeNull()
      expect(learnedPeakMib([null, null])).toBeNull()
      expect(learnedPeakMib([null, 300, 900, null])).toBe(900)
      expect(learnedPeakMib([100, 100, 100, 100, 100, 100, 100, 100, 5000])).toBe(100)
    })

    test('growth is what each holder is learned to reach less what it holds, never negative', () => {
      const learned = new Map<string, number | null>([
        ['a', 8000],
        ['b', 100],
        ['c', null],
      ])
      const holders = [
        { name: 'a', rssMib: 3000 },
        { name: 'b', rssMib: 400 },
        { name: 'c', rssMib: null },
        { name: 'a', rssMib: null },
      ]
      expect(growthMib(holders, learned)).toBe(5000 + 8000)
    })
  })

  test('a slot held past half its limit has a line, derived at read', () => {
    const rows = call([], 'make test', now).rows
    expect(slotLines(rows, at(14 * 60_000))).toEqual([])
    expect(slotLines([{ ...rows[0], leasedUntil: at(3_600_000) } as SlotRow], at(20 * 60_000))).toEqual([
      'test slot 1 held by "make test" for 20 min, limit 30 min',
    ])
  })
})

describe('the picker rank orders the open accounts, the gates stay', () => {
  const hour = 3_600_000
  const readings = [
    reading('iu', { weeklyUsed: 80, weeklyResetsAt: at(32 * hour) }),
    reading('me', { weeklyUsed: 54, weeklyResetsAt: at(46 * hour) }),
    reading('me2', { weeklyUsed: 11, weeklyResetsAt: at(132 * hour) }),
  ]
  const rank = (accounts: string[], readAt = now): AccountRank => ({
    lane: 'bulk',
    order: accounts.map((account) => ({ account, reason: 'home', weight: null })),
    at: readAt,
    readAt,
  })
  const base = { readings, loaded: new Set<string>(), leads: new Map<string, number>(), leadsPerAccount: 2, now }
  const order = ['me', 'me2', 'iu']

  test('the head of a fresh rank is picked over the account with the lowest weekly use', () => {
    expect(pickAccount({ ...base, rank: rank(order) })).toMatchObject({ picked: { account: 'me' } })
  })

  test('an account at its lead cap or loaded since its sample is passed over to the next in the rank', () => {
    const capped = new Map([['me', 2]])
    expect(pickAccount({ ...base, rank: rank(order), leads: capped })).toMatchObject({ picked: { account: 'me2' } })
    expect(pickAccount({ ...base, rank: rank(order), loaded: new Set(['me']) })).toMatchObject({
      picked: { account: 'me2' },
    })
  })

  test('an account absent from the rank goes after the ranked ones, by lowest weekly use', () => {
    expect(pickAccount({ ...base, rank: rank(['iu']) })).toMatchObject({ picked: { account: 'iu' } })
    expect(pickAccount({ ...base, rank: rank(['iu']), loaded: new Set(['iu']) })).toMatchObject({
      picked: { account: 'me2' },
    })
  })

  test('a stale or missing rank leaves the lowest weekly use', () => {
    const stale = rank(order, at(-READING_MAX_AGE_MS - 1))
    expect(pickAccount({ ...base, rank: stale })).toMatchObject({ picked: { account: 'me2' } })
    expect(pickAccount({ ...base, rank: null })).toMatchObject({ picked: { account: 'me2' } })
  })

  test('a ranked account that is closed is still refused', () => {
    const closed = [reading('me', { weeklyUsed: 96 }), ...readings.slice(2)]
    expect(pickAccount({ ...base, readings: closed, rank: rank(order) })).toMatchObject({ picked: { account: 'me2' } })
    expect(pickAccount({ ...base, readings: [closed[0] as AccountReading], rank: rank(order) })).toMatchObject({
      picked: null,
    })
  })
})
