import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import type { SpoolLine } from '@software-factory/contract/spool'
import { followLeads } from '../../src/app/leads-follow.ts'
import { recordHook, stopCheck } from '../../src/app/leads-hooks.ts'
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
beforeEach(async () => {
  await w.reset()
})

async function running(): Promise<IssueId> {
  const issue = await w.admitted()
  const e = startEffect(issue, 1)
  await startLead(w.deps, { ...e, issueId: issue } as never)
  return issue
}

let n = 0
const line = (
  kind: SpoolLine['kind'],
  secondsAfter = 0,
  payload?: Record<string, unknown>,
  session = 'lead-1-1',
): SpoolLine => ({
  key: `${session}:${kind}:${n++}`,
  session,
  kind,
  at: new Date(BASE + secondsAfter * 1000).toISOString(),
  ...(payload ? { payload } : {}),
})

const issueRow = async (issue: IssueId) => {
  const [row] = await w.db.sql`SELECT state, wait_reason FROM factory.issues WHERE id = ${issue}`
  return row
}

describe('hook events', () => {
  test('a line is stored once; the same key again, or a session that is no lead, stores nothing', async () => {
    await running()
    const first = line('session_started', 1)
    expect(await recordHook(w.deps, first)).toEqual({ ok: true, value: { recorded: true, reacted: null } })
    expect(await recordHook(w.deps, first)).toEqual({ ok: true, value: { recorded: false, reacted: null } })
    expect(await recordHook(w.deps, line('turn_started', 1, undefined, 'rd-agent'))).toEqual({
      ok: true,
      value: { recorded: false, reacted: null },
    })
    const [count] = await w.db.sql`SELECT count(*)::int AS n FROM factory.lead_hook_events`
    expect(count?.n).toBe(1)
  })

  test("the factory's own findings are never a session's to report", async () => {
    await running()
    expect((await recordHook(w.deps, line('pane_gone', 1))).ok).toBe(true)
    const [count] = await w.db.sql`SELECT count(*)::int AS n FROM factory.lead_hook_events`
    expect(count?.n).toBe(0)
  })

  test('a spool line of a kind the server does not know is skipped, not stored', async () => {
    await running()
    const odd = { ...line('turn_started', 1), kind: 'something_new' } as unknown as SpoolLine
    expect(await recordHook(w.deps, odd)).toEqual({ ok: true, value: { recorded: false, reacted: null } })
    const [count] = await w.db.sql`SELECT count(*)::int AS n FROM factory.lead_hook_events`
    expect(count?.n).toBe(0)
  })

  test('a limit stop of a working lead is a wall stall, once, with the window capacity knows', async () => {
    const issue = await running()
    w.windowReset = new Date('2026-11-07T15:00:00Z')
    const stop = line('limit_stop', 1)
    expect(await recordHook(w.deps, stop)).toEqual({ ok: true, value: { recorded: true, reacted: 'stalled' } })
    expect(await recordHook(w.deps, stop)).toEqual({ ok: true, value: { recorded: false, reacted: null } })
    expect(await issueRow(issue)).toEqual({ state: 'waiting', wait_reason: 'wall' })
    const [event] = await w.db
      .sql`SELECT payload->>'detail' AS detail FROM factory.issue_events WHERE issue_id = ${issue} AND kind = 'stalled'`
    expect(event?.detail).toContain('2026-11-07T15:00:00.000Z')
  })

  test('a turn that starts ends a wall or an unreported stall; one replayed from before the stall does not', async () => {
    const issue = await running()
    w.clock.at_(5)
    await recordHook(w.deps, line('limit_stop', 5))
    // a line from before the stall, delivered late by the spool replay
    w.clock.at_(60)
    const old = line('turn_started', -30)
    expect(await recordHook(w.deps, old)).toEqual({ ok: true, value: { recorded: true, reacted: null } })
    expect(await issueRow(issue)).toEqual({ state: 'waiting', wait_reason: 'wall' })

    expect(await recordHook(w.deps, line('turn_started', 120))).toEqual({
      ok: true,
      value: { recorded: true, reacted: 'woken' },
    })
    expect(await issueRow(issue)).toEqual({ state: 'working', wait_reason: null })
  })

  test('a turn while the Issue works, or waits for a person, moves nothing', async () => {
    const issue = await running()
    expect(await recordHook(w.deps, line('turn_started', 1))).toEqual({
      ok: true,
      value: { recorded: true, reacted: null },
    })
    await w.event(issue, 'ask', {
      kind: 'asked',
      payload: { attempt: 1, decision: { id: 'd1', summary: 'which database?' } },
      actor: 'lead',
    })
    await recordHook(w.deps, line('turn_started', 2))
    expect(await issueRow(issue)).toEqual({ state: 'waiting', wait_reason: 'decision' })
  })
})

describe('stop-check', () => {
  const stop = (stopHookActive = false, backgroundTasks = false) =>
    stopCheck(w.deps, 'lead-1-1', { stopHookActive, backgroundTasks })

  test("a note typed into the lead makes the turn it starts the factory's: sent back when nothing is reported", async () => {
    const issue = await running()
    await recordHook(w.deps, line('session_started', 0))
    await recordHook(w.deps, line('turn_started', 1))
    // turn 1 ends reported: a deferral
    w.clock.at_(2)
    await w.event(issue, 'defer', {
      kind: 'deferred',
      payload: { attempt: 1, until: new Date(BASE + 3_600_000).toISOString() },
      actor: 'lead',
    })
    expect(await stop()).toEqual({ ok: true, value: { sendBack: false, message: null } })
    w.clock.at_(3)
    await w.event(issue, 'woken', { kind: 'woken', payload: { since: 5, detail: 'timer' }, actor: 'factory' })

    // a second turn the owner started by typing: let through
    await recordHook(w.deps, line('turn_started', 10))
    expect(await stop()).toEqual({ ok: true, value: { sendBack: false, message: null } })

    // a third turn that follows a note the factory typed: the factory's, so sent back
    await w.db.sql`
      INSERT INTO factory.lead_deliveries (key, issue_id, attempt, kind, text, claimed_at, typed_at)
      VALUES ('note_lead:x', ${issue}, 1, 'note', 'n', ${new Date(BASE + 15_000)}, ${new Date(BASE + 15_000)})`
    w.clock.at_(16)
    await recordHook(w.deps, line('turn_started', 16))
    const sent = await stop()
    expect(sent.ok && sent.value.sendBack).toBe(true)
    expect(sent.ok && sent.value.message).toContain('you stopped with nothing reported')
  })

  test('no lead, no session of the Issue, or background work: nothing is said', async () => {
    await running()
    expect(await stopCheck(w.deps, 'rd-agent', { stopHookActive: false, backgroundTasks: false })).toEqual({
      ok: true,
      value: { sendBack: false, message: null },
    })
    await recordHook(w.deps, line('turn_started', 1))
    expect(await stop(false, true)).toEqual({ ok: true, value: { sendBack: false, message: null } })
  })
})

describe('following the leads', () => {
  test('a lead whose terminal runs is left alone; one lost past the grace is gone, once', async () => {
    const issue = await running()
    expect(await followLeads(w.deps)).toBe(0)

    w.terminals.lose('lead-1-1')
    expect(await followLeads(w.deps)).toBe(1)
    expect(await followLeads(w.deps)).toBe(0)
    expect(await issueRow(issue)).toEqual({ state: 'queued', wait_reason: null })
    const [fact] = await w.db.sql`SELECT kind FROM factory.lead_hook_events WHERE session = 'lead-1-1'`
    expect(fact?.kind).toBe('pane_gone')
  })

  test('within the grace a missing terminal is not yet gone; a core that does not answer says nothing', async () => {
    const issue = await running()
    const graced = { ...w.deps, graceMs: 120_000 }
    w.terminals.lose('lead-1-1')
    expect(await followLeads(graced)).toBe(0)
    w.clock.advance(121_000)
    expect(await followLeads(graced)).toBe(1)
    expect(await issueRow(issue)).toMatchObject({ state: 'queued' })

    const other = await w.admitted()
    await startLead(w.deps, { ...startEffect(other, 1), issueId: other } as never)
    const silent = {
      ...w.deps,
      terminals: {
        ...w.terminals,
        find: async () => ({ ok: false as const, error: { kind: 'timeout' as const, detail: 'x' } }),
      },
    }
    expect(await followLeads(silent as never)).toBe(0)
  })

  test('the tab of a lead whose Issue waits is named too; a lost terminal is not called gone then', async () => {
    const issue = await running()
    w.clock.at_(2)
    await w.event(issue, 'defer', {
      kind: 'deferred',
      payload: { attempt: 1, until: new Date(BASE + 3_600_000).toISOString() },
      actor: 'lead',
    })
    expect(await issueRow(issue)).toMatchObject({ state: 'waiting' })
    await followLeads(w.deps)
    expect(w.terminals.named).toHaveLength(1)

    w.terminals.lose('lead-1-1')
    expect(await followLeads(w.deps)).toBe(0)
  })

  test('the tab of a lead that runs is named on a pass; a terminal without a tab name is never touched', async () => {
    await running()
    const [started] = w.terminals.started
    await followLeads(w.deps)
    expect(w.terminals.named).toEqual([{ tab: 'tb-1', name: started?.tabName ?? '' }])
    expect(started?.tabName).toMatch(/^Lead/)

    // a lead started before the label carried the name: the key is in it, the name still comes from the title
    w.terminals.named = []
    w.terminals.terminals.set(
      'lead-1-1',
      (w.terminals.terminals.get('lead-1-1') ?? []).map((t) => ({ ...t, tabName: 'lead-1-1' })),
    )
    await followLeads(w.deps)
    expect(w.terminals.named).toEqual([{ tab: 'tb-1', name: started?.tabName ?? '' }])

    w.terminals.named = []
    w.terminals.terminals.set(
      'lead-1-1',
      (w.terminals.terminals.get('lead-1-1') ?? []).map((t) => ({ ...t, tabName: null })),
    )
    await followLeads(w.deps)
    expect(w.terminals.named).toEqual([])
  })
})
