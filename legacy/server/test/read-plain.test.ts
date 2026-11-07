import { describe, expect, test } from 'bun:test'
import { lineKey, lineText } from '../src/fleet/digest.ts'
import { aboutFallback } from '../src/read/index.ts'
import { describesMessage, fallbackWords, localTime, plainText } from '../src/read/plain.ts'

const IDS = /lead-\d|\bIssue \d|[0-9a-f]{8}-[0-9a-f]{4}|\b[0-9a-f]{7,}\b|\bt\d+\b|\/Users/

describe('plainText', () => {
  test.each([
    [
      'spawn lead-119-1 failed: Issue 119 closed before the spawn started',
      'A spawn failed: an Issue closed before the spawn started',
    ],
    [
      'note note:881da3f6-c525-4b5e-b1f6-64571bd1b853 to rv3-desk failed: expired: the session never took it',
      'A note to rv3-desk failed: expired: the session never took it',
    ],
    [
      "Issue 112 waits on the owner's decision and holds iris for 210 min: Issue 134 queued behind it",
      "An Issue waits on the owner's decision and holds iris for 210 min: an Issue queued behind it",
    ],
    ['digest: 2 failed passes in the last 24 h', 'Digest: 2 failed passes in the last 24 h'],
    [
      'Deploy gate [teamchat] deploy of origin/main aee69bad8aa4 FAILED.\nError: boom',
      'Deploy gate [teamchat] deploy of origin/main FAILED. Error: boom',
    ],
  ])('%s', (raw, plain) => {
    expect(plainText(raw)).toBe(plain)
  })

  test('the lead, Issues, panes, tabs, paths', () => {
    expect(plainText('the lead-5-2 stopped')).toBe('The lead stopped')
    expect(plainText('Issues 3, 4 and 5 wait')).toBe('Some Issues wait')
    expect(plainText('pane t12 in tb-9f3a lost')).toBe('Pane in lost')
    expect(plainText('see /Users/me/SourceRoot/iris/docs/runbook.md now')).toBe('See runbook.md now')
  })

  test('words that look a little like ids stay', () => {
    expect(plainText('defaced the 1234567 pages')).toBe('Defaced the 1234567 pages')
  })
})

describe('fallbackWords', () => {
  test('no ids, short at most 60, summary at most 160', () => {
    const runbook = `Set up the App Store Connect record for ${'iris '.repeat(30)}\n\n1. Open /Users/me/x/y\n2. lead-9-1 note:881da3f6-c525-4b5e-b1f6-64571bd1b853`
    const { short, summary } = fallbackWords(runbook, 'ask')
    expect(short.length).toBeLessThanOrEqual(60)
    expect(summary.length).toBeLessThanOrEqual(160)
    expect(short + summary).not.toMatch(IDS)
  })

  test('a health line', () => {
    const { short, summary } = fallbackWords(
      'spawn lead-119-1 failed: Issue 119 closed before the spawn started',
      'health',
    )
    expect(short).toBe('A spawn failed: an Issue closed before the spawn started')
    expect(summary).toBe(short)
  })

  test('a text of only ids still has words', () => {
    expect(fallbackWords('t12', 'ask').short).toBe('A question for the owner')
  })
})

describe('lineText', () => {
  test('an elapsed time does not change the item the digest is asked about', () => {
    const a = lineText('stuck lead-5-1: nothing moved for 17 min')
    const b = lineText('stuck lead-5-1: nothing moved for 22 min')
    const c = lineText('walled lead-5-1 for 3 h on me')
    expect(lineKey(a)).toBe(lineKey(b))
    expect(lineKey(a)).not.toBe(lineKey(c))
    expect(a).not.toMatch(/\d/)
  })
})

describe('local times', () => {
  const locale = { now: new Date('2026-11-06T22:30:00Z'), timeZone: 'Europe/Berlin' }

  test('a UTC clock time is the owner’s local one, an ISO time too', () => {
    expect(plainText('Waiting until 23:12Z on Issue 239; fseventsd restart check pending', locale)).toBe(
      'Waiting until 00:12 on an Issue; fseventsd restart check pending',
    )
    expect(plainText('retry at 2026-11-06 15:30 UTC', locale)).toBe('Retry at 16:30')
    expect(plainText('until 2026-11-07T00:05:00Z', locale)).toBe('Until 01:05')
  })

  test('an impossible date is left as written, not a crash', () => {
    expect(plainText('at 2026-13-01 10:00Z', locale)).toBe('At 2026-13-01 10:00Z')
    expect(plainText('at 2026-11-31 25:99 UTC', locale)).toBe('At 2026-11-31 25:99 UTC')
  })

  test('without a locale the text is left alone (a fingerprinted text must not change with the clock)', () => {
    expect(plainText('until 23:12Z')).toBe('Until 23:12Z')
  })

  test('localTime', () => {
    expect(localTime(new Date('2026-11-06T22:40:00Z'), locale)).toBe('23:40')
    expect(localTime(new Date('2026-11-09T10:00:00Z'), locale)).toBe('9 Nov 11:00')
  })
})

describe('about', () => {
  test('a sentence about a message is not an Issue purpose', () => {
    expect(describesMessage('Last message lists sidebar requests: project glance, readable text.')).toBe(true)
    expect(describesMessage('The message asks for a full-screen board.')).toBe(true)
    expect(describesMessage('Message queue backs up under load.')).toBe(false)
    expect(describesMessage('Text input wraps badly in the sidebar.')).toBe(false)
    expect(describesMessage('Show a project glance and a full-screen board in the sidebar.')).toBe(false)
  })

  test('the fallback skips where a request came from, and is plain words', () => {
    expect(
      aboutFallback(
        'Sidebar board',
        'Filed from dotfiles Issue 218 (feedback). Show the open asks of Issue 12 in the sidebar. Later more.',
      ),
    ).toBe('Show the open asks of an Issue in the sidebar.')
    expect(aboutFallback('Sidebar board for Issue 12', null)).toBe('Sidebar board for an Issue')
    expect(aboutFallback('', null)).toBeNull()
    expect(aboutFallback('x', 'Filed from the report.')).toBe('X')
  })
})
