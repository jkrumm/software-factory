import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import type { ErrandScreenAnswer } from '@software-factory/contract'
import { startTestCluster, type TestCluster } from '@software-factory/tests/pg'
import { postgresCheckpointStore } from '../../src/adapters/postgres/checkpoint-store.ts'
import { postgresDeskStore } from '../../src/adapters/postgres/desk-store.ts'
import { loadMigrations, migrate } from '../../src/adapters/postgres/migrate.ts'
import { postgresPlanningStore } from '../../src/adapters/postgres/planning-store.ts'
import { postgresReviewStore } from '../../src/adapters/postgres/review-store.ts'
import { postgresUnitOfWork } from '../../src/adapters/postgres/unit-of-work.ts'
import { postgresVisitStore } from '../../src/adapters/postgres/visit-store.ts'
import { postgresWorkStore } from '../../src/adapters/postgres/work-store.ts'
import { prReview } from '../../src/adapters/reviews/pr.ts'
import { finishErrand, raiseErrand, requestErrand, turnBackErrand } from '../../src/app/checkpoints.ts'
import { screenErrands } from '../../src/app/checkpoints-errands.ts'
import type { SettleDeps } from '../../src/app/checkpoints-settle.ts'
import { fileIssue, recordIssueEvent } from '../../src/app/issues.ts'
import { deskPass } from '../../src/app/loops/desk.ts'
import { reviewsPass } from '../../src/app/loops/reviews.ts'
import { registerVisit } from '../../src/app/visit.ts'
import type { PushPort } from '../../src/domains/checkpoints/ports.ts'
import type { CheckRun } from '../../src/domains/checkpoints/request.ts'
import type { ReviewPort } from '../../src/domains/loops/reviews.ts'
import type { AnyIssueEvent } from '../../src/domains/work/events.ts'
import { type FixedClock, fixedClock } from '../../src/kernel/clock.ts'
import { type IssueId, sequentialIds } from '../../src/kernel/ids.ts'
import { key } from '../../src/kernel/keys.ts'
import { err, ok, portError, type Result } from '../../src/kernel/result.ts'
import { readNeeds } from '../../src/read/needs.ts'

/**
 * Errands converge (issue 1020) over a real Postgres: an Errand that asks the owner to approve a pull request is turned back
 * and the Issue waits on the pull request; the review poll wakes it when the (fake) `gh` says APPROVED; the orchestrator's
 * turn back ends an Errand wait; and the desk pass closes an Errand whose check exits 1 and pushes one command Errand.
 */
let db: TestCluster
const clock: FixedClock = fixedClock('2026-11-13T08:00:00Z')
const HOUR = 3_600_000
let deps: SettleDeps
let checks: Record<string, CheckRun>
let screened: string[]
let screenAnswer: () => Result<ErrandScreenAnswer>
let pushed: string[]
let ghJson: string
let ghCalls: string[][]

const push: PushPort = {
  push: (errand) => {
    expect(deps.uow.inTransaction()).toBe(false)
    pushed.push(errand)
    return Promise.resolve(ok({ exit: 75 }))
  },
}

beforeAll(async () => {
  db = await startTestCluster()
})
afterAll(() => db.stop())

const stores = (tx: Parameters<Parameters<typeof postgresUnitOfWork>[1]>[0]) => ({
  work: postgresWorkStore(tx),
  checkpoints: postgresCheckpointStore(tx),
  planning: postgresPlanningStore(tx),
  reviews: postgresReviewStore(tx),
  desk: postgresDeskStore(tx),
  visits: postgresVisitStore(tx),
})
const uow = () => postgresUnitOfWork(db.sql, stores)

beforeEach(async () => {
  await db.sql`DROP SCHEMA IF EXISTS factory CASCADE`
  await migrate(db.sql, await loadMigrations())
  clock.set(new Date('2026-11-13T08:00:00Z'))
  checks = {}
  screened = []
  pushed = []
  ghCalls = []
  ghJson = JSON.stringify({
    state: 'OPEN',
    reviewDecision: 'REVIEW_REQUIRED',
    author: { login: 'me' },
    reviews: [],
    comments: [],
  })
  screenAnswer = () => ok({ verdict: 'pass', reason: 'a person must do it' })
  deps = {
    uow: uow(),
    clock,
    ids: sequentialIds(),
    blobs: { put: async () => err(portError('unreadable', 'x')), get: async () => err(portError('unreadable', 'x')) },
    consoleUrl: 'https://console.example.test',
    checks: {
      run: (command) => {
        expect(deps.uow.inTransaction()).toBe(false)
        return Promise.resolve(checks[command] ?? { exit: 0, timedOut: false, output: '' })
      },
    },
    policies: { rulesFor: () => Promise.resolve(ok([])) },
    judge: { judge: () => Promise.resolve(err(portError('gone', 'no judge'))) },
    errandScreen: {
      screen: (request) => {
        expect(deps.uow.inTransaction()).toBe(false)
        screened.push(request.errand.id)
        return Promise.resolve(screenAnswer())
      },
    },
    recheckAfterMs: 0,
  }
})

const value = <T, E>(result: Result<T, E>): T => {
  if (!result.ok) throw new Error(`expected ok, got ${JSON.stringify(result.error)}`)
  return result.value
}
const record = async (issueId: IssueId, name: string, event: AnyIssueEvent) =>
  value(await recordIssueEvent(deps, { issueId, key: key('test', issueId, name), event }))

async function workingIssue(repo = '/w/work-repo-1'): Promise<IssueId> {
  const filed = value(
    await fileIssue(deps, {
      key: key('filed', deps.ids.next('signal')),
      event: {
        kind: 'filed',
        payload: { repo, title: 'ship the change', kind: 'feature', origin: 'you' },
        actor: 'factory',
      },
    }),
  )
  const id = filed.issue.id
  await record(id, 'settled', { kind: 'settled', payload: {}, actor: 'factory' })
  await record(id, 'admitted', { kind: 'admitted', payload: {}, actor: 'factory' })
  await record(id, 'lead_started', { kind: 'lead_started', payload: { attempt: 1, terminal: 't1' }, actor: 'factory' })
  return id
}

const raise = async (issueId: IssueId, raw: Record<string, unknown>) =>
  value(await raiseErrand(deps, { issueId, attempt: 1, raw: { tried: 'looked for a route: none', ...raw } }))
const issueRow = async (id: string) => (await db.sql`SELECT * FROM factory.issues WHERE id = ${id}`)[0]
const errandRow = async (id: string) => (await db.sql`SELECT * FROM factory.errands WHERE id = ${id}`)[0]
const noteEffects = async (id: string) =>
  Number(
    (
      await db.sql`SELECT count(*)::int AS n FROM factory.issue_effects WHERE issue_id = ${id} AND kind = 'note_lead'`
    )[0]?.n,
  )

/** `gh` as the fake the scenarios script: every call is recorded and answers `ghJson`. */
const fakeGh = prReview({
  run: (cmd) => {
    ghCalls.push(cmd)
    return Promise.resolve({ exitCode: 0, stdout: ghJson })
  },
})
const reviews = () => {
  const port: ReviewPort = fakeGh
  return { uow: deps.uow as never, clock, ids: deps.ids, port }
}

describe('an Errand that asks the owner to approve a pull request', () => {
  test('is turned away by the screen and the Issue waits on the pull request, not on the owner', async () => {
    const issueId = await workingIssue()
    const raised = await raise(issueId, {
      summary: 'Approve and merge PR #91',
      detail: "The owner's approval or admin squash merge is needed on pull request #91.",
    })
    expect(value(await screenErrands(deps))).toEqual([{ errand: raised.errand.id, outcome: 'turned_away' }])
    // the rule decided: the screen workflow was never asked, and the Errand never reached the owner
    expect(screened).toEqual([])
    expect(await issueRow(issueId)).toMatchObject({ state: 'waiting', wait_reason: 'external' })
    expect(await errandRow(raised.errand.id)).toMatchObject({ closed_kind: 'turned_away', reached_owner_at: null })
    expect((await readNeeds(db.sql, clock.now())).items).toEqual([])
    const [event] = await db.sql`
      SELECT actor, wait FROM factory.issue_events WHERE issue_id = ${issueId} AND kind = 'errand_done'`
    expect(event).toMatchObject({ actor: 'factory', wait: { reason: 'external', holds: { id: '#91' } } })
  })

  test('is woken by the review poll when gh reports APPROVED, and the lead is told', async () => {
    const issueId = await workingIssue()
    await raise(issueId, { summary: 'Approve and merge PR #91' })
    value(await screenErrands(deps))
    const effectsBefore = await noteEffects(issueId)

    // nothing yet: the PR is open and wants a review; the first look is the baseline
    expect(value(await reviewsPass(reviews()))).toMatchObject({ looked: 1, woken: [], problems: [] })
    expect(ghCalls.at(-1)?.join(' ')).toContain('pr view 91')

    // a comment by the author is not a reviewer's, and one by someone else is
    ghJson = JSON.stringify({
      state: 'OPEN',
      reviewDecision: 'REVIEW_REQUIRED',
      author: { login: 'me' },
      reviews: [],
      comments: [{ author: { login: 'me' } }],
    })
    expect(value(await reviewsPass(reviews())).woken).toEqual([])

    ghJson = JSON.stringify({
      state: 'OPEN',
      reviewDecision: 'APPROVED',
      author: { login: 'me' },
      reviews: [{ author: { login: 'them' }, state: 'APPROVED' }],
      comments: [],
    })
    expect(value(await reviewsPass(reviews())).woken).toEqual([issueId])
    expect(await issueRow(issueId)).toMatchObject({ state: 'working', wait_reason: null })
    expect(await noteEffects(issueId)).toBe(effectsBefore + 1)
    const [woken] = await db.sql`
      SELECT payload FROM factory.issue_events WHERE issue_id = ${issueId} AND kind = 'woken'`
    expect(woken?.payload.detail).toBe('#91: the pull request was approved')
    // a replay wakes nothing twice
    expect(value(await reviewsPass(reviews())).looked).toBe(0)
  })

  test('a new review comment, a request for changes and a merge each wake it', async () => {
    const cases: [Record<string, unknown>, string][] = [
      [
        { state: 'OPEN', reviewDecision: 'REVIEW_REQUIRED', comments: [{ author: { login: 'them' } }] },
        'a reviewer commented',
      ],
      [{ state: 'OPEN', reviewDecision: 'CHANGES_REQUESTED' }, 'a reviewer requested changes'],
      [{ state: 'MERGED', reviewDecision: 'APPROVED' }, 'the pull request was merged'],
    ]
    for (const [body, reason] of cases) {
      await db.sql`DROP SCHEMA IF EXISTS factory CASCADE`
      await migrate(db.sql, await loadMigrations())
      const issueId = await workingIssue()
      await raise(issueId, { summary: 'Approve PR #7' })
      value(await screenErrands(deps))
      // the first look is the baseline for comments, so a comment must come after it
      ghJson = JSON.stringify({
        author: { login: 'me' },
        reviews: [],
        comments: [],
        ...{ state: 'OPEN', reviewDecision: 'REVIEW_REQUIRED' },
      })
      value(await reviewsPass(reviews()))
      ghJson = JSON.stringify({ author: { login: 'me' }, reviews: [], comments: [], ...body })
      expect(value(await reviewsPass(reviews())).woken).toEqual([issueId])
      const [woken] = await db.sql`SELECT payload FROM factory.issue_events WHERE kind = 'woken'`
      expect(woken?.payload.detail).toBe(`#7: ${reason}`)
    }
  })

  test('a pull request that cannot be read changes nothing and is named', async () => {
    const issueId = await workingIssue()
    await raise(issueId, { summary: 'Approve PR #91' })
    value(await screenErrands(deps))
    ghJson = 'not json'
    const pass = value(await reviewsPass(reviews()))
    expect(pass.woken).toEqual([])
    expect(pass.problems[0]).toContain('did not answer with JSON')
    expect(await issueRow(issueId)).toMatchObject({ state: 'waiting', wait_reason: 'external' })
  })
})

describe('turning an Errand back', () => {
  test("the orchestrator's turn back ends the wait, closes it turned_back and the lead hears the note", async () => {
    const issueId = await workingIssue()
    const raised = await raise(issueId, { summary: 'Rotate the staging token in the portal' })
    value(await screenErrands(deps))
    const effectsBefore = await noteEffects(issueId)
    const turned = value(
      await turnBackErrand(deps, { errandId: raised.errand.id, note: 'a token can do it', by: 'orchestrator' }),
    )
    expect(turned).toMatchObject({ result: 'applied', issue: { state: 'working' } })
    expect(await errandRow(raised.errand.id)).toMatchObject({
      closed_kind: 'turned_back',
      closed_by: 'orchestrator',
      done_note: 'a token can do it',
    })
    expect(await noteEffects(issueId)).toBe(effectsBefore + 1)
    const [event] = await db.sql`
      SELECT actor, payload FROM factory.issue_events WHERE issue_id = ${issueId} AND kind = 'errand_turned_back'`
    expect(event).toMatchObject({ actor: 'orchestrator', payload: { note: 'a token can do it' } })
    expect(value(await turnBackErrand(deps, { errandId: raised.errand.id, note: 'again', by: 'owner' }))).toMatchObject(
      {
        result: 'replayed',
      },
    )
  })
})

describe('the desk pass', () => {
  const macbook = (text: string, command: string, key: string) =>
    requestErrand(deps, { raw: { source: 'ask-human', text, command, key, where: 'macbook' } })

  test('closes an Errand whose check exits 1, wakes its lead, and pushes one command Errand', async () => {
    const issueId = await workingIssue('example')
    const raised = await raise(issueId, { summary: 'The porch light is unreachable', check: 'home doctor' })
    value(await screenErrands(deps))
    checks['home doctor'] = { exit: 1, timedOut: false, output: 'all accessories respond' }
    const first = value(await macbook('Reseal the cache', 'make secrets-seed', 'reseal'))
    const second = value(await macbook('Reload the keys', 'make keys', 'keys'))
    // ask-human errands go through the screen first
    expect(value(await screenErrands(deps)).map((s) => s.outcome)).toEqual(['reached_owner', 'reached_owner'])
    const effectsBefore = await noteEffects(issueId)

    const pass = value(await deskPass({ settle: deps, desk: deps.uow as never, push }))
    expect(pass).toMatchObject({ ran: true, resolved: 1, pushed: first.errand.id })
    expect(await errandRow(raised.errand.id)).toMatchObject({ closed_kind: 'not_needed', closed_by: 'check' })
    expect(await issueRow(issueId)).toMatchObject({ state: 'working' })
    expect(await noteEffects(issueId)).toBe(effectsBefore + 1)
    expect(pushed).toEqual([first.errand.id])
    expect(await errandRow(second.errand.id)).toMatchObject({ pushed_at: null })

    // not due again for six hours, unless the owner came back
    expect(value(await deskPass({ settle: deps, desk: deps.uow as never, push })).ran).toBe(false)
    clock.set(new Date(clock.now().getTime() + 3 * HOUR))
    value(await registerVisit(deps.uow as never, clock.now()))
    clock.set(new Date(clock.now().getTime() + 3 * HOUR))
    // six hours later the pass is due on the clock alone; the next command goes, one only
    const again = value(await deskPass({ settle: deps, desk: deps.uow as never, push }))
    expect(again).toMatchObject({ ran: true, pushed: second.errand.id })
    expect(pushed).toEqual([first.errand.id, second.errand.id])
  })

  test('is due when the owner comes back after two hours, and not for a short absence', async () => {
    value(await deskPass({ settle: deps, desk: deps.uow as never, push }))
    clock.set(new Date(clock.now().getTime() + 1 * HOUR))
    value(await registerVisit(deps.uow as never, clock.now()))
    expect(value(await deskPass({ settle: deps, desk: deps.uow as never, push })).ran).toBe(true)
    // that read was the first visit, so it counted; a read 30 minutes on is a short absence
    clock.set(new Date(clock.now().getTime() + HOUR / 2))
    value(await registerVisit(deps.uow as never, clock.now()))
    expect(value(await deskPass({ settle: deps, desk: deps.uow as never, push })).ran).toBe(false)
    clock.set(new Date(clock.now().getTime() + 2 * HOUR))
    value(await registerVisit(deps.uow as never, clock.now()))
    expect(value(await deskPass({ settle: deps, desk: deps.uow as never, push })).ran).toBe(true)
  })

  test('screens the rest again and turns back what an agent can now do', async () => {
    const issueId = await workingIssue('example')
    const raised = await raise(issueId, { summary: 'Click the portal button' })
    value(await screenErrands(deps))
    expect(await errandRow(raised.errand.id)).not.toMatchObject({ reached_owner_at: null })
    screenAnswer = () => ok({ verdict: 'turn_away', reason: 'a token mints it now' })
    clock.set(new Date(clock.now().getTime() + 7 * HOUR))
    const pass = value(await deskPass({ settle: deps, desk: deps.uow as never, push }))
    expect(pass).toMatchObject({ ran: true, turnedAway: 1 })
    expect(await errandRow(raised.errand.id)).toMatchObject({
      closed_kind: 'turned_away',
      done_note: 'a token mints it now',
    })
    expect(await issueRow(issueId)).toMatchObject({ state: 'working' })
    expect(await finishErrandReplay(raised.errand.id)).toBe('replayed')
  })

  const finishErrandReplay = async (errandId: string) =>
    value(await finishErrand(deps, { errandId: errandId as never, note: null })).result
})
