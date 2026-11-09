import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { finalizeLead } from '../../src/app/leads-finalize.ts'
import { noteLead } from '../../src/app/leads-note.ts'
import { startLead } from '../../src/app/leads-start.ts'
import {
  type Effect,
  type EffectKind,
  type EffectOf,
  finalize,
  finalizeClosed,
  startLead as startEffect,
} from '../../src/domains/work/effects.ts'
import type { IssueId } from '../../src/kernel/ids.ts'
import { err, ok, portError } from '../../src/kernel/result.ts'
import { startWorld, type World } from './world.ts'

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

function asEffect<K extends EffectKind>(effect: Effect, kind: K, issueId: IssueId): EffectOf<K> & { issueId: IssueId } {
  if (effect.kind !== kind) throw new Error(`not a ${kind}`)
  return { ...effect, issueId } as EffectOf<K> & { issueId: IssueId }
}

/** An Issue with a running lead and one recorded note, and the note_lead that carries it. */
async function withNote() {
  const issue = await w.admitted()
  const started = startEffect(issue, 1)
  await startLead(w.deps, asEffect(started, 'start_lead', issue))
  const noted = (await w.event(issue, 'note:1', {
    kind: 'noted',
    payload: { text: 'mind the migration' },
    actor: 'owner',
  })) as { effects: Effect[] }
  const effect = noted.effects[0]
  if (!effect) throw new Error('no effect planned')
  return { issue, effect: asEffect(effect, 'note_lead', issue) }
}

describe('note_lead', () => {
  test('types the news once; the same effect again types nothing', async () => {
    const { effect } = await withNote()
    expect((await noteLead(w.deps, effect)).ok).toBe(true)
    expect((await noteLead(w.deps, effect)).ok).toBe(true)
    expect(w.terminals.typed).toHaveLength(1)
    expect(w.terminals.typed[0]).toMatchObject({ terminal: 't1', force: false })
    expect(w.terminals.typed[0]?.text).toContain('mind the migration')
  })

  test('a lead mid-turn is asked again; it is typed into its working turn only after the force time', async () => {
    const { effect } = await withNote()
    w.terminals.typeAnswers = [ok('busy'), ok('busy'), ok('typed')]
    const first = await noteLead(w.deps, effect)
    expect(first).toEqual({
      ok: false,
      error: portError('refused', 'the lead is mid-turn; it hears the note when its turn ends'),
    })
    expect((await noteLead(w.deps, effect)).ok).toBe(false)
    expect(w.terminals.typed.map((t) => t.force)).toEqual([false, false])

    w.clock.advance(5 * 60_000)
    expect((await noteLead(w.deps, effect)).ok).toBe(true)
    expect(w.terminals.typed.map((t) => t.force)).toEqual([false, false, true])
    expect((await noteLead(w.deps, effect)).ok).toBe(true)
    expect(w.terminals.typed).toHaveLength(3)
  })

  test('typing that may have happened (the core did not say) is confirmed by the turn that began after it, never typed twice', async () => {
    const { issue, effect } = await withNote()
    w.terminals.typeAnswers = [{ ok: false, error: portError('timeout', 'uncertain: hc timed out') }]
    expect((await noteLead(w.deps, effect)).ok).toBe(false)
    expect(w.terminals.typed).toHaveLength(1)

    // The lead's next turn began: it took the text.
    w.clock.advance(1_000)
    await w.db.sql`
      INSERT INTO factory.lead_hook_events (key, session, issue_id, attempt, kind, at, received_at)
      VALUES ('lead-1-1:turn_started:1', 'lead-1-1', ${issue}, 1, 'turn_started', ${w.clock.now()}, ${w.clock.now()})`
    expect((await noteLead(w.deps, effect)).ok).toBe(true)
    expect(w.terminals.typed).toHaveLength(1)
    const [row] = await w.db.sql`SELECT typed_at FROM factory.lead_deliveries WHERE key = ${effect.key}`
    expect(row?.typed_at).not.toBeNull()
  })

  test('with no turn since, an unconfirmed typing is typed again', async () => {
    const { effect } = await withNote()
    w.terminals.typeAnswers = [{ ok: false, error: portError('timeout', 'uncertain: hc timed out') }]
    await noteLead(w.deps, effect)
    expect((await noteLead(w.deps, effect)).ok).toBe(true)
    expect(w.terminals.typed).toHaveLength(2)
  })

  test('a lead whose terminal is gone is the lead gone, and nothing is typed', async () => {
    const { issue, effect } = await withNote()
    w.terminals.lose('lead-1-1')
    expect((await noteLead(w.deps, effect)).ok).toBe(true)
    expect(w.terminals.typed).toHaveLength(0)
    const [row] = await w.db.sql`SELECT state FROM factory.issues WHERE id = ${issue}`
    expect(row?.state).toBe('queued')
  })

  test('the lead takes its repo claim back before the typing; a full repo types nothing and is asked again', async () => {
    const { issue, effect } = await withNote()
    w.claims.resumeError = portError('refused', 'Issue 1 waits for a claim in example: the repo is full')
    expect(await noteLead(w.deps, effect)).toEqual({ ok: false, error: w.claims.resumeError })
    expect(w.terminals.typed).toHaveLength(0)

    w.claims.resumeError = null
    expect((await noteLead(w.deps, effect)).ok).toBe(true)
    expect(w.claims.resumed).toEqual([{ issue, attempt: 1 }])
    expect(w.terminals.typed).toHaveLength(1)
  })

  test('a note for a lead that waits again takes no claim', async () => {
    const { issue, effect } = await withNote()
    await w.event(issue, 'defer', {
      kind: 'deferred',
      payload: { attempt: 1, until: new Date(w.clock.now().getTime() + 3_600_000).toISOString() },
      actor: 'lead',
    })
    expect((await noteLead(w.deps, effect)).ok).toBe(true)
    expect(w.claims.resumed).toHaveLength(0)
  })

  test('an Issue that closed, or a note for an earlier attempt, types nothing', async () => {
    const { issue, effect } = await withNote()
    await w.event(issue, 'cancel', { kind: 'cancelled', payload: { reason: 'stop' }, actor: 'owner' })
    expect((await noteLead(w.deps, effect)).ok).toBe(true)
    expect(w.terminals.typed).toHaveLength(0)
  })
})

describe('finalize', () => {
  async function closedLead() {
    const issue = await w.admitted()
    await startLead(w.deps, asEffect(startEffect(issue, 1), 'start_lead', issue))
    await w.db.sql`
      INSERT INTO factory.lead_hook_events (key, session, issue_id, attempt, kind, at, received_at, payload)
      VALUES ('lead-1-1:session_started:0', 'lead-1-1', ${issue}, 1, 'session_started', now(), now(),
              '{"claudeSessionId":"c-1","transcriptPath":"/x/c-1.jsonl"}')`
    return { issue, effect: asEffect(finalize(issue, 1), 'finalize', issue) }
  }

  test('gives the claim back, closes the terminals, archives the transcripts, removes the worktree: in this order, once', async () => {
    const { issue, effect } = await closedLead()
    expect((await finalizeLead(w.deps, effect)).ok).toBe(true)
    expect(w.claims.released).toEqual([{ issue, attempt: 1 }])
    expect(w.terminals.closed).toEqual(['lead-1-1'])
    expect(w.transcripts.archived).toMatchObject([
      { attempt: 1, sessions: [{ claudeSession: 'c-1', transcriptPath: '/x/c-1.jsonl' }] },
    ])
    expect(w.worktrees.removed).toEqual([{ repo: '/roots/example', branch: 'factory/1-1' }])

    expect((await finalizeLead(w.deps, effect)).ok).toBe(true)
    expect(w.claims.released).toHaveLength(1)
    expect(w.terminals.closed).toHaveLength(1)
    expect(w.worktrees.removed).toHaveLength(1)
  })

  test('a crash between two steps replays to one of each', async () => {
    const { effect } = await closedLead()
    w.transcripts.error = portError('gone', 'the disk is full')
    expect((await finalizeLead(w.deps, effect)).ok).toBe(false)
    expect(w.claims.released).toHaveLength(1)
    expect(w.terminals.closed).toHaveLength(1)
    expect(w.worktrees.removed).toHaveLength(0)

    w.transcripts.error = null
    expect((await finalizeLead(w.deps, effect)).ok).toBe(true)
    expect(w.claims.released).toHaveLength(1)
    expect(w.terminals.closed).toHaveLength(1)
    expect(w.worktrees.removed).toHaveLength(1)
  })

  test("a worktree that holds work is kept and says why; the next attempt's brief will quote it", async () => {
    const { issue, effect } = await closedLead()
    w.worktrees.removal = { kept: 'it has uncommitted changes', path: '/w/factory-1-1' }
    expect((await finalizeLead(w.deps, effect)).ok).toBe(true)
    const [row] = await w.db
      .sql`SELECT worktree_kept, worktree_path, done_at FROM factory.lead_finalizations WHERE issue_id = ${issue}`
    expect(row).toMatchObject({ worktree_kept: 'it has uncommitted changes', worktree_path: '/w/factory-1-1' })
    expect(row?.done_at).not.toBeNull()
  })

  test('an attempt that never made a worktree has none to remove, and still gives its claim back', async () => {
    const issue = await w.admitted()
    w.repoError = portError('refused', 'outside the roots')
    await startLead(w.deps, asEffect(startEffect(issue, 1), 'start_lead', issue))
    expect((await finalizeLead(w.deps, asEffect(finalize(issue, 1), 'finalize', issue))).ok).toBe(true)
    expect(w.claims.released).toEqual([{ issue, attempt: 1 }])
    expect(w.worktrees.removed).toHaveLength(0)
  })

  test('a restart of an open Issue removes the worktree and cleans no branches', async () => {
    const { effect } = await closedLead()
    expect((await finalizeLead(w.deps, effect)).ok).toBe(true)
    expect(w.worktrees.removed).toHaveLength(1)
    expect(w.branches.cleaned).toHaveLength(0)
  })

  test('a closed Issue has its branches cleaned, with the commits it shipped; what is kept is recorded', async () => {
    const { issue, effect } = await closedLead()
    await w.db.sql`
      INSERT INTO factory.quality_ships (id, issue_id, attempt, event_key, at, result, reported)
      VALUES ('s-1', ${issue}, 1, 'ship-1', now(), 'accepted', '[]')`
    await w.db.sql`
      INSERT INTO factory.quality_evidence (id, issue_id, attempt, source_key, kind, at, payload)
      VALUES ('e-1', ${issue}, 1, 'ship-1', 'commits', now(),
              '{"commits":["abc1234"],"landedAt":null,"mergedAt":null,"deploys":true,"paths":[]}')`
    await w.event(issue, 'cancel', { kind: 'cancelled', payload: { reason: 'stop' }, actor: 'owner' })
    w.branches.answer = ok({
      deleted: [],
      kept: [{ branch: 'factory/1-1', why: 'its commits are not on origin/master' }],
    })
    expect((await finalizeLead(w.deps, effect)).ok).toBe(true)
    expect(w.branches.cleaned).toEqual([
      { repo: '/roots/example', issue: 1, closed: 'cancelled', shipped: ['abc1234'] },
    ])
    const [row] = await w.db.sql`SELECT worktree_kept FROM factory.lead_finalizations WHERE issue_id = ${issue}`
    expect(row?.worktree_kept).toBe('branch factory/1-1 kept: its commits are not on origin/master')

    expect((await finalizeLead(w.deps, effect)).ok).toBe(true)
    expect(w.branches.cleaned).toHaveLength(1)
  })

  test('a close cleans the branches even when a restart already finalized the attempt, and again on a repeat', async () => {
    const { issue, effect } = await closedLead()
    expect((await finalizeLead(w.deps, effect)).ok).toBe(true)
    expect(w.branches.cleaned).toHaveLength(0)

    await w.event(issue, 'cancel', { kind: 'cancelled', payload: { reason: 'stop' }, actor: 'owner' })
    const closing = asEffect(finalizeClosed(issue, 1), 'finalize', issue)
    expect(closing.key).not.toBe(effect.key)
    expect((await finalizeLead(w.deps, closing)).ok).toBe(true)
    expect(w.branches.cleaned).toMatchObject([{ repo: '/roots/example', issue: 1, closed: 'cancelled' }])
    expect(w.claims.released).toHaveLength(1)
    expect(w.worktrees.removed).toHaveLength(1)

    expect((await finalizeLead(w.deps, closing)).ok).toBe(true)
    expect(w.branches.cleaned).toHaveLength(2)

    w.branches.answer = err(portError('gone', 'the remote is down'))
    expect((await finalizeLead(w.deps, closing)).ok).toBe(false)
  })
})
