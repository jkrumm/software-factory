import { describe, expect, test } from 'bun:test'
import type { Status } from '@software-factory/contract'
import { assemble, EXPIRE_FACTORY_ASK_MS, isMachineNoise, lineKey, type MergedSession } from '../src/fleet/model.ts'

const NOW = new Date('2026-11-04T12:00:00.000Z')
const none = { session: null, spawnWorking: false, issueOpen: false }

describe('machine failures are not asks', () => {
  test('a note to a terminal that no longer exists, or never confirmed', () => {
    const expired = 'note n1 to w1:p1 failed: expired: the session never took it'
    expect(isMachineNoise(expired, none)).toBe(true)
    expect(isMachineNoise(expired, { ...none, session: 'w1:p1' })).toBe(false)
    const unconfirmed =
      'note n1 to w1:p1 failed: unconfirmed: no turn started within a minute of the retry; not delivered'
    expect(isMachineNoise(unconfirmed, { ...none, session: 'w1:p1' })).toBe(true)
  })

  test('a failed spawn whose terminal still works', () => {
    const line = 'spawn s1 failed: t1 is running but reported nothing'
    expect(isMachineNoise(line, { ...none, spawnWorking: true })).toBe(true)
    expect(isMachineNoise(line, none)).toBe(false)
  })

  test('a kept worktree of a closed Issue, not of an open one', () => {
    const line = 'Issue 7: its worktree was kept (dirty): /x'
    expect(isMachineNoise(line, none)).toBe(true)
    expect(isMachineNoise(line, { ...none, issueOpen: true })).toBe(false)
  })

  test('the informational claim line', () => {
    expect(isMachineNoise('Issue 9 waits for the claim on proj', { ...none, issueOpen: true })).toBe(true)
  })

  test('what needs a person stays', () => {
    expect(isMachineNoise('Issue 9 blocked: x', { ...none, issueOpen: true })).toBe(false)
    expect(isMachineNoise('stuck w1:p1: nothing moved for 40 min', none)).toBe(false)
  })
})

const status = (attention: string[], health: string[] = []): Status =>
  ({ attention, health, accounts: [], queue: { spawns: [] }, issues: [] }) as unknown as Status

const model = (
  attention: string[],
  firstSeen: Map<string, string>,
  expired = new Map<string, string>(),
  health: string[] = [],
) =>
  assemble({
    now: NOW,
    roots: [],
    isVisible: () => false,
    status: status(attention, health),
    sessions: [] as MergedSession[],
    sessionPlans: new Map(),
    repos: [],
    decisions: [],
    queue: [],
    firstSeen,
    expired,
    errors: [],
  })

describe('assemble: machine failures and expiry', () => {
  test('a note to a missing terminal and a claim line are not listed; a stuck session is a health line, never an ask', () => {
    const fleet = model([], new Map(), undefined, [
      'note n1 to gone:p failed: expired: the session never took it',
      'Issue 9 waits for the claim on proj',
      'stuck w1:p1: nothing moved for 40 min',
    ])
    expect(fleet.asks).toEqual([])
    expect(fleet.health.map((h) => [h.kind, h.text])).toEqual([['machine', 'stuck w1:p1: nothing moved for 40 min']])
  })

  test('a health line keeps the time it was first seen, and carries its kind and Issue', () => {
    const park = 'Issue 7 parked for 5 min: its lead is gone (x)'
    const seenAt = '2026-11-04T10:00:00.000Z'
    const base = {
      now: NOW,
      roots: [],
      isVisible: () => false,
      sessions: [] as MergedSession[],
      sessionPlans: new Map(),
      repos: [],
      decisions: [],
      queue: [],
      firstSeen: new Map<string, string>(),
      errors: [],
    }
    const id = `health:${lineKey(park)}`
    const fleet = assemble({
      ...base,
      status: status([], [park, 'Issue 7: no hook event for 25 min']),
      healthSeen: new Map([[id, seenAt]]),
    })
    expect(fleet.health.map((h) => [h.id, h.kind, h.issue, h.since])).toEqual([
      [id, 'park', 7, seenAt],
      [expect.stringMatching(/^health:issue:7:silent:/), 'silent', 7, NOW.toISOString()],
    ])
    expect(fleet.asks).toEqual([])
  })

  test('a factory ask older than seven days expires and keeps its time; a younger one stays', () => {
    const old = 'Issue 1 blocked: needs a credential'
    const young = 'Issue 2 blocked: needs a credential'
    const oldAt = new Date(NOW.getTime() - EXPIRE_FACTORY_ASK_MS).toISOString()
    const youngAt = new Date(NOW.getTime() - EXPIRE_FACTORY_ASK_MS + 60_000).toISOString()
    const expired = new Map<string, string>()
    const fleet = model(
      [old, young],
      new Map([
        [`factory:${lineKey(old)}`, oldAt],
        [`factory:${lineKey(young)}`, youngAt],
      ]),
      expired,
    )
    expect(fleet.asks.map((a) => a.text)).toEqual([young])
    expect([...expired]).toEqual([[`factory:${lineKey(old)}`, oldAt]])
  })

  test('a human-queue ask is never expired', () => {
    const fleet = assemble({
      now: NOW,
      roots: [],
      isVisible: () => false,
      status: status([]),
      sessions: [],
      sessionPlans: new Map(),
      repos: [],
      decisions: [],
      queue: [{ id: 'q1', text: 'decide', askedAt: '2026-01-01T00:00:00.000Z', state: null }] as never,
      firstSeen: new Map(),
      errors: [],
    })
    expect(fleet.asks.map((a) => a.id)).toEqual(['queue:q1'])
  })
})
