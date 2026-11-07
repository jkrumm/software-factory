import { expect, test } from 'bun:test'
import { fixedClock } from '../src/kernel/clock.ts'
import { idOf, sequentialIds, systemIds } from '../src/kernel/ids.ts'
import { key } from '../src/kernel/keys.ts'
import { err, ok } from '../src/kernel/result.ts'

test('a key is its parts joined, and two part lists never make one key', () => {
  expect(String(key('start_lead', 'issue_7', 2))).toBe('start_lead:issue_7:2')
  expect(key('a:b', 'c')).not.toBe(key('a', 'b:c'))
  expect(key('50%', 'x')).not.toBe(key('50%25', 'x'))
  expect(() => key()).toThrow('at least one part')
  expect(() => key('a', '')).toThrow('must not be empty')
  expect(() => key('a', 1.5)).toThrow('must be whole')
})

test('ids: one kind is not another, a test source counts per kind', () => {
  const ids = sequentialIds()
  expect([ids.next('issue'), ids.next('issue'), ids.next('event')].map(String)).toEqual([
    'issue_1',
    'issue_2',
    'event_1',
  ])
  expect(String(idOf('issue', 'issue_1'))).toBe('issue_1')
  expect(idOf('issue', 'event_1')).toBeNull()
  expect(idOf('issue', 'issue_')).toBeNull()
  expect(idOf('event', systemIds.next('event'))).not.toBeNull()
})

test('a fixed clock moves only when told to', () => {
  const clock = fixedClock('2026-01-01T00:00:00Z')
  clock.advance(1_000)
  expect(clock.now().toISOString()).toBe('2026-01-01T00:00:01.000Z')
  clock.now().setFullYear(1999)
  expect(clock.now().getFullYear()).toBe(2026)
})

test('ok and err', () => {
  expect(ok(1)).toEqual({ ok: true, value: 1 })
  expect(err({ kind: 'gone', detail: 'x' })).toEqual({ ok: false, error: { kind: 'gone', detail: 'x' } })
})
