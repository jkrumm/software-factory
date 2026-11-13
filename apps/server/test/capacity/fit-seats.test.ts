import { describe, expect, test } from 'bun:test'
import { type AdmissionInputs, checkAdmission, type LeadFit } from '../../src/domains/capacity/admission.ts'
import { freeMibOf, headroomMib } from '../../src/domains/capacity/costs.ts'
import { type SeatInputs, seatBonus } from '../../src/domains/capacity/seats.ts'

const now = new Date('2026-11-07T12:00:00Z')
const reading = {
  account: 'a',
  readAt: now,
  sampledAt: now,
  enabled: true,
  authOk: true,
  fiveHourUsed: 10,
  weeklyUsed: 20,
  fiveHourResetsAt: new Date(now.getTime() + 3_600_000),
  weeklyResetsAt: new Date(now.getTime() + 3 * 86_400_000),
  exhaustedUntil: null,
}
const inputs = (extra: Partial<AdmissionInputs> = {}): AdmissionInputs => ({
  now,
  state: 'run',
  leads: 4,
  holders: [],
  owed: [],
  candidate: { issue: 'issue_1' as never, urgent: false, since: null },
  lane: null,
  reserved: null,
  load: 3,
  loadCeiling: 60,
  memory: { swapoutMbPer300s: 0, swapUsedPct: 10 },
  memoryCeilings: { swapoutMbPer300s: 2048, swapUsedPct: 75 },
  accounts: [reading],
  loaded: new Set(),
  leadsByAccount: new Map(),
  leadsPerAccount: 2,
  ...extra,
})
const fit = (extra: Partial<LeadFit> = {}): LeadFit => ({
  repo: 'heavy',
  candidateMib: 18_000,
  attempts: 5,
  freeMib: 30_000,
  headroomMib: 2_621,
  running: 1,
  ...extra,
})

describe('the learned fit rule', () => {
  const cases: { name: string; fit: LeadFit | null; refused: boolean }[] = [
    {
      name: 'a heavy lead that does not fit beside the running ones',
      fit: fit({ candidateMib: 28_000 }),
      refused: true,
    },
    { name: 'a heavy lead that fits', fit: fit(), refused: false },
    { name: 'a small repo beside a heavy lead', fit: fit({ candidateMib: 600, freeMib: 4_000 }), refused: false },
    { name: 'an unknown learned cost', fit: fit({ candidateMib: null, freeMib: 1_000 }), refused: false },
    { name: 'an unknown free memory', fit: fit({ freeMib: null }), refused: false },
    { name: 'a lone lead on a host with little free', fit: fit({ freeMib: 1_000, running: 0 }), refused: false },
    { name: 'a running lead and little free memory', fit: fit({ freeMib: 1_000, running: 1 }), refused: true },
    { name: 'no fit given', fit: null, refused: false },
  ]
  for (const c of cases) {
    test(c.name, () => {
      const verdict = checkAdmission(inputs({ leadFit: c.fit }))
      expect(!verdict.admit).toBe(c.refused)
      if (!verdict.admit) expect(verdict.refusal.kind).toBe('memory')
    })
  }

  test('the refusal names the numbers', () => {
    const verdict = checkAdmission(inputs({ leadFit: fit({ candidateMib: 18_000, freeMib: 18_432 }) }))
    expect(verdict).toMatchObject({
      admit: false,
      refusal: {
        kind: 'memory',
        message:
          'memory: a lead of heavy takes ~17.6 GiB (p80 of 5 past leads), the host has 18 GiB free, headroom 2.6 GiB',
      },
    })
  })

  test('the fit comes after the swap ceilings and before the lane', () => {
    const swap = checkAdmission(
      inputs({ leadFit: fit({ candidateMib: 28_000 }), memory: { swapoutMbPer300s: 0, swapUsedPct: 90 } }),
    )
    expect(swap).toMatchObject({ admit: false, refusal: { message: expect.stringContaining('short of memory') } })
    const lane = checkAdmission(
      inputs({
        leadFit: fit({ candidateMib: 28_000 }),
        lane: { name: 'apple', cap: 1, holders: ['issue_9' as never] },
      }),
    )
    expect(lane).toMatchObject({ admit: false, refusal: { kind: 'memory' } })
  })

  test('a cap refusal names the raise when a bonus is in force', () => {
    const capped = inputs({ leadsByAccount: new Map([['a', 3]]), leadsPerAccount: 3, seatBonus: 1 })
    expect(checkAdmission(capped)).toMatchObject({
      admit: false,
      refusal: { kind: 'cap', message: expect.stringContaining('(raised by 1: the host is idle)') },
    })
    const plain = checkAdmission({ ...capped, seatBonus: 0 })
    expect(plain).toMatchObject({ admit: false, refusal: { kind: 'cap' } })
    if (!plain.admit) expect(plain.refusal.message).not.toContain('raised')
  })
})

describe('admission on a busy but idle host (6 leads running, test peaks are held back by the slot grant)', () => {
  const candidate = (repo: string, candidateMib: number, memory = { swapoutMbPer300s: 0, swapUsedPct: 10 }) =>
    checkAdmission(
      inputs({ memory, leadFit: fit({ repo, candidateMib, freeMib: 7_168, headroomMib: 2_662, running: 6 }) }),
    )

  test('a dotfiles and a software-factory lead are admitted on memory', () => {
    expect(candidate('dotfiles', 717).admit).toBe(true)
    expect(candidate('software-factory', 1_536).admit).toBe(true)
  })

  test('a lead that does not fit the free memory less headroom is refused with the numbers', () => {
    expect(candidate('weatherorb', 6_334)).toMatchObject({
      admit: false,
      refusal: {
        kind: 'memory',
        message:
          'memory: a lead of weatherorb takes ~6.2 GiB (p80 of 5 past leads), the host has 7 GiB free, headroom 2.6 GiB',
      },
    })
  })

  test('swapout over its ceiling still refuses', () => {
    const verdict = candidate('dotfiles', 717, { swapoutMbPer300s: 3_000, swapUsedPct: 10 })
    expect(verdict).toMatchObject({ admit: false, refusal: { message: expect.stringContaining('short of memory') } })
  })
})

describe('free memory and headroom', () => {
  test('from the newest sample', () => {
    const at = new Date(now.getTime() - 60_000)
    expect(freeMibOf({ at, memoryUsedPct: 50 }, 32_768, now)).toBe(16_384)
    expect(freeMibOf({ at: new Date(now.getTime() - 301_000), memoryUsedPct: 50 }, 32_768, now)).toBeNull()
    expect(freeMibOf({ at, memoryUsedPct: null }, 32_768, now)).toBeNull()
    expect(freeMibOf(null, 32_768, now)).toBeNull()
    expect(freeMibOf({ at, memoryUsedPct: 50 }, null, now)).toBeNull()
    expect(headroomMib(32_768)).toBe(2_621)
    expect(headroomMib(8_192)).toBe(2_048)
    expect(headroomMib(null)).toBe(2_048)
  })
})

describe('seatBonus', () => {
  const idle = { load: 2, swapUsedPct: 10 }
  const base = (extra: Partial<SeatInputs> = {}): SeatInputs => ({
    recent: [idle, idle, idle, idle, idle],
    loadCeiling: 60,
    swapCeilingPct: 75,
    queued: 3,
    freeMib: 20_000,
    typicalLeadMib: 4_096,
    headroomMib: 2_048,
    maxBonus: 2,
    ...extra,
  })

  test('an idle host with work queued raises seats up to the maximum', () => {
    expect(seatBonus(base())).toBe(2)
  })
  test('the free memory beyond the headroom bounds it', () => {
    expect(seatBonus(base({ freeMib: 7_000 }))).toBe(1)
    expect(seatBonus(base({ freeMib: 6_000 }))).toBe(0)
    expect(seatBonus(base({ freeMib: 2_000 }))).toBe(0)
  })
  test('the queued work bounds it', () => {
    expect(seatBonus(base({ queued: 1 }))).toBe(1)
  })
  test('nothing queued, off, or unknown memory gives 0', () => {
    expect(seatBonus(base({ queued: 0 }))).toBe(0)
    expect(seatBonus(base({ maxBonus: 0 }))).toBe(0)
    expect(seatBonus(base({ freeMib: null }))).toBe(0)
  })
  test('fewer than five samples give 0', () => {
    expect(seatBonus(base({ recent: [idle, idle, idle, idle] }))).toBe(0)
    expect(seatBonus(base({ recent: [] }))).toBe(0)
  })
  test('one busy sample, a load at the boundary, high swap or an unread figure gives 0', () => {
    const busy = { load: 15.1, swapUsedPct: 10 }
    expect(seatBonus(base({ recent: [idle, idle, busy, idle, idle] }))).toBe(0)
    expect(seatBonus(base({ recent: [idle, idle, { load: 15, swapUsedPct: 10 }, idle, idle] }))).toBe(2)
    expect(seatBonus(base({ recent: [idle, idle, { load: 1, swapUsedPct: 75 }, idle, idle] }))).toBe(0)
    expect(seatBonus(base({ recent: [idle, idle, { load: null, swapUsedPct: 1 }, idle, idle] }))).toBe(0)
    expect(seatBonus(base({ recent: [idle, idle, { load: 1, swapUsedPct: null }, idle, idle] }))).toBe(0)
  })
})
