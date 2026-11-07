import { afterAll, beforeAll, expect, test } from 'bun:test'
import { AdmitAnswer, CapacityView, QueueOrder } from '@software-factory/contract'
import { type Lab, startLab } from '../planning/lab.ts'

/**
 * Admission through the CLI a person or the tick would use: `factory capacity admit`, `factory queue order`. The repos
 * are real git repos under a repo root, the picker and `sysctl` are fakes, the server is the real process.
 */
let lab: Lab

beforeAll(async () => {
  lab = await startLab({
    repos: {
      duo: { project: 'apiVersion: factory/v2\nname: duo\nleads: 2\n' },
      mem: { project: 'apiVersion: factory/v2\nname: mem\n' },
      swap: { project: 'apiVersion: factory/v2\nname: swap\n' },
      solo: { project: 'apiVersion: factory/v2\nname: solo\n' },
      ordered: { project: 'apiVersion: factory/v2\nname: ordered\n' },
    },
    accounts: [{ id: 'a' }, { id: 'b' }],
    // the lead cap per account is unit-tested; here it would couple the scenarios through the accounts
    env: { FACTORY_LEADS_PER_ACCOUNT: '16' },
  })
  const synced = await lab.cli(['project', 'sync'])
  expect(synced.code).toBe(0)
})

afterAll(async () => {
  await lab.stop()
})

const settle = async (issue: string, after: string[] = []) => {
  const result = await lab.cli(['planning', 'settle', '--body', JSON.stringify({ issue, after })])
  expect(result.code).toBe(0)
}
/** The picker is polled once a minute, and an account takes one new lead per sample: every pass here follows a poll. */
const admit = async () => {
  expect((await lab.cli(['capacity', 'refresh'])).code).toBe(0)
  const result = await lab.cli(['capacity', 'admit'])
  expect(result.code).toBe(0)
  return AdmitAnswer.parse(result.json)
}
const order = async () => {
  const result = await lab.cli(['queue', 'order'])
  expect(result.code).toBe(0)
  return QueueOrder.parse(result.json).queue
}
const stateOf = async (issue: string) => {
  const [row] = await lab.world.db.sql`SELECT state FROM factory.issues WHERE id = ${issue}`
  return row?.state as string
}
const close = async (issue: string, attempt = 1) => {
  await lab.event(issue, 'lead_started', 'lead_started', { attempt, terminal: `t-${issue}` })
  await lab.event(issue, 'closed', 'closed', { attempt, outcome: 'done', reason: 'done' }, 'lead')
}

test('leads: 2 admits two leads in one repo, a third waits for a claim and is admitted when one closes', async () => {
  const [one, two, three] = [
    await lab.file('duo', 'first'),
    await lab.file('duo', 'second'),
    await lab.file('duo', 'third'),
  ]
  for (const issue of [one, two, three]) await settle(issue)

  const first = await admit()
  expect(first.admitted.map((a) => [a.issue, a.attempt])).toEqual([
    [one, 1],
    [two, 1],
  ])
  expect(new Set(first.admitted.map((a) => a.account))).toEqual(new Set(['a', 'b']))
  expect(first.queue.find((e) => e.issue === three)?.reason).toMatchObject({
    kind: 'claim',
    message: `no claim free in the repo: the repo runs 2 of 2 leads (Issue 1, Issue 2)`,
  })
  expect([await stateOf(one), await stateOf(two), await stateOf(three)]).toEqual(['working', 'working', 'queued'])

  // a second pass starts nothing twice
  expect((await admit()).admitted).toEqual([])
  const effects = await lab.world.db.sql`SELECT key FROM factory.issue_effects WHERE kind = 'start_lead' ORDER BY key`
  expect(effects.map((e: { key: string }) => e.key)).toEqual([`start_lead:${one}:1`, `start_lead:${two}:1`])

  await close(one)
  const second = await admit()
  expect(second.admitted.map((a) => a.issue)).toEqual([three])
  expect(await stateOf(three)).toBe('working')

  const capacity = CapacityView.parse((await lab.cli(['capacity', 'get'])).json)
  expect(capacity.claims.map((s) => s.issue).sort()).toEqual([two, three].sort())
  expect(capacity.accounts.map((a) => [a.account, a.open])).toEqual([
    ['a', true],
    ['b', true],
  ])
})

test('a memory ceiling keeps a queued Issue out; the reason says memory and the numbers; it goes when memory recovers', async () => {
  const issue = await lab.file('mem', 'needs memory')
  await settle(issue)
  await lab.memory({ swapUsedMb: 32_768 }) // as much swap as there is RAM (32 GiB)
  const held = await admit()
  expect(held.admitted).toEqual([])
  const entry = held.queue.find((e) => e.issue === issue)
  expect(entry?.reason?.kind).toBe('memory')
  expect(entry?.reason?.message).toBe(
    'the host is short of memory: swapouts 0 MiB/300s (ceiling 2048), swap 100% of RAM (ceiling 75%)',
  )
  expect(await stateOf(issue)).toBe('queued')
  // `factory queue order` says the same without admitting anything
  expect((await order()).find((e) => e.issue === issue)?.reason?.kind).toBe('memory')

  await lab.memory({ swapUsedMb: 2048 })
  expect((await admit()).admitted.map((a) => a.issue)).toEqual([issue])
})

test('a swapout rate over its ceiling keeps it out too, from two readings of the counter', async () => {
  await lab.memory({ swapUsedMb: 1024, swapouts: 1000 })
  await admit() // the first reading has no rate
  await Bun.sleep(1200)
  // 1,000,000 pages of 16 KiB in about a second: far over 2 GiB per 300 s
  await lab.memory({ swapUsedMb: 1024, swapouts: 1_001_000 })
  const issue = await lab.file('swap', 'swapping')
  await settle(issue)
  const reason = (await admit()).queue.find((e) => e.issue === issue)?.reason
  expect(reason?.kind).toBe('memory')
  expect(reason?.message).toMatch(/^the host is short of memory: swapouts \d+ MiB\/300s \(ceiling 2048\)/)
  // the counter stands still: no new swapouts, the rate drops back to zero
  await Bun.sleep(1200)
  const last = await admit()
  expect(last.admitted.map((a) => a.issue)).toEqual([issue])
})

test('stop the line admits only the fix in its project; other projects go on', async () => {
  await lab.accounts([{ id: 'a' }, { id: 'b' }, { id: 'c' }])
  const feature = await lab.file('solo', 'a feature while production is red')
  const fix = await lab.file('solo', 'production is down', 'incident')
  const elsewhere = await lab.file('ordered', 'unrelated')
  for (const issue of [feature, fix, elsewhere]) await settle(issue)
  const result = await admit()
  expect(result.admitted.map((a) => a.issue)).toEqual([fix, elsewhere])
  expect(await stateOf(feature)).toBe('queued')
  expect(result.queue.find((e) => e.issue === feature)?.reason).toMatchObject({
    kind: 'line',
    message: expect.stringContaining('production of solo is red'),
  })
})

test('prio orders the queue before age, and never an incident behind it', async () => {
  await lab.cli(['queue', 'set', '--body', JSON.stringify({ project: 'ordered', state: 'drain' })])
  const old = await lab.file('ordered', 'old')
  const urgent = await lab.file('ordered', 'urgent to the owner')
  for (const issue of [old, urgent]) await settle(issue)
  const prio = await lab.cli([
    'planning',
    'prio',
    '--body',
    JSON.stringify({ issue: urgent, value: 100, key: 'owner-1' }),
  ])
  expect(prio).toMatchObject({ code: 0, json: { issue: urgent, value: 100, recorded: true } })
  const again = await lab.cli([
    'planning',
    'prio',
    '--body',
    JSON.stringify({ issue: urgent, value: 100, key: 'owner-1' }),
  ])
  expect(again.json).toMatchObject({ recorded: false })
  const queue = (await order()).filter((e) => e.project === 'ordered' && e.reason?.kind === 'drain')
  expect(queue.map((e) => [e.issue, e.prio])).toEqual([
    [urgent, 100],
    [old, 0],
  ])
  const states = await lab.cli(['queue', 'get'])
  expect(states.json).toMatchObject({ global: 'run', projects: { ordered: 'drain' } })
})

test('admitting called neither hc nor agw', async () => {
  expect(await lab.world.calls()).toEqual([])
})
