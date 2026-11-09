import { describe, expect, test } from 'bun:test'
import type { ReadChange } from '@software-factory/contract'
import { encodeFrame } from '../../server/src/read/stream.ts'
import {
  affected,
  affectedByAny,
  isAggregate,
  parseChange,
  issueNumber,
  LIVE_SAFETY_MS,
  POLL_MS,
  pollEvery,
  safeToReload,
  silentWhileHidden,
  sleptBetween,
  type Change,
} from '../src/lib/policy.ts'

test('a query polls every 15 s without the stream and once a minute with it', () => {
  expect(pollEvery(false)).toBe(POLL_MS)
  expect(pollEvery(true)).toBe(LIVE_SAFETY_MS)
  expect(POLL_MS).toBe(15_000)
  expect(LIVE_SAFETY_MS).toBe(60_000)
})

test('a tick more than 45 s after the last one means the machine slept', () => {
  expect(sleptBetween(0, 15_000)).toBe(false)
  expect(sleptBetween(0, 45_000)).toBe(false)
  expect(sleptBetween(0, 45_001)).toBe(true)
})

test('a reload waits while a field has focus or a textarea holds a draft', () => {
  expect(safeToReload(null, false)).toBe(true)
  expect(safeToReload({ tagName: 'BODY', isContentEditable: false }, false)).toBe(true)
  expect(safeToReload({ tagName: 'BUTTON', isContentEditable: false }, false)).toBe(true)
  expect(safeToReload({ tagName: 'INPUT', isContentEditable: false }, false)).toBe(false)
  expect(safeToReload({ tagName: 'TEXTAREA', isContentEditable: false }, false)).toBe(false)
  expect(safeToReload({ tagName: 'DIV', isContentEditable: true }, false)).toBe(false)
  expect(safeToReload(null, true)).toBe(false)
})

describe('affected', () => {
  const keys = {
    needs: ['needs'],
    since: ['since'],
    flow: ['flow'],
    chain: ['chain'],
    errands: ['errands'],
    kpis: ['kpis', 7],
    friction: ['friction', 7],
    classes: ['finding-classes'],
    fixes: ['fix-commits'],
    accounts: ['accounts'],
    machine: ['machine'],
    issue12: ['issue', '12'],
    issue13: ['issue', 'issue_13'],
    decisionA: ['decision', 'dec_a'],
    decisionB: ['decision', 'dec_b'],
    artifactA: ['artifact', 'art_a', 'latest'],
    artifactB: ['artifact', 'art_b', 3],
  } as const
  const hits = (change: Change | null) =>
    Object.entries(keys)
      .filter(([, key]) => affected(change)(key))
      .map(([name]) => name)

  test('an Issue event alters the lists, the aggregates and its own page, not another Issue', () => {
    const names = hits({ kind: 'issue', ref: 'issue_12' })
    expect(names).toContain('needs')
    expect(names).toContain('since')
    expect(names).toContain('flow')
    expect(names).toContain('chain')
    expect(names).toContain('kpis')
    expect(names).toContain('issue12')
    expect(names).not.toContain('issue13')
    expect(names).not.toContain('errands')
  })

  test('a session event leaves needs, flow and chain alone', () => {
    const names = hits({ kind: 'session', ref: 'issue_13' })
    expect(names).toEqual(expect.arrayContaining(['issue13', 'kpis', 'friction']))
    expect(names).not.toContain('needs')
    expect(names).not.toContain('since')
    expect(names).not.toContain('flow')
    expect(names).not.toContain('chain')
    expect(names).not.toContain('issue12')
    expect(names).not.toContain('artifactA')
  })

  test('a Decision answered alters needs and that Decision, not another', () => {
    const names = hits({ kind: 'decision', ref: 'issue_12', detail: { decision: 'dec_a' } })
    expect(names).toContain('needs')
    expect(names).toContain('decisionA')
    expect(names).not.toContain('decisionB')
    expect(names).not.toContain('artifactA')
  })

  test('an artifact change names its artifact; one that names none alters every artifact', () => {
    expect(hits({ kind: 'artifact', ref: 'issue_12', detail: { artifact: 'art_b' } })).toEqual(
      expect.arrayContaining(['artifactB', 'needs', 'issue12']),
    )
    expect(hits({ kind: 'artifact', ref: 'issue_12', detail: { artifact: 'art_b' } })).not.toContain('artifactA')
    expect(hits({ kind: 'artifact', ref: null })).toEqual(expect.arrayContaining(['artifactA', 'artifactB']))
  })

  test('an Errand alters the Errands and needs', () => {
    const names = hits({ kind: 'errand', ref: null, detail: { errand: 'e1' } })
    expect(names).toEqual(expect.arrayContaining(['errands', 'needs']))
    expect(names).toEqual(expect.arrayContaining(['issue12', 'issue13']))
  })

  test('the strip readings are never altered, whatever the change', () => {
    for (const change of [null, { kind: 'issue', ref: 'issue_1' }, { kind: 'banana', ref: null }]) {
      const names = hits(change)
      expect(names).not.toContain('accounts')
      expect(names).not.toContain('machine')
    }
  })

  test('a change that did not parse or has an unknown kind alters everything else', () => {
    const all = Object.keys(keys).filter((name) => name !== 'accounts' && name !== 'machine')
    expect(hits(null).sort()).toEqual([...all].sort())
    expect(hits({ kind: 'banana', ref: null }).sort()).toEqual([...all].sort())
  })

  test('an unknown query key is altered', () => {
    expect(affected({ kind: 'session', ref: null })(['something-new'])).toBe(true)
  })

  test('the union of changes alters what any of them alters', () => {
    const both = affectedByAny([
      { kind: 'session', ref: 'issue_12' },
      { kind: 'errand', ref: null },
    ])
    expect(both(['errands'])).toBe(true)
    expect(both(['issue', '12'])).toBe(true)
    expect(both(['flow'])).toBe(true)
    expect(both(['accounts'])).toBe(false)
    expect(affectedByAny([])(['flow'])).toBe(false)
  })

  test('the aggregates are the slow tier; an Issue id is read with or without its prefix', () => {
    expect(isAggregate(['kpis', 7])).toBe(true)
    expect(isAggregate(['needs'])).toBe(false)
    expect(issueNumber('issue_12')).toBe(12)
    expect(issueNumber('12')).toBe(12)
    expect(issueNumber('abc')).toBeNull()
    expect(issueNumber(null)).toBeNull()
  })
})

test('a hidden tab is silent when no frame came since it hid and it stayed hidden past the sleep gap', () => {
  expect(silentWhileHidden(null, 0, 100_000)).toBe(false)
  expect(silentWhileHidden(1_000, 2_000, 100_000)).toBe(false)
  expect(silentWhileHidden(1_000, 500, 40_000)).toBe(false)
  expect(silentWhileHidden(1_000, 500, 100_000)).toBe(true)
})

describe('parseChange', () => {
  const change: ReadChange = {
    cursor: '12.34',
    kind: 'decision',
    issue: 12,
    ref: 'issue_12',
    subject: 'answered',
    detail: { decision: 'dec_a' },
    at: '2026-11-09T08:00:00.000Z',
  }
  const dataOf = (frame: string): string =>
    frame
      .split('\n')
      .find((line) => line.startsWith('data: '))
      ?.slice(6) ?? ''

  test("reads the data line of the server's own change frame, which has no cursor", () => {
    const data = dataOf(encodeFrame({ type: 'change', change }))
    expect(data).not.toContain('cursor')
    expect(parseChange(data)).toMatchObject({
      kind: 'decision',
      issue: 12,
      ref: 'issue_12',
      subject: 'answered',
      detail: { decision: 'dec_a' },
      at: change.at,
    })
  })

  test('a frame that does not parse is null', () => {
    expect(parseChange('{}')).toBeNull()
    expect(parseChange('not json')).toBeNull()
    expect(parseChange(undefined)).toBeNull()
  })
})
