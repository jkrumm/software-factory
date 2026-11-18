import { describe, expect, test } from 'bun:test'
import { type AdmissionInputs, checkAdmission } from '../../src/domains/capacity/admission.ts'
import {
  type DiskFit,
  diskHeadroomMib,
  diskRefusal,
  dueWorktrees,
  learnedWorktreeMib,
  mibOfDu,
  SIZE_EVERY_MS,
  SIZES_PER_PASS,
} from '../../src/domains/capacity/disk.ts'

const GIB = 1024
const now = new Date('2026-11-18T12:00:00Z')
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
  leads: 64,
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
const fit = (extra: Partial<DiskFit> = {}): DiskFit => ({
  repo: 'shutterflow',
  candidateMib: 2 * GIB,
  attempts: 17,
  freeMib: 130 * GIB,
  headroomMib: diskHeadroomMib(1000 * GIB),
  running: 6,
  growingMib: 0,
  ...extra,
})

describe('the learned worktree footprint', () => {
  test('is the p80 of the newest ten attempts, and nothing with fewer than three', () => {
    expect(learnedWorktreeMib([100, 200])).toBeNull()
    expect(learnedWorktreeMib([100, 200, 300])).toBe(300)
    // eleven attempts: only the newest ten count, so the old 9000 is out
    expect(learnedWorktreeMib([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 9000])).toBe(8)
  })

  test('du output is read in MiB', () => {
    expect(mibOfDu('2097152\t/work/tree\n')).toBe(2048)
    expect(mibOfDu('du: cannot read')).toBeNull()
  })

  test('the headroom is 10 GiB, or 5 % of a large volume', () => {
    expect(diskHeadroomMib(null)).toBe(10 * GIB)
    expect(diskHeadroomMib(100 * GIB)).toBe(10 * GIB)
    expect(diskHeadroomMib(1000 * GIB)).toBe(50 * GIB)
  })
})

describe('disk admission by fit', () => {
  test('admits a lead whose learned footprint fits the free disk less the headroom', () => {
    // 130 GiB free, 50 GiB headroom, 2 GiB wanted
    expect(checkAdmission(inputs({ diskFit: fit() })).admit).toBe(true)
  })

  test('refuses a lead whose learned footprint does not fit, naming the disk and the numbers', () => {
    const verdict = checkAdmission(inputs({ diskFit: fit({ candidateMib: 90 * GIB }) }))
    expect(verdict).toMatchObject({
      admit: false,
      refusal: {
        kind: 'disk',
        message:
          'disk: a worktree of shutterflow takes ~90 GiB with its build output (p80 of 17 past attempts), the host has 130 GiB free, headroom 50 GiB',
      },
    })
  })

  test('counts what the leads that just started will still take', () => {
    const young = fit({ candidateMib: 20 * GIB, growingMib: 70 * GIB })
    expect(diskRefusal(young)).toContain('70 GiB is still to come from leads that just started')
    expect(checkAdmission(inputs({ diskFit: young })).admit).toBe(false)
    expect(checkAdmission(inputs({ diskFit: { ...young, growingMib: 10 * GIB } })).admit).toBe(true)
  })

  test('keeps nobody out without a learned size, a disk reading, or while no lead runs', () => {
    expect(diskRefusal(fit({ candidateMib: null }))).toBeNull()
    expect(diskRefusal(fit({ freeMib: null, candidateMib: 900 * GIB }))).toBeNull()
    expect(diskRefusal(fit({ running: 0, freeMib: 1, candidateMib: 900 * GIB }))).toBeNull()
    expect(checkAdmission(inputs({ diskFit: null })).admit).toBe(true)
  })
})

describe('the worktrees due a measurement', () => {
  test('are those not measured within ten minutes, the longest unmeasured first, a few per pass', () => {
    const t = 10_000_000
    const trees = ['/a', '/b', '/c', '/d', '/e', '/f'].map((path) => ({ path }))
    const last = new Map([
      ['/a', t - 1000],
      ['/b', t - SIZE_EVERY_MS - 5],
      ['/c', t - SIZE_EVERY_MS - 50],
    ])
    expect(dueWorktrees(trees, last, t)).toEqual(['/d', '/e', '/f'].slice(0, SIZES_PER_PASS))
    expect(dueWorktrees(trees.slice(0, 3), last, t)).toEqual(['/c', '/b'])
  })
})
