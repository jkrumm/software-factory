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
import { approveErrand } from '../../src/app/checkpoints-approve.ts'
import { checkErrandNow } from '../../src/app/checkpoints-check.ts'
import { screenErrands } from '../../src/app/checkpoints-errands.ts'
import type { SettleDeps } from '../../src/app/checkpoints-settle.ts'
import { fileIssue, recordIssueEvent } from '../../src/app/issues.ts'
import { deskPass } from '../../src/app/loops/desk.ts'
import { errandsPass } from '../../src/app/loops/errands.ts'
import { endRequest } from '../../src/app/checkpoints-errands.ts'
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
import { loadErrands } from '../../src/read/issues.ts'
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
/** what the commands an approved Errand runs on the mini were given, and what they come to */
let ran: string[]
let commandRuns: Record<string, CheckRun>
let commandExit: CheckRun
let screened: string[]
let screenAnswer: () => Result<ErrandScreenAnswer>
let pushed: string[]
let pushExit: number
let probeUp: boolean
let probes: number
let inFlight: number
let ghJson: string
let ghCalls: string[][]

const push: PushPort = {
  push: async (errand) => {
    expect(deps.uow.inTransaction()).toBe(false)
    // one dialog at a time: the next is pushed after this one was answered
    expect(inFlight).toBe(0)
    inFlight++
    pushed.push(errand)
    await Promise.resolve()
    inFlight--
    return ok({ exit: pushExit })
  },
  probe: () => {
    probes++
    return Promise.resolve(probeUp)
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
  ran = []
  commandRuns = {}
  commandExit = { exit: 0, timedOut: false, output: 'released' }
  screened = []
  pushed = []
  pushExit = 75
  probeUp = false
  probes = 0
  inFlight = 0
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
    commands: {
      run: (command) => {
        expect(deps.uow.inTransaction()).toBe(false)
        ran.push(command)
        return Promise.resolve(commandRuns[command] ?? commandExit)
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
    specScreen: { screen: () => Promise.resolve(err(portError('gone', 'no screen'))) },
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
    const second = value(await macbook('Reload the keys with Touch ID', 'make keys', 'keys'))
    // ask-human errands go through the screen first
    expect(value(await screenErrands(deps)).map((s) => s.outcome)).toEqual(['reached_owner', 'reached_owner'])
    const effectsBefore = await noteEffects(issueId)

    const pass = value(await deskPass({ settle: deps, desk: deps.uow as never, push }))
    expect(pass).toMatchObject({ ran: true, resolved: 1, returned: false, pushed: [first.errand.id] })
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
    // he came back since the last pass (the first read counts), so it is due and every pending command goes, oldest first
    const again = value(await deskPass({ settle: deps, desk: deps.uow as never, push }))
    expect(again).toMatchObject({ ran: true, returned: true, pushed: [first.errand.id, second.errand.id] })
    expect(pushed).toEqual([first.errand.id, first.errand.id, second.errand.id])
  })

  test("a lead's check now closes an Errand its check answers and wakes the lead, with no desk pass", async () => {
    const issueId = await workingIssue('example')
    const raised = await raise(issueId, { summary: 'Install the sysctl profile', check: 'sysctl-done' })
    value(await screenErrands(deps))
    const effectsBefore = await noteEffects(issueId)

    // still needed: exit 0 keeps it open and says so
    const kept = value(await checkErrandNow(deps, { errandId: raised.errand.id }))
    expect(kept).toMatchObject({ outcome: 'needed' })
    expect(await errandRow(raised.errand.id)).toMatchObject({ done_at: null, check_at: clock.now() })

    checks['sysctl-done'] = { exit: 1, timedOut: false, output: 'value changed' }
    const closed = value(await checkErrandNow(deps, { errandId: raised.errand.id }))
    expect(closed.outcome).toBe('closed')
    expect(closed.note).toContain('value changed')
    expect(await errandRow(raised.errand.id)).toMatchObject({ closed_kind: 'not_needed', closed_by: 'check' })
    expect(await issueRow(issueId)).toMatchObject({ state: 'working' })
    expect(await noteEffects(issueId)).toBe(effectsBefore + 1)

    // asked again it is a replay, never a second wake
    expect(value(await checkErrandNow(deps, { errandId: raised.errand.id })).outcome).toBe('already_closed')
    expect(await noteEffects(issueId)).toBe(effectsBefore + 1)
  })

  test('a check that cannot run is noted, and an Errand with no check says so', async () => {
    const issueId = await workingIssue('example')
    const checked = await raise(issueId, { summary: 'Plug it in', check: 'no-such-tool' })
    const otherIssue = await workingIssue('example')
    const bare = await raise(otherIssue, { summary: 'Click the portal' })
    value(await screenErrands(deps))
    checks['no-such-tool'] = { exit: null, timedOut: false, output: 'not found' }

    const unrunnable = value(await checkErrandNow(deps, { errandId: checked.errand.id }))
    expect(unrunnable.outcome).toBe('unrunnable')
    expect(unrunnable.note).toContain('could not run')
    expect(await errandRow(checked.errand.id)).toMatchObject({ done_at: null, check_fails: 1 })
    expect(value(await checkErrandNow(deps, { errandId: bare.errand.id })).outcome).toBe('no_check')
    const missing = await checkErrandNow(deps, { errandId: 'errand_missing' as never })
    expect(missing).toMatchObject({ ok: false, error: { kind: 'not_found' } })
  })

  test('issue show lists the Errands with when their check last ran and next runs', async () => {
    const issueId = await workingIssue('example')
    const raised = await raise(issueId, { summary: 'Install the profile', check: 'sysctl-done' })
    const otherIssue = await workingIssue('example')
    await raise(otherIssue, { summary: 'Click the portal' })
    value(await screenErrands(deps))

    // no desk pass yet: the next check is due at once
    const first = await loadErrands(db.sql, issueId, clock.now())
    expect(first.map((line) => line.summary)).toEqual(['Install the profile'])
    expect(first[0]).toMatchObject({
      state: 'open',
      hasCheck: true,
      lastCheckedAt: null,
      nextCheckAt: clock.now().toISOString(),
    })
    expect((await loadErrands(db.sql, otherIssue, clock.now()))[0]).toMatchObject({
      hasCheck: false,
      nextCheckAt: null,
    })

    value(await deskPass({ settle: deps, desk: deps.uow as never, push }))
    const passAt = clock.now()
    clock.set(new Date(passAt.getTime() + 2 * HOUR))
    const waiting = await loadErrands(db.sql, issueId, clock.now())
    expect(waiting[0]).toMatchObject({
      lastCheckedAt: passAt.toISOString(),
      nextCheckAt: new Date(passAt.getTime() + 6 * HOUR).toISOString(),
    })

    checks['sysctl-done'] = { exit: 1, timedOut: false, output: 'changed' }
    value(await checkErrandNow(deps, { errandId: raised.errand.id }))
    const done = await loadErrands(db.sql, issueId, clock.now())
    expect(done[0]).toMatchObject({ state: 'closed', closedKind: 'not_needed', nextCheckAt: null })
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

  const reached = async (issueId: IssueId, raw: Record<string, unknown>) => {
    const raised = await raise(issueId, raw)
    value(await screenErrands(deps))
    return raised.errand.id
  }

  test("an Issue's Errand with a command is pushed when he comes back, and a second pending one after it", async () => {
    const issueId = await workingIssue('example')
    // the away pass has run and found nothing to push yet
    value(await deskPass({ settle: deps, desk: deps.uow as never, push }))
    clock.set(new Date(clock.now().getTime() + HOUR))
    const queued = await reached(issueId, {
      summary: 'Approve the queued dialog with Touch ID',
      cmd: 'make maxvnodes-install',
      host: 'macbook',
    })
    const request = value(await macbook('Reload the keys with Touch ID', 'make keys', 'keys')).errand.id
    value(await screenErrands(deps))
    expect(await errandRow(queued)).toMatchObject({ command: 'make maxvnodes-install', host: 'macbook' })
    // away: the loop's tick finds nothing due
    clock.set(new Date(clock.now().getTime() + HOUR))
    expect(value(await deskPass({ settle: deps, desk: deps.uow as never, push })).ran).toBe(false)
    expect(pushed).toEqual([])

    // his read, two hours after the last
    clock.set(new Date(clock.now().getTime() + 3 * HOUR))
    value(await registerVisit(deps.uow as never, clock.now()))
    const pass = value(await deskPass({ settle: deps, desk: deps.uow as never, push }))
    expect(pass).toMatchObject({ ran: true, returned: true, pushed: [queued, request] })
    expect(pushed).toEqual([queued, request])
    // the return is spent: the next tick is not due
    expect(value(await deskPass({ settle: deps, desk: deps.uow as never, push })).ran).toBe(false)
  })

  test('his button runs the pass at once, as on a return', async () => {
    const issueId = await workingIssue('example')
    const queued = await reached(issueId, {
      summary: 'Approve the queued dialog with Touch ID',
      cmd: 'make x',
      host: 'macbook',
    })
    const request = value(await macbook('Reload the keys with Touch ID', 'make keys', 'keys')).errand.id
    value(await screenErrands(deps))
    value(await deskPass({ settle: deps, desk: deps.uow as never, push }))
    expect(pushed).toEqual([queued])
    clock.set(new Date(clock.now().getTime() + 1_000))
    expect(value(await deskPass({ settle: deps, desk: deps.uow as never, push })).ran).toBe(false)
    const forced = value(await deskPass({ settle: deps, desk: deps.uow as never, push, force: true }))
    expect(forced).toMatchObject({ ran: true, returned: true, pushed: [queued, request] })
  })

  test('the MacBook answering after it was unreachable counts as his return', async () => {
    const issueId = await workingIssue('example')
    const queued = await reached(issueId, {
      summary: 'Approve the queued dialog with Touch ID',
      cmd: 'make x',
      host: 'macbook',
    })
    const request = value(await macbook('Reload the keys with Touch ID', 'make keys', 'keys')).errand.id
    value(await screenErrands(deps))
    // the away pass pushes one; the MacBook does not answer, which ends the run and marks it down
    pushExit = 69
    const away = value(await deskPass({ settle: deps, desk: deps.uow as never, push }))
    expect(pushed).toEqual([queued])
    // a dialog that never appeared is not counted as pushed, and the pass says why
    expect(away.pushed).toEqual([])
    expect(away.problems[0]).toContain('the MacBook did not answer')
    expect(probes).toBe(0)

    // still down: the probe says so, nothing is due
    clock.set(new Date(clock.now().getTime() + HOUR))
    expect(value(await deskPass({ settle: deps, desk: deps.uow as never, push })).ran).toBe(false)
    expect(probes).toBe(1)

    // it answers: his return, so the pass runs at once and pushes every pending command
    probeUp = true
    pushExit = 75
    clock.set(new Date(clock.now().getTime() + HOUR))
    const pass = value(await deskPass({ settle: deps, desk: deps.uow as never, push }))
    expect(pass).toMatchObject({ ran: true, returned: true, pushed: [queued, request] })
    // up again: it is not probed any more, and the return is spent
    expect(value(await deskPass({ settle: deps, desk: deps.uow as never, push })).ran).toBe(false)
    expect(probes).toBe(2)
  })

  test('an Errand with no command beside a request the lead queued is refused with the verb to use', async () => {
    const issueId = await workingIssue('example')
    deps.queuedAsks = (issue) =>
      Promise.resolve(
        `issue_${issue}` === String(issueId)
          ? [{ id: '20261114T031243-30967', text: 'Raise kern.maxvnodes', cmd: 'make maxvnodes-install' }]
          : [],
      )
    const raw = { tried: 'looked for a route: none', summary: 'Approve the queued dialog' }
    const refused = await raiseErrand(deps, { issueId, attempt: 1, raw })
    expect(!refused.ok && refused.error).toMatchObject({ kind: 'invalid' })
    const detail = !refused.ok && 'detail' in refused.error ? refused.error.detail : ''
    expect(detail).toContain('factory errand raise')
    expect(detail).toContain("--cmd '<the command he runs>' --host macbook")
    expect(detail).toContain('20261114T031243-30967')
    expect(await db.sql`SELECT id FROM factory.errands`).toEqual([])
    // with the command it is raised
    const raised = value(
      await raiseErrand(deps, { issueId, attempt: 1, raw: { ...raw, cmd: 'make maxvnodes-install' } }),
    )
    expect(raised.errand).toMatchObject({ command: 'make maxvnodes-install', host: 'macbook' })
  })

  const finishErrandReplay = async (errandId: string) =>
    value(await finishErrand(deps, { errandId: errandId as never, note: null })).result
})

const RELEASE = "ssh mini 'make -C ~/gate deploy-release SHA=78088f16'"

describe('an Errand that needs only his yes', () => {
  const reach = async (issueId: IssueId, extra: Record<string, unknown> = {}) => {
    const raised = await raise(issueId, {
      summary: "Release the colleague's commit 78088f16",
      cmd: RELEASE,
      check: 'gate-pending',
      ...extra,
    })
    return raised
  }

  test('a gate release is an approval by rule, never goes to the MacBook, and Approve runs it on the mini and closes it by its check', async () => {
    const issueId = await workingIssue()
    const raised = await reach(issueId)
    expect(value(await screenErrands(deps))).toEqual([{ errand: raised.errand.id, outcome: 'reached_owner' }])
    // the shape decided: no model was asked, and the screen says what it is
    expect(screened).toEqual([])
    expect(await errandRow(raised.errand.id)).toMatchObject({ need: 'approval', screen_by: 'rule' })
    const [need] = (await readNeeds(db.sql, clock.now())).items
    expect(need).toMatchObject({ id: raised.errand.id, need: 'approval', command: RELEASE })

    // the desk pass, the owner back: nothing is pushed to the MacBook for it
    const pass = value(await deskPass({ settle: deps, desk: deps.uow as never, push, force: true }))
    expect(pass).toMatchObject({ ran: true, returned: true, pushed: [] })
    expect(pushed).toEqual([])

    // the gate has not released yet, then his Approve runs the command here and the check says it is done
    checks['gate-pending'] = { exit: 1, timedOut: false, output: 'released' }
    const approved = value(await approveErrand(deps, { errandId: raised.errand.id }))
    expect(approved.errand).toMatchObject({ approvedAt: expect.any(Date), runStatus: 'running' })
    await approved.done
    // `ssh mini '<x>'` ran as <x> here, never as an ssh to itself
    expect(ran).toHaveLength(1)
    expect(ran[0]).not.toContain('ssh')
    expect(ran[0]).toContain('make -C ~/gate deploy-release SHA=78088f16')
    expect(await errandRow(raised.errand.id)).toMatchObject({ closed_kind: 'done', closed_by: 'owner' })
    expect((await errandRow(raised.errand.id))?.done_note).toContain('its check exited 1')
    expect(await issueRow(issueId)).toMatchObject({ state: 'working' })
    expect(pushed).toEqual([])
  })

  test('an Approve whose command ran but whose check still says it is needed leaves it open, with no run going', async () => {
    const issueId = await workingIssue()
    const raised = await reach(issueId)
    value(await screenErrands(deps))
    const approved = value(await approveErrand(deps, { errandId: raised.errand.id }))
    await approved.done
    expect(await errandRow(raised.errand.id)).toMatchObject({
      done_at: null,
      run_status: null,
      check_note: 'marked done but the check says still needed',
    })
  })

  test('Approve is refused for what is not an approval, for a closed Errand and while its command runs', async () => {
    const issueId = await workingIssue()
    const secret = await raise(issueId, { summary: 'Reseal', cmd: 'make secrets-seed', host: 'macbook' })
    value(await screenErrands(deps))
    expect(await errandRow(secret.errand.id)).toMatchObject({ need: 'secret' })
    const refused = await approveErrand(deps, { errandId: secret.errand.id })
    expect(refused).toMatchObject({ ok: false, error: { kind: 'machine_refused' } })
    expect(ran).toEqual([])

    const other = await workingIssue()
    const gate = await reach(other, { check: undefined })
    // still unscreened: it has not reached the owner
    expect(await approveErrand(deps, { errandId: gate.errand.id })).toMatchObject({ ok: false })
    value(await screenErrands(deps))
    const first = value(await approveErrand(deps, { errandId: gate.errand.id }))
    // a second press while the first runs does not run it twice
    expect(await approveErrand(deps, { errandId: gate.errand.id })).toMatchObject({ ok: false })
    await first.done
    expect(ran).toHaveLength(1)
    expect(await errandRow(gate.errand.id)).toMatchObject({ closed_kind: 'done' })
    expect(await approveErrand(deps, { errandId: gate.errand.id })).toMatchObject({ ok: false })
  })

  test('a second Issue with the same command joins the open Errand: one Errand, one page, and both Issues hear it end', async () => {
    const first = await workingIssue()
    const second = await workingIssue()
    const raised = await reach(first)
    value(await screenErrands(deps))
    const joined = await reach(second, { summary: 'Release it for my Issue too' })
    expect(joined.result).toBe('joined')
    expect(joined.errand.id).toBe(raised.errand.id)
    expect(await issueRow(second)).toMatchObject({ state: 'waiting', wait_reason: 'errand' })
    expect((await db.sql`SELECT count(*)::int AS n FROM factory.errands`)[0]?.n).toBe(1)
    expect((await db.sql`SELECT count(*)::int AS n FROM factory.errand_joins`)[0]?.n).toBe(1)
    expect((await readNeeds(db.sql, clock.now())).items).toMatchObject([{ id: raised.errand.id, joined: 1 }])
    // a request with the same command is that Errand too
    const asked = value(
      await requestErrand(deps, {
        raw: { source: 'ask-human', text: 'Release 78088f16', command: RELEASE, key: 'gate' },
      }),
    )
    expect(asked).toMatchObject({ result: 'joined', errand: { id: raised.errand.id }, superseded: [] })

    checks['gate-pending'] = { exit: 1, timedOut: false, output: 'released' }
    const approved = value(await approveErrand(deps, { errandId: raised.errand.id }))
    await approved.done
    expect(await issueRow(first)).toMatchObject({ state: 'working' })
    expect(await issueRow(second)).toMatchObject({ state: 'working' })
  })

  test('a request under the same key with another command replaces the open one; the same command joins', async () => {
    const ask = (command: string) =>
      requestErrand(deps, { raw: { source: 'test-agent', text: 'Release the commit', command, key: 'gate' } })
    const first = value(await ask(RELEASE))
    expect(first.result).toBe('applied')
    const corrected = value(await ask("ssh mini 'make -C ~/gate deploy-release SHA=feedbeef'"))
    expect(corrected).toMatchObject({ result: 'applied', superseded: [first.errand.id] })
    expect(value(await ask("ssh mini 'make -C ~/gate deploy-release SHA=feedbeef'")).result).toBe('replayed')
  })

  test('a check that cannot find its command is broken: the owner and the lead are told, and his done closes it', async () => {
    const issueId = await workingIssue()
    const raised = await raise(issueId, { summary: 'Raise the vnode limit', check: 'sysctl-check' })
    value(await screenErrands(deps))
    // `[ "$(sysctl -n kern.maxvnodes)" != 526336 ]` with no sysctl on the PATH: exit 0 and a not-found line
    checks['sysctl-check'] = { exit: 0, timedOut: false, output: 'sh: sysctl: command not found' }
    const checked = value(await checkErrandNow(deps, { errandId: raised.errand.id }))
    expect(checked.outcome).toBe('broken')
    expect(await errandRow(raised.errand.id)).toMatchObject({ done_at: null })
    expect((await errandRow(raised.errand.id))?.check_note).toContain(
      'the check is broken: sh: sysctl: command not found',
    )
    // the lead's Issue keeps waiting; the note is on its record for the turn it next gets, once however often the check runs
    value(await checkErrandNow(deps, { errandId: raised.errand.id }))
    const told = await db.sql`
      SELECT payload FROM factory.issue_events WHERE issue_id = ${issueId} AND kind = 'noted'`
    expect(told).toHaveLength(1)
    expect(told[0]?.payload.text).toContain('is broken')
    const [need] = (await readNeeds(db.sql, clock.now())).items
    expect(need?.tried).toContain('the check is broken')
    // his done is accepted: the check says nothing
    const closed = value(await finishErrand(deps, { errandId: raised.errand.id, note: 'it is 526336' }))
    expect(closed.errand).toMatchObject({ closedKind: 'done' })
    expect(closed.errand.doneNote).toContain('the check is broken')
    expect(await issueRow(issueId)).toMatchObject({ state: 'working' })
  })

  test('a command that failed twice is not offered a third time: the lead is told to correct it', async () => {
    const issueId = await workingIssue()
    const raised = await raise(issueId, { summary: 'Release it', cmd: RELEASE })
    value(await screenErrands(deps))
    commandExit = { exit: 2, timedOut: false, output: "error: 'abc' is not a commit" }
    const once = value(await approveErrand(deps, { errandId: raised.errand.id }))
    await once.done
    expect(await errandRow(raised.errand.id)).toMatchObject({ done_at: null, run_attempts: 1, run_status: 'failed' })
    expect((await readNeeds(db.sql, clock.now())).items[0]?.tried).toContain('is not a commit')
    const twice = value(await approveErrand(deps, { errandId: raised.errand.id }))
    await twice.done
    expect(await errandRow(raised.errand.id)).toMatchObject({ closed_kind: 'turned_back', closed_by: 'loop' })
    expect((await errandRow(raised.errand.id))?.done_note).toContain('raise it again with a corrected command')
    expect(await issueRow(issueId)).toMatchObject({ state: 'working' })
    const [event] = await db.sql`
      SELECT payload FROM factory.issue_events WHERE issue_id = ${issueId} AND kind = 'errand_done'`
    expect(event?.payload.turnedAway).toContain('failed 2 times')
    expect(ran).toHaveLength(2)
  })

  test('a request an Issue joined ends for that Issue when the errands loop closes it, when it is replaced, and a repeat of the join is one join', async () => {
    const asked = value(
      await requestErrand(deps, {
        raw: { source: 'test-agent', text: 'Release 78088f16', command: RELEASE, check: 'gate-pending', key: 'gate' },
      }),
    )
    const issueId = await workingIssue()
    const joined = await raise(issueId, { summary: 'Release it for me', cmd: RELEASE, call: 'one' })
    expect(joined).toMatchObject({ result: 'joined', errand: { id: asked.errand.id } })
    expect(await issueRow(issueId)).toMatchObject({ state: 'waiting', wait_reason: 'errand' })
    // the same call again: the same join, not a second one
    expect(await raise(issueId, { summary: 'Release it for me', cmd: RELEASE, call: 'one' })).toMatchObject({
      result: 'replayed',
    })
    expect((await db.sql`SELECT count(*)::int AS n FROM factory.errand_joins`)[0]?.n).toBe(1)

    // the loop's own finding closes the request, and the joined Issue hears it
    checks['gate-pending'] = { exit: 1, timedOut: false, output: 'released' }
    const pass = value(
      await errandsPass({
        uow: deps.uow,
        clock,
        checks: deps.checks,
        needed: { judge: () => Promise.resolve(err(portError('gone', 'no look'))) },
        end: async (errand, how) => {
          const ended = await endRequest(deps, errand.id, how)
          return ended.ok && ended.value
        },
      }),
    )
    expect(pass).toMatchObject({ checkedOut: 1 })
    expect(await errandRow(asked.errand.id)).toMatchObject({ closed_kind: 'not_needed', closed_by: 'check' })
    expect(await issueRow(issueId)).toMatchObject({ state: 'working' })
  })

  test('a request replaced under its key ends for the Issues that joined it', async () => {
    const first = value(
      await requestErrand(deps, { raw: { source: 'test-agent', text: 'Release', command: RELEASE, key: 'gate' } }),
    )
    const issueId = await workingIssue()
    await raise(issueId, { summary: 'Release it for me', cmd: RELEASE })
    expect(await issueRow(issueId)).toMatchObject({ state: 'waiting' })
    const fixed = value(
      await requestErrand(deps, {
        raw: {
          source: 'test-agent',
          text: 'Release',
          command: "ssh mini 'make -C ~/gate deploy-release SHA=feedbeef'",
          key: 'gate',
        },
      }),
    )
    expect(fixed.superseded).toEqual([first.errand.id])
    expect(await issueRow(issueId)).toMatchObject({ state: 'working' })
  })
})
