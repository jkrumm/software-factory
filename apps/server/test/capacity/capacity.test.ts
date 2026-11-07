import { describe, expect, test } from 'bun:test'
import { type AccountReading, pickAccount, standing, WEEK_MS } from '../../src/domains/capacity/accounts.ts'
import { type AdmissionInputs, checkAdmission } from '../../src/domains/capacity/admission.ts'
import { type Claimant, claimRoom } from '../../src/domains/capacity/claims.ts'
import {
  describeMemory,
  memoryReadingOf,
  overLoad,
  overMemory,
  swapUsedBytes,
} from '../../src/domains/capacity/host.ts'
import { holdsClaim } from '../../src/domains/capacity/claims.ts'
import {
  releaseSlot,
  SLOT_LEASE_MS,
  type SlotRow,
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

  test('every account at its cap says cap, with the window of none', () => {
    const verdict = checkAdmission(inputs({ leadsByAccount: new Map([['a', 2]]) }))
    expect(verdict).toMatchObject({ admit: false, refusal: { kind: 'cap' } })
  })
})

describe('test slots', () => {
  const call = (rows: SlotRow[], who: string, at: Date, slots = 2) =>
    touchSlots(rows, { id: who, name: who, slots, runMs: 1_800_000 }, at)

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

  test('a slot held past half its limit has a line, derived at read', () => {
    const rows = call([], 'make test', now).rows
    expect(slotLines(rows, at(14 * 60_000))).toEqual([])
    expect(slotLines([{ ...rows[0], leasedUntil: at(3_600_000) } as SlotRow], at(20 * 60_000))).toEqual([
      'test slot 1 held by "make test" for 20 min, limit 30 min',
    ])
  })
})
