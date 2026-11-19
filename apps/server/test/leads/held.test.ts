import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import type { SpoolLine } from '@software-factory/contract/spool'
import { HELD_AFTER_MS, holdWalledLeads } from '../../src/app/leads-held.ts'
import { apiErrorMemory } from '../../src/app/leads-api-errors.ts'
import { leadPorts, leadTick } from '../../src/app/leads-tick.ts'
import type { QuiesceProcess } from '../../src/domains/leads/ports.ts'
import { recordHook } from '../../src/app/leads-hooks.ts'
import { startLead } from '../../src/app/leads-start.ts'
import { startLead as startEffect } from '../../src/domains/work/effects.ts'
import type { IssueId } from '../../src/kernel/ids.ts'
import { BASE, startWorld, type World } from './world.ts'

let w: World

beforeAll(async () => {
  w = await startWorld()
})
afterAll(async () => {
  await w.db.stop()
})
// the host's process table the fake quiesce port answers with; null: unreadable
let table: QuiesceProcess[] | null
beforeEach(async () => {
  await w.reset()
  table = [{ pid: 10, ppid: 1, session: 'lead-1-1' }]
  w.deps.quiesce = { afterMs: 30 * 60_000, processes: async () => table, slotCwds: async () => [], maxReviveTries: 3 }
})

async function running(): Promise<IssueId> {
  const issue = await w.admitted()
  await startLead(w.deps, { ...startEffect(issue, 1), issueId: issue } as never)
  return issue
}

let n = 0
const line = (kind: SpoolLine['kind'], secondsAfter: number, payload?: Record<string, unknown>): SpoolLine => ({
  key: `lead-1-1:${kind}:${n++}`,
  session: 'lead-1-1',
  kind,
  at: new Date(BASE + secondsAfter * 1000).toISOString(),
  ...(payload ? { payload } : {}),
})

const issueRow = async (issue: IssueId) => {
  const [row] = await w.db.sql`SELECT state, wait_reason FROM factory.issues WHERE id = ${issue}`
  return row
}

const afterHeld = HELD_AFTER_MS / 1000

describe('a turn the account wall refused', () => {
  test('a resumed message that starts a turn on a closed account and never ends is a wall stall, once', async () => {
    const issue = await running()
    await recordHook(w.deps, line('session_started', 1, { source: 'resume', claudeSessionId: 'c1' }))
    await recordHook(w.deps, line('turn_started', 2))
    w.windowReset = new Date(BASE + 3_600_000)
    w.clock.at_(2 + afterHeld + 1)
    expect(await holdWalledLeads(w.deps)).toBe(1)
    expect(await issueRow(issue)).toEqual({ state: 'waiting', wait_reason: 'wall' })
    expect(await holdWalledLeads(w.deps)).toBe(0)
  })

  test("a turn is not held while a tool runs in the lead's tree, or when the table cannot be read", async () => {
    const issue = await running()
    await recordHook(w.deps, line('turn_started', 2))
    w.windowReset = new Date(BASE + 3_600_000)
    w.clock.at_(2 + afterHeld + 1)
    table = [
      { pid: 10, ppid: 1, session: 'lead-1-1' },
      { pid: 11, ppid: 10, session: 'lead-1-1' },
    ]
    expect(await holdWalledLeads(w.deps)).toBe(0)
    table = null
    expect(await holdWalledLeads(w.deps)).toBe(0)
    expect(await issueRow(issue)).toEqual({ state: 'working', wait_reason: null })
  })

  test('the lead tick finds a held lead', async () => {
    const issue = await running()
    await recordHook(w.deps, line('turn_started', 2))
    w.windowReset = new Date(BASE + 3_600_000)
    w.clock.at_(2 + afterHeld + 1)
    await leadTick({
      leads: w.deps,
      ports: leadPorts(w.deps) as never,
      replaySpool: async () => 0,
      apiErrorMemory: apiErrorMemory(),
    })
    expect(await issueRow(issue)).toEqual({ state: 'waiting', wait_reason: 'wall' })
  })

  test('a turn that has not been silent for long, or an account that is open, is left working', async () => {
    const issue = await running()
    await recordHook(w.deps, line('turn_started', 2))
    w.windowReset = new Date(BASE + 3_600_000)
    w.clock.at_(2 + afterHeld - 1)
    expect(await holdWalledLeads(w.deps)).toBe(0)
    w.windowReset = null
    w.clock.at_(2 + afterHeld + 1)
    expect(await holdWalledLeads(w.deps)).toBe(0)
    expect(await issueRow(issue)).toEqual({ state: 'working', wait_reason: null })
  })

  test('a lead that is idle at its prompt is not held, and the turn that starts later wakes the stall', async () => {
    const issue = await running()
    await recordHook(w.deps, line('turn_started', 2))
    await recordHook(w.deps, line('turn_ended', 3))
    w.windowReset = new Date(BASE + 3_600_000)
    w.clock.at_(3 + afterHeld + 1)
    expect(await holdWalledLeads(w.deps)).toBe(0)

    await recordHook(w.deps, line('turn_started', 400))
    w.clock.at_(400 + afterHeld + 1)
    expect(await holdWalledLeads(w.deps)).toBe(1)
    expect(await issueRow(issue)).toEqual({ state: 'waiting', wait_reason: 'wall' })
    w.clock.at_(400 + afterHeld + 60)
    expect(await recordHook(w.deps, line('turn_started', 400 + afterHeld + 60))).toEqual({
      ok: true,
      value: { recorded: true, reacted: 'woken' },
    })
    expect(await issueRow(issue)).toEqual({ state: 'working', wait_reason: null })
  })
})
