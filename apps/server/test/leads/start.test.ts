import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { startLead } from '../../src/app/leads-start.ts'
import { startLead as startLeadEffect } from '../../src/domains/work/effects.ts'
import type { IssueId } from '../../src/kernel/ids.ts'
import { portError } from '../../src/kernel/result.ts'
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

const effect = (issue: IssueId, attempt = 1) => {
  const e = startLeadEffect(issue, attempt)
  if (e.kind !== 'start_lead') throw new Error('not a start_lead')
  return { ...e, issueId: issue }
}

const events = async (issue: IssueId, kind: string) =>
  w.db
    .sql`SELECT payload, version FROM factory.issue_events WHERE issue_id = ${issue} AND kind = ${kind} AND result = 'applied'`

describe('start_lead', () => {
  test('makes the worktree, starts the terminal under its key with the brief, and records lead_started once', async () => {
    const issue = await w.admitted(['the owner said: be careful with the migration'])
    expect((await startLead(w.deps, effect(issue))).ok).toBe(true)

    expect(w.worktrees.created).toEqual([{ repo: '/roots/example', branch: 'factory/1-1' }])
    expect(w.terminals.started).toHaveLength(1)
    const [started] = w.terminals.started
    expect(started).toMatchObject({
      key: 'lead-1-1',
      cwd: '/w/factory-1-1',
      space: '/roots/example',
      tier: 'sonnet',
      effort: 'high',
    })
    expect(started?.prompt).toContain('be careful with the migration')
    expect(started?.prompt).toContain('## Notes from the owner, recorded before you started')
    expect(started?.prompt).not.toContain('## Notes recorded before you started')
    expect(await events(issue, 'lead_started')).toEqual([{ payload: { attempt: 1, terminal: 't1' }, version: 5 }])
  })

  test('a replay finds the lead that runs: nothing is made or started twice, the fact is recorded once', async () => {
    const issue = await w.admitted()
    await startLead(w.deps, effect(issue))
    await startLead(w.deps, effect(issue))
    expect(w.worktrees.created).toHaveLength(1)
    expect(w.terminals.started).toHaveLength(1)
    expect(await events(issue, 'lead_started')).toHaveLength(1)
    const [row] = await w.db.sql`SELECT tries FROM factory.lead_attempts WHERE issue_id = ${issue}`
    expect(row?.tries).toBe(2)
  })

  test('a transient failure is retried, and the worktree already made is not made again', async () => {
    const issue = await w.admitted()
    w.terminals.startError = portError('timeout', 'hc timed out')
    const failed = await startLead(w.deps, effect(issue))
    expect(failed).toEqual({ ok: false, error: portError('timeout', 'hc timed out') })
    expect(await events(issue, 'lead_started')).toHaveLength(0)

    w.terminals.startError = null
    expect((await startLead(w.deps, effect(issue))).ok).toBe(true)
    expect(w.worktrees.created).toHaveLength(1)
    expect(w.terminals.started).toHaveLength(1)
  })

  test('a refusal that retrying cannot fix is the lead gone, with the reason', async () => {
    const issue = await w.admitted()
    w.repoError = portError('refused', 'repo example is not inside the allowed roots')
    expect((await startLead(w.deps, effect(issue))).ok).toBe(true)
    expect(w.terminals.started).toHaveLength(0)
    const [gone] = await events(issue, 'lead_gone')
    expect(gone?.payload).toEqual({ attempt: 1, detail: 'repo example is not inside the allowed roots' })
    const [row] = await w.db.sql`SELECT state FROM factory.issues WHERE id = ${issue}`
    expect(row?.state).toBe('queued')
  })

  test('a start that has outlived its budget is the lead gone', async () => {
    const issue = await w.admitted()
    w.terminals.startError = portError('timeout', 'hc timed out')
    expect((await startLead(w.deps, effect(issue))).ok).toBe(false)
    w.clock.advance(31 * 60_000)
    expect((await startLead(w.deps, effect(issue))).ok).toBe(true)
    const [gone] = await events(issue, 'lead_gone')
    expect(JSON.stringify(gone?.payload)).toContain('did not work in time')
  })

  test('an Issue that closed meanwhile gets no lead', async () => {
    const issue = await w.admitted()
    await w.event(issue, 'cancel', { kind: 'cancelled', payload: { reason: 'no longer needed' }, actor: 'owner' })
    expect((await startLead(w.deps, effect(issue))).ok).toBe(true)
    expect(w.worktrees.created).toHaveLength(0)
    expect(w.terminals.started).toHaveLength(0)
  })

  test("the next attempt's brief carries the previous attempt's kept work", async () => {
    const issue = await w.admitted()
    await startLead(w.deps, effect(issue))
    await w.event(issue, 'gone:1', {
      kind: 'lead_gone',
      payload: { attempt: 1, detail: 'its terminal was lost' },
      actor: 'factory',
    })
    await w.db.sql`
      INSERT INTO factory.lead_finalizations (issue_id, attempt, worktree_kept, worktree_path, done_at)
      VALUES (${issue}, 1, 'it has uncommitted changes', '/w/factory-1-1', now())`
    await w.event(issue, 'admitted:2', { kind: 'admitted', payload: {}, actor: 'factory' })
    await startLead(w.deps, effect(issue, 2))
    const second = w.terminals.started.at(-1)
    expect(second?.key).toBe('lead-1-2')
    expect(second?.prompt).toContain('The previous attempt')
    expect(second?.prompt).toContain('it has uncommitted changes')
    expect(second?.prompt).toContain('its terminal was lost')
  })
})
