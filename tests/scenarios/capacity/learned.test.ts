import { afterAll, beforeAll, expect, test } from 'bun:test'
import { AdmitAnswer } from '@software-factory/contract'
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
  // four past attempts of the heavy repo, peaks 14000..18000 MiB (p80 18000), three of the small one at 400 MiB
  for (const [index, peak] of [14_000, 15_000, 16_000, 18_000].entries()) {
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
  const answer = await admit()
  expect(answer.admitted.map((a) => a.issue)).toEqual([light])
  expect(reasonOf(answer, second)).toMatchObject({
    kind: 'memory',
    message:
      `memory: a lead of heavy takes ~17.6 GiB (p80 of 4 past leads), the host has 16 GiB free, ` + 'headroom 2.6 GiB',
  })
}, 60_000)
