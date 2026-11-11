import { afterAll, beforeAll, expect, test } from 'bun:test'
import { AdmitAnswer } from '@software-factory/contract'
import { type Lab, startLab } from '../planning/lab.ts'

/**
 * The seats an idle host adds: one lead per account, five minute samples seeded, work queued behind the cap. The host
 * loop is kept from writing samples of its own.
 */
let lab: Lab

beforeAll(async () => {
  lab = await startLab({
    repos: { wide: { project: 'apiVersion: factory/v2\nname: wide\nleads: 4\n' } },
    accounts: [{ id: 'a' }],
    env: { FACTORY_LEADS_PER_ACCOUNT: '1', FACTORY_LOOP_HOST_MS: '3600000' },
  })
  expect((await lab.cli(['project', 'sync'])).code).toBe(0)
})

afterAll(async () => {
  await lab.stop()
})

const sql = () => lab.world.db.sql
const queued = async (title: string) => {
  const issue = await lab.file('wide', title)
  expect((await lab.cli(['planning', 'settle', '--body', JSON.stringify({ issue, after: [] })])).code).toBe(0)
  return issue
}
/** The picker is polled once a minute and an account takes one new lead per sample: every pass follows a poll. */
const admit = async () => {
  expect((await lab.cli(['capacity', 'refresh'])).code).toBe(0)
  const result = await lab.cli(['capacity', 'admit'])
  expect(result.code).toBe(0)
  return AdmitAnswer.parse(result.json)
}

/** Replaces the host samples by `rows`, one per minute ending now. */
const hostSamples = async (rows: { load: number }[]) => {
  await sql()`DELETE FROM factory.host_samples`
  for (const [index, row] of rows.entries()) {
    const ago = rows.length - 1 - index
    await sql()`
      INSERT INTO factory.host_samples (at, load, memory_used_pct, swap_used_pct, swapout_mb_per_300s)
      VALUES (now() - ${ago} * interval '1 minute', ${row.load}, 20, 10, 0)`
  }
}

test('an idle host adds a seat for queued work; one busy minute among the five does not', async () => {
  const [one, two] = [await queued('first lead'), await queued('second lead')]
  const idle = { load: 1 }
  await hostSamples([idle, idle, { load: 40 }, idle, idle])
  expect((await admit()).admitted.map((a) => a.issue)).toEqual([one])

  const held = await admit()
  expect(held.admitted).toEqual([])
  const reason = held.queue.find((e) => e.issue === two)?.reason
  expect(reason?.kind).toBe('cap')
  expect(reason?.message).not.toContain('raised')

  await hostSamples([idle, idle, idle, idle, idle])
  const raised = await admit()
  expect(raised.admitted.map((a) => a.issue)).toEqual([two])
}, 60_000)

test('the raise is seats, not a release: a third lead stays queued and the reason names the raise', async () => {
  const third = await queued('third lead')
  await hostSamples([1, 1, 1, 1, 1].map((load) => ({ load })))
  const closed = await admit()
  expect(closed.admitted).toEqual([])
  const reason = closed.queue.find((e) => e.issue === third)?.reason
  expect(reason?.kind).toBe('cap')
  expect(reason?.message).toContain('(raised by 1: the host is idle)')
}, 60_000)
