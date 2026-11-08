import type { ErrandScreenRequest } from '@software-factory/contract'
import {
  checkErrandScreen,
  ERRAND_SCREEN_BACKOFF_MS,
  ERRAND_SCREEN_MAX_TRIES,
  type ErrandId,
  screenByRule,
} from '../domains/checkpoints/errand.ts'
import { deepLink, errandPage } from '../domains/checkpoints/page.ts'
import type { ErrandRecord } from '../domains/checkpoints/ports.ts'
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
  | { kind: 'turn_away'; by: 'rule' | 'judge'; reason: string }
  | { kind: 'reach'; by: 'judge' | 'failed'; note: string }
  | { kind: 'failed'; why: string }

/**
 * The Errand under its lock, while it is still open, unscreened and waited for. An Errand the Issue no longer waits for is
 * finished on the spot (no event, no page); anything else that moved under the call drops the result.
 */
async function openUnder(
  stores: CheckpointStores,
  deps: SettleDeps,
  id: ErrandId,
): Promise<{ errand: ErrandRecord; title: string; repo: string; kind: string } | 'dropped' | 'finished'> {
  const { work, checkpoints } = stores
  const errand = await checkpoints.lockErrand(id)
  if (!errand || errand.doneAt || errand.reachedOwnerAt) return 'dropped'
  const issue = await issueOf(work, errand.issueId)
  if (issue && waitingOn(issue, 'errand', errand.id)) {
    return { errand, title: issue.title, repo: issue.repo, kind: issue.kind }
  }
  const at = deps.clock.now()
  await checkpoints.finishErrand(errand.id, at, 'the Issue no longer waits for it')
  await checkpoints.cancelPages(errand.id, at)
  return 'finished'
}

/** The Errand reaches the owner: recorded and paged (the page's key is the Errand's) in one transaction. */
async function reachOwner(
  stores: CheckpointStores,
  deps: SettleDeps,
  found: { errand: ErrandRecord; repo: string },
  by: 'judge' | 'failed',
  note: string,
): Promise<void> {
  const at = deps.clock.now()
  const { errand } = found
  await stores.checkpoints.reachOwner(errand.id, { at, by, note, tries: errand.screenTries })
  await stores.checkpoints.planPage(
    errandPage({
      issue: { id: errand.issueId, repo: found.repo },
      link: deepLink(deps.consoleUrl, errand.id),
      errand: errand.id,
      summary: errand.summary,
    }),
    at,
  )
}

/** The Errand is turned away: the wait ends and the lead hears why. */
async function turnAway(
  stores: CheckpointStores,
  deps: SettleDeps,
  errand: ErrandRecord,
  by: 'rule' | 'judge',
  reason: string,
): Promise<Result<null, CheckpointError>> {
  const at = deps.clock.now()
  const recorded = applied(
    await recordIn(stores.work, deps, {
      issueId: errand.issueId,
      key: key('errand_done', errand.id),
      event: {
        kind: 'errand_done',
        payload: { errand: errand.id, turnedAway: reason },
        actor: by === 'rule' ? 'factory' : 'judge',
      },
    }),
    'errand_done',
  )
  if (!recorded.ok) return recorded
  await stores.checkpoints.turnAwayErrand(errand.id, { at, by, reason })
  await stores.checkpoints.cancelPages(errand.id, at)
  return ok(null)
}

/** Records what the screen came to, in a new transaction that re-reads the Errand and the Issue under the lock. */
function record(deps: SettleDeps, id: ErrandId, verdict: Verdict): Step<Outcome> {
  return deps.uow.run<Outcome, CheckpointError>(async (stores) => {
    const found = await openUnder(stores, deps, id)
    if (found === 'finished' || found === 'dropped') return ok('dropped')
    const { errand } = found
    if (verdict.kind === 'turn_away') {
      const turned = await turnAway(stores, deps, errand, verdict.by, verdict.reason)
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
    | { rule: string; errand: ErrandRecord },
    CheckpointError
  >(async (stores) => {
    const found = await openUnder(stores, deps, id)
    if (found === 'dropped' || found === 'finished') return ok(found)
    const { errand } = found
    const turned = screenByRule(errand)
    if (turned) return ok({ rule: turned.reason, errand })
    return ok({
      errand,
      request: {
        errand: { id: errand.id, summary: errand.summary, detail: errand.detail },
        issue: { id: errand.issueId, repo: found.repo, title: found.title, kind: found.kind },
      },
    })
  })
  if (!first.ok) return first
  if (first.value === 'dropped' || first.value === 'finished') return ok({ errand: id, outcome: 'dropped' })

  if ('rule' in first.value) {
    const done = await record(deps, id, { kind: 'turn_away', by: 'rule', reason: first.value.rule })
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
