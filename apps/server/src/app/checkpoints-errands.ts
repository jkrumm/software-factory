import type { ErrandScreenRequest } from '@software-factory/contract'
import {
  checkErrandScreen,
  ERRAND_SCREEN_BACKOFF_MS,
  ERRAND_SCREEN_MAX_TRIES,
  type ErrandId,
  errandScreenDetail,
  screenByReview,
  screenByNeed,
  screenByRule,
} from '../domains/checkpoints/errand.ts'
import { MAX_RUN_TRIES, type Need, needOf, ranStillNeededNote } from '../domains/checkpoints/need.ts'
import { closedNote, SCREENED_SOURCES } from '../domains/checkpoints/request.ts'
import { type MacbookVerb, verbFor, verbWords } from '../domains/checkpoints/triage.ts'
import { firstErrorLine, outputNote } from '../kernel/run.ts'
import { deepLink, errandPage } from '../domains/checkpoints/page.ts'
import type { ErrandRecord, MacbookVerbPort } from '../domains/checkpoints/ports.ts'
import type { IssueId } from '../kernel/ids.ts'
import { key } from '../kernel/keys.ts'
import { WORKFLOWS } from '../kernel/workflows.ts'
import { ok, type PortError, type Result } from '../kernel/result.ts'
import {
  applied,
  type CheckpointError,
  type CheckpointStores,
  eachJoined,
  endJoined,
  issueOf,
  retireFailed,
  turnBackErrandWith,
  waitingOn,
} from './checkpoints.ts'
import { PASS_LIMIT, type SettleDeps } from './checkpoints-settle.ts'
import { recordIn } from './issues.ts'

/** the composition passes it to the health lines, which import no domain code */
export { MAX_RUN_TRIES }

export interface ErrandScreened {
  errand: string
  /** `held`: a call failed and is tried again later; `dropped`: it changed under the call */
  outcome: 'held' | 'reached_owner' | 'turned_away' | 'ran' | 'dropped'
}

type Outcome = ErrandScreened['outcome']
type Step<T> = Promise<Result<T, CheckpointError | PortError>>

type Verdict =
  | { kind: 'turn_away'; by: 'rule' | 'judge'; reason: string; awaits?: string }
  | { kind: 'reach'; by: 'rule' | 'judge' | 'failed'; note: string; need: Need | null }
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
  // whoever joined it is told: the Errand is gone, and the lead raises it again
  const ended = await endJoined(stores, deps, errand, {
    turnedAway: 'the Issue that raised it no longer waits for it, so it ended: raise it again if it still applies',
  })
  if (!ended.ok) throw new Error(`errand ${errand.id} could not end its joined Issues: ${JSON.stringify(ended.error)}`)
  await checkpoints.finishErrand(errand.id, at, 'the Issue no longer waits for it')
  await checkpoints.cancelPages(errand.id, at)
  return 'finished'
}

/** The Errand reaches the owner: recorded and paged (the page's key is the Errand's) in one transaction. */
async function reachOwner(
  stores: CheckpointStores,
  deps: SettleDeps,
  found: { errand: ErrandRecord; issueId: IssueId | null; repo: string },
  by: 'rule' | 'judge' | 'failed',
  note: string,
  /** what the screen found it needs; null: the rule over its shape, else `hands` */
  need: Need | null,
): Promise<void> {
  const at = deps.clock.now()
  const { errand } = found
  await stores.checkpoints.reachOwner(errand.id, {
    at,
    by,
    note,
    tries: errand.screenTries,
    need: needOf(errand, need),
  })
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
  const end = async (issue: IssueId): Promise<Result<unknown, CheckpointError>> =>
    applied(
      await recordIn(stores.work, deps, {
        issueId: issue,
        key: key('errand_done', errand.id, ...(issue === errand.issueId ? [] : [issue])),
        event: {
          kind: 'errand_done',
          payload: { errand: errand.id, turnedAway: reason, ...(awaits ? { awaits: { review: awaits } } : {}) },
          actor: by === 'rule' ? 'factory' : 'judge',
        },
      }),
      'errand_done',
    )
  // a request no Issue raised has no lead to tell: the reason is the Errand's note, which the asker reads when it closes
  if (issueId) {
    const recorded = await end(issueId)
    if (!recorded.ok) return recorded
  }
  const joined = await eachJoined(stores, errand, end)
  if (!joined.ok) return joined
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
      await reachOwner(stores, deps, found, verdict.by, verdict.note, verdict.need)
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
      null,
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
    | { rule: string; awaits?: string; errand: ErrandRecord }
    | { verb: MacbookVerb; errand: ErrandRecord }
    | { reach: string; need: Need; errand: ErrandRecord },
    CheckpointError
  >(async (stores) => {
    const found = await openUnder(stores, deps, id)
    if (found === 'dropped' || found === 'finished') return ok(found)
    const { errand } = found
    const review = screenByReview(errand)
    if (review) return ok({ rule: review.reason, awaits: review.review, errand })
    // a command that is exactly a report or a pull of a fixed MacBook verb runs with no dialog, before any other look
    // an Errand with its own check is not run here: the check decides whether it is still needed, and only the owner's done reads it
    const verb = deps.macbook && errand.checkCommand === null ? verbFor(errand) : null
    if (verb) return ok({ verb, errand })
    const shaped = screenByNeed(errand)
    if (shaped) return ok({ reach: shaped.note, need: shaped.need, errand })
    const turned = screenByRule(errand)
    if (turned) return ok({ rule: turned.reason, errand })
    return ok({
      errand,
      request: {
        errand: { id: errand.id, summary: errand.summary, detail: errandScreenDetail(errand) },
        issue: { id: found.issueId ?? errand.id, repo: found.repo, title: found.title, kind: found.kind },
      },
    })
  })
  if (!first.ok) return first
  if (first.value === 'dropped' || first.value === 'finished') return ok({ errand: id, outcome: 'dropped' })

  if ('verb' in first.value && deps.macbook) return viaMacbook(deps, deps.macbook, id, first.value.verb)
  if ('verb' in first.value) return ok({ errand: id, outcome: 'dropped' })

  if ('reach' in first.value) {
    const done = await record(deps, id, { kind: 'reach', by: 'rule', note: first.value.reach, need: first.value.need })
    return done.ok ? ok({ errand: id, outcome: done.value }) : done
  }

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
  const answer = await deps.agw.run('errandScreen', request, WORKFLOWS.errandScreen.key(id, errand.screenTries + 1))
  let verdict: Verdict
  if (!answer.ok) verdict = { kind: 'failed', why: `${answer.error.kind}: ${answer.error.detail}` }
  else {
    const checked = checkErrandScreen(answer.value)
    if (checked.action === 'refused') verdict = { kind: 'failed', why: checked.why }
    else if (checked.action === 'pass') verdict = { kind: 'reach', by: 'judge', note: checked.note, need: checked.need }
    else verdict = { kind: 'turn_away', by: 'judge', reason: checked.reason }
  }
  const done = await record(deps, id, verdict)
  return done.ok ? ok({ errand: id, outcome: done.value }) : done
}

/**
 * Runs an Errand's fixed MacBook verb through its port (no transaction open) and closes the Errand with what it printed: the
 * lead hears it as its next note and the owner is never paged. A verb that did not run (the gate refuses it, the MacBook does not
 * answer, git refused the pull) leaves the command with the owner, as a `place` Errand, with the reason in its note.
 */
async function viaMacbook(
  deps: SettleDeps,
  port: MacbookVerbPort,
  id: ErrandId,
  verb: MacbookVerb,
): Step<ErrandScreened> {
  const answer = await port.run(verb)
  const said = `MacBook verb "${verbWords(verb).join(' ')}"`
  const failed = !answer.ok
    ? answer.error.detail
    : answer.value.exit === 126
      ? "the MacBook's gate does not serve that verb"
      : answer.value.exit === 255
        ? 'the MacBook did not answer'
        : answer.value.exit === 0
          ? null
          : `it exited ${answer.value.exit}: ${firstErrorLine(answer.value.output)}`
  if (answer.ok && failed === null) {
    const finished = await finishRan(
      deps,
      id,
      `${said}: ${outputNote(answer.value.output) || '(no output)'}`.slice(0, 1800),
    )
    return finished.ok ? ok({ errand: id, outcome: finished.value ? 'ran' : 'dropped' }) : finished
  }
  const done = await record(deps, id, {
    kind: 'reach',
    by: 'rule',
    need: 'place',
    note: `the factory tried the ${said} and it did not run (${failed ?? 'unknown'}): the command is his to run`.slice(
      0,
      300,
    ),
  })
  return done.ok ? ok({ errand: id, outcome: done.value }) : done
}

/**
 * An Errand the factory ran itself through a fixed MacBook verb ends `done` (closed by the loop, never by the owner): the Issue
 * that waits on it, and every Issue that joined it, hear what the verb printed. False when it closed under the call.
 */
async function finishRan(deps: SettleDeps, id: ErrandId, ran: string): Step<boolean> {
  return deps.uow.run<boolean, CheckpointError>(async (stores) => {
    const found = await openUnder(stores, deps, id)
    if (found === 'dropped' || found === 'finished') return ok(false)
    const { errand } = found
    const at = deps.clock.now()
    const end = async (issueId: IssueId): Promise<Result<unknown, CheckpointError>> =>
      applied(
        await recordIn(stores.work, deps, {
          issueId,
          key: key('errand_done', errand.id, ...(issueId === errand.issueId ? [] : [issueId])),
          event: { kind: 'errand_done', payload: { errand: errand.id, ran }, actor: 'factory' },
        }),
        'errand_done',
      )
    if (errand.issueId) {
      const ended = await end(errand.issueId)
      if (!ended.ok) return ended
    }
    const joined = await eachJoined(stores, errand, end)
    if (!joined.ok) return joined
    await stores.checkpoints.finishErrand(errand.id, at, ran.slice(0, 1500), { kind: 'done', by: 'loop' })
    await stores.checkpoints.cancelPages(errand.id, at)
    return ok(true)
  })
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
    // a step the shape settles (a secret on his MacBook, an approval) stays with him: the screen model does not know the policy
    if (screenByNeed(errand)) return ok('dropped')
    const turned = screenByRule(errand)
    if (turned) return ok({ rule: turned.reason })
    return ok({
      request: {
        errand: { id: errand.id, summary: errand.summary, detail: errandScreenDetail(errand) },
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
  const answer = await deps.agw.run(
    'errandScreen',
    first.value.request,
    WORKFLOWS.errandScreen.key(id, 'desk', Math.floor(deps.clock.now().getTime() / 3_600_000)),
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
    const end = async (issueId: IssueId): Promise<Result<unknown, CheckpointError>> =>
      applied(
        await recordIn(work, deps, {
          issueId,
          key: key('errand_done', errand.id, ...(issueId === errand.issueId ? [] : [issueId])),
          event: { kind: 'errand_done', payload: { errand: errand.id, resolved: why }, actor: 'factory' },
        }),
        'errand_done',
      )
    if (errand.issueId) {
      const issue = await issueOf(work, errand.issueId)
      if (issue && waitingOn(issue, 'errand', errand.id)) {
        const recorded = await end(errand.issueId)
        if (!recorded.ok) return recorded
      }
    }
    const joined = await eachJoined({ work, checkpoints }, errand, end)
    if (!joined.ok) return joined
    await checkpoints.finishErrand(errand.id, at, closedNote('not_needed', why), { kind: 'not_needed', by: 'check' })
    await checkpoints.cancelPages(errand.id, at)
    return ok(true)
  })
}

/**
 * The Errand's check cannot answer (a command in it is not found): the lead whose Issue waits on it, and every Issue that
 * joined it, get it once as a note on their record (a waiting lead reads it at its next turn; it does not wake it), so the check is fixed or the Errand raised again without one. The owner reads the same
 * words as the Errand's check note on Needs you. A request has no lead; its note is its asker's.
 */
export async function tellCheckBroken(deps: SettleDeps, errand: ErrandRecord, line: string): Step<null> {
  return deps.uow.run<null, CheckpointError>(async (stores) => {
    const said = `The check of your Errand "${errand.summary}" is broken (${line || 'a command was not found'}): it cannot say whether the Errand is still needed, so it stays open until the owner marks it done. Raise it again with a working check if you can.`
    const tell = async (issueId: IssueId): Promise<Result<unknown, CheckpointError>> =>
      applied(
        await recordIn(stores.work, deps, {
          issueId,
          key: key('noted', 'check_broken', errand.id, issueId),
          event: { kind: 'noted', payload: { text: said }, actor: 'factory' },
        }),
        'noted',
      )
    if (errand.issueId) {
      const issue = await issueOf(stores.work, errand.issueId)
      if (issue && waitingOn(issue, 'errand', errand.id)) {
        const told = await tell(errand.issueId)
        if (!told.ok) return told
      }
    }
    const joined = await eachJoined(stores, errand, tell)
    return joined.ok ? ok(null) : joined
  })
}

/**
 * An open Errand whose command already came back unsuccessful `MAX_RUN_TRIES` times (a run recorded before the second failure
 * ended it, or one the desk pass finds): it ends, and its lead or asker is told to correct the command. False when it closed
 * under the call or its runs are not that many.
 */
export async function retireErrand(deps: SettleDeps, id: ErrandId): Step<boolean> {
  return deps.uow.run<boolean, CheckpointError>(async (stores) => {
    const errand = await stores.checkpoints.lockErrand(id)
    if (
      !errand ||
      errand.doneAt ||
      errand.runAttempts < MAX_RUN_TRIES ||
      errand.runStatus === 'running' ||
      errand.runStatus === 'done'
    )
      return ok(false)
    const retired = await retireFailed(stores, deps, errand)
    return retired.ok ? ok(true) : retired
  })
}

/**
 * An open Errand whose pushed command already ran and exited 0, and whose check still says the step is needed (`checkLine`:
 * what that check said just now): it is not pushed again, since a second run may repeat what the first did. It ends, and its
 * lead or asker is told with the check's words to raise it again with a command that is safe to repeat. False when it closed
 * under the call or has no such run, so a repeat of the call tells nobody twice.
 */
export async function turnBackRan(deps: SettleDeps, id: ErrandId, checkLine: string): Step<boolean> {
  return deps.uow.run<boolean, CheckpointError>(async (stores) => {
    const errand = await stores.checkpoints.lockErrand(id)
    if (!errand || errand.doneAt || errand.runStatus !== 'done') return ok(false)
    const turned = await turnBackErrandWith(stores, deps, errand, ranStillNeededNote(checkLine))
    return turned.ok ? ok(true) : turned
  })
}

/**
 * Gives an open Errand that reached the owner with no `need` the one its shape says (`needOf`): the Errands that were
 * open when the field arrived. A pass over a few at a time; the screen sets it for every Errand after.
 */
export async function assignNeeds(deps: SettleDeps, limit = PASS_LIMIT): Step<number> {
  return deps.uow.run<number, CheckpointError>(async ({ checkpoints }) => {
    let assigned = 0
    for (const errand of await checkpoints.needlessErrands(limit)) {
      if (await checkpoints.setNeed(errand.id, needOf(errand))) assigned++
    }
    return ok(assigned)
  })
}

/**
 * A request (no Issue raised it) ends by a loop's own finding: its check says it is not needed, it expired, or the
 * still-needed look said so. Every Issue that joined it hears the end in the same transaction. False when it closed under
 * the call.
 */
export async function endRequest(
  deps: SettleDeps,
  id: ErrandId,
  how: { kind: 'not_needed' | 'expired'; by: 'check' | 'judge' | 'loop'; why: string },
): Step<boolean> {
  return deps.uow.run<boolean, CheckpointError>(async (stores) => {
    const errand = await stores.checkpoints.lockErrand(id)
    if (!errand || errand.doneAt) return ok(false)
    const at = deps.clock.now()
    const ended = await endJoined(
      stores,
      deps,
      errand,
      how.kind === 'expired'
        ? { turnedAway: `it expired (${how.why}): raise it again if it still applies` }
        : { resolved: how.why },
    )
    if (!ended.ok) return ended
    await stores.checkpoints.finishErrand(errand.id, at, closedNote(how.kind, how.why), { kind: how.kind, by: how.by })
    await stores.checkpoints.cancelPages(errand.id, at)
    return ok(true)
  })
}
