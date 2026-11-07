import { afterAll, beforeAll, expect, test } from 'bun:test'
import { existsSync, realpathSync } from 'node:fs'
import { type LeadsWorld, startLeadsWorld } from './support.ts'

let w: LeadsWorld

beforeAll(async () => {
  w = await startLeadsWorld()
})

afterAll(async () => {
  await w.stop()
})

test('start: admitted runs start_lead; the fake hc shows one terminal with its key; lead_started is recorded', async () => {
  const issue = await w.admitted('the probe on /health fails')
  const tick = await w.tick()
  expect(tick.outbox).toEqual({ ran: 1, failed: 0 })

  const terminals = w.terminals()
  expect(terminals).toHaveLength(1)
  const [terminal] = terminals
  expect(terminal?.labels['factory.key']).toBe('lead-1-1')
  expect(terminal?.argv.slice(0, 6)).toEqual([
    'claude',
    '--dangerously-skip-permissions',
    '--model',
    'sonnet',
    '--effort',
    'high',
  ])
  const brief = terminal?.argv.at(-1) ?? ''
  expect(brief).toContain('# Operating contract')
  expect(brief).toContain('attempt 1 of Issue 1')
  expect(brief).toContain('the probe on /health fails')
  expect(terminal?.env.FACTORY_SESSION).toBe('lead-1-1')
  // The lead works in its own worktree of the repo, on its branch.
  expect(terminal?.cwd).toBe(`${realpathSync(w.repo)}/.claude/worktrees/factory-1-1`)
  expect(existsSync(`${terminal?.cwd}/README.md`)).toBe(true)

  const [started] = await w.world.db.sql`
    SELECT version, payload FROM factory.issue_events WHERE issue_id = ${issue} AND kind = 'lead_started'`
  expect(started?.payload).toEqual({ attempt: 1, terminal: terminal?.address })
  const [effect] = await w.world.db
    .sql`SELECT done_at FROM factory.issue_effects WHERE key = ${`start_lead:${issue}:1`}`
  expect(effect?.done_at).not.toBeNull()

  const lead = await w.cli(['lead', 'get', issue])
  expect(lead.code).toBe(0)
  expect(JSON.parse(lead.out)).toMatchObject({ attempt: 1, key: 'lead-1-1', state: 'starting', turns: 0 })
})

test('the same tick again starts nothing twice', async () => {
  const before = await w.world.db.sql`SELECT count(*)::int AS n FROM factory.issue_events`
  await w.tick()
  await w.tick()
  expect(w.terminals()).toHaveLength(1)
  const after = await w.world.db.sql`SELECT count(*)::int AS n FROM factory.issue_events`
  expect(after).toEqual(before)
})
