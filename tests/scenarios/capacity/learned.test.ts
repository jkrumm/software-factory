import { afterAll, beforeAll, expect, test } from 'bun:test'
import { AdmitAnswer } from '@software-factory/contract'
import { TOKENS } from '../harness.ts'
import { type Lab, startLab } from '../planning/lab.ts'

/**
 * Admission by what a repo's lead has been seen to take (the learned fit). The host sample and the lead samples are
 * seeded rows, with the project name as `repo` as the host loop writes it (`loop-closes.test.ts` runs the host loop itself); the host loop is kept from writing its own.
 */
let lab: Lab

beforeAll(async () => {
  lab = await startLab({
    repos: {
      heavy: { project: 'apiVersion: factory/v2\nname: heavy\nleads: 3\n' },
      small: { project: 'apiVersion: factory/v2\nname: small\nleads: 3\n' },
    },
    accounts: [{ id: 'a' }, { id: 'b' }],
    env: { FACTORY_LEADS_PER_ACCOUNT: '16', FACTORY_LOOP_HOST_MS: '3600000' },
  })
  expect((await lab.cli(['project', 'sync'])).code).toBe(0)
})

afterAll(async () => {
  await lab.stop()
})

const sql = () => lab.world.db.sql
const settle = async (issue: string) => {
  expect((await lab.cli(['planning', 'settle', '--body', JSON.stringify({ issue, after: [] })])).code).toBe(0)
}
const queued = async (repo: string, title: string) => {
  const issue = await lab.file(repo, title)
  await settle(issue)
  return issue
}
/** The picker is polled once a minute and an account takes one new lead per sample: every pass follows a poll. */
const admit = async () => {
  expect((await lab.cli(['capacity', 'refresh'])).code).toBe(0)
  const result = await lab.cli(['capacity', 'admit'])
  expect(result.code).toBe(0)
  return AdmitAnswer.parse(result.json)
}
const reasonOf = (answer: AdmitAnswer, issue: string) => answer.queue.find((e) => e.issue === issue)?.reason

/** Replaces the host samples by `rows`, newest last, one per minute ending now. */
const hostSamples = async (rows: { load: number; used: number; swap?: number }[]) => {
  await sql()`DELETE FROM factory.host_samples`
  for (const [index, row] of rows.entries()) {
    const ago = rows.length - 1 - index
    await sql()`
      INSERT INTO factory.host_samples (at, load, memory_used_pct, swap_used_pct, swapout_mb_per_300s)
      VALUES (now() - ${ago} * interval '1 minute', ${row.load}, ${row.used}, ${row.swap ?? 10}, 0)`
  }
}

test('a heavy repo whose second lead would not fit stays queued with the numbers, a small repo is admitted', async () => {
  // seven past attempts of the heavy repo, peaks 14000, 15000, 16000, then four of 18000 MiB (median 18000; the newest three, 14000..16000, all below it: the figure falls to 16000), three of the small one at 400 MiB
  for (const [index, peak] of [14_000, 15_000, 16_000, 18_000, 18_000, 18_000, 18_000].entries()) {
    await sql()`
      INSERT INTO factory.lead_samples (at, worktree, repo, issue, attempt, rss_mib, procs)
      VALUES (now() - ${index + 1} * interval '1 day', ${`/wt/heavy-${index}`}, ${'heavy'}, ${9000 + index}, 1, ${peak}, 5)`
  }
  for (const index of [0, 1, 2]) {
    await sql()`
      INSERT INTO factory.lead_samples (at, worktree, repo, issue, attempt, rss_mib, procs)
      VALUES (now() - ${index + 1} * interval '1 day', ${`/wt/small-${index}`}, ${'small'}, ${9100 + index}, 1, 400, 2)`
  }
  // 32 GiB, 50 % in use
  await hostSamples([{ load: 1, used: 50 }])

  const first = await queued('heavy', 'the lone heavy lead')
  expect((await admit()).admitted.map((a) => a.issue)).toEqual([first])

  const second = await queued('heavy', 'a second heavy lead')
  const light = await queued('small', 'a small lead')
  // the lone lead is minutes old and holds nothing yet: it is still learned to take its 15.6 GiB, which the sample does not show
  const early = await admit()
  expect(early.admitted).toEqual([])
  expect(reasonOf(early, light)).toMatchObject({
    kind: 'memory',
    message: expect.stringContaining('the host has 16 GiB free, of which 1 young lead still takes 15.6 GiB more'),
  })
  // past 30 minutes its figure counts as settled: the sample is believed
  await sql()`UPDATE factory.capacity_claims SET taken_at = now() - interval '40 minutes'`
  const answer = await admit()
  expect(answer.admitted.map((a) => a.issue)).toEqual([light])
  expect(reasonOf(answer, second)).toMatchObject({
    kind: 'memory',
    message:
      `memory: a lead of heavy takes ~15.6 GiB outside test slots (the largest of the newest 3 settled leads, all below the median of 17.6 GiB), the host has 16 GiB free, ` +
      // the small lead admitted in this pass is young and takes its 400 MiB before the sample shows it
      'of which 1 young lead still takes 0.4 GiB more, headroom 2.6 GiB',
  })
}, 60_000)

test('a relearn point drops the repo to its lane prior, queue order says so, and a point in the future is refused', async () => {
  // the heavy repo's second lead is held by the 15.6 GiB figure of the test above
  const held = (await lab.cli(['queue', 'order'])).json as {
    queue: { issue: string; reason: { kind: string } | null }[]
  }
  expect(held.queue.find((e) => e.reason?.kind === 'memory')).toBeDefined()

  const set = await lab.cli(['capacity', 'relearn', '--repo', 'heavy'])
  expect(set.code).toBe(0)
  expect(set.json).toMatchObject({ repo: 'heavy', setBy: 'owner' })

  // no attempt follows the point: fewer than three, so no learned figure and the lane's prior (none declared) lets it in
  const order = (await lab.cli(['queue', 'order'])).json as {
    queue: { reason: { kind: string } | null }[]
    notes: string[]
  }
  expect(order.queue.some((e) => e.reason?.kind === 'memory')).toBe(false)
  expect(order.notes.some((n) => n.startsWith('heavy: lead cost learned from after the relearn point'))).toBe(true)
  expect((await admit()).admitted).toHaveLength(1)

  const future = await lab.cli(['capacity', 'relearn', '--repo', 'heavy', '--at', '2999-01-01T00:00:00Z'])
  expect(future.code).not.toBe(0)

  // a lead's token may set a point too (an Issue's own ship step), recorded as the agent, but not admit
  const lead = await lab.cli(['capacity', 'relearn', '--repo', 'small'], { FACTORY_TOKEN: TOKENS.agent })
  expect(lead.code).toBe(0)
  expect(lead.json).toMatchObject({ repo: 'small', setBy: 'agent' })
  expect((await lab.cli(['capacity', 'admit'], { FACTORY_TOKEN: TOKENS.agent })).code).toBe(3)
}, 60_000)
