import { describe, expect, test } from 'bun:test'
import type { AccountMode, AccountRow } from '@software-factory/contract'
import {
  defaultHoldModel,
  EXPIRIES,
  forecastWords,
  intentBody,
  laneOrder,
  ledgerBars,
  limitsOf,
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
