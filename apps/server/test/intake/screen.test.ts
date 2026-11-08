import { expect, test } from 'bun:test'
import type { ScreenAnswer } from '@software-factory/contract'
import { screenPass } from '../../src/app/loops/screen.ts'
import type { IntakeStore, SignalRow } from '../../src/domains/intake/ports.ts'
import { checkScreen, NOT_SCREENED, screenBackoffMs, screenRequest } from '../../src/domains/intake/screen.ts'
import { err, ok } from '../../src/kernel/result.ts'

const answer = (over: Partial<ScreenAnswer>): ScreenAnswer => ({
  verdict: 'leave',
  reason: 'because',
  repo: null,
  duplicateOf: null,
  recommendation: null,
  ...over,
})
const shown = { signalRepo: 'app', openIssues: [{ id: 'issue_1' }], repoKnown: true }

test('promote: the signal’s own repo or the one named; an unknown or missing repo downgrades to leave', () => {
  expect(checkScreen(shown, answer({ verdict: 'promote' }))).toEqual({ action: 'promote', repo: 'app' })
  expect(checkScreen({ ...shown, signalRepo: null }, answer({ verdict: 'promote', repo: 'shop' }))).toEqual({
    action: 'promote',
    repo: 'shop',
  })
  expect(
    checkScreen({ ...shown, signalRepo: null, repoKnown: false }, answer({ verdict: 'promote', repo: 'moon' })),
  ).toMatchObject({ action: 'leave', note: expect.stringContaining('screen named an unknown repo') })
  expect(checkScreen({ ...shown, signalRepo: null }, answer({ verdict: 'promote' }))).toMatchObject({
    action: 'leave',
    note: expect.stringContaining('no repo'),
  })
})

test('dismiss: a reason is required; a duplicate must be an Issue it was shown, else leave', () => {
  expect(checkScreen(shown, answer({ verdict: 'dismiss', reason: 'spam' }))).toEqual({
    action: 'dismiss',
    reason: 'spam',
  })
  expect(checkScreen(shown, answer({ verdict: 'dismiss', reason: '   ' }))).toMatchObject({ action: 'refused' })
  expect(checkScreen(shown, answer({ verdict: 'dismiss', reason: 'same', duplicateOf: 'issue_1' }))).toEqual({
    action: 'dismiss',
    reason: 'same (duplicate of issue_1)',
  })
  expect(checkScreen(shown, answer({ verdict: 'dismiss', reason: 'same', duplicateOf: 'issue_9' }))).toMatchObject({
    action: 'leave',
    note: expect.stringContaining('issue_9'),
  })
})

test('leave: no recommendation is needed (the reason stands in), one given is stored', () => {
  expect(checkScreen(shown, answer({ reason: 'unclear' }))).toEqual({ action: 'leave', note: 'unclear' })
  expect(checkScreen(shown, answer({ reason: 'unclear', recommendation: 'ask them' }))).toEqual({
    action: 'leave',
    note: 'ask them',
  })
})

test('a failed call waits 10 minutes, doubling, at most 6 hours', () => {
  const minutes = [0, 1, 2, 3, 4, 5, 6].map((n) => screenBackoffMs(n) / 60_000)
  expect(minutes).toEqual([10, 20, 40, 80, 160, 320, 360])
})

const row = (over: Partial<SignalRow> = {}): SignalRow => ({
  id: 'signal_1',
  key: null,
  received: {
    signal: {
      source: 'feedback:app',
      kind: 'feedback',
      origin: 'feedback',
      trust: 'outside',
      repo: 'app',
      fingerprint: 'fp',
      title: 'Title token=abcdef123456',
      text: 'text',
      link: null,
      madeBy: null,
      probe: false,
    },
    alert: null,
  },
  receivedAt: new Date('2026-11-08T10:00:00Z'),
  state: 'held',
  issueId: null,
  dismissal: null,
  screening: NOT_SCREENED,
  ...over,
})

test('the request scrubs the words and bounds what the workflow is shown', () => {
  const request = screenRequest(row(), [], ['app'], (t) => t.replace(/token=\S+/, 'token=[redacted]'))
  expect(request.signal.title).toBe('Title token=[redacted]')
  expect(request.signal).not.toHaveProperty('fingerprint')
  expect(request.openIssues).toEqual([])
  expect(request.projects).toEqual(['app'])
})

test('a signal the owner dismissed meanwhile is counted, not an error', async () => {
  const store = { screenable: async () => [row()], setScreening: async () => false }
  const pass = await screenPass({
    uow: { run: async (fn) => fn({ intake: store as unknown as IntakeStore }), inTransaction: () => false },
    clock: { now: () => new Date('2026-11-08T11:00:00Z') },
    workflow: { screen: async () => ok(answer({ verdict: 'dismiss', reason: 'noise' })) },
    openIssues: { inRepo: async () => ok([]) },
    projects: { find: async () => ok(null), names: async () => ok(['app']) },
    promote: async () => err({ kind: 'not_held', detail: 'x' }),
    dismiss: async () => err({ kind: 'not_held', detail: 'signal_1 is dismissed' }),
  })
  expect(pass).toMatchObject({ ok: true, value: { looked: 1, notHeld: 1, dismissed: 0, problems: [] } })
})
