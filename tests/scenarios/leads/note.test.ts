import { afterAll, beforeAll, expect, test } from 'bun:test'
import { type LeadsWorld, startLeadsWorld } from './support.ts'

let w: LeadsWorld
let issue = ''

beforeAll(async () => {
  w = await startLeadsWorld()
  issue = await w.admitted()
  await w.tick()
})

afterAll(async () => {
  await w.stop()
})

test("note: an owner signal's noted reaches the lead once, also when the outbox runs twice", async () => {
  const noted = await w.record(issue, 'note:1', 'noted', { text: 'use the staging database, not production' }, 'owner')
  expect(noted).toMatchObject({ result: 'applied', issue: { state: 'working' }, effects: [{ kind: 'note_lead' }] })

  expect((await w.tick()).outbox).toEqual({ ran: 1, failed: 0 })
  expect((await w.tick()).outbox).toEqual({ ran: 0, failed: 0 })

  const [terminal] = w.terminals()
  expect(terminal?.sent).toHaveLength(1)
  expect(terminal?.sent[0]).toStartWith('Factory, Issue 1:')
  expect(terminal?.sent[0]).toContain('use the staging database, not production')
  expect(terminal?.sent[0]).not.toContain('\n')
})

test('a note the lead is told while it works reaches it once more only for another note', async () => {
  await w.record(issue, 'note:2', 'noted', { text: 'and keep the change small' }, 'owner')
  await w.tick()
  await w.tick()
  const [terminal] = w.terminals()
  expect(terminal?.sent).toHaveLength(2)
  expect(terminal?.sent[1]).toContain('and keep the change small')
  expect(terminal?.sent[1]).not.toContain('staging')
})
