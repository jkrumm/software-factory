import { expect, test } from 'bun:test'
import type { ScreenAnswer } from '@software-factory/contract'
import { screenPass, screenSummary, type ScreenPass } from '../../src/app/loops/screen.ts'
import type { IntakeStore, SignalRow } from '../../src/domains/intake/ports.ts'
import {
  checkScreen,
  decideFinal,
  FINAL_STEER,
  isFinalScreen,
  NOT_SCREENED,
  screenBackoffMs,
  screenRequest,
} from '../../src/domains/intake/screen.ts'
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
    openIssues: { inRepo: async () => ok([]), closedSince: async () => ok([]) },
    projects: { find: async () => ok(null), names: async () => ok(['app']) },
    promote: async () => err({ kind: 'not_held', detail: 'x' }),
    dismiss: async () => err({ kind: 'not_held', detail: 'signal_1 is dismissed' }),
  })
  expect(pass).toMatchObject({ ok: true, value: { looked: 1, notHeld: 1, dismissed: 0, problems: [] } })
})

test('a promote the factory refuses at act time records the attempt with a backoff, so it is not asked again at once', async () => {
  const recorded: unknown[] = []
  const store = {
    screenable: async () => [row()],
    setScreening: async (_id: string, screening: unknown) => {
      recorded.push(screening)
      return true
    },
  }
  const pass = await screenPass({
    uow: { run: async (fn) => fn({ intake: store as unknown as IntakeStore }), inTransaction: () => false },
    clock: { now: () => new Date('2026-11-08T11:00:00Z') },
    workflow: { screen: async () => ok(answer({ verdict: 'promote' })) },
    openIssues: { inRepo: async () => ok([]), closedSince: async () => ok([]) },
    projects: { find: async () => ok({ work: false }), names: async () => ok(['app']) },
    promote: async () => err({ kind: 'unknown_project', detail: 'app is gone' }),
    dismiss: async () => err({ kind: 'not_held', detail: 'x' }),
  })
  expect(pass).toMatchObject({ ok: true, value: { looked: 1, promoted: 0, failed: 1, actFailed: 1 } })
  expect(recorded).toEqual([expect.objectContaining({ attempts: 1, retryAt: new Date('2026-11-08T11:10:00Z') })])
  expect(screenSummary((pass as { value: ScreenPass }).value)).toStartWith('acting failed')
})

// ---- the last look at a signal held 72 hours ---------------------------------------------------------------------------

test('a signal 72 hours old that was not screened since is on its last look, once', () => {
  const old = row({ receivedAt: new Date('2026-11-08T10:00:00Z') })
  expect(isFinalScreen(old, new Date('2026-11-11T09:59:00Z'))).toBe(false)
  expect(isFinalScreen(old, new Date('2026-11-11T10:00:00Z'))).toBe(true)
  // screened as a young one (a leave): the last look is still due
  const left = row({ receivedAt: old.receivedAt, screening: { ...NOT_SCREENED, at: new Date('2026-11-08T11:00:00Z') } })
  expect(isFinalScreen(left, new Date('2026-11-12T00:00:00Z'))).toBe(true)
  // screened after it got that old: done
  const done = row({ receivedAt: old.receivedAt, screening: { ...NOT_SCREENED, at: new Date('2026-11-11T10:05:00Z') } })
  expect(isFinalScreen(done, new Date('2026-11-12T00:00:00Z'))).toBe(false)
})

test('the last look is told so, and a leave becomes a promote with a known project, else a dismissal', () => {
  const request = screenRequest(row(), [], ['app'], (t) => t, true)
  expect(request.final).toBe(true)
  expect(screenRequest(row(), [], ['app'], (t) => t)).not.toHaveProperty('final')

  const leave = { action: 'leave', note: 'unclear' } as const
  expect(decideFinal(leave, { target: 'app', repoKnown: true })).toEqual({
    action: 'promote',
    repo: 'app',
    steer: FINAL_STEER,
  })
  expect(decideFinal(leave, { target: 'moon', repoKnown: false })).toMatchObject({ action: 'dismiss' })
  expect(decideFinal(leave, { target: null, repoKnown: false })).toMatchObject({ action: 'dismiss' })
  expect(decideFinal({ action: 'dismiss', reason: 'noise' }, { target: 'app', repoKnown: true })).toEqual({
    action: 'dismiss',
    reason: 'noise',
  })
  expect(decideFinal({ action: 'promote', repo: 'app' }, { target: 'app', repoKnown: true })).toMatchObject({
    action: 'promote',
    steer: FINAL_STEER,
  })
})

test('a held signal older than 72 h is screened again with final, a leave is promoted with the steer and it leaves the held list', async () => {
  const asked: unknown[] = []
  const promoted: unknown[] = []
  let held = true
  const store = {
    screenable: async (_now: Date, _max: number, _limit: number, finalAfterMs: number) => {
      expect(finalAfterMs).toBe(72 * 3_600_000)
      return held
        ? [
            row({
              receivedAt: new Date('2026-11-05T10:00:00Z'),
              screening: { ...NOT_SCREENED, at: new Date('2026-11-05T11:00:00Z'), note: 'unclear' },
            }),
          ]
        : []
    },
    setScreening: async () => true,
  }
  const pass = await screenPass({
    uow: { run: async (fn) => fn({ intake: store as unknown as IntakeStore }), inTransaction: () => false },
    clock: { now: () => new Date('2026-11-13T08:00:00Z') },
    workflow: {
      screen: async (request) => {
        asked.push(request.final)
        return ok(answer({ verdict: 'leave', reason: 'a stranger asks' }))
      },
    },
    openIssues: { inRepo: async () => ok([]), closedSince: async () => ok([]) },
    projects: { find: async () => ok({ work: false }), names: async () => ok(['app']) },
    promote: async (id, body, by, steer) => {
      promoted.push({ id, body, by, steer })
      held = false
      return ok({} as never)
    },
    dismiss: async () => err({ kind: 'not_held', detail: 'x' }),
  })
  expect(pass).toMatchObject({ ok: true, value: { looked: 1, promoted: 1, left: 0, problems: [] } })
  expect(asked).toEqual([true])
  expect(promoted).toEqual([{ id: 'signal_1', body: { repo: 'app' }, by: 'judge', steer: FINAL_STEER }])
  expect(held).toBe(false)
})
