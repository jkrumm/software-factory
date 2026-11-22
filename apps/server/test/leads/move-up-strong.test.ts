import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { blockIssue } from '../../src/app/leads-verbs.ts'
import { finalizeLead } from '../../src/app/leads-finalize.ts'
import { noteLead } from '../../src/app/leads-note.ts'
import { startLead } from '../../src/app/leads-start.ts'
import type { LeadDeps } from '../../src/app/leads.ts'
import type { Recorded } from '../../src/app/issues.ts'
import { moveUpIfDue } from '../../src/app/move-up.ts'
import { HANDOVER_WAIT_MS } from '../../src/domains/leads/light.ts'
import {
  type Effect,
  type EffectKind,
  type EffectOf,
  startLead as startEffect,
} from '../../src/domains/work/effects.ts'
import type { IssueId } from '../../src/kernel/ids.ts'
import { ok } from '../../src/kernel/result.ts'
import { startWorld, type World } from './world.ts'

/**
 * The lead row's step: a lead-row seat filed with `moveUp` is moved up to the `strong` row with its handover. Against
 * real tables and fake ports, as the other lead tests.
 */
let w: World

beforeAll(async () => {
  w = await startWorld()
})
afterAll(async () => {
  await w.db.stop()
})
beforeEach(async () => {
  await w.reset()
  delete (w.deps as { apiErrors?: unknown }).apiErrors
})

const LEAD_SEAT = { tier: 'sonnet', effort: 'high', role: 'lead', moveUp: true } as const

function asEffect<K extends EffectKind>(effect: Effect, kind: K, issueId: IssueId): EffectOf<K> & { issueId: IssueId } {
  if (effect.kind !== kind) throw new Error(`not a ${kind}: ${effect.kind}`)
  return { ...effect, issueId } as EffectOf<K> & { issueId: IssueId }
}

const start = (issue: IssueId, attempt: number) => {
  const planned = startEffect(issue, attempt)
  return startLead(w.deps, asEffect(planned, 'start_lead', issue))
}

/** A hook fact of the lead's session, stamped with the test clock (which only moves on `w.clock.advance`). */
let hooks = 0
async function hookFact(issue: IssueId, attempt: number, kind: string, payload: Record<string, unknown> = {}) {
  const session = `lead-${issue.slice('issue_'.length)}-${attempt}`
  hooks += 1
  await w.db.sql`
    INSERT INTO factory.lead_hook_events (key, session, issue_id, attempt, kind, at, received_at, payload)
    VALUES (${`${session}:${kind}:${hooks}`}, ${session}, ${issue}, ${attempt}, ${kind}, ${w.clock.now()}, ${w.clock.now()},
      ${JSON.stringify(payload)}::text::jsonb)`
}

/** The lead has started its session and ended its first turn: it sits at the prompt. */
async function idleLead(issue: IssueId, attempt = 1) {
  await hookFact(issue, attempt, 'session_started', {
    claudeSessionId: `c-${attempt}`,
    transcriptPath: `/x/c-${attempt}.jsonl`,
  })
  w.clock.advance(1_000)
  await hookFact(issue, attempt, 'turn_started')
  w.clock.advance(1_000)
  await hookFact(issue, attempt, 'turn_ended')
  w.clock.advance(1_000)
}

/** A lead on the lead row with the move-up, started and quiet. */
async function leadWithMoveUp(seat: Parameters<World['admitted']>[1] | null = LEAD_SEAT, kind?: 'bug' | 'docs') {
  const issue = await w.admitted([], seat ?? undefined, kind)
  expect((await start(issue, 1)).ok).toBe(true)
  await idleLead(issue)
  return issue
}

/** Two stalls of attempt 1, the first woken, then the move-up the second one asks for. */
async function secondStall(issue: IssueId) {
  const first = (await w.event(issue, 'stall:1', {
    kind: 'stalled',
    payload: { attempt: 1, cause: 'blocked', detail: 'cannot find it' },
    actor: 'lead',
  })) as Recorded
  await w.event(issue, 'wake:1', {
    kind: 'woken',
    payload: { since: first.issue.version, detail: 'try again' },
    actor: 'owner',
  })
  await w.event(issue, 'stall:2', {
    kind: 'stalled',
    payload: { attempt: 1, cause: 'blocked', detail: 'still cannot' },
    actor: 'lead',
  })
  return w.deps.uow.run(({ work, quality }) => moveUpIfDue({ work, quality }, w.deps, { issueId: issue }))
}

const moved = async (issue: IssueId) =>
  (
    await w.db
      .sql`SELECT payload FROM factory.issue_events WHERE issue_id = ${issue} AND kind = 'moved_up' AND result = 'applied'`
  ).map((row: { payload: unknown }) => row.payload)

const words = (text: string | null): Partial<LeadDeps> => ({
  apiErrors: { tails: { lastWords: async () => ok(text) } } as unknown as LeadDeps['apiErrors'],
})

describe('a filed lead-row seat with moveUp', () => {
  test('starts on the lead row and its brief says its --reason is the handover', async () => {
    const issue = await leadWithMoveUp()
    const prompt = w.terminals.started[0]?.prompt ?? ''
    expect(w.terminals.started[0]).toMatchObject({ tier: 'sonnet', effort: 'high' })
    expect(prompt).toContain('You run on the lead row, filed with the move-up')
    expect(prompt).toContain('--out-of-depth --reason "<handover>"')
    expect(prompt).not.toContain('Keep the change as small as the finding')
    expect(
      (await w.db.sql`SELECT payload FROM factory.issue_events WHERE issue_id = ${issue} AND kind = 'lead_started'`)[0]
        ?.payload,
    ).toMatchObject({
      seat: { tier: 'sonnet', effort: 'high', role: 'lead', moveUp: true },
    })
  })

  test('an out-of-depth block is the handover: the move plans no ask, and the next lead starts on strong with the reason in its brief', async () => {
    const issue = await leadWithMoveUp()
    const reason =
      'needs a new queue table; tried a column, the claim race remains; branch pushed at 3 commits; next: a lock row'
    const blocked = await blockIssue(w.deps, issue, { attempt: 1, reason, call: 'b1', outOfDepth: true })
    expect(blocked.ok).toBe(true)
    expect(await moved(issue)).toEqual([
      { attempt: 1, why: 'the lead said the work is beyond its seat', to: 'strong', handover: reason },
    ])
    const effects = await w.db
      .sql`SELECT kind FROM factory.issue_effects WHERE issue_id = ${issue} AND cancelled_at IS NULL ORDER BY version, position`
    expect(effects.map((row: { kind: string }) => row.kind)).toEqual(['finalize'])

    await w.event(issue, 'admitted:2', { kind: 'admitted', payload: {}, actor: 'factory' })
    expect((await start(issue, 2)).ok).toBe(true)
    const second = w.terminals.started.at(-1)
    expect(second).toMatchObject({ tier: 'opus', effort: 'high' })
    expect(second?.prompt).toContain('## Moved up from the lead row')
    expect(second?.prompt).toContain('the lead said the work is beyond its seat')
    expect(second?.prompt).toContain('its reason is its handover')
    expect(second?.prompt).toContain(reason)
    expect(second?.prompt).not.toContain('## Your seat')
  })

  test('a second stall asks the leaving lead once; its finalize waits for the answer, which the next brief carries', async () => {
    const issue = await leadWithMoveUp()
    const recorded = await secondStall(issue)
    if (!recorded.ok || !recorded.value) throw new Error('no move-up')
    const [ask, finalize] = recorded.value.effects
    expect((await moved(issue))[0]).toEqual({ attempt: 1, why: 'the lead stalled 2 times', to: 'strong', ask: 1 })
    expect(ask?.kind).toBe('note_lead')
    expect(finalize).toMatchObject({
      kind: 'finalize',
      payload: { attempt: 1, handover: ask?.payload && 'version' in ask.payload ? ask.payload.version : -1 },
    })

    // the note is typed; the lead has not answered: the finalize keeps its terminal
    expect((await noteLead(w.deps, asEffect(ask as Effect, 'note_lead', issue))).ok).toBe(true)
    expect(w.terminals.typed).toHaveLength(1)
    expect(w.terminals.typed[0]?.text).toContain('you are being moved up')
    expect(w.terminals.typed[0]?.text).toContain('write the handover as your final message')
    const waiting = await finalizeLead(w.deps, asEffect(finalize as Effect, 'finalize', issue))
    expect(waiting.ok).toBe(false)
    expect(w.terminals.closed).toEqual([])

    // it answers: a turn began after the note and ended
    w.clock.advance(5_000)
    await hookFact(issue, 1, 'turn_started')
    w.clock.advance(5_000)
    expect((await finalizeLead(w.deps, asEffect(finalize as Effect, 'finalize', issue))).ok).toBe(false)
    await hookFact(issue, 1, 'turn_ended')
    w.clock.advance(1_000)
    expect((await finalizeLead(w.deps, asEffect(finalize as Effect, 'finalize', issue))).ok).toBe(true)
    expect(w.terminals.closed).toEqual(['lead-1-1'])

    Object.assign(w.deps, words('HANDOVER: needs a lock row; tried a column; branch pushed; next: the lock'))
    await w.event(issue, 'admitted:2', { kind: 'admitted', payload: {}, actor: 'factory' })
    expect((await start(issue, 2)).ok).toBe(true)
    const second = w.terminals.started.at(-1)
    expect(second).toMatchObject({ tier: 'opus', effort: 'high' })
    expect(second?.prompt).toContain('It was asked for a handover and wrote this')
    expect(second?.prompt).toContain('HANDOVER: needs a lock row')
  })

  test('a lead that does not answer leaves its last words once the wait is over, and the brief says so', async () => {
    const issue = await leadWithMoveUp()
    const recorded = await secondStall(issue)
    if (!recorded.ok || !recorded.value) throw new Error('no move-up')
    const [ask, finalize] = recorded.value.effects
    await noteLead(w.deps, asEffect(ask as Effect, 'note_lead', issue))
    expect((await finalizeLead(w.deps, asEffect(finalize as Effect, 'finalize', issue))).ok).toBe(false)
    w.clock.advance(HANDOVER_WAIT_MS + 1_000)
    expect((await finalizeLead(w.deps, asEffect(finalize as Effect, 'finalize', issue))).ok).toBe(true)
    expect(w.terminals.closed).toEqual(['lead-1-1'])

    Object.assign(w.deps, words('I was reading the queue code when it ended'))
    await w.event(issue, 'admitted:2', { kind: 'admitted', payload: {}, actor: 'factory' })
    expect((await start(issue, 2)).ok).toBe(true)
    const prompt = w.terminals.started.at(-1)?.prompt ?? ''
    expect(prompt).toContain('did not answer; its last words')
    expect(prompt).toContain('I was reading the queue code when it ended')
  })

  test('a lead that is gone does not hold its finalize', async () => {
    const issue = await leadWithMoveUp()
    const recorded = await secondStall(issue)
    if (!recorded.ok || !recorded.value) throw new Error('no move-up')
    const [ask, finalize] = recorded.value.effects
    await noteLead(w.deps, asEffect(ask as Effect, 'note_lead', issue))
    w.clock.advance(1_000)
    await hookFact(issue, 1, 'session_ended')
    expect((await finalizeLead(w.deps, asEffect(finalize as Effect, 'finalize', issue))).ok).toBe(true)
  })

  test('a lead whose note never reached it (gone before the ask) has nothing to wait for', async () => {
    const issue = await leadWithMoveUp()
    const recorded = await secondStall(issue)
    if (!recorded.ok || !recorded.value) throw new Error('no move-up')
    const finalize = recorded.value.effects[1]
    // no note typed: no delivery, so the finalize does not wait
    expect((await finalizeLead(w.deps, asEffect(finalize as Effect, 'finalize', issue))).ok).toBe(true)
  })

  test('the second step is taken once: the strong lead is never moved up', async () => {
    const issue = await leadWithMoveUp()
    await blockIssue(w.deps, issue, { attempt: 1, reason: 'beyond me', call: 'b1', outOfDepth: true })
    await w.event(issue, 'admitted:2', { kind: 'admitted', payload: {}, actor: 'factory' })
    expect((await start(issue, 2)).ok).toBe(true)
    await idleLead(issue, 2)
    await w.event(issue, 'stall:3', {
      kind: 'stalled',
      payload: { attempt: 2, cause: 'blocked', detail: 'x', depth: true },
      actor: 'lead',
    })
    const moved2 = await w.deps.uow.run(({ work }) => moveUpIfDue({ work }, w.deps, { issueId: issue }))
    expect(moved2.ok && moved2.value).toBeNull()
    expect(await moved(issue)).toHaveLength(1)
  })
})

describe('what does not move up to the strong row', () => {
  test('an owner re-seat that asks to move up is refused once the Issue was moved up', async () => {
    const issue = await leadWithMoveUp()
    await blockIssue(w.deps, issue, { attempt: 1, reason: 'beyond me', call: 'b1', outOfDepth: true })
    const refused = await w.event(issue, 'seated:1', {
      kind: 'seated',
      payload: { tier: 'sonnet', effort: 'high', role: 'lead', moveUp: true },
      actor: 'owner',
    })
    expect(refused).toMatchObject({ result: 'refused' })
  })

  test('an owner re-seat of a moved-up Issue starts the next lead on that seat, not on the strong row', async () => {
    const issue = await leadWithMoveUp()
    await blockIssue(w.deps, issue, { attempt: 1, reason: 'beyond me', call: 'b1', outOfDepth: true })
    await w.event(issue, 'seated:1', { kind: 'seated', payload: { tier: 'sonnet', effort: 'max' }, actor: 'owner' })
    await w.event(issue, 'admitted:2', { kind: 'admitted', payload: {}, actor: 'factory' })
    expect((await start(issue, 2)).ok).toBe(true)
    expect(w.terminals.started.at(-1)).toMatchObject({ tier: 'sonnet', effort: 'max' })
  })

  test('the same seat filed without moveUp does not move', async () => {
    const issue = await leadWithMoveUp({ tier: 'sonnet', effort: 'high', role: 'lead' })
    const result = await secondStall(issue)
    expect(result.ok && result.value).toBeNull()
    expect(await moved(issue)).toEqual([])
  })

  test('a default lead-row Issue (no filed seat) does not move', async () => {
    const issue = await leadWithMoveUp(null)
    const result = await secondStall(issue)
    expect(result.ok && result.value).toBeNull()
  })

  test('a light-rule Issue moves up to the lead row, with no handover ask, and a later struggle there moves it no more', async () => {
    const issue = await leadWithMoveUp(null, 'docs')
    expect(w.terminals.started[0]).toMatchObject({ tier: 'haiku', effort: 'high' })
    const recorded = await secondStall(issue)
    if (!recorded.ok || !recorded.value) throw new Error('no move-up')
    expect(await moved(issue)).toEqual([{ attempt: 1, why: 'the light lead stalled 2 times' }])
    expect(recorded.value.effects.map((effect) => effect.kind)).toEqual(['finalize'])

    await w.event(issue, 'admitted:2', { kind: 'admitted', payload: {}, actor: 'factory' })
    expect((await start(issue, 2)).ok).toBe(true)
    expect(w.terminals.started.at(-1)).toMatchObject({ tier: 'sonnet', effort: 'high' })
    await idleLead(issue, 2)
    await w.event(issue, 'stall:9', {
      kind: 'stalled',
      payload: { attempt: 2, cause: 'blocked', detail: 'x', depth: true },
      actor: 'lead',
    })
    const again = await w.deps.uow.run(({ work }) => moveUpIfDue({ work }, w.deps, { issueId: issue }))
    expect(again.ok && again.value).toBeNull()
  })

  test('a filed light seat with moveUp ends on the lead row with last words, no second step', async () => {
    const issue = await leadWithMoveUp({ tier: 'haiku', effort: 'high', role: 'light', moveUp: true })
    const recorded = await secondStall(issue)
    if (!recorded.ok || !recorded.value) throw new Error('no move-up')
    expect((await moved(issue))[0]).toEqual({ attempt: 1, why: 'the light lead stalled 2 times' })
    await w.event(issue, 'admitted:2', { kind: 'admitted', payload: {}, actor: 'factory' })
    expect((await start(issue, 2)).ok).toBe(true)
    expect(w.terminals.started.at(-1)).toMatchObject({ tier: 'sonnet', effort: 'high' })
    expect(w.terminals.started.at(-1)?.prompt).toContain('## Moved up from the light seat')
  })
})
