import { describe, expect, test } from 'bun:test'
import { HookEventBody } from '../src/index.ts'

const base = { key: 'k', session: 'lead-1-1', kind: 'turn_ended', at: '2026-11-07T10:00:00.000Z' }

describe('HookEventBody', () => {
  test('text the database can store parses', () => {
    expect(HookEventBody.safeParse({ ...base, payload: { message: 'ok \u{1F600}', list: ['a'] } }).success).toBe(true)
  })

  test.each([
    ['a NUL in a value', { message: 'a\0b' }],
    ['a lone high surrogate', { message: 'a\uD83D' }],
    ['a lone low surrogate', { message: '\uDE00a' }],
    ['a NUL in a key', { 'a\0': 'x' }],
    ['a NUL nested in an array', { list: [{ deep: 'x\0' }] }],
  ])('%s is refused', (_, payload) => {
    expect(HookEventBody.safeParse({ ...base, payload }).success).toBe(false)
  })
})
