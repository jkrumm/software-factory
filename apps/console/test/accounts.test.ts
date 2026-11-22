import { describe, expect, test } from 'bun:test'
import type { AccountHealthRow, AccountMode, AccountRow, AccountsView } from '@software-factory/contract'
import {
  defaultHoldModel,
  EXPIRIES,
  forecastWords,
  intentBody,
  laneOrder,
  ledgerBars,
  limitsOf,
  loginAlerts,
  loginLines,
  loginMark,
  machineNotes,
  modeLabel,
  modeUntil,
  reasonWords,
} from '../src/lib/accounts.ts'

const NOW = new Date('2026-11-19T12:00:00Z')
const mode = (patch: Partial<AccountMode> = {}): AccountMode => ({
  kind: 'normal',
  for: null,
  until: null,
  until_at: null,
  why: null,
  source: 'registry',
  set_at: null,
  set_on: null,
  expired: false,
  ...patch,
})

describe('modes', () => {
  test('are named by intent', () => {
    expect(modeLabel(mode({ kind: 'drain' }))).toBe('Fill first')
    expect(modeLabel(mode({ kind: 'reserve', for: 'fable' }))).toBe('Holds fable')
    expect(modeLabel(mode({ kind: 'paused' }))).toBe('Paused')
  })
  test('end in words', () => {
    expect(modeUntil({ until: 'reset', until_at: null }, NOW)).toBe('until the reset')
    expect(modeUntil({ until: 'reset', until_at: '2026-11-22T18:00:00Z' }, NOW)).toMatch(
      /^until the reset, Sun \d\d:\d\d$/,
    )
    expect(modeUntil({ until: null, until_at: null }, NOW)).toBe('until cleared')
    expect(modeUntil({ until: 'x', until_at: '2026-11-19T15:00:00Z' }, NOW)).toMatch(/^until \d\d:\d\d$/)
  })
})

describe('forecast', () => {
  const full = {
    method: 'm',
    weekly_at_reset: 100,
    full_at: '2026-11-21T14:00:00Z',
    waste_percent: 0,
    waste_units: 0,
    burn_per_hour: 1,
    basis_hours: 24,
  }
  test('a full week says when', () => {
    expect(forecastWords({ forecast: full }, '2026-11-22T18:00:00Z', NOW)).toEqual({
      head: 'Full Saturday 14:00'.replace('Saturday', 'Sat'),
      rest: null,
      endsAt: 100,
    })
  })
  test('a week that ends short says where and what expires', () => {
    const words = forecastWords(
      { forecast: { ...full, full_at: null, weekly_at_reset: 38.4, waste_percent: 61.6 } },
      '2026-11-22T18:00:00Z',
      NOW,
    )
    expect(words.head).toBe('Ends at 38 %')
    expect(words.rest).toBe('the rest expires Sun 18:00')
  })
  test('no forecast says why, never a number', () => {
    expect(forecastWords({ forecast: null }, null, NOW).head).toBe('No forecast')
  })
})

describe('limits and the ledger', () => {
  test('read the open limit records defensively', () => {
    const rows = limitsOf({
      limits: [
        { kind: 'session', percent: 22.4, resets_at: '2026-11-19T16:10:00Z' },
        { kind: 'weekly_all', percent: 120, resets_at: null },
        { kind: 'weekly_scoped', model: 'fable', percent: null },
        { kind: 'unknown' },
      ],
    })
    expect(rows.map((r) => [r.label, r.percent])).toEqual([
      ['5 h', 22],
      ['This week', 100],
      ['fable this week', null],
    ])
  })
  test('the ledger is the last eight resets, oldest first', () => {
    const resets = Array.from({ length: 10 }, (_, i) => ({
      at: new Date(Date.UTC(2026, 9, 1 + i)).toISOString(),
      weekly: i === 9 ? null : 90 + i / 10,
      scoped: null,
      modes: [],
      rule: null,
      closed_hours: 0,
      manual: false,
    }))
    const bars = ledgerBars({ resets: [...resets].reverse() })
    expect(bars).toHaveLength(8)
    expect(bars[0]?.at).toBe(resets[2]?.at)
    expect(bars.at(-1)?.weekly).toBeNull()
  })
})

describe('the order of a lane', () => {
  const lane = (open: boolean, position: number | null, reason: string | null, why: string | null) => ({
    open,
    position,
    reason,
    closed: open ? null : 'paused',
    why,
    opens_at: null,
  })
  const account = (id: string, state: ReturnType<typeof lane>, enabled = true) =>
    ({ id, enabled, lanes: { bulk: state } }) as unknown as AccountRow
  test('lists the open accounts by place, then the closed ones with why, and leaves out one that is switched off', () => {
    const order = laneOrder(
      {
        accounts: [
          account('c', lane(false, null, null, 'paused by its mode')),
          account('b', lane(true, 2, 'home', null)),
          account('a', lane(true, 1, 'drain', null)),
          account('off', lane(true, 3, 'home', null), false),
        ],
      },
      'bulk',
    )
    expect(order.map((e) => [e.account, e.words])).toEqual([
      ['a', 'fills first'],
      ['b', 'its own lane'],
      ['c', 'paused by its mode'],
    ])
  })
  test('an unknown reason reads as it is, a reserve names its model', () => {
    expect(reasonWords('weird')).toBe('weird')
    expect(reasonWords('fable-reserve')).toBe('held back for fable')
    expect(reasonWords(null)).toBeNull()
  })
})

describe('the intents', () => {
  test('Fill first is a drain to the reset, with no other choice', () => {
    expect(EXPIRIES['fill-first']).toHaveLength(1)
    expect(intentBody('fill-first', EXPIRIES['fill-first'][0], NOW, '')).toEqual({
      mode: 'drain',
      why: 'set in the Console',
      until: 'reset',
    })
  })
  test('Pause defaults to 4 h and can last until cleared (no until)', () => {
    expect(intentBody('pause', EXPIRIES.pause[0], NOW, '')).toEqual({
      mode: 'paused',
      why: 'set in the Console',
      until: '2026-11-19T16:00:00.000Z',
    })
    const cleared = EXPIRIES.pause.find((c) => c.key === 'cleared')
    if (!cleared) throw new Error('Pause has no until-cleared choice')
    expect(intentBody('pause', cleared, NOW, '')).toEqual({ mode: 'paused', why: 'set in the Console' })
  })
  test('Hold for a model needs the model', () => {
    expect(intentBody('hold-for-a-model', EXPIRIES['hold-for-a-model'][0], NOW, '  ')).toBeNull()
    expect(intentBody('hold-for-a-model', EXPIRIES['hold-for-a-model'][0], NOW, ' fable ')).toMatchObject({
      mode: 'reserve',
      for: 'fable',
      until: 'reset',
    })
    expect(defaultHoldModel({ mode: mode(), reserve: null })).toBe('fable')
  })
})

describe('the logins of an account', () => {
  const row = (patch: Partial<AccountHealthRow>): AccountHealthRow => ({
    machine: 'mini',
    id: 'me',
    check: 'login',
    state: 'ok',
    detail: '20 d left',
    fix: null,
    ...patch,
  })
  const view = (rows: AccountHealthRow[]): Pick<AccountsView, 'health' | 'machine'> => ({
    machine: 'mini',
    health: { at: '2026-11-19T11:50:00Z', rows },
  })
  // the owner's state on 2026-11-22: the mini login ends in 6.9 d, the MacBook has had no quota sample for 7 h
  const rows = [
    row({
      machine: 'macbook',
      id: 'me2',
      check: 'quota',
      state: 'warn',
      detail: 'no quota sample for 7 h (token rejected?)',
    }),
    row({ machine: 'macbook', id: 'me2', detail: '9 d left', ends_at: '2026-11-28T12:00:00.000Z', days_left: 9 }),
    row({
      id: 'me',
      state: 'warn',
      detail: 'login ends in 6.9 d',
      fix: 'claude-relogin me --machine mini',
      ends_at: '2026-11-26T09:00:00.000Z',
      days_left: 6.9,
    }),
    row({ id: 'me', machine: 'macbook', detail: '11 d left', ends_at: '2026-11-30T12:00:00.000Z', days_left: 11 }),
    row({
      machine: 'macbook',
      id: '-',
      check: 'queue',
      state: 'warn',
      detail: '1 re-login request(s) waiting for your click',
    }),
  ]

  test('one line per machine with the date and the days left, toned by the package grade, this machine first', () => {
    const lines = loginLines(view(rows), 'me', NOW)
    expect(lines.map((l) => [l.machine, l.label, l.state, l.tone])).toEqual([
      ['mini', 'Login', 'warn', 'warn'],
      ['macbook', 'Login', 'ok', 'good'],
    ])
    expect(lines[0]?.words).toMatch(/^Ends (Thu 26 Nov|Fri 27 Nov) · 6\.9 d left$/)
    expect(lines[1]?.words).toMatch(/^Valid until \w{3} \d+ Nov · 11 d left$/)
  })

  test('a rejected-token quota row shows beside the login, in the package words', () => {
    const lines = loginLines(view(rows), 'me2', NOW)
    expect(lines.map((l) => [l.label, l.state, l.words])).toEqual([
      ['Login', 'ok', expect.stringMatching(/^Valid until .* · 9 d left$/)],
      ['Quota', 'warn', 'No quota sample for 7 h (token rejected?)'],
    ])
  })

  test('a login past its end says expired; a row with no date shows the package detail', () => {
    const gone = loginLines(
      view([row({ state: 'fail', detail: 'login expired', ends_at: '2026-11-18T00:00:00.000Z', days_left: -1.5 })]),
      'me',
      NOW,
    )
    expect(gone[0]).toMatchObject({ state: 'fail', tone: 'bad' })
    expect(gone[0]?.words).toMatch(/^Expired /)
    expect(loginLines(view([row({ state: 'fail', detail: 'logged out' })]), 'me', NOW)[0]?.words).toBe('Logged out')
  })

  test('the strip shows only warn and fail, and marks the worst', () => {
    expect(loginAlerts(view(rows), 'me', NOW).map((l) => l.machine)).toEqual(['mini'])
    expect(loginAlerts(view(rows), 'me2', NOW).map((l) => l.label)).toEqual(['Quota'])
    expect(loginAlerts(view([row({})]), 'me', NOW)).toEqual([])
    const both = loginAlerts(
      view([row({ state: 'warn', detail: 'x' }), row({ check: 'quota', state: 'fail', detail: 'y' })]),
      'me',
      NOW,
    )
    expect(loginMark(both)).toEqual({ label: 'Quota', tone: 'bad' })
    expect(loginMark([])).toBeNull()
  })

  test('no health read yet shows nothing; a waiting re-login request is a note on the machine', () => {
    expect(loginLines({ machine: 'mini', health: null }, 'me', NOW)).toEqual([])
    expect(machineNotes(view(rows))).toEqual([
      { key: 'macbook/queue', tone: 'warn', words: 'macbook: 1 re-login request(s) waiting for your click' },
    ])
  })
})
