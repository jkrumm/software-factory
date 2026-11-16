import { describe, expect, test } from 'bun:test'
import { checkAdmission, type AdmissionInputs, type LeadFit } from '../../src/domains/capacity/admission.ts'
import { headroomMib } from '../../src/domains/capacity/costs.ts'
import { leadGrowth, type RunningLead } from '../../src/domains/capacity/leadcost.ts'
import fixture from './fixtures/memory-fit-replay.json'

/**
 * The recorded window (`fixtures/memory-fit-replay.json`): every third minute of 2026-11-15 11:03 to 2026-11-16 20:27 UTC
 * in which the live fit refused a queued Issue, with the host's free memory, the candidates, the young leads and what the
 * host did in the next 30 minutes. The live rule refused every one of these minutes; the rule under test is asked again.
 */
interface Row {
  at: string
  freeMib: number
  ramMib: number
  queued: number[]
  young: [number, number, number][]
  burstInMin: number | null
  liveAdmitInMin: number | null
}
const rows = fixture.rows as Row[]

const now = new Date('2026-11-16T12:00:00Z')
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
const verdict = (fit: Partial<LeadFit>) =>
  checkAdmission({
    now,
    state: 'run',
    leads: 40,
    holders: [],
    owed: [],
    candidate: { issue: 'issue_1' as never, urgent: false, since: null },
    lane: null,
    reserved: null,
    load: 3,
    loadCeiling: 60,
    memory: { swapoutMbPer300s: 0, swapUsedPct: 2 },
    memoryCeilings: { swapoutMbPer300s: 2048, swapUsedPct: 75 },
    accounts: [reading],
    loaded: new Set(),
    leadsByAccount: new Map(),
    leadsPerAccount: 40,
    leadFit: { repo: 'r', candidateMib: 700, attempts: 10, freeMib: 6_000, headroomMib: 2_621, running: 5, ...fit },
  } satisfies AdmissionInputs)

const leadsOf = (row: Row, ageMs: (seconds: number) => number): RunningLead[] =>
  row.young.map(([learnedMib, heldMib, seconds]) => ({ learnedMib, heldMib, ageMs: ageMs(seconds) }))

/** The minute is open when some queued candidate fits what the host had free, less the headroom and what the leads are about to take. */
const admits = (row: Row, growth: number): boolean =>
  row.queued.some(
    (candidateMib) =>
      verdict({
        candidateMib,
        freeMib: row.freeMib,
        headroomMib: headroomMib(row.ramMib),
        growing: { leads: 1, mib: growth },
        running: row.young.length + 1,
      }).admit,
  )

describe('the memory fit over the recorded window', () => {
  const growth = (row: Row) => leadGrowth(leadsOf(row, (seconds) => seconds * 1000)).mib

  test('the minutes the fit still refuses are under half of the minutes it refused live', () => {
    const open = rows.filter((row) => admits(row, growth(row)))
    const refusedNow = rows.length - open.length
    expect(rows.length).toBeGreaterThan(400)
    expect(refusedNow / rows.length).toBeLessThan(0.5)
  })

  test('no minute it opens is followed by swapout above the ceiling that the live rule did not meet first', () => {
    const hurt = rows.filter(
      (row) =>
        admits(row, growth(row)) &&
        row.burstInMin !== null &&
        !(row.liveAdmitInMin !== null && row.liveAdmitInMin <= row.burstInMin),
    )
    expect(hurt.map((row) => row.at)).toEqual([])
  })

  test('a free memory too small for the candidate and the headroom is refused whatever the leads hold', () => {
    const tight = verdict({ candidateMib: 2_300, freeMib: 4_500, headroomMib: 2_621, growing: { leads: 0, mib: 0 } })
    expect(tight.admit).toBe(false)
  })
})

describe('the state of 2026-11-16 20:20 UTC', () => {
  // 26 of 32 GiB used, pressure normal, five leads started 5 to 25 minutes ago, each holding what its repo's leads hold within a minute of starting.
  const leads = [25, 17, 12, 8, 5].map((minutes) => ({ learnedMib: 717, heldMib: 57, ageMs: minutes * 60_000 }))
  const lead = { candidateMib: 717, freeMib: 6_144, headroomMib: headroomMib(32_768), running: 5 }

  test('a 0.7 GiB lead is admitted', () => {
    expect(verdict({ ...lead, growing: leadGrowth(leads) }).admit).toBe(true)
  })

  test('counted as growing until 30 minutes old they reserved 3.2 GiB, and the lead was refused', () => {
    const grown = leads.reduce((sum, l) => sum + Math.max(0, l.learnedMib - l.heldMib), 0)
    expect(grown).toBe(3_300)
    expect(verdict({ ...lead, growing: { leads: 5, mib: grown } }).admit).toBe(false)
  })

  test('a lead that started a minute before the reading is still reserved, and the refusal names its numbers', () => {
    const fresh = leadGrowth([{ learnedMib: 2_253, heldMib: 300, ageMs: 60_000 }])
    const refused = verdict({ ...lead, candidateMib: 2_253, growing: fresh })
    if (refused.admit) throw new Error('expected a refusal')
    expect(refused.refusal.message).toContain(
      'the host has 6 GiB free, of which 1 young lead still takes 1.9 GiB more, headroom 2.6 GiB',
    )
  })
})
