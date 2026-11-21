import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { finalizeLead } from '../../src/app/leads-finalize.ts'
import { noteLead } from '../../src/app/leads-note.ts'
import { quiesceLeads } from '../../src/app/leads-quiesce.ts'
import { startLead } from '../../src/app/leads-start.ts'
import { sweepKeptWorktrees } from '../../src/app/leads-sweep.ts'
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

  test('a lead whose hooks say its turn ended is typed with idle once it has been quiet for the force time', async () => {
    const { issue, effect } = await withNote()
    const hookEvent = (kind: string, n: number) =>
      w.db.sql`
        INSERT INTO factory.lead_hook_events (key, session, issue_id, attempt, kind, at, received_at)
        VALUES (${`lead-1-1:${kind}:${n}`}, 'lead-1-1', ${issue}, 1, ${kind}, ${w.clock.now()}, ${w.clock.now()})`
    await hookEvent('session_started', 0)
    w.clock.advance(1_000)
    await hookEvent('turn_started', 1)
    w.clock.advance(1_000)
    // the turn is running: the core's status is the only word
    w.terminals.typeAnswers = [ok('busy'), ok('busy'), ok('typed')]
    expect((await noteLead(w.deps, effect)).ok).toBe(false)
    expect(w.terminals.typed.map((t) => t.idle)).toEqual([false])

    await hookEvent('turn_ended', 1)
    w.clock.advance(60_000)
    expect((await noteLead(w.deps, effect)).ok).toBe(false)
    expect(w.terminals.typed.map((t) => t.idle)).toEqual([false, false])

    // quiet for the force time by the hooks: the adapter may believe the screen over the core's status
    w.clock.advance(5 * 60_000)
    expect((await noteLead(w.deps, effect)).ok).toBe(true)
    expect(w.terminals.typed.map((t) => t.idle)).toEqual([false, false, true])
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

  test('a lead whose attempt was given another account is started again there, same session, with the note as its first message', async () => {
    w.seatAccount = 'me'
    const { issue, effect } = await withNote()
    await w.db.sql`
      INSERT INTO factory.lead_hook_events (key, session, issue_id, attempt, kind, at, received_at, payload)
      VALUES ('lead-1-1:session_started:0', 'lead-1-1', ${issue}, 1, 'session_started', ${w.clock.now()}, ${w.clock.now()},
        ${JSON.stringify({ claudeSessionId: 'c-1', transcriptPath: '/x/c-1.jsonl' })}::text::jsonb)`
    w.seatAccount = 'other'
    w.projectEnv = { ORB_FORMAT: 'json' }
    expect((await noteLead(w.deps, effect)).ok).toBe(true)
    expect(w.terminals.dormant).toEqual(['lead-1-1'])
    expect(w.terminals.typed).toHaveLength(0)
    expect(w.terminals.revived).toHaveLength(1)
    expect(w.terminals.revived[0]).toMatchObject({
      key: 'lead-1-1',
      account: 'other',
      session: 'c-1',
      env: { ORB_FORMAT: 'json' },
    })
    expect(w.terminals.revived[0]?.prompt).toContain('mind the migration')
    const [row] = await w.db.sql`SELECT account, dormant_at FROM factory.lead_attempts WHERE issue_id = ${issue}`
    expect(row).toMatchObject({ account: 'other', dormant_at: null })
    // the same effect again starts nothing twice
    expect((await noteLead(w.deps, effect)).ok).toBe(true)
    expect(w.terminals.revived).toHaveLength(1)
  })

  test('a moved lead whose worktree was removed meanwhile gets it back before its session resumes, and is told so', async () => {
    w.seatAccount = 'me'
    const { issue, effect } = await withNote()
    await w.db.sql`
      INSERT INTO factory.lead_hook_events (key, session, issue_id, attempt, kind, at, received_at, payload)
      VALUES ('lead-1-1:session_started:0', 'lead-1-1', ${issue}, 1, 'session_started', ${w.clock.now()}, ${w.clock.now()},
        ${JSON.stringify({ claudeSessionId: 'c-1', transcriptPath: '/x/c-1.jsonl' })}::text::jsonb)`
    w.seatAccount = 'other'
    const [row] = await w.db.sql`SELECT worktree_path FROM factory.lead_attempts WHERE issue_id = ${issue}`
    w.worktrees.gone.add(String(row?.worktree_path))
    expect((await noteLead(w.deps, effect)).ok).toBe(true)
    expect(w.worktrees.restored).toEqual([
      { repo: expect.any(String), branch: 'factory/1-1', path: row?.worktree_path },
    ])
    expect(w.terminals.revived).toHaveLength(1)
    expect(w.terminals.revived[0]?.prompt).toContain('made again at the same path')
    expect(w.terminals.revived[0]?.prompt).toContain('mind the migration')
  })

  test('a worktree that cannot be made again fails the revive like any failed start: counted, tried again, nothing resumed', async () => {
    w.seatAccount = 'me'
    const { issue, effect } = await withNote()
    await w.db.sql`
      INSERT INTO factory.lead_hook_events (key, session, issue_id, attempt, kind, at, received_at, payload)
      VALUES ('lead-1-1:session_started:0', 'lead-1-1', ${issue}, 1, 'session_started', ${w.clock.now()}, ${w.clock.now()},
        ${JSON.stringify({ claudeSessionId: 'c-1', transcriptPath: '/x/c-1.jsonl' })}::text::jsonb)`
    w.seatAccount = 'other'
    w.worktrees.restoreError = portError('gone', 'git worktree add failed (exit 128)')
    expect((await noteLead(w.deps, effect)).ok).toBe(false)
    expect(w.terminals.revived).toEqual([])
  })

  test('a lead with no session id on file is not ended for a move: the note is typed to it where it runs', async () => {
    w.seatAccount = 'me'
    const { effect } = await withNote()
    w.seatAccount = 'other'
    expect((await noteLead(w.deps, effect)).ok).toBe(true)
    expect(w.terminals.dormant).toEqual([])
    expect(w.terminals.revived).toEqual([])
    expect(w.terminals.typed).toHaveLength(1)
  })

  test('a lead on the account its attempt belongs to is typed to, never moved', async () => {
    w.seatAccount = 'me'
    const { effect } = await withNote()
    expect((await noteLead(w.deps, effect)).ok).toBe(true)
    expect(w.terminals.dormant).toEqual([])
    expect(w.terminals.revived).toEqual([])
    expect(w.terminals.typed).toHaveLength(1)
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

  /** A dormant lead whose Issue waits on a Decision the Judge sent back: the back is the note typed to it. */
  async function withBackToDormantLead(dormant = true) {
    w.seatAccount = 'me'
    const issue = await w.admitted()
    await startLead(w.deps, asEffect(startEffect(issue, 1), 'start_lead', issue))
    await w.event(issue, 'ask', {
      kind: 'asked',
      payload: { attempt: 1, decision: { id: 'd1', summary: 'which?' } },
      actor: 'lead',
    })
    const back = (await w.event(issue, 'back', {
      kind: 'noted',
      payload: { text: 'look at the migration again', back: 'd1' },
      actor: 'judge',
    })) as { effects: Effect[] }
    const effect = back.effects[0]
    if (!effect) throw new Error('no effect planned')
    await w.db.sql`
      INSERT INTO factory.lead_hook_events (key, session, issue_id, attempt, kind, at, received_at, payload)
      VALUES ('lead-1-1:session_started:0', 'lead-1-1', ${issue}, 1, 'session_started', ${w.clock.now()}, ${w.clock.now()},
        ${JSON.stringify({ claudeSessionId: 'c-1', transcriptPath: '/x/c-1.jsonl' })}::text::jsonb)`
    if (dormant) {
      await w.db.sql`UPDATE factory.lead_attempts SET dormant_at = ${w.clock.now()} WHERE issue_id = ${issue}`
      w.terminals.lose('lead-1-1')
    }
    return { issue, effect: asEffect(effect, 'note_lead', issue) }
  }

  test("the Judge's back to a dormant lead takes the repo claim before the session starts; a full repo starts nothing and is asked again", async () => {
    const { issue, effect } = await withBackToDormantLead()
    w.claims.resumeError = portError('refused', 'Issue 1 waits for a claim in example: the repo is full')
    expect(await noteLead(w.deps, effect)).toEqual({ ok: false, error: w.claims.resumeError })
    expect(w.terminals.revived).toEqual([])

    w.claims.resumeError = null
    expect((await noteLead(w.deps, effect)).ok).toBe(true)
    expect(w.claims.resumed).toEqual([{ issue, attempt: 1 }])
    expect(w.terminals.revived).toHaveLength(1)
    expect(w.terminals.revived[0]?.prompt).toContain('look at the migration again')
  })

  test("the Judge's back to a live lead is typed as before, with no claim taken", async () => {
    const { effect } = await withBackToDormantLead(false)
    expect((await noteLead(w.deps, effect)).ok).toBe(true)
    expect(w.claims.resumed).toHaveLength(0)
    expect(w.terminals.typed).toHaveLength(1)
  })

  test('a lead asleep again gives back the claim its Decision wait took', async () => {
    const issue = await w.admitted()
    await startLead(w.deps, asEffect(startEffect(issue, 1), 'start_lead', issue))
    const hook = (kind: string, n: number, payload: unknown = {}) =>
      w.db.sql`
        INSERT INTO factory.lead_hook_events (key, session, issue_id, attempt, kind, at, received_at, payload)
        VALUES (${`lead-1-1:${kind}:${n}`}, 'lead-1-1', ${issue}, 1, ${kind}, ${w.clock.now()}, ${w.clock.now()}, ${JSON.stringify(payload)}::text::jsonb)`
    await hook('session_started', 0, { claudeSessionId: 'c-1', transcriptPath: '/x/c-1.jsonl' })
    await hook('turn_started', 1)
    await w.event(issue, 'ask', {
      kind: 'asked',
      payload: { attempt: 1, decision: { id: 'd1', summary: 'which?' } },
      actor: 'lead',
    })
    await hook('turn_ended', 1)
    const quiet = {
      ...w.deps,
      quiesce: {
        afterMs: 30 * 60_000,
        maxReviveTries: 3,
        slotCwds: async () => [],
        processes: async () => [
          { pid: 1, ppid: 0, session: null },
          { pid: 100, ppid: 1, session: 'lead-1-1' },
        ],
      },
    }
    expect(await quiesceLeads(quiet)).toBe(0)
    expect(w.claims.released).toEqual([])

    w.clock.advance(40 * 60_000)
    expect(await quiesceLeads(quiet)).toBe(1)
    expect(w.terminals.dormant).toEqual(['lead-1-1'])
    expect(w.claims.released).toEqual([{ issue, attempt: 1 }])
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
    expect(w.worktrees.removed).toMatchObject([
      { repo: '/roots/example', branch: 'factory/1-1', path: expect.any(String), shipped: [] },
    ])

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
    expect(w.worktrees.removed).toMatchObject([{ branch: 'factory/1-1', shipped: ['abc1234'] }])
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

  test('the sweep takes up the kept worktree of a closed Issue again: gone it loses its reason, kept it keeps one', async () => {
    const { issue, effect } = await closedLead()
    const tmp = mkdtempSync(join(tmpdir(), 'kept-'))
    w.worktrees.removal = { kept: 'it has uncommitted changes', path: tmp }
    expect((await finalizeLead(w.deps, effect)).ok).toBe(true)

    // the Issue is still open: nothing to sweep
    expect(await sweepKeptWorktrees(w.deps)).toEqual({ looked: 0, removed: 0 })

    await w.event(issue, 'cancel', { kind: 'cancelled', payload: { reason: 'stop' }, actor: 'owner' })
    w.worktrees.removal = { kept: 'it has uncommitted changes to tracked files (a.txt)', path: tmp }
    expect(await sweepKeptWorktrees(w.deps)).toEqual({ looked: 1, removed: 0 })
    expect(w.worktrees.removed.at(-1)).toMatchObject({
      branch: 'factory/1-1',
      path: tmp,
      issue: 1,
      attempt: 1,
    })
    const [row] = await w.db
      .sql`SELECT worktree_kept, worktree_path FROM factory.lead_finalizations WHERE issue_id = ${issue}`
    expect(row).toMatchObject({
      worktree_kept: 'it has uncommitted changes to tracked files (a.txt)',
      worktree_path: tmp,
    })

    w.worktrees.removal = { removed: true }
    expect(await sweepKeptWorktrees(w.deps)).toEqual({ looked: 1, removed: 1 })
    const [gone] = await w.db
      .sql`SELECT worktree_kept, worktree_path FROM factory.lead_finalizations WHERE issue_id = ${issue}`
    expect(gone).toMatchObject({ worktree_kept: null, worktree_path: null })
    expect(await sweepKeptWorktrees(w.deps)).toEqual({ looked: 0, removed: 0 })
  })
})
