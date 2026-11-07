import { afterAll, beforeAll, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { admit, fileIssue, killTerminal, runLoop, admitted } from '../flow.ts'
import { startServer } from '../harness.ts'
import { type LeadsWorld, startLeadsWorld } from './support.ts'

let w: LeadsWorld

beforeAll(async () => {
  w = await startLeadsWorld()
})

afterAll(async () => {
  await w.stop()
})

test('lose a terminal: lead_gone, a new attempt up to the limit, then a stall', async () => {
  const issue = await w.admitted()
  await w.tick()

  for (const attempt of [1, 2]) {
    const live = w.terminals().filter((t) => t.state === 'live' && t.labels['factory.key'] === `lead-1-${attempt}`)
    expect(live).toHaveLength(1)
    await killTerminal(w.world, live[0]?.address ?? '')
    const tick = await w.tick()
    expect(tick.lost).toBe(1)

    const [row] = await w.world.db.sql`SELECT state FROM factory.issues WHERE id = ${issue}`
    expect(row?.state).toBe('queued')
    // Capacity admits the next attempt; the next tick starts its lead.
    expect((await admit(w)).admitted.map((a) => [a.issue, a.attempt])).toEqual([[issue, attempt + 1]])
    await w.tick()
    expect(
      w.terminals().filter((t) => t.labels['factory.key'] === `lead-1-${attempt + 1}` && t.state === 'live'),
    ).toHaveLength(1)
  }

  // The third lead is lost: no new attempt, a stall the steward ends.
  const third = w.terminals().find((t) => t.labels['factory.key'] === 'lead-1-3' && t.state === 'live')
  await killTerminal(w.world, third?.address ?? '')
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

test('a lead that cannot start (a repo that left the roots) is gone at once, with the reason', async () => {
  const issue = await fileIssue(w, { repo: 'example', title: 'outside' })
  await admitted(w, issue)
  // The same database under a server whose allowed roots no longer hold the repo.
  await w.server.stop()
  const elsewhere = await mkdtemp('/tmp/factory-elsewhere-')
  const later = await startServer(w.world, { env: { FACTORY_REPO_ROOTS: elsewhere, FACTORY_GRACE_MS: '0' } })
  try {
    await runLoop({ world: w.world, server: later }, 'leads')
  } finally {
    await later.stop()
    await rm(elsewhere, { recursive: true, force: true })
  }
  const [event] = await w.world.db.sql`
    SELECT payload->>'detail' AS detail FROM factory.issue_events WHERE issue_id = ${issue} AND kind = 'lead_gone'`
  expect(event?.detail).toContain('allowed roots')
  expect(w.terminals().filter((t) => t.labels['factory.key'] === 'lead-2-1')).toHaveLength(0)
})
