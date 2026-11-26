import { expect, test } from 'bun:test'
import { isBackoff, withoutAwaitedBlocks } from '../../src/kernel/backoff.ts'

test('an answer that says to wait for it reads as a backoff', () => {
  for (const answer of ['Park until image-gateway ships portrait', 'Hold until the update lands', 'Wait'])
    expect(isBackoff(answer)).toBe(true)
  expect(isBackoff('Drop the Issue')).toBe(false)
})

const record = (kind: string, payload: Record<string, unknown> = {}, actor = 'lead') => ({ kind, payload, actor })

test('blocks after the first backoff of an attempt are not the lead struggling', () => {
  const first = record('stalled', { cause: 'blocked' })
  const unreported = record('stalled', { cause: 'unreported' })
  const records = [
    record('admitted'),
    first,
    record('answered', { hold: '2026-11-26T17:00:00Z' }, 'judge'),
    record('stalled', { cause: 'blocked' }),
    unreported,
  ]
  expect(withoutAwaitedBlocks(records).filter((r) => r.kind === 'stalled')).toEqual([first, unreported])
  // a new attempt counts its own stalls
  const next = [...records, record('admitted'), first]
  expect(withoutAwaitedBlocks(next)).toEqual(next)
})
