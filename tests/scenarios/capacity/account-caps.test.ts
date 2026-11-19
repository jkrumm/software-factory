import { afterAll, beforeAll, expect, test } from 'bun:test'
import { AdmitAnswer, CapacityView } from '@software-factory/contract'
import { type Lab, startLab } from '../planning/lab.ts'

/**
 * Seats per account and the package's windows: an account with no 5-hour window takes leads up to its
 * own cap in one pass, one with a window above 70 % takes one per sample, and whether an account is open at all is the
 * package's verdict (its weekly ceiling, not a limit of the factory). The caps are `FACTORY_ACCOUNT_LEADS`.
 */
let lab: Lab

beforeAll(async () => {
  lab = await startLab({
    repos: { wide: { project: 'apiVersion: factory/v2\nname: wide\nleads: 40\n' } },
    accounts: [
      { id: 'iu', five_hour: null, seven_day: 25 },
      { id: 'me', five_hour: 40, seven_day: 40 },
    ],
    env: {
      FACTORY_ACCOUNT_LEADS: 'iu=5,me=2',
      FACTORY_LEADS_PER_ACCOUNT: '1',
      FACTORY_SEATS_MAX_BONUS: '0',
      FACTORY_LOOP_HOST_MS: '3600000',
    },
  })
  expect((await lab.cli(['project', 'sync'])).code).toBe(0)
})

afterAll(async () => {
  await lab.stop()
})

const queued = async (title: string) => {
  const issue = await lab.file('wide', title)
  expect((await lab.cli(['planning', 'settle', '--body', JSON.stringify({ issue, after: [] })])).code).toBe(0)
  return issue
}
/** The picker is polled once a minute: every pass follows a poll. */
const admit = async () => {
  expect((await lab.cli(['capacity', 'refresh'])).code).toBe(0)
  const result = await lab.cli(['capacity', 'admit'])
  expect(result.code).toBe(0)
  return AdmitAnswer.parse(result.json)
}
const cancel = async (issues: string[]) => {
  for (const issue of issues) expect((await lab.cli(['issue', 'cancel', issue, '--reason', 'done'])).code).toBe(0)
}
const view = async () => CapacityView.parse((await lab.cli(['capacity', 'get'])).json)

test('two accounts take leads up to their own cap in one pass; the refusal names each account and its cap', async () => {
  const issues: string[] = []
  for (let n = 1; n <= 9; n++) issues.push(await queued(`lead ${n}`))
  const pass = await admit()
  // iu has no 5-hour window (no pacing) and the most room, so it fills first; me (a window at 40 %) is not paced either
  const byAccount = (account: string) => pass.admitted.filter((a) => a.account === account).length
  expect([byAccount('iu'), byAccount('me')]).toEqual([5, 2])
  const last = pass.queue.find((e) => e.issue === issues[8])?.reason
  expect(last?.kind).toBe('cap')
  expect(last?.message).toContain('iu 5 of 5, me 2 of 2')
  const seen = await view()
  expect(seen.accounts.filter((a) => a.account !== 'spare').map((a) => [a.account, a.leads, a.cap])).toEqual([
    ['iu', 5, 5],
    ['me', 2, 2],
  ])
  await cancel(issues)
}, 90_000)

test('a window above 70 % takes one lead per sample; with no window an account takes the rest at once', async () => {
  await lab.accounts([
    { id: 'iu', five_hour: 80, seven_day: 20 },
    { id: 'me', enabled: false },
  ])
  const issues = [await queued('one'), await queued('two'), await queued('three')]
  expect((await admit()).admitted).toHaveLength(1)
  expect((await admit()).admitted).toHaveLength(1)
  await cancel(issues)
  await lab.accounts([
    { id: 'iu', five_hour: null, seven_day: 20 },
    { id: 'me', enabled: false },
  ])
  const more = [await queued('four'), await queued('five'), await queued('six')]
  expect((await admit()).admitted).toHaveLength(3)
  await cancel(more)
}, 90_000)

test("an account below the package's weekly ceiling takes a lead; at it the package closes it and the refusal says so", async () => {
  await lab.accounts([
    { id: 'iu', five_hour: null, seven_day: 90 },
    { id: 'me', enabled: false },
  ])
  const issue = await queued('late in the week')
  expect((await admit()).admitted.map((a) => a.account)).toEqual(['iu'])
  await cancel([issue])
  // the ceiling is the package's rule (95 % of the week until the last day), not a setting of the factory
  await lab.accounts([
    { id: 'iu', five_hour: null, seven_day: 96 },
    { id: 'me', enabled: false },
  ])
  const refused = await queued('at the ceiling')
  const pass = await admit()
  expect(pass.admitted).toEqual([])
  const reason = pass.queue.find((e) => e.issue === refused)?.reason
  expect(reason?.kind).toBe('window')
  expect(reason?.message).toContain('weekly at 96')
  await cancel([refused])
}, 90_000)
