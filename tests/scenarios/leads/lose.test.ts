import { afterAll, beforeAll, expect, test } from 'bun:test'
import { join } from 'node:path'
import { statePathOf, withState } from '../fakes/hc-state.ts'
import { type LeadsWorld, startLeadsWorld } from './support.ts'

let w: LeadsWorld

beforeAll(async () => {
  w = await startLeadsWorld()
})

afterAll(async () => {
  await w.stop()
})

/** The lead's terminal ends, as if its process died: the core keeps it finished. */
const kill = (address: string) =>
  withState(statePathOf(join(w.world.bin, 'calls.jsonl')), (state) => {
    const terminal = state.terminals[address]
    if (!terminal) throw new Error(`no terminal ${address}`)
    terminal.state = 'finished'
    terminal.status = null
    terminal.exit_code = 137
  })

test('lose a terminal: lead_gone, a new attempt up to the limit, then a stall', async () => {
  const issue = await w.admitted()
  await w.tick()

  for (const attempt of [1, 2]) {
    const live = w.terminals().filter((t) => t.state === 'live' && t.labels['factory.key'] === `lead-1-${attempt}`)
    expect(live).toHaveLength(1)
    await kill(live[0]?.address ?? '')
    const tick = await w.tick()
    expect(tick.lost).toBe(1)

    const [row] = await w.world.db.sql`SELECT state FROM factory.issues WHERE id = ${issue}`
    expect(row?.state).toBe('queued')
    // Capacity admits the next attempt (package 3); the next tick starts its lead.
    await w.record(issue, `admitted:${attempt + 1}`, 'admitted', {}, 'factory')
    await w.tick()
    expect(
      w.terminals().filter((t) => t.labels['factory.key'] === `lead-1-${attempt + 1}` && t.state === 'live'),
    ).toHaveLength(1)
  }

  // The third lead is lost: no new attempt, a stall the steward ends.
  const third = w.terminals().find((t) => t.labels['factory.key'] === 'lead-1-3' && t.state === 'live')
  await kill(third?.address ?? '')
  await w.tick()
  const [stalled] = await w.world.db.sql`SELECT state, wait_reason FROM factory.issues WHERE id = ${issue}`
  expect(stalled).toEqual({ state: 'waiting', wait_reason: 'lead_gone' })

  const gone = await w.world.db.sql`
    SELECT payload->>'attempt' AS attempt FROM factory.issue_events WHERE issue_id = ${issue} AND kind = 'lead_gone' ORDER BY version`
  expect(gone.map((row: { attempt: string }) => row.attempt)).toEqual(['1', '2', '3'])
  // Finalizing the first two lost attempts took their terminals away. The third is a stall, not a restart: the steward's
  // wake (package 7) finalizes it, so its finished terminal waits.
  await w.tick()
  const left = w.terminals().filter((t) => t.labels['factory.key']?.startsWith('lead-1-'))
  expect(left.map((t) => [t.labels['factory.key'], t.state])).toEqual([['lead-1-3', 'finished']])
})

test('a lead that cannot start (a repo outside the roots) is gone at once, with the reason', async () => {
  const filed = await w.post('/internal/test/issues', {
    key: 'filed:outside',
    kind: 'filed',
    payload: { repo: '/etc', title: 'outside', kind: 'chore', origin: 'you' },
    actor: 'factory',
  })
  const issue = filed.issue.id
  await w.record(issue, 'settled', 'settled', {}, 'factory')
  await w.record(issue, 'admitted:1', 'admitted', {}, 'factory')
  await w.tick()
  const [event] = await w.world.db.sql`
    SELECT payload->>'detail' AS detail FROM factory.issue_events WHERE issue_id = ${issue} AND kind = 'lead_gone'`
  expect(event?.detail).toContain('allowed roots')
  expect(w.terminals().filter((t) => t.labels['factory.key'] === 'lead-2-1')).toHaveLength(0)
})
