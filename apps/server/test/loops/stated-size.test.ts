import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test'
import type { TriageAnswer, TriageRequest } from '@software-factory/contract'
import { postgresCapacityStore } from '../../src/adapters/postgres/capacity-store.ts'
import { postgresLoopStore } from '../../src/adapters/postgres/loop-store.ts'
import { postgresPlanningStore } from '../../src/adapters/postgres/planning-store.ts'
import { postgresUnitOfWork } from '../../src/adapters/postgres/unit-of-work.ts'
import { postgresWorkStore } from '../../src/adapters/postgres/work-store.ts'
import { fileIssue, recordIssueEvent } from '../../src/app/issues.ts'
import { triagePass, type TriageDeps } from '../../src/app/loops/triage.ts'
import { addAfter } from '../../src/app/planning-chain.ts'
import { planningPass } from '../../src/app/planning-pass.ts'
import { syncProjects } from '../../src/app/planning-sync.ts'
import type { IssueId } from '../../src/kernel/ids.ts'
import { key } from '../../src/kernel/keys.ts'
import { ok } from '../../src/kernel/result.ts'
import { loopReads } from '../../src/read/loops.ts'
import { readIssues } from '../../src/read/planning.ts'
import { lightRule } from '../../src/domains/leads/light.ts'
import { readLeadSeats, type SeatTable } from '../../src/read/seats.ts'
import { startWorld, value, type World } from '../planning/support.ts'
import { fakeAgw } from '../support/agw.ts'

/**
 * NL51: an Issue whose filer stated its edges (`--alone`, `--after`, a plan row) is still asked for its size, so the light
 * seat's rule can reach it, and its planned seat says what the rule names for it before a lead starts.
 */
let world: World
let requests: Extract<TriageRequest, { mode: 'settle' }>[] = []
// what the model says: "small" for the mechanical edits, and it names an edge it was never shown and a Spec it was not asked for
const answer = (request: Extract<TriageRequest, { mode: 'settle' }>): TriageAnswer => ({
  amend: null,
  after: ['issue_1'],
  kind: null,
  size: /three|rename/i.test(request.issue.text + request.issue.title) ? 'small' : 'large',
  checkpoint: 'spec',
  reason: 'sized',
})

beforeAll(async () => {
  world = await startWorld()
})
afterAll(async () => {
  await world.stop()
})
beforeEach(async () => {
  await world.reset()
  requests = []
})

const uow = () =>
  postgresUnitOfWork(world.db.sql, (tx) => ({
    work: postgresWorkStore(tx),
    planning: postgresPlanningStore(tx),
    capacity: postgresCapacityStore(tx),
    reads: readIssues(tx),
    loops: postgresLoopStore(tx),
    loopReads: loopReads(tx),
  }))

const triageDeps = (): TriageDeps => {
  const stores = uow()
  return {
    clock: world.deps.clock,
    ids: world.deps.ids,
    uow: stores,
    planning: { uow: stores, clock: world.deps.clock, ids: world.deps.ids },
    agw: fakeAgw({
      settle: async (request) => {
        requests.push(request)
        return ok(answer(request))
      },
    }),
    retryMs: 0,
    changed: () => {},
  }
}

/** What `issue new --alone` (or `--after`) writes: `filed` with the edges stated, then its words as the first note. */
async function fileStated(input: { title: string; text: string; after?: IssueId[] }): Promise<IssueId> {
  const n = world.deps.ids.next('signal')
  const filed = value(
    await fileIssue(world.deps, {
      key: key('filed', n),
      event: {
        kind: 'filed',
        payload: { repo: 'app', title: input.title, kind: 'feature', origin: 'you', edges: 'stated' },
        actor: 'owner',
      },
    }),
  )
  const issue = filed.issue.id
  if (input.after) value(await addAfter(world.deps, { issue, after: input.after }))
  value(
    await recordIssueEvent(world.deps, {
      issueId: issue,
      key: key('note', issue),
      event: { kind: 'noted', payload: { text: input.text }, actor: 'owner' },
    }),
  )
  return issue
}

const table = (gate: boolean): SeatTable => ({
  lead: async () => ({ tier: 'sonnet', effort: 'high' }),
  light: {
    role: 'light',
    rule: lightRule,
    row: async () => ({ tier: 'haiku', effort: 'high' }),
    gate: async () => gate,
  },
})

const settledOf = async (issue: IssueId) => {
  const [row] = await world.db.sql`
    SELECT payload FROM factory.issue_events WHERE issue_id = ${issue} AND kind = 'settled' AND result = 'applied'`
  return row?.payload as Record<string, unknown> | undefined
}
const edgesOf = async (issue: IssueId): Promise<string[]> =>
  (
    await world.db.sql`SELECT after_issue FROM factory.planning_edges WHERE issue_id = ${issue} ORDER BY after_issue`
  ).map((row: { after_issue: string }) => row.after_issue)

test('--alone: the Issue gets a size, its edges stay as stated, and its planned seat is light with the rule before any lead starts', async () => {
  const mechanical = await fileStated({
    title: 'Fix the config after the repo rename',
    text: 'what: three config and doc edits that rename the repo',
  })
  const risky = await fileStated({
    title: 'Fix the config after the repo rename, too',
    text: 'what: three edits, one of them a migration of the column',
  })

  // before triage ran: the size is not known, and the planned seat says so
  let seats = await readLeadSeats(world.db.sql, [mechanical, risky], table(true))
  expect(seats.get(mechanical)).toMatchObject({ role: 'lead', planned: true, rule: null, sizeKnown: false })

  const pass = value(await triagePass(triageDeps()))
  expect(pass).toMatchObject({ asked: 2, settled: 2, chained: 0, refused: 0 })
  // triage was shown no candidate and its words (the note, not only the title) went with the request
  expect(requests.map((request) => request.candidates)).toEqual([[], []])
  expect(requests[0]?.issue.text).toContain('three config and doc edits')

  // size and nothing else: no edge, no Spec flag
  expect(await settledOf(mechanical)).toEqual({ size: 'small' })
  expect(await edgesOf(mechanical)).toEqual([])
  expect(await world.db.sql`SELECT id, state FROM factory.issues ORDER BY id`).toEqual([
    { id: mechanical, state: 'queued' },
    { id: risky, state: 'queued' },
  ])

  seats = await readLeadSeats(world.db.sql, [mechanical, risky], table(true))
  expect(seats.get(mechanical)).toEqual({
    tier: 'haiku',
    effort: 'high',
    role: 'light',
    planned: true,
    rule: 'triage:small',
    sizeKnown: true,
  })
  // a word of OUT_OF_SCOPE in its text keeps it on the lead row, with its size known
  expect(seats.get(risky)).toMatchObject({ role: 'lead', planned: true, rule: null, sizeKnown: true })
  // the gate is the light seat's own: closed, the same Issue stays planned on the lead row
  expect((await readLeadSeats(world.db.sql, [mechanical], table(false))).get(mechanical)).toMatchObject({
    role: 'lead',
    rule: null,
  })
})

test('--after: the stated edge is kept and the answer adds none', async () => {
  const blocker = await world.queued({ repo: 'app', title: 'The blocker' })
  const waiting = await fileStated({
    title: 'Rename it after the blocker',
    text: 'three edits that rename it',
    after: [blocker],
  })
  value(await triagePass(triageDeps()))
  expect(await edgesOf(waiting)).toEqual([blocker])
  expect(await settledOf(waiting)).toEqual({ size: 'small' })
})

test('an incident is settled by rule: no call, no size', async () => {
  const incident = value(
    await fileIssue(world.deps, {
      key: key('filed', 'incident'),
      event: {
        kind: 'filed',
        payload: { repo: 'app', title: 'It is down', kind: 'incident', origin: 'application', edges: 'stated' },
        actor: 'factory',
      },
    }),
  ).issue.id
  const pass = value(await triagePass(triageDeps()))
  expect(pass).toMatchObject({ asked: 0, settled: 1 })
  expect(requests).toEqual([])
  expect(await settledOf(incident)).toEqual({})
  // settled with no size, it will get none: the planned seat does not claim it waits for one
  expect((await readLeadSeats(world.db.sql, [incident], table(true))).get(incident)).toMatchObject({
    role: 'lead',
    sizeKnown: true,
  })
})

test('a plan row behaves like the --alone Issue: stated edges, a size from triage, then queued', async () => {
  const project = { state: 'text' as const, sha: 'sha-app', value: { apiVersion: 'factory/v2', name: 'app' } }
  const row = (k: string, what: string) => ({ key: k, title: `Title of ${k}`, facts: { why: 'because', what } })
  world.source.add('app', {
    project,
    plan: {
      state: 'text' as const,
      sha: 'p1',
      value: {
        version: 1,
        rows: [
          row('mechanical', 'three config edits that rename the repo'),
          row('risky', 'rename the column and add a migration'),
        ],
      },
    },
  })
  value(await syncProjects(world.deps, { fetch: false }))
  const filed = value(await planningPass(world.deps)).filed.map((f) => f.issue)
  const states = async () =>
    (await world.db.sql`SELECT id, state FROM factory.issues ORDER BY id`).map(
      (r: { id: string; state: string }) => r.state,
    )
  expect(await states()).toEqual(['settling', 'settling'])

  value(await triagePass(triageDeps()))
  expect(await states()).toEqual(['queued', 'queued'])
  expect(requests[0]?.issue.text).toContain('three config edits')
  const seats = await readLeadSeats(world.db.sql, filed, table(true))
  expect(seats.get(filed[0] as IssueId)).toMatchObject({ role: 'light', planned: true, rule: 'triage:small' })
  expect(seats.get(filed[1] as IssueId)).toMatchObject({ role: 'lead', rule: null })
})
