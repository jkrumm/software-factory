import type { ErrandScreenRequest } from '@software-factory/contract'
import {
  checkErrandScreen,
  ERRAND_SCREEN_BACKOFF_MS,
  ERRAND_SCREEN_MAX_TRIES,
  type ErrandId,
  screenByReview,
  screenByRule,
} from '../domains/checkpoints/errand.ts'
import { closedNote, SCREENED_SOURCES } from '../domains/checkpoints/request.ts'
import { deepLink, errandPage } from '../domains/checkpoints/page.ts'
import type { ErrandRecord } from '../domains/checkpoints/ports.ts'
import type { IssueId } from '../kernel/ids.ts'
import { key } from '../kernel/keys.ts'
import { ok, type PortError, type Result } from '../kernel/result.ts'
import { applied, type CheckpointError, type CheckpointStores, issueOf, waitingOn } from './checkpoints.ts'
import { PASS_LIMIT, type SettleDeps } from './checkpoints-settle.ts'
import { recordIn } from './issues.ts'

export interface ErrandScreened {
  errand: string
  /** `held`: a call failed and is tried again later; `dropped`: it changed under the call */
  outcome: 'held' | 'reached_owner' | 'turned_away' | 'dropped'
}

type Outcome = ErrandScreened['outcome']
type Step<T> = Promise<Result<T, CheckpointError | PortError>>

type Verdict =
  | { kind: 'turn_away'; by: 'rule' | 'judge'; reason: string; awaits?: string }
  | { kind: 'reach'; by: 'judge' | 'failed'; note: string }
  | { kind: 'failed'; why: string }

/** What the screen is told of a request no Issue raised: who asked stands for the repo, and there is no Issue. */
const STANDALONE_KIND = 'request'

/**
 * The Errand under its lock, while it is still open, unscreened and waited for. An Errand the Issue no longer waits for is
 * finished on the spot (no event, no page); anything else that moved under the call drops the result. A request no Issue
 * raised (a screened source: `ask-human`) has no Issue to wait for it.
 */
async function openUnder(
  stores: CheckpointStores,
  deps: SettleDeps,
  id: ErrandId,
  /** the desk pass looks again at an Errand that reached the owner already */
  reached = false,
): Promise<
  { errand: ErrandRecord; issueId: IssueId | null; title: string; repo: string; kind: string } | 'dropped' | 'finished'
> {
  const { work, checkpoints } = stores
  const errand = await checkpoints.lockErrand(id)
  if (!errand || errand.doneAt || (errand.reachedOwnerAt && !reached)) return 'dropped'
  if (!errand.issueId) {
    return errand.source === null
      ? 'dropped'
      : { errand, issueId: null, title: errand.summary, repo: errand.source, kind: STANDALONE_KIND }
  }
  const issue = await issueOf(work, errand.issueId)
  if (issue && waitingOn(issue, 'errand', errand.id)) {
    return { errand, issueId: errand.issueId, title: issue.title, repo: issue.repo, kind: issue.kind }
  }
  const at = deps.clock.now()
  await checkpoints.finishErrand(errand.id, at, 'the Issue no longer waits for it')
  await checkpoints.cancelPages(errand.id, at)
  return 'finished'
}

/** A request carries the command to run too; the screen sees it, the first look by rule reads the words only. */
const screenedDetail = (errand: ErrandRecord): string | null => {
  if (errand.command === null) return errand.detail
  return `${errand.detail ?? ''}\nCommand to run${errand.host ? ` (${errand.host})` : ''}: ${errand.command}`
    .trim()
    .slice(0, 4000)
}

/** The Errand reaches the owner: recorded and paged (the page's key is the Errand's) in one transaction. */
async function reachOwner(
  stores: CheckpointStores,
  deps: SettleDeps,
  found: { errand: ErrandRecord; issueId: IssueId | null; repo: string },
  by: 'judge' | 'failed',
  note: string,
): Promise<void> {
  const at = deps.clock.now()
  const { errand } = found
  await stores.checkpoints.reachOwner(errand.id, { at, by, note, tries: errand.screenTries })
  // a request no Issue raised is on the owner's list through its row; only an Issue's Errand is paged
  if (!found.issueId) return
  await stores.checkpoints.planPage(
    errandPage({
      issue: { id: found.issueId, repo: found.repo },
      link: deepLink(deps.consoleUrl, errand.id),
      errand: errand.id,
      summary: errand.summary,
    }),
    at,
  )
}

/** The Errand is turned away: the wait ends and the lead hears why. */
export async function turnAway(
  stores: CheckpointStores,
  deps: SettleDeps,
  errand: ErrandRecord,
  by: 'rule' | 'judge',
  reason: string,
  awaits?: string,
): Promise<Result<null, CheckpointError>> {
  const { issueId } = errand
  const at = deps.clock.now()
  // a request no Issue raised has no lead to tell: the reason is the Errand's note, which the asker reads when it closes
  if (issueId) {
    const recorded = applied(
      await recordIn(stores.work, deps, {
        issueId,
        key: key('errand_done', errand.id),
        event: {
          kind: 'errand_done',
          payload: { errand: errand.id, turnedAway: reason, ...(awaits ? { awaits: { review: awaits } } : {}) },
          actor: by === 'rule' ? 'factory' : 'judge',
        },
      }),
      'errand_done',
    )
    if (!recorded.ok) return recorded
  }
  await stores.checkpoints.turnAwayErrand(errand.id, { at, by, reason })
  await stores.checkpoints.cancelPages(errand.id, at)
  return ok(null)
}

/** Records what the screen came to, in a new transaction that re-reads the Errand and the Issue under the lock. */
function record(deps: SettleDeps, id: ErrandId, verdict: Verdict, reached = false): Step<Outcome> {
  return deps.uow.run<Outcome, CheckpointError>(async (stores) => {
    const found = await openUnder(stores, deps, id, reached)
    if (found === 'finished' || found === 'dropped') return ok('dropped')
    const { errand } = found
    if (verdict.kind === 'turn_away') {
      const turned = await turnAway(stores, deps, errand, verdict.by, verdict.reason, verdict.awaits)
      return turned.ok ? ok('turned_away') : turned
    }
    if (verdict.kind === 'reach') {
      await reachOwner(stores, deps, found, verdict.by, verdict.note)
      return ok('reached_owner')
    }
    const tries = errand.screenTries + 1
    if (tries < ERRAND_SCREEN_MAX_TRIES) {
      const at = deps.clock.now()
      await stores.checkpoints.failErrandScreen(errand.id, {
        tries,
        retryAt: new Date(at.getTime() + ERRAND_SCREEN_BACKOFF_MS),
        note: verdict.why.slice(0, 300),
      })
      return ok('held')
    }
    await reachOwner(
      stores,
      deps,
      { ...found, errand: { ...errand, screenTries: tries } },
      'failed',
      `the screen could not be reached after ${ERRAND_SCREEN_MAX_TRIES} tries: ${verdict.why}`,
    )
    return ok('reached_owner')
  })
}

/**
 * Screens one Errand: the rules, then the `factory-errand` workflow through its port (no transaction open), then the owner.
 * A screen that cannot be reached is tried again after a backoff, and after the last try the Errand reaches the owner
 * unscreened.
 */
async function screenErrand(deps: SettleDeps, id: ErrandId): Step<ErrandScreened> {
  const first = await deps.uow.run<
    | { request: ErrandScreenRequest; errand: ErrandRecord }
    | 'dropped'
    | 'finished'
    | { rule: string; awaits?: string; errand: ErrandRecord },
    CheckpointError
  >(async (stores) => {
    const found = await openUnder(stores, deps, id)
    if (found === 'dropped' || found === 'finished') return ok(found)
    const { errand } = found
    const review = screenByReview(errand)
    if (review) return ok({ rule: review.reason, awaits: review.review, errand })
    const turned = screenByRule(errand)
    if (turned) return ok({ rule: turned.reason, errand })
    return ok({
      errand,
      request: {
        errand: { id: errand.id, summary: errand.summary, detail: screenedDetail(errand) },
        issue: { id: found.issueId ?? errand.id, repo: found.repo, title: found.title, kind: found.kind },
      },
    })
  })
  if (!first.ok) return first
  if (first.value === 'dropped' || first.value === 'finished') return ok({ errand: id, outcome: 'dropped' })

  if ('rule' in first.value) {
    const done = await record(deps, id, {
      kind: 'turn_away',
      by: 'rule',
      reason: first.value.rule,
      ...(first.value.awaits ? { awaits: first.value.awaits } : {}),
    })
    return done.ok ? ok({ errand: id, outcome: done.value }) : done
  }

  const { request, errand } = first.value
  const answer = await deps.errandScreen.screen(request, key('factory-errand', id, errand.screenTries + 1))
  let verdict: Verdict
  if (!answer.ok) verdict = { kind: 'failed', why: `${answer.error.kind}: ${answer.error.detail}` }
  else {
    const checked = checkErrandScreen(answer.value)
    if (checked.action === 'refused') verdict = { kind: 'failed', why: checked.why }
    else if (checked.action === 'pass') verdict = { kind: 'reach', by: 'judge', note: checked.note }
    else verdict = { kind: 'turn_away', by: 'judge', reason: checked.reason }
  }
  const done = await record(deps, id, verdict)
  return done.ok ? ok({ errand: id, outcome: done.value }) : done
}

/** One pass over the Errands the screen holds, oldest first. */
export async function screenErrands(deps: SettleDeps, limit = PASS_LIMIT): Step<ErrandScreened[]> {
  const held = await deps.uow.run(async ({ checkpoints }) =>
    ok(await checkpoints.unscreenedErrands(deps.clock.now(), limit)),
  )
  if (!held.ok) return held
  const screened: ErrandScreened[] = []
  for (const errand of held.value) {
    const result = await screenErrand(deps, errand.id)
    if (result.ok) screened.push(result.value)
    else console.error(`checkpoints: ${errand.id} could not be screened: ${JSON.stringify(result.error)}`)
  }
  return ok(screened)
}

/** What the desk pass's second look at an Errand that reached the owner came to. */
export type Rescreened = 'turned_away' | 'kept' | 'dropped'

/**
 * The desk pass looks again at an Errand that reached the owner: the same rules and the same `factory-errand` workflow as
 * the first screen, because an agent may be able to do now what it could not (a token was minted, a route was added). Only
 * a turn-away changes anything, and it ends the wait exactly as the first screen's does; a pass, or a screen that cannot be
 * reached, leaves the Errand where it was and is not counted as a try.
 */
export async function rescreenErrand(deps: SettleDeps, id: ErrandId): Step<Rescreened> {
  const first = await deps.uow.run<
    { request: ErrandScreenRequest } | { rule: string; awaits?: string } | 'dropped',
    CheckpointError
  >(async (stores) => {
    const errand = await stores.checkpoints.errand(id)
    if (!errand || errand.doneAt || !errand.reachedOwnerAt) return ok('dropped')
    const screened = errand.issueId !== null || (errand.source !== null && SCREENED_SOURCES.includes(errand.source))
    if (!screened) return ok('dropped')
    const issue = errand.issueId ? await issueOf(stores.work, errand.issueId) : null
    if (errand.issueId && !issue) return ok('dropped')
    const review = screenByReview(errand)
    if (review) return ok({ rule: review.reason, awaits: review.review })
    const turned = screenByRule(errand)
    if (turned) return ok({ rule: turned.reason })
    return ok({
      request: {
        errand: { id: errand.id, summary: errand.summary, detail: screenedDetail(errand) },
        issue: {
          id: errand.issueId ?? errand.id,
          repo: issue?.repo ?? errand.source ?? 'unknown',
          title: issue?.title ?? errand.summary,
          kind: issue?.kind ?? STANDALONE_KIND,
        },
      },
    })
  })
  if (!first.ok) return first
  if (first.value === 'dropped') return ok('dropped')
  if ('rule' in first.value) {
    const done = await record(
      deps,
      id,
      {
        kind: 'turn_away',
        by: 'rule',
        reason: first.value.rule,
        ...(first.value.awaits ? { awaits: first.value.awaits } : {}),
      },
      true,
    )
    return done.ok ? ok(done.value === 'turned_away' ? 'turned_away' : 'dropped') : done
  }
  const answer = await deps.errandScreen.screen(
    first.value.request,
    key('factory-errand', id, 'desk', Math.floor(deps.clock.now().getTime() / 3_600_000)),
  )
  if (!answer.ok) return ok('kept')
  const checked = checkErrandScreen(answer.value)
  if (checked.action !== 'turn_away') return ok('kept')
  const done = await record(deps, id, { kind: 'turn_away', by: 'judge', reason: checked.reason }, true)
  return done.ok ? ok(done.value === 'turned_away' ? 'turned_away' : 'dropped') : done
}

/**
 * An Errand whose check no longer says it is needed is closed `not_needed` by its check. An Issue that waits on it moves on
 * with `errand_done` (`resolved`: what the check said), so the lead hears that nothing is left to do; a request has no one
 * to tell. False when the Errand closed under the call (the owner acted first).
 */
export async function resolveErrand(deps: SettleDeps, id: ErrandId, why: string): Step<boolean> {
  return deps.uow.run<boolean, CheckpointError>(async ({ work, checkpoints }) => {
    const errand = await checkpoints.lockErrand(id)
    if (!errand || errand.doneAt) return ok(false)
    const at = deps.clock.now()
    if (errand.issueId) {
      const issue = await issueOf(work, errand.issueId)
      if (issue && waitingOn(issue, 'errand', errand.id)) {
        const recorded = applied(
          await recordIn(work, deps, {
            issueId: errand.issueId,
            key: key('errand_done', errand.id),
            event: { kind: 'errand_done', payload: { errand: errand.id, resolved: why }, actor: 'factory' },
          }),
          'errand_done',
        )
        if (!recorded.ok) return recorded
      }
    }
    await checkpoints.finishErrand(errand.id, at, closedNote('not_needed', why), { kind: 'not_needed', by: 'check' })
    await checkpoints.cancelPages(errand.id, at)
    return ok(true)
  })
}
