import { describe, expect, test } from 'bun:test'
import { quiesceVerdict } from '../../src/domains/leads/quiesce.ts'
import type { QuiesceProcess } from '../../src/domains/leads/ports.ts'
import type { SessionView } from '../../src/domains/leads/session.ts'

const NOW = new Date('2026-11-14T12:00:00Z')
const minutesAgo = (n: number) => new Date(NOW.getTime() - n * 60_000)
const NAME = 'lead-7-1'
const WORKTREE = '/w/factory-7-1'

const idle: SessionView = {
  state: 'idle',
  turns: 3,
  turnStartedAt: null,
  lastTurnAt: minutesAgo(50),
  previousTurnAt: minutesAgo(90),
  lastEventAt: minutesAgo(45),
  idleSince: minutesAgo(45),
  walled: false,
  backgroundTasks: false,
  apiIncident: null,
  claudeSession: 'c0ffee00-0000-4000-8000-000000000001',
  transcriptPath: '/x/c.jsonl',
}

const root: QuiesceProcess = { pid: 100, ppid: 1, session: NAME }
const verdict = (over: Partial<Parameters<typeof quiesceVerdict>[0]> = {}) =>
  quiesceVerdict({
    now: NOW,
    afterMs: 30 * 60_000,
    session: NAME,
    waitingFree: true,
    waitSince: minutesAgo(40),
    view: idle,
    processes: [{ pid: 1, ppid: 0, session: null }, root],
    worktree: WORKTREE,
    slotCwds: [],
    ...over,
  })

describe('quiescing a waiting lead', () => {
  test('a quiet idle lead alone in its tree is dormant', () => {
    expect(verdict()).toEqual({ quiesce: true })
  })

  test.each([
    ['a stall, which keeps its lead', { waitingFree: false }, 'claim'],
    ['a wait of unknown start', { waitSince: null }, 'unknown'],
    [
      'a wait younger than the threshold',
      { waitSince: minutesAgo(10), view: { ...idle, lastEventAt: minutesAgo(45) } },
      'long enough',
    ],
    ['a session that spoke inside the threshold', { view: { ...idle, lastEventAt: minutesAgo(5) } }, 'long enough'],
    ['a session mid-turn', { view: { ...idle, state: 'working' as const } }, 'working'],
    ['background work in flight', { view: { ...idle, backgroundTasks: true } }, 'background'],
    ['a session that is not known', { view: { ...idle, claudeSession: null } }, 'session id'],
    ['an unreadable process table', { processes: null }, 'process table'],
  ] as const)('not dormant: %s', (_name, over, why) => {
    const answer = verdict(over)
    expect(answer.quiesce).toBe(false)
    expect(JSON.stringify(answer)).toContain(why)
  })

  test('a process under the lead (a lock, a test, a shell) keeps it running; one of another session does not', () => {
    const child: QuiesceProcess = { pid: 200, ppid: 100, session: NAME }
    const grandchild: QuiesceProcess = { pid: 300, ppid: 200, session: NAME }
    const other: QuiesceProcess = { pid: 400, ppid: 1, session: 'lead-8-1' }
    expect(verdict({ processes: [root, child] })).toMatchObject({ quiesce: false, why: 'process 200 runs in its tree' })
    expect(verdict({ processes: [root, grandchild, child] }).quiesce).toBe(false)
    expect(verdict({ processes: [root, other] })).toEqual({ quiesce: true })
  })

  test('a lead the table does not show is not dormant on a guess', () => {
    expect(verdict({ processes: [{ pid: 1, ppid: 0, session: null }] })).toMatchObject({
      quiesce: false,
      why: 'its process is not in the process table',
    })
  })

  test('a slot granted to its worktree or below keeps it; a sibling directory does not', () => {
    expect(verdict({ slotCwds: [WORKTREE] }).quiesce).toBe(false)
    expect(verdict({ slotCwds: [`${WORKTREE}/apps/server`] }).quiesce).toBe(false)
    expect(verdict({ slotCwds: [`${WORKTREE}-other`, '/w/factory-8-1'] })).toEqual({ quiesce: true })
  })
})
