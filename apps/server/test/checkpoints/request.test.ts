import { describe, expect, test } from 'bun:test'
import {
  checkVerdict,
  DEFAULT_EXPIRY_MS,
  evidenceLines,
  hostOf,
  readExpiry,
  readRequest,
} from '../../src/domains/checkpoints/request.ts'

const NOW = new Date('2026-11-13T08:00:00Z')

describe('a request for the owner’s hands', () => {
  test('the first line is the title, the rest is the detail, and a request without a check expires in 7 days', () => {
    const read = readRequest(
      { text: 'Reseal the cache\nrun make secrets-seed on the MacBook', source: 'ask-human' },
      NOW,
    )
    expect(read).toMatchObject({
      ok: true,
      value: {
        summary: 'Reseal the cache',
        detail: 'Reseal the cache\nrun make secrets-seed on the MacBook',
        command: null,
        check: null,
        host: 'macbook',
        source: 'ask-human',
        key: null,
      },
    })
    expect(read.ok && read.value.expiresAt?.getTime()).toBe(NOW.getTime() + DEFAULT_EXPIRY_MS)
  })

  test('a check keeps it open until the check says otherwise; `never` and a duration are read; a bad one is named', () => {
    const withCheck = readRequest({ text: 'x', source: 'ask-human', check: 'test -f /tmp/a' }, NOW)
    expect(withCheck.ok && withCheck.value.expiresAt).toBeNull()
    const never = readRequest({ text: 'x', source: 'ask-human', expires: 'never' }, NOW)
    expect(never.ok && never.value.expiresAt).toBeNull()
    const days = readRequest({ text: 'x', source: 'ask-human', expires: '2d', check: 'true' }, NOW)
    expect(days.ok && days.value.expiresAt?.getTime()).toBe(NOW.getTime() + 2 * 86_400_000)
    const bad = readRequest({ text: '', source: 'Ask Human', key: 'a b', expires: 'soon', where: 'moon' }, NOW)
    expect(bad).toMatchObject({ ok: false, error: { kind: 'missing_field' } })
    const fields = !bad.ok && bad.error.kind === 'missing_field' ? bad.error.fields.join(' | ') : ''
    for (const word of ['text', 'source', 'key', 'expires', 'where']) expect(fields).toContain(word)
  })

  test('the expiry reads 90m, 36h, 7d, an ISO time and never; zero and nonsense are none', () => {
    expect(readExpiry('90m', NOW)).toEqual(new Date(NOW.getTime() + 90 * 60_000))
    expect(readExpiry('36h', NOW)).toEqual(new Date(NOW.getTime() + 36 * 3_600_000))
    expect(readExpiry('2026-12-01T00:00:00Z', NOW)).toEqual(new Date('2026-12-01T00:00:00Z'))
    expect(readExpiry('never', NOW)).toBe('never')
    expect(readExpiry('0d', NOW)).toBeUndefined()
    expect(readExpiry('later', NOW)).toBeUndefined()
  })

  test('where the hands must be comes from the words when it is not said', () => {
    expect(hostOf('add the ntfy topics on the iPhone')).toBe('iphone')
    expect(hostOf('sudo tee /etc/sudoers.d/x')).toBe('macbook')
    expect(hostOf('open the Cloudflare dashboard')).toBe('portal')
    expect(hostOf('look at it')).toBe('any')
  })
})

describe('what a check’s exit says', () => {
  const run = (exit: number | null, timedOut = false) => ({ exit, timedOut, output: '' })
  test('0 is needed, 1..125 is not needed, and a check that could not answer says nothing', () => {
    expect(checkVerdict(run(0))).toBe('needed')
    expect(checkVerdict(run(1))).toBe('not_needed')
    expect(checkVerdict(run(2))).toBe('not_needed')
    expect(checkVerdict(run(125))).toBe('not_needed')
    expect(checkVerdict(run(126))).toBe('unrunnable')
    expect(checkVerdict(run(127))).toBe('unrunnable')
    expect(checkVerdict(run(137))).toBe('unrunnable')
    expect(checkVerdict(run(null))).toBe('unrunnable')
    expect(checkVerdict(run(1, true))).toBe('unrunnable')
  })
})

test('the evidence lists the same source’s other requests with how each ended, and leaves the asked one out', () => {
  const lines = evidenceLines(
    'errand_1',
    [
      {
        id: 'errand_1',
        summary: 'self',
        raisedAt: NOW,
        doneAt: null,
        closedKind: null,
        closedBy: null,
        doneNote: null,
      },
      {
        id: 'errand_2',
        summary: 'Reseal the cache',
        raisedAt: new Date(NOW.getTime() - 50 * 3_600_000),
        doneAt: new Date(NOW.getTime() - 2 * 3_600_000),
        closedKind: 'done',
        closedBy: 'owner',
        doneNote: 'resealed',
      },
    ],
    NOW,
    (text) => text,
  )
  expect(lines).toBe('raised 50 h ago, closed 2 h ago as done by owner (resealed): Reseal the cache')
  expect(evidenceLines('errand_1', [], NOW, (t) => t)).toContain('No other request')
})
