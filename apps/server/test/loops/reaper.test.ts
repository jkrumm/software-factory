import { expect, test } from 'bun:test'
import {
  decideReaping,
  type ReaperAttempt,
  type ReaperProc,
  type ReapingInput,
} from '../../src/domains/loops/reaper.ts'

const now = new Date('2026-11-11T12:00:00Z')
const ago = (ms: number) => new Date(now.getTime() - ms)
const HOUR = 3_600_000
const GRACE = 5 * 60_000

const proc = (pid: number, over: Partial<ReaperProc> = {}): ReaperProc => ({
  pid,
  ppid: 1,
  ageS: 7200,
  comm: 'chrome',
  session: null,
  cwd: null,
  ...over,
})
const closed: ReaperAttempt = { session: 'lead-5-1', worktree: '/w/app/5-1', closedAt: ago(HOUR) }
const liveOne: ReaperAttempt = { session: 'lead-6-1', worktree: '/w/app/6-1', closedAt: null }

const decide = (procs: ReaperProc[], over: Partial<ReapingInput> = {}) =>
  decideReaping({
    procs,
    attempts: [closed, liveOne],
    now,
    graceMs: GRACE,
    protect: [1],
    previouslyTermed: [],
    ...over,
  })
const pids = (leaks: { pid: number }[]) => leaks.map((l) => l.pid)

test.each([
  ['a process of a closed attempt by its session', proc(10, { session: 'lead-5-1' }), 'term', 'session'],
  ['a process in the closed worktree', proc(11, { cwd: '/w/app/5-1' }), 'term', 'worktree'],
  ['a process deep in the closed worktree', proc(12, { cwd: '/w/app/5-1/node_modules/x' }), 'term', 'worktree'],
  ['a trailing slash on the directory', proc(13, { cwd: '/w/app/5-1/' }), 'term', 'worktree'],
] as const)('%s is reaped', (_name, p, bucket, reason) => {
  const out = decide([p])
  expect(pids(out[bucket])).toEqual([p.pid])
  expect(out[bucket][0]).toMatchObject({ session: 'lead-5-1', reason })
})

test.each([
  ['a sibling path sharing a prefix (/a/b vs /a/bc)', proc(20, { cwd: '/w/app/5-10' })],
  ['an unknown session', proc(21, { session: 'lead-99-1' })],
  ['an unknown directory', proc(22, { cwd: '/tmp/other' })],
  ['no session and no directory', proc(23)],
  ['a live attempt by session', proc(24, { session: 'lead-6-1' })],
  ['a live attempt by directory', proc(25, { cwd: '/w/app/6-1/src' })],
  ['a closed session whose directory is in a live worktree', proc(26, { session: 'lead-5-1', cwd: '/w/app/6-1' })],
  ['a protected pid', proc(27, { session: 'lead-5-1' })],
])('%s is left alone', (_name, p) => {
  const out = decide([p], { protect: [1, 27] })
  expect([...out.term, ...out.kill]).toEqual([])
})

test('a boundary: /a/b does not own /a/bc', () => {
  const out = decide([proc(30, { cwd: '/w/app/5-1x' })])
  expect([...out.term, ...out.kill]).toEqual([])
})

test('inside the grace after the close a process is left, after it is reaped', () => {
  const young: ReaperAttempt = { ...closed, closedAt: ago(GRACE - 1_000) }
  const old: ReaperAttempt = { ...closed, closedAt: ago(GRACE + 1_000) }
  const p = proc(40, { session: 'lead-5-1' })
  const a = decide([p], { attempts: [young] })
  expect([...a.term, ...a.kill]).toEqual([])
  expect(a.skipped.young).toBe(1)
  expect(pids(decide([p], { attempts: [old] }).term)).toEqual([40])
})

test('an attempt without a close is live: gone but not finalized keeps its processes', () => {
  const unfinished: ReaperAttempt = { session: 'lead-5-1', worktree: '/w/app/5-1', closedAt: null }
  const out = decide([proc(50, { session: 'lead-5-1' }), proc(51, { cwd: '/w/app/5-1' })], { attempts: [unfinished] })
  expect([...out.term, ...out.kill]).toEqual([])
})

test('a live twin with the closed key protects the session', () => {
  const twin: ReaperAttempt = { session: 'lead-5-1', worktree: '/w/other', closedAt: null }
  const out = decide([proc(60, { session: 'lead-5-1' })], { attempts: [closed, twin] })
  expect([...out.term, ...out.kill]).toEqual([])
  expect(out.skipped.live).toBe(1)
})

test('pid 1, the server and every ancestor of a protected pid are never touched', () => {
  const procs = [
    proc(100, { ppid: 1, session: 'lead-5-1' }),
    proc(101, { ppid: 100, session: 'lead-5-1' }),
    proc(102, { ppid: 101, session: 'lead-5-1' }),
    proc(103, { ppid: 100, session: 'lead-5-1' }),
  ]
  const out = decide(procs, { protect: [1, 102] })
  expect(pids(out.term)).toEqual([103])
  expect(out.skipped.protected).toBe(3)
})

test('a leak termed before and still the same process is killed; a younger one on the same pid is a new process', () => {
  const termed = [{ pid: 70, ageS: 7000 }]
  const same = decide([proc(70, { session: 'lead-5-1', ageS: 7300 })], { previouslyTermed: termed })
  expect(pids(same.kill)).toEqual([70])
  expect(same.term).toEqual([])
  const equal = decide([proc(70, { session: 'lead-5-1', ageS: 7000 })], { previouslyTermed: termed })
  expect(pids(equal.kill)).toEqual([70])
  const reused = decide([proc(70, { session: 'lead-5-1', ageS: 12 })], { previouslyTermed: termed })
  expect(pids(reused.term)).toEqual([70])
  expect(reused.kill).toEqual([])
})

test('the longest closed worktree wins when two contain the directory', () => {
  const outer: ReaperAttempt = { session: 'lead-7-1', worktree: '/w/app', closedAt: ago(HOUR) }
  const out = decide([proc(80, { cwd: '/w/app/5-1/x' })], { attempts: [outer, closed] })
  expect(out.term[0]?.session).toBe('lead-5-1')
})
