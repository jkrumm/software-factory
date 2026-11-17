import { describe, expect, test } from 'bun:test'
import {
  type AccountRank,
  type AccountReading,
  pickAccount,
  READING_MAX_AGE_MS,
  roomLeft,
  standing,
  tightestReset,
  WEEK_MS,
} from '../../src/domains/capacity/accounts.ts'
import { type AdmissionInputs, checkAdmission } from '../../src/domains/capacity/admission.ts'
import { type Claimant, claimRoom } from '../../src/domains/capacity/claims.ts'
import {
  describeMemory,
  loadCeilingOf,
  memoryReadingOf,
  overLoad,
  overMemory,
  reservedOf,
  sustainedSwapoutMb,
  swapUsedBytes,
} from '../../src/domains/capacity/host.ts'
import { hostRule, planningSettings } from '../../src/app/planning-settings.ts'
import { holdsClaim } from '../../src/domains/capacity/claims.ts'
import { laneRoom } from '../../src/domains/capacity/lanes.ts'
import { growthMib, learnedPeakMib } from '../../src/domains/capacity/costs.ts'
import {
  releaseSlot,
  SLOT_LEASE_MS,
  type SlotRow,
  type SlotFit,
  slotLines,
  slotLiveIn,
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
  test('an account is open until a window is reached: at 100 % by default, at the setting when one is given', () => {
    expect(standing(reading('a'), now)).toEqual({ open: true })
    expect(standing(reading('a', { fiveHourUsed: 85, weeklyUsed: 97 }), now)).toEqual({ open: true })
    expect(standing(reading('a', { fiveHourUsed: 100 }), now)).toMatchObject({ open: false, until: at(3_600_000) })
    expect(standing(reading('a', { weeklyUsed: 100 }), now)).toMatchObject({ open: false, until: at(WEEK_MS / 2) })
    const limits = { fiveHour: 85, weekly: 95 }
    expect(standing(reading('a', { fiveHourUsed: 85 }), now, { limits })).toMatchObject({ open: false })
    expect(standing(reading('a', { weeklyUsed: 94 }), now, { limits })).toEqual({ open: true })
    expect(standing(reading('a', { weeklyUsed: 95 }), now, { limits })).toMatchObject({ open: false })
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
    const s = standing(r, now, { pace: true })
    expect(s).toMatchObject({ open: false })
    expect(s.open ? null : s.until?.getTime()).toBe(at(WEEK_MS / 2).getTime() - WEEK_MS + 0.8 * WEEK_MS)
  })

  test('room left is the tightest window in points of its limit; a window with no number does not count', () => {
    expect(roomLeft(reading('a', { fiveHourUsed: 20, weeklyUsed: 30 }))).toBe(70)
    expect(roomLeft(reading('a', { fiveHourUsed: 90, weeklyUsed: 30 }))).toBe(10)
    expect(roomLeft(reading('a', { fiveHourUsed: null, weeklyUsed: 25 }))).toBe(75)
    expect(roomLeft(reading('a', { fiveHourUsed: 20, weeklyUsed: 30 }), { fiveHour: 85, weekly: 95 })).toBe(65)
  })

  test('it picks the open account with the most room in its tightest window, never one a lead started on since its sample', () => {
    const readings = [
      reading('a', { weeklyUsed: 50 }),
      reading('b', { weeklyUsed: 10 }),
      reading('c', { weeklyUsed: 90 }),
    ]
    const input = { readings, loaded: new Set<string>(), leads: new Map<string, number>(), leadsPerAccount: 2, now }
    expect(pickAccount(input)).toMatchObject({ picked: { account: 'b' } })
    // `b` has a 5-hour window at 20 %: below the pacing point, a lead started since its sample does not hold it back
    expect(pickAccount({ ...input, loaded: new Set(['b']) })).toMatchObject({ picked: { account: 'b' } })
    const busy = readings.map((r) => (r.account === 'b' ? { ...r, fiveHourUsed: 80 } : r))
    expect(pickAccount({ ...input, readings: busy, loaded: new Set(['b']) })).toMatchObject({
      picked: { account: 'a' },
    })
  })

  test('a week closer to its end weighs as much as a 5-hour window: the smaller room decides', () => {
    const readings = [
      reading('week', { fiveHourUsed: 10, weeklyUsed: 80 }),
      reading('hours', { fiveHourUsed: 60, weeklyUsed: 10 }),
    ]
    const input = { readings, loaded: new Set<string>(), leads: new Map<string, number>(), leadsPerAccount: 2, now }
    expect(pickAccount(input)).toMatchObject({ picked: { account: 'hours' } })
  })

  test('a nearly full account gets a lead only when the roomier ones are at their caps', () => {
    const readings = [reading('full', { weeklyUsed: 92 }), reading('roomy', { weeklyUsed: 20 })]
    const base = { readings, loaded: new Set<string>(), leadsPerAccount: 2, now }
    expect(pickAccount({ ...base, leads: new Map([['roomy', 1]]) })).toMatchObject({ picked: { account: 'roomy' } })
    expect(pickAccount({ ...base, leads: new Map([['roomy', 2]]) })).toMatchObject({ picked: { account: 'full' } })
  })

  test('an account takes leads up to its own cap; one not named takes the default', () => {
    const readings = [reading('iu', { fiveHourUsed: null, weeklyUsed: 25 }), reading('me', { weeklyUsed: 60 })]
    const accountCaps = new Map([['iu', 20]])
    const base = { readings, loaded: new Set<string>(), leadsPerAccount: 10, accountCaps, now }
    expect(pickAccount({ ...base, leads: new Map([['iu', 19]]) })).toMatchObject({ picked: { account: 'iu' } })
    expect(pickAccount({ ...base, leads: new Map([['iu', 20]]) })).toMatchObject({ picked: { account: 'me' } })
    const full = pickAccount({
      ...base,
      leads: new Map([
        ['iu', 20],
        ['me', 10],
      ]),
    })
    expect(full).toMatchObject({ picked: null, capped: true })
    expect(full.picked === null && full.why).toContain('iu 20 of 20, me 10 of 10')
  })

  test('an account with no 5-hour window takes leads at once; one with a window above 70 % takes one per sample', () => {
    const none = reading('iu', { fiveHourUsed: null, weeklyUsed: 25 })
    const high = reading('me', { fiveHourUsed: 80 })
    const low = reading('lo', { fiveHourUsed: 70 })
    const loaded = new Set(['iu', 'me', 'lo'])
    const base = { loaded, leads: new Map<string, number>(), leadsPerAccount: 20, now }
    expect(pickAccount({ ...base, readings: [none] })).toMatchObject({ picked: { account: 'iu' } })
    expect(pickAccount({ ...base, readings: [low] })).toMatchObject({ picked: { account: 'lo' } })
    expect(pickAccount({ ...base, readings: [high] })).toMatchObject({
      picked: null,
      why: 'the open accounts took a lead since their last sample',
      capped: false,
    })
  })

  test('an account at 97 % of its week still takes a lead by default, and is refused at the limit', () => {
    const base = { loaded: new Set<string>(), leads: new Map<string, number>(), leadsPerAccount: 2, now }
    expect(pickAccount({ ...base, readings: [reading('a', { weeklyUsed: 97 })] })).toMatchObject({
      picked: { account: 'a' },
    })
    const refused = pickAccount({ ...base, readings: [reading('a', { weeklyUsed: 100 })] })
    expect(refused).toMatchObject({ picked: null, opensAt: at(WEEK_MS / 2) })
    expect(refused.picked === null && refused.why).toContain('week at 100% (limit 100%)')
    expect(
      pickAccount({ ...base, readings: [reading('a', { weeklyUsed: 97 })], limits: { fiveHour: 100, weekly: 95 } }),
    ).toMatchObject({ picked: null })
  })

  test('the reset a lead that hit the wall waits for: the closing window, else the one nearest its limit', () => {
    const closed = reading('a', { fiveHourUsed: 100 })
    expect(standing(closed, now)).toMatchObject({ open: false, until: at(3_600_000) })
    const behind = reading('a', { fiveHourUsed: 97, weeklyUsed: 40 })
    expect(tightestReset(behind, now)).toEqual(at(3_600_000))
    expect(tightestReset(reading('a', { fiveHourUsed: null, weeklyUsed: 97 }), now)).toEqual(at(WEEK_MS / 2))
    expect(tightestReset(reading('a', { fiveHourUsed: 20, weeklyUsed: 95 }), now)).toEqual(at(WEEK_MS / 2))
    expect(tightestReset(reading('a', { fiveHourUsed: 97, fiveHourResetsAt: null }), now)).toBeNull()
    // a rate limit far from any window is a throttle: no wait for a reset
    expect(tightestReset(reading('a', { fiveHourUsed: 50, weeklyUsed: 60 }), now)).toBeNull()
    expect(tightestReset(reading('a', { fiveHourUsed: 97, fiveHourResetsAt: at(-1) }), now)).toBeNull()
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
    const closed = [
      reading('a', { fiveHourUsed: 100 }),
      reading('b', { weeklyUsed: 100, weeklyResetsAt: at(7_200_000) }),
    ]
    const pick = pickAccount({ readings: closed, loaded: new Set(), leads: new Map(), leadsPerAccount: 2, now })
    expect(pick).toMatchObject({ picked: null, opensAt: at(3_600_000), capped: false })
    expect(pick.picked === null && pick.why).toContain('a 5-hour window at 100%')
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

  test('the throughput rule: a load ceiling in multiples of the cores', () => {
    expect(loadCeilingOf(12, 3)).toBe(36)
    expect(loadCeilingOf(8, 2.5)).toBe(20)
    expect(loadCeilingOf(0, 3)).toBe(1)
  })

  test('the throughput rule is shadowed beside the fixed ceiling until it is switched on', () => {
    const settings = (env: Record<string, string>) =>
      planningSettings({ FACTORY_LOAD_CEILING: '120', ...env }, { cores: 12 })
    expect(hostRule(settings({}))).toEqual({
      loadCeiling: 120,
      processCap: null,
      shadow: { loadCeiling: 36, processCap: 1800 },
    })
    expect(
      hostRule(settings({ FACTORY_LOAD_RULE: 'on', FACTORY_LOAD_PER_CORE: '2', FACTORY_PROCESS_CAP: '1200' })),
    ).toEqual({
      loadCeiling: 24,
      processCap: 1200,
      shadow: null,
    })
  })

  test('the account caps and the window limits: defaults, the named caps, and refusals of what is no cap', () => {
    const settings = (env: Record<string, string>) => planningSettings(env, { cores: 12 })
    expect(settings({})).toMatchObject({ leadsPerAccount: 2, windowLimits: { fiveHour: 100, weekly: 100 } })
    expect([...settings({}).accountLeads]).toEqual([])
    const named = settings({
      FACTORY_ACCOUNT_LEADS: 'iu=20, me=10,me2=10',
      FACTORY_LEADS_PER_ACCOUNT: '64',
      FACTORY_FIVE_HOUR_LIMIT: '90',
      FACTORY_WEEKLY_LIMIT: '97',
    })
    expect([...named.accountLeads]).toEqual([
      ['iu', 20],
      ['me', 10],
      ['me2', 10],
    ])
    expect(named).toMatchObject({ leadsPerAccount: 64, windowLimits: { fiveHour: 90, weekly: 97 } })
    for (const bad of ['iu', 'iu=0', 'iu=65', 'iu=x', 'iu=2=3', 'iu=2,iu=3', '=4'])
      expect(() => settings({ FACTORY_ACCOUNT_LEADS: bad })).toThrow('FACTORY_ACCOUNT_LEADS')
    expect(() => settings({ FACTORY_LEADS_PER_ACCOUNT: '65' })).toThrow('FACTORY_LEADS_PER_ACCOUNT')
    expect(() => settings({ FACTORY_WEEKLY_LIMIT: '101' })).toThrow('FACTORY_WEEKLY_LIMIT')
  })

  test('swapouts are graded over the last 300 s of minute samples, so a lull between bursts keeps the gate shut (Issue 858)', () => {
    const now = new Date('2026-11-12T06:58:00Z')
    const at = (minutesAgo: number) => new Date(now.getTime() - minutesAgo * 60_000)
    // 06:54 to 06:58 of the incident's neighbour: 6027, 0, 1507, 0, 11349 per 300 s -> 18,883 MiB in five minutes / 5
    const burst = [
      { at: at(0), swapoutMbPer300s: 0 },
      { at: at(1), swapoutMbPer300s: 11349 },
      { at: at(2), swapoutMbPer300s: 0 },
      { at: at(3), swapoutMbPer300s: 1507 },
      { at: at(4), swapoutMbPer300s: 6027 },
    ]
    expect(sustainedSwapoutMb(burst, now)).toBe(3777)
    expect(sustainedSwapoutMb(burst, now)).toBeGreaterThan(2048)
    // the burst leaves the window: five quiet minutes open the gate
    expect(sustainedSwapoutMb(burst, new Date(now.getTime() + 5 * 60_000))).toBe(0)
    // unreadable and stale samples count as nothing
    expect(
      sustainedSwapoutMb(
        [
          { at: at(0), swapoutMbPer300s: null },
          { at: at(9), swapoutMbPer300s: 9000 },
        ],
        now,
      ),
    ).toBe(0)
    expect(sustainedSwapoutMb([], now)).toBe(0)
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

  test("a red doctor refuses the project's lead with its own words, after a drain and before the host's readings", () => {
    const words = 'lab cannot run on this host: lab seed missing'
    const refused = checkAdmission(inputs({ doctor: words, load: 99 }))
    expect(refused).toMatchObject({ admit: false, refusal: { kind: 'doctor', message: words, opensAt: null } })
    expect(checkAdmission(inputs({ doctor: words, state: 'drain' }))).toMatchObject({ refusal: { kind: 'drain' } })
    expect(checkAdmission(inputs({ doctor: null }))).toMatchObject({ admit: true })
  })

  test('the first rule that says no wins: drain, load, memory, claim, then the account', () => {
    const everything = inputs({
      state: 'drain',
      load: 99,
      memory: { swapoutMbPer300s: 5000, swapUsedPct: 90 },
      holders: [claimant(9)],
      accounts: [reading('a', { fiveHourUsed: 100 })],
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

  test('two accounts with caps of 20 and 10 take leads up to their own cap; the cap refusal names each account and number', () => {
    const accounts = [
      reading('iu', { fiveHourUsed: null, weeklyUsed: 25 }),
      reading('me', { fiveHourUsed: 40, weeklyUsed: 40 }),
    ]
    const accountLeads = new Map([
      ['iu', 20],
      ['me', 10],
    ])
    const held = (iu: number, me: number) =>
      new Map([
        ['iu', iu],
        ['me', me],
      ])
    const verdict = (iu: number, me: number, extra: Partial<AdmissionInputs> = {}) =>
      checkAdmission(inputs({ accounts, accountLeads, leadsPerAccount: 2, leadsByAccount: held(iu, me), ...extra }))
    expect(verdict(19, 0)).toMatchObject({ admit: true, account: { account: 'iu' } })
    expect(verdict(20, 9)).toMatchObject({ admit: true, account: { account: 'me' } })
    const full = verdict(20, 10)
    expect(full).toMatchObject({ admit: false, refusal: { kind: 'cap' } })
    if (!full.admit) expect(full.refusal.message).toContain('iu 20 of 20, me 10 of 10')
    // the idle host's raise is on top of each account's own cap
    const raised = verdict(20, 10, { leadsPerAccount: 3, seatBonus: 1 })
    expect(raised).toMatchObject({ admit: true, account: { account: 'iu' } })
    expect(verdict(21, 11, { leadsPerAccount: 3, seatBonus: 1 })).toMatchObject({ admit: false })
  })

  test('an account at 97 % of its week takes a lead by default, and is refused at the limit', () => {
    const at97 = [reading('a', { weeklyUsed: 97 })]
    expect(checkAdmission(inputs({ accounts: at97 }))).toMatchObject({ admit: true })
    const refused = checkAdmission(inputs({ accounts: [reading('a', { weeklyUsed: 100 })] }))
    expect(refused).toMatchObject({ admit: false, refusal: { kind: 'window', opensAt: at(WEEK_MS / 2) } })
    expect(checkAdmission(inputs({ accounts: at97, windowLimits: { fiveHour: 100, weekly: 95 } }))).toMatchObject({
      admit: false,
      refusal: { kind: 'window' },
    })
  })

  test('a process count over its cap keeps a new lead out with the numbers; none known, or no cap, admits', () => {
    const refused = checkAdmission(inputs({ processes: 1801, processCap: 1800 }))
    expect(refused).toMatchObject({
      admit: false,
      refusal: { kind: 'load', message: 'the machine runs too many processes: 1801 processes (cap 1800)' },
    })
    expect(checkAdmission(inputs({ processes: 1800, processCap: 1800 })).admit).toBe(true)
    expect(checkAdmission(inputs({ processes: null, processCap: 1800 })).admit).toBe(true)
    expect(checkAdmission(inputs({ processes: 99_999, processCap: null })).admit).toBe(true)
    // the load gate looks first
    expect(checkAdmission(inputs({ load: 99, processes: 99_999, processCap: 1800 }))).toMatchObject({
      refusal: { message: expect.stringContaining('load average') },
    })
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

  test('while swap in use grows, a second step waits whatever memory is free; the first is never held back', () => {
    const growing: SlotFit = { ...open, freeMib: 60_000, swapGrowing: true }
    const a = call([], 'a', now, 2, growing)
    const b = call(a.rows, 'b', now, 2, growing)
    expect(a.view.granted).toBe(true)
    expect(b.view).toMatchObject({ granted: false })
    expect(b.view.why).toContain('swap in use is growing')
    const settled = call(b.rows, 'b', at(1000), 2, { ...growing, swapGrowing: false })
    expect(settled.view.granted).toBe(true)
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

  test('a running command whose lease lapsed takes a slot back, past the limit when the others hold theirs', () => {
    const held = call([], 'a', now, 1)
    const lapsed = at(SLOT_LEASE_MS + 1)
    const taken = call(held.rows, 'b', lapsed, 1)
    expect(taken.view.granted).toBe(true)
    const waiting = call(taken.rows, 'c', lapsed, 1)
    expect(waiting.view.granted).toBe(false)
    const back = touchSlots(
      waiting.rows,
      { id: 'a', name: 'a', slots: 1, runMs: 1_800_000, fit: { ...open, max: 1 }, holding: true },
      lapsed,
    )
    expect(back.view).toMatchObject({ granted: true, slot: 2, ahead: 0 })
    expect(
      back.rows
        .filter((r) => r.slot !== null)
        .map((r) => r.id)
        .sort(),
    ).toEqual(['a', 'b'])
    // without the flag the same call is a waiter in line
    expect(call(waiting.rows, 'a', lapsed, 1).view.granted).toBe(false)
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
        cwd: null,
        passedAt: null,
        passedBy: null,
        whyKind: null,
        waitSplit: {},
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

  describe('small steps pass a big one that does not fit', () => {
    const MIN = 60_000
    // two base slots, up to six; the host has 1 GiB to give once the headroom is kept
    const mem = (growthMib: number, peakMib: number): SlotFit => ({
      peakMib,
      peaksByName: new Map([
        ['big', 5120],
        ['s1', 300],
        ['s2', 300],
        ['s3', 300],
        ['s4', 300],
      ]),
      freeMib: 3072,
      growthMib,
      max: 6,
      loadOk: true,
      headroomMib: 2048,
    })
    const ask = (rows: SlotRow[], who: string, ms: number, growth: number, peak: number) =>
      touchSlots(
        rows,
        { id: who, name: who, slots: 2, runMs: 1_800_000, fit: mem(growth, peak), passAfterMs: 10 * MIN },
        at(ms),
      )

    test('the three small steps are granted in turn and the big one keeps its place; after the window nothing passes it', () => {
      let rows = call([], 'h', now, 2, { ...open, max: 6 }).rows
      const big = ask(rows, 'big', 1000, 0, 5120)
      expect(big.view).toMatchObject({ granted: false })
      expect(big.view.why).toContain('waiting for memory')
      rows = big.rows
      const grants: boolean[] = []
      for (const [i, name] of ['s1', 's2', 's3'].entries()) {
        const small = ask(rows, name, 2000 + i * 1000, i * 300, 300)
        grants.push(small.view.granted)
        rows = small.rows
      }
      expect(grants).toEqual([true, true, true])
      const bigRow = rows.find((r) => r.id === 'big')
      expect(bigRow).toMatchObject({ slot: null, passedBy: 's1', passedAt: at(2000) })
      // the big one still asks, and its line says who passed it
      const again = ask(rows, 'big', 5000, 900, 5120)
      expect(again.view.granted).toBe(false)
      expect(again.view.why).toContain('passed by "s1"')
      rows = again.rows

      // after the window: a fourth small step does not pass, whatever it would fit
      const late = 2000 + 10 * MIN
      // (the running steps renew their leases and the big one keeps asking, as the CLI does every few seconds)
      for (let ms = 15_000; ms < late; ms += 10_000) {
        for (const id of ['h', 's1', 's2', 's3']) rows = ask(rows, id, ms, 900, 300).rows
        rows = ask(rows, 'big', ms, 900, 5120).rows
      }
      expect(rows.find((r) => r.id === 'big')).toMatchObject({ slot: null, passedAt: at(2000) })
      // (more memory has come free since: 1.2 GiB of steps fit now, the big one still does not)
      const s4 = touchSlots(
        rows,
        {
          id: 's4',
          name: 's4',
          slots: 2,
          runMs: 1_800_000,
          fit: { ...mem(900, 300), freeMib: 4096 },
          passAfterMs: 10 * MIN,
        },
        at(late),
      )
      expect(s4.view).toMatchObject({ granted: false, ahead: 1 })
      expect(s4.view.why).toContain('"big" ahead was passed for 10 min and nothing passes it')
      // the steps end, memory frees: the big one is next, the small one waits behind it
      rows = ['h', 's1', 's2', 's3'].reduce((acc, id) => releaseSlot(acc, id).rows, s4.rows)
      const roomy: SlotFit = { ...mem(0, 5120), freeMib: 30_000 }
      const next = touchSlots(
        rows,
        { id: 'big', name: 'big', slots: 2, runMs: 1_800_000, fit: roomy, passAfterMs: 10 * MIN },
        at(late + 1000),
      )
      expect(next.view).toMatchObject({ granted: true })
      const behind = touchSlots(
        next.rows,
        {
          id: 's4',
          name: 's4',
          slots: 2,
          runMs: 1_800_000,
          fit: { ...roomy, peakMib: 300, growthMib: 5120 },
          passAfterMs: 10 * MIN,
        },
        at(late + 1500),
      )
      expect(behind.view.granted).toBe(true)
    })

    test("the line behind a waiter says how that waiter's size is known, not the caller's", () => {
      let rows = call([], 'h', now, 2, { ...open, max: 6 }).rows
      const guessed = { ...mem(0, 5120), peakFrom: 'default' as const }
      rows = touchSlots(
        rows,
        { id: 'big', name: 'big', slots: 2, runMs: 1, fit: guessed, passAfterMs: 10 * MIN },
        at(1000),
      ).rows
      const blocked = touchSlots(
        rows.map((r) =>
          r.id === 'h'
            ? { ...r, leasedUntil: at(12 * MIN) }
            : { ...r, seenAt: at(11 * MIN - 1000), passedAt: at(0), passedBy: 'x' },
        ),
        {
          id: 's1',
          name: 's1',
          slots: 2,
          runMs: 1,
          fit: { ...mem(0, 300), peakFromByName: new Map([['big', 'default' as const]]) },
          passAfterMs: 10 * MIN,
        },
        at(11 * MIN),
      )
      expect(blocked.view.why).toContain('a guess: nothing of this project learned yet')
      expect(blocked.view.why).not.toContain('learned from the last runs')
    })

    test('after the window a step still passes a head that fits beside it once the holders from before the passing end', () => {
      // h holds 4 GiB of the host's used memory since before the big step asked; big (5 GiB) was passed once, 10 min ago
      let rows = call([], 'h', now, 2, { ...open, max: 6 }).rows
      rows = touchSlots(
        rows,
        { id: 'h', name: 'h', slots: 2, runMs: 1, fit: open, rssMib: 4096, peakRssMib: 4096 },
        at(500),
      ).rows
      rows = ask(rows, 'big', 1000, 0, 5120).rows
      rows = ask(rows, 's1', 2000, 0, 300).rows
      expect(rows.find((r) => r.id === 'big')).toMatchObject({ passedBy: 's1', passedAt: at(2000) })
      const late = 2000 + 10 * MIN
      for (let ms = 15_000; ms < late; ms += 10_000) {
        for (const id of ['h', 's1']) rows = ask(rows, id, ms, 0, 300).rows
        rows = ask(rows, 'big', ms, 0, 5120).rows
      }
      const hOnly = rows.map((r) => (r.id === 'h' ? { ...r, rssMib: 4096 } : r))
      const fits = (freeMib: number, heldPeakById?: Map<string, number | null>) =>
        touchSlots(
          hOnly,
          {
            id: 's2',
            name: 's2',
            slots: 2,
            runMs: 1,
            fit: { ...mem(0, 300), freeMib, ...(heldPeakById ? { heldPeakById } : {}) },
            passAfterMs: 10 * MIN,
          },
          at(late),
        ).view
      // 5120 + 300 + 2048 = 7468 needs 3372 free now beside h's 4096 that ends: it fits
      expect(fits(3372).granted).toBe(true)
      // 100 MiB less and the head would no longer fit beside the step: the freeze holds
      const held = fits(3371)
      expect(held.granted).toBe(false)
      expect(held.why).toContain('nothing passes it')
      // the passer s1 still grows by 1000 MiB (learned 1000, resident 0): the head has to fit beside that growth too
      const growing = new Map<string, number | null>([['s1', 1000]])
      expect(fits(3372 + 1000, growing).granted).toBe(true)
      expect(fits(3372 + 999, growing).granted).toBe(false)
    })

    test('a small step that does not fit either does not pass', () => {
      const rows = call([], 'h', now, 2, { ...open, max: 6 }).rows
      const big = ask(rows, 'big', 1000, 0, 5120)
      const small = ask(big.rows, 's1', 2000, 900, 300)
      expect(small.view.granted).toBe(false)
      expect(big.rows.find((r) => r.id === 'big')?.passedAt).toBeNull()
    })
  })

  describe('what a wait waited for', () => {
    const mem = (peakMib: number): SlotFit => ({
      peakMib,
      freeMib: 3072,
      growthMib: 0,
      max: 6,
      loadOk: true,
      headroomMib: 2048,
    })
    test('the time between two calls counts to the reason of the first, and the grant hands the split over', () => {
      let rows = call([], 'h', now, 2, { ...open, max: 6 }).rows
      const input = (fit: SlotFit) => ({ id: 'w', name: 'w', slots: 1, runMs: 1_800_000, fit })
      // 1 s of the line on memory, then 3 s on the load gate, then it fits
      const first = touchSlots(rows, input(mem(5120)), at(0))
      expect(first.rows.find((r) => r.id === 'w')).toMatchObject({ whyKind: 'memory', waitSplit: {} })
      const second = touchSlots(first.rows, input({ ...mem(5120), loadOk: false }), at(1000))
      expect(second.rows.find((r) => r.id === 'w')).toMatchObject({ whyKind: 'load', waitSplit: { memory: 1000 } })
      const third = touchSlots(second.rows, input(mem(300)), at(4000))
      expect(third.view.granted).toBe(true)
      expect(third.waited).toEqual({ ms: 4000, split: { memory: 1000, load: 3000 } })
      expect(third.rows.find((r) => r.id === 'w')).toMatchObject({ whyKind: null })
      rows = third.rows
      // a renewal is no wait; nor is a grant at the first call
      expect(touchSlots(rows, input(mem(300)), at(5000)).waited).toBeUndefined()
      expect(call([], 'solo', now).waited).toBeUndefined()
    })

    test('the line, the slot count and the unsized step are told apart', () => {
      let rows = call([], 'h', now, 2, { ...open, max: 6 }).rows
      rows = call(rows, 'h2', now, 2, { ...open, max: 6 }).rows
      const busy = touchSlots(rows, { id: 'a', name: 'a', slots: 2, runMs: 1, fit: { ...mem(300), max: 2 } }, at(1000))
      expect(busy.rows.find((r) => r.id === 'a')?.whyKind).toBe('slots')
      const unsized = touchSlots(
        rows,
        { id: 'b', name: 'b', slots: 2, runMs: 1, fit: { ...mem(300), peakMib: null } },
        at(1000),
      )
      expect(unsized.rows.find((r) => r.id === 'b')?.whyKind).toBe('unsized')
      // a waiter behind one that would be granted waits on the line
      const ahead = touchSlots(rows, { id: 'c', name: 'c', slots: 2, runMs: 1, fit: { ...mem(300), max: 6 } }, at(2000))
      const behind = touchSlots(
        ahead.rows.map((r) => (r.id === 'c' ? { ...r, slot: null, leasedUntil: null } : r)),
        {
          id: 'd',
          name: 'd',
          slots: 2,
          runMs: 1,
          fit: { ...mem(300), max: 6, peaksByName: new Map([['c', 300]]) },
        },
        at(2500),
      )
      expect(behind.rows.find((r) => r.id === 'd')?.whyKind).toBe('line')
    })
  })

  describe('the ledger', () => {
    test('the learned peak is the p80 of the 8 newest measured peaks, so one inflated run does not set it', () => {
      expect(learnedPeakMib([])).toBeNull()
      expect(learnedPeakMib([null, null])).toBeNull()
      expect(learnedPeakMib([null, 300, 900, null])).toBe(900)
      expect(learnedPeakMib([100, 100, 100, 100, 100, 100, 100, 100, 5000])).toBe(100)
      expect(learnedPeakMib([7600, 5500, 5600, 5500, 5400])).toBe(5600)
      expect(learnedPeakMib([5400, 5500, 5600, 5500, 5500, 5500, 7600, 7600])).toBe(7600)
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

describe('a slot is live work of the lead whose worktree its command started in', () => {
  const row = (extra: Partial<SlotRow>): SlotRow => ({
    id: 'x',
    name: 'make',
    requestedAt: now,
    seenAt: now,
    slot: 1,
    leasedUntil: at(SLOT_LEASE_MS),
    grantedAt: now,
    runMs: 1_800_000,
    rssMib: null,
    peakRssMib: null,
    why: null,
    cwd: '/w/factory-1-1/apps/server',
    passedAt: null,
    passedBy: null,
    whyKind: null,
    waitSplit: {},
    ...extra,
  })

  test('a holder in the worktree or below it, a waiter that still asks', () => {
    expect(slotLiveIn([row({})], '/w/factory-1-1', now)).toBe(true)
    expect(slotLiveIn([row({ cwd: '/w/factory-1-1' })], '/w/factory-1-1/', now)).toBe(true)
    expect(
      slotLiveIn([row({ slot: null, leasedUntil: null, seenAt: at(-WAITER_TTL_MS + 1) })], '/w/factory-1-1', now),
    ).toBe(true)
  })

  test('not another worktree with the same prefix, no directory, an expired lease, a waiter that gave up', () => {
    expect(slotLiveIn([row({ cwd: '/w/factory-1-10' })], '/w/factory-1-1', now)).toBe(false)
    expect(slotLiveIn([row({ cwd: null })], '/w/factory-1-1', now)).toBe(false)
    expect(slotLiveIn([row({ leasedUntil: at(-1) })], '/w/factory-1-1', now)).toBe(false)
    expect(
      slotLiveIn([row({ slot: null, leasedUntil: null, seenAt: at(-WAITER_TTL_MS - 1) })], '/w/factory-1-1', now),
    ).toBe(false)
  })
})

describe('the picker rank breaks a tie in room, the gates stay', () => {
  const hour = 3_600_000
  const readings = [
    // the 5-hour window is the tightest of each (25 points of room), so the rank decides
    reading('iu', { fiveHourUsed: 75, weeklyUsed: 70, weeklyResetsAt: at(32 * hour) }),
    reading('me', { fiveHourUsed: 75, weeklyUsed: 54, weeklyResetsAt: at(46 * hour) }),
    reading('me2', { fiveHourUsed: 75, weeklyUsed: 11, weeklyResetsAt: at(132 * hour) }),
  ]
  const rank = (accounts: string[], readAt = now): AccountRank => ({
    lane: 'bulk',
    order: accounts.map((account) => ({ account, reason: 'home', weight: null })),
    at: readAt,
    readAt,
  })
  const base = { readings, loaded: new Set<string>(), leads: new Map<string, number>(), leadsPerAccount: 2, now }
  const order = ['me', 'me2', 'iu']

  test('among accounts with the same room the head of a fresh rank is picked over the lowest weekly use', () => {
    expect(pickAccount({ ...base, rank: rank(order) })).toMatchObject({ picked: { account: 'me' } })
  })

  test('the most room beats the rank: a ranked account near its limit goes after one with room', () => {
    const near = [
      reading('me', { fiveHourUsed: 95, weeklyUsed: 54 }),
      ...readings.slice(1).filter((r) => r.account !== 'me'),
    ]
    expect(pickAccount({ ...base, readings: near, rank: rank(order) })).toMatchObject({ picked: { account: 'me2' } })
  })

  test('an account at its lead cap or (with a 5-hour window above 70 %) loaded since its sample is passed over to the next in the rank', () => {
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
    const closed = [reading('me', { fiveHourUsed: 75, weeklyUsed: 100 }), ...readings.slice(2)]
    expect(pickAccount({ ...base, readings: closed, rank: rank(order) })).toMatchObject({ picked: { account: 'me2' } })
    expect(pickAccount({ ...base, readings: [closed[0] as AccountReading], rank: rank(order) })).toMatchObject({
      picked: null,
    })
  })
})
