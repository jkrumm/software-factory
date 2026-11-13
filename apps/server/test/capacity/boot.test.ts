import { describe, expect, test } from 'bun:test'
import { type AdmissionInputs, checkAdmission } from '../../src/domains/capacity/admission.ts'
import { BOOT_ADMIT_GAP_MS, type BootInputs, type BootSample, bootRefusal } from '../../src/domains/capacity/boot.ts'
import { bootTimeSeconds } from '../../src/domains/capacity/host.ts'

const now = new Date('2026-11-13T18:20:00Z')
const MIN = 60_000

/** Five minute samples since the boot, newest first, each `load` and `memory` as given. */
const samples = (load: number | null, memoryUsedPct: number | null, count = 5): BootSample[] =>
  Array.from({ length: count }, (_, i) => ({ at: new Date(now.getTime() - (i + 1) * 30_000), load, memoryUsedPct }))

const boot = (extra: Partial<BootInputs> = {}): BootInputs => ({
  uptimeMs: 10 * MIN,
  samples: samples(10, 60),
  lastAdmittedAt: null,
  load: 10,
  loadCeiling: 60,
  ...extra,
})

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
  load: 10,
  loadCeiling: 60,
  memory: { swapoutMbPer300s: 0, swapUsedPct: 10 },
  memoryCeilings: { swapoutMbPer300s: 2048, swapUsedPct: 75 },
  accounts: [reading],
  loaded: new Set(),
  leadsByAccount: new Map(),
  leadsPerAccount: 4,
  ...extra,
})

describe('the boot grace', () => {
  test('uptime 5 min and load 200: refused with the boot reason, before the load', () => {
    const verdict = checkAdmission(
      inputs({ load: 200, boot: boot({ uptimeMs: 5 * MIN, load: 200, samples: samples(200, 60) }) }),
    )
    expect(verdict).toMatchObject({ admit: false, refusal: { kind: 'boot' } })
    if (!verdict.admit) expect(verdict.refusal.message).toContain('host booted 5 min ago')
  })

  test('uptime 10 min, load under a quarter for 5 min and memory 60%: admits one, refuses the next within 2 min', () => {
    expect(checkAdmission(inputs({ boot: boot() })).admit).toBe(true)
    const justAdmitted = boot({ lastAdmittedAt: new Date(now.getTime() - 30_000) })
    const verdict = checkAdmission(inputs({ boot: justAdmitted }))
    expect(verdict).toMatchObject({ admit: false, refusal: { kind: 'boot' } })
    if (!verdict.admit) {
      expect(verdict.refusal.message).toContain('host booted 10 min ago')
      expect(verdict.refusal.opensAt).toEqual(new Date(now.getTime() - 30_000 + BOOT_ADMIT_GAP_MS))
    }
    expect(checkAdmission(inputs({ boot: boot({ lastAdmittedAt: new Date(now.getTime() - 2 * MIN) }) })).admit).toBe(
      true,
    )
  })

  test('uptime 40 min behaves as today: no boot reason, the load ceiling still holds', () => {
    const late = boot({ uptimeMs: 40 * MIN, samples: [], load: 200 })
    expect(checkAdmission(inputs({ boot: late })).admit).toBe(true)
    expect(checkAdmission(inputs({ load: 200, boot: late }))).toMatchObject({ admit: false, refusal: { kind: 'load' } })
    expect(
      checkAdmission(inputs({ boot: boot({ uptimeMs: 40 * MIN, lastAdmittedAt: new Date(now.getTime() - 1000) }) }))
        .admit,
    ).toBe(true)
  })

  test('an unread uptime does not apply the grace', () => {
    expect(checkAdmission(inputs({ boot: null })).admit).toBe(true)
  })
})

describe('what ends the wait', () => {
  test.each([
    ['fewer than five samples', boot({ samples: samples(10, 60, 4) }), 'minutes of samples'],
    ['a sample from before the boot', boot({ uptimeMs: 2 * MIN }), 'minutes of samples'],
    [
      'a sample older than six minutes',
      boot({ samples: samples(10, 60).map((s) => ({ ...s, at: new Date(now.getTime() - 7 * MIN) })) }),
      'minutes of samples',
    ],
    [
      'one sample with a load of a quarter',
      boot({
        samples: [...samples(10, 60, 4), { at: new Date(now.getTime() - 4 * MIN), load: 15, memoryUsedPct: 60 }],
      }),
      'the load must stay under 15',
    ],
    ['an unread sample load', boot({ samples: samples(null, 60) }), 'unknown'],
    ['the load now', boot({ load: 20 }), 'the load must stay under 15'],
    ['memory at 80%', boot({ samples: samples(10, 80) }), 'memory in use must be under 80%'],
    ['an unread memory', boot({ samples: samples(10, null) }), 'memory in use must be under 80%'],
  ])('%s keeps a new lead out', (_name, input, reason) => {
    const refusal = bootRefusal(input, now)
    expect(refusal?.message).toContain(reason)
    expect(refusal?.message).toContain('host booted')
  })

  test('the boot time is read from kern.boottime', () => {
    expect(bootTimeSeconds('{ sec = 1731520000, usec = 123456 } Thu Nov 13 19:06:40 2026')).toBe(1731520000)
    expect(bootTimeSeconds('nonsense')).toBeNull()
  })
})
