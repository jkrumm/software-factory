import { describe, expect, test } from 'bun:test'
import { fallbackWords, plainText } from '../src/read/plain.ts'

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
