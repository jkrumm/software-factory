import { describe, expect, test } from 'bun:test'
import { type AdmissionInputs, aimRefusal, checkAdmission, type LeadFit } from '../../src/domains/capacity/admission.ts'
import { freeMibOf, headroomMib } from '../../src/domains/capacity/costs.ts'
import {
  aimStep,
  LEAD_AIM_STEP_MS,
  type LeadAim,
  type LeadAimSignals,
  leadAimStep,
} from '../../src/domains/capacity/slot-aim.ts'

const AT = new Date('2026-11-18T11:48:00Z')
const at = (min: number) => new Date(AT.getTime() + min * 60_000)
const RAM_MIB = 32_768

describe('the free memory of a host sample', () => {
  const sample = { at: AT, memoryUsedPct: 77.1, kernelFreePct: 57 }

  test('the kernel figure is taken when the sample has it', () => {
    expect(freeMibOf(sample, RAM_MIB, at(1))).toBe(Math.round(RAM_MIB * 0.57))
  })

  test('the factory sum stays the fallback, and an unread host or a stale sample is unknown', () => {
    expect(freeMibOf({ ...sample, kernelFreePct: null }, RAM_MIB, at(1))).toBe(Math.round(RAM_MIB * (1 - 0.771)))
    expect(freeMibOf({ at: AT, memoryUsedPct: 77.1 }, RAM_MIB, at(1))).toBe(Math.round(RAM_MIB * (1 - 0.771)))
    expect(freeMibOf({ at: AT, memoryUsedPct: null, kernelFreePct: null }, RAM_MIB, at(1))).toBeNull()
    expect(freeMibOf(sample, RAM_MIB, at(6))).toBeNull()
    expect(freeMibOf(sample, null, at(1))).toBeNull()
    expect(freeMibOf(null, RAM_MIB, at(1))).toBeNull()
  })
})

const reading = {
  account: 'a',
  readAt: AT,
  sampledAt: AT,
  enabled: true,
  authOk: true,
  fiveHourUsed: 10,
  weeklyUsed: 20,
  fiveHourResetsAt: at(60),
  weeklyResetsAt: at(3 * 24 * 60),
  exhaustedUntil: null,
}
const verdict = (over: Partial<AdmissionInputs>) =>
  checkAdmission({
    now: AT,
    state: 'run',
    leads: 40,
    holders: [],
    owed: [],
    candidate: { issue: 'issue_1' as never, urgent: false, since: null },
    lane: null,
    reserved: null,
    load: 4.3,
    loadCeiling: 36,
    memory: { swapoutMbPer300s: 0, swapUsedPct: 3.5 },
    memoryCeilings: { swapoutMbPer300s: 2048, swapUsedPct: 75 },
    accounts: [reading],
    loaded: new Set(),
    leadsByAccount: new Map(),
    leadsPerAccount: 40,
    ...over,
  } satisfies AdmissionInputs)

/** 2026-11-18 11:48: a shutterflow lead learned at 4.3 GiB, 18 leads running, 2 of them young and still to take 4.8 GiB. */
const fit = (over: Partial<LeadFit>): LeadFit => ({
  repo: 'shutterflow',
  candidateMib: 4_403,
  attempts: 76,
  freeMib: 7_680,
  headroomMib: headroomMib(RAM_MIB),
  running: 18,
  growing: { leads: 2, mib: 4_915 },
  ...over,
})

describe('the state of 2026-11-18 11:48 UTC: pressure normal, swap steady, 22 of 40 seats idle', () => {
  test('the old rule (the factory sum: 7.5 GiB free, the young leads and the headroom taken off) admitted no lead', () => {
    const old = verdict({ leadFit: fit({}) })
    if (old.admit) throw new Error('expected the old rule to refuse')
    expect(old.refusal.kind).toBe('memory')
    expect(old.refusal.part).toBe('fit')
  })

  test('the lead aim admits while fewer leads run than the host takes, the fit left as the guard of what cannot fit', () => {
    const free = freeMibOf({ at: AT, memoryUsedPct: 77.1, kernelFreePct: 57 }, RAM_MIB, AT) as number
    const admitted = verdict({
      leadFit: fit({ freeMib: free, headroomMib: 0 }),
      leadAim: { target: 19, running: 18, pressureRead: true },
    })
    expect(admitted.admit).toBe(true)
  })

  test('as many leads as the aim allows run: no more, said in words', () => {
    const refused = verdict({ leadAim: { target: 18, running: 18, pressureRead: true } })
    if (refused.admit) throw new Error('expected a refusal')
    expect(refused.refusal).toMatchObject({ kind: 'memory', part: 'aim' })
    expect(refused.refusal.message).toContain('the host takes 18 leads at its pressure now')
  })

  test('a lead that cannot fit at all (its learned peak over the free memory) is refused whatever the aim says', () => {
    const refused = verdict({
      leadFit: fit({ candidateMib: 20_000, freeMib: 18_000, headroomMib: 0, growing: { leads: 0, mib: 0 } }),
      leadAim: { target: 40, running: 18, pressureRead: true },
    })
    if (refused.admit) throw new Error('expected a refusal')
    expect(refused.refusal.part).toBe('fit')
    expect(refused.refusal.message).not.toContain('headroom')
  })

  test('an unread pressure admits nothing beyond what runs: the aim fails closed', () => {
    const refused = verdict({ leadAim: { target: 40, running: 18, pressureRead: false } })
    if (refused.admit) throw new Error('expected a refusal')
    expect(refused.refusal.part).toBe('aim')
    expect(aimRefusal({ target: 40, running: 18, pressureRead: false })).toContain('not read')
  })

  test('without an aim the fit decides alone, as before', () => {
    expect(verdict({ leadFit: fit({ freeMib: 18_000 }), leadAim: null }).admit).toBe(true)
  })
})

describe('the lead aim', () => {
  const signals = (over: Partial<LeadAimSignals> = {}): LeadAimSignals => ({
    at: AT,
    pressureLevel: 1,
    swapGrowing: false,
    swapouts: false,
    load: 4.3,
    loadTrip: { tripped: false },
    loadCeiling: 36,
    running: 18,
    waiting: 24,
    ...over,
  })
  const quiet = (target: number, minutes = 2): LeadAim => ({ target, since: at(-minutes) })

  test('the first minute seeds the count at the leads running, never above what the host was taking', () => {
    expect(leadAimStep(null, signals()).state).toEqual({ target: 18, since: AT })
  })

  test('one lead more after two quiet minutes when the count binds and a lead waits for it, and the quiet restarts', () => {
    const step = leadAimStep(quiet(18), signals())
    expect(step.state).toEqual({ target: 19, since: AT })
    expect(LEAD_AIM_STEP_MS).toBe(120_000)
    // 19 now allowed, 18 run: not binding, nothing more is added until the 19th runs
    expect(leadAimStep({ target: 19, since: at(-3) }, signals({ running: 18 })).state.target).toBe(19)
    expect(leadAimStep({ target: 19, since: at(-3) }, signals({ running: 19 })).state.target).toBe(20)
  })

  test('one quiet minute, nobody waiting for the aim, an unread load or the tripped load tripwire add nothing', () => {
    expect(leadAimStep(quiet(18, 1), signals()).state.target).toBe(18)
    expect(leadAimStep(quiet(18), signals({ waiting: 0 })).state.target).toBe(18)
    expect(leadAimStep(quiet(18), signals({ load: null })).state.target).toBe(18)
    const tripped = leadAimStep(
      quiet(18),
      signals({ load: 50, loadTrip: { tripped: true, loads: [50, 41, 40, 39, 38] } }),
    )
    expect(tripped.state.target).toBe(18)
    expect(tripped.reason).toContain('load over 36 in each of the last 5 minutes')
  })

  test('pressure warning, swap growth or swapouts halve what runs (never below one) and end the quiet', () => {
    expect(leadAimStep(quiet(30), signals({ pressureLevel: 2 })).state).toEqual({ target: 9, since: null })
    expect(leadAimStep(quiet(30), signals({ pressureLevel: 4 })).state).toEqual({ target: 9, since: null })
    expect(leadAimStep(quiet(30), signals({ swapGrowing: true })).state).toEqual({ target: 9, since: null })
    expect(leadAimStep(quiet(30), signals({ swapouts: true })).state).toEqual({ target: 9, since: null })
    expect(leadAimStep(quiet(30), signals({ pressureLevel: 2, running: 0 })).state.target).toBe(1)
  })

  test('with the count halved below the leads running, the gate admits none until they end', () => {
    const halved = leadAimStep(quiet(19), signals({ pressureLevel: 2 })).state
    expect(halved.target).toBe(9)
    const refused = verdict({ leadAim: { target: halved.target, running: 18, pressureRead: true } })
    expect(refused.admit).toBe(false)
  })

  test('an unread pressure holds the count and is not quiet', () => {
    expect(leadAimStep(quiet(20), signals({ pressureLevel: null })).state).toEqual({ target: 20, since: null })
  })

  test('the slot aim halves on swapouts too', () => {
    const state = { target: 6, quietSince: at(-10) }
    const step = aimStep(
      state,
      {
        at: AT,
        pressureLevel: 1,
        swapGrowing: false,
        load: 6,
        loadTrip: { tripped: false },
        loadCeiling: 36,
        waiters: 1,
        swapouts: true,
      },
      6,
    )
    expect(step.state).toEqual({ target: 3, quietSince: null })
  })
})
