import {
  defaultDue,
  type DecisionForm,
  type DecisionId,
  guardVerdict,
  JUDGE_MAX_TRIES,
  judgeInputOf,
  matchPolicy,
  precedentTerms,
  type Settler,
} from '../domains/checkpoints/decision.ts'
import type { Precedent } from '../domains/checkpoints/decision.ts'
import { decisionPage, deepLink } from '../domains/checkpoints/page.ts'
import {
  type ErrandScreenPort,
  type SpecScreenPort,
  type JudgePort,
  type DecisionRecord,
  type DecisionStatus,
  type StandingPolicies,
  type StepClaim,
  statusOf,
} from '../domains/checkpoints/ports.ts'
import { key } from '../kernel/keys.ts'
import { err, ok, type PortError, type Result } from '../kernel/result.ts'
import {
  type CheckpointDeps,
  type CheckpointError,
  type CheckpointStores,
  answerIn,
  formDigest,
  issueOf,
  waitingOn,
} from './checkpoints.ts'

export interface SettleDeps extends CheckpointDeps {
  policies: StandingPolicies
  judge: JudgePort
  errandScreen: ErrandScreenPort
  specScreen: SpecScreenPort
  /** a checkpoint at the owner this long is looked at once more (`FACTORY_CHECKPOINT_RECHECK_MS`); 0 is off */
  recheckAfterMs: number
}

/**
 * A claimed call is held this long. The Judge's hang guard is 30 minutes (`adapters/agw-ask`), so a lease that outlives it
 * lets a second pass take over only after the first call can no longer be running.
 */
export const STEP_LEASE_MS = 35 * 60_000

/** The Decisions one pass looks at. */
export const PASS_LIMIT = 20

export interface Settled {
  decision: DecisionId
  status: DecisionStatus
  settledBy: Settler | null
}

const settledOf = (decision: DecisionRecord): Settled => ({
  decision: decision.id,
  status: statusOf(decision),
  settledBy: decision.settledBy,
})

type Step<T> = Promise<Result<T, CheckpointError | PortError>>

/** A race lost is not a failure: another pass or the owner answered first. */
const lostRace = (error: CheckpointError | PortError): boolean => error.kind === 'already_answered'

/**
 * Settles one Decision as far as it can go now, in turn: standing policy, then the Judge, then the default when its wait
 * has run out and its option is reversible, then the owner. Each step records who settled it. A step with a call
 * claims and commits, calls its port with no transaction open, and records the result in a new transaction; every call
 * has a deterministic key, so a replayed pass answers nothing twice. A Decision with a default that is not due yet is
 * left for the owner to see in the Console and for a later pass to default; one without a default reaches the owner now,
 * and only then is he paged.
 */
export async function settleDecision(deps: SettleDeps, id: DecisionId): Step<Settled> {
  const first = await deps.uow.run(async ({ work, checkpoints }) => {
    const decision = await checkpoints.decision(id)
    if (!decision) return err({ kind: 'not_found', what: 'Decision', id } as const)
    if (statusOf(decision) !== 'open') return ok({ decision, title: '', waiting: false })
    const issue = await issueOf(work, decision.issueId)
    // The Issue stopped waiting for it (closed, cancelled): nothing to call, and no Judge run to waste.
    if (!issue || !waitingOn(issue, 'decision', decision.id)) {
      const at = deps.clock.now()
      await checkpoints.withdrawDecision(decision.id, 'the Issue no longer waits for it', at)
      await checkpoints.cancelPages(decision.id, at)
      return ok({ decision: (await checkpoints.decision(decision.id)) ?? decision, title: '', waiting: false })
    }
    return ok({ decision, title: issue.title, waiting: true })
  })
  if (!first.ok) return first
  if (!first.value.waiting) return ok(settledOf(first.value.decision))
  const { title } = first.value

  let judging = false
  for (const step of [policyStep, judgeStep, defaultStep]) {
    const stepped = await step(deps, first.value.decision, title)
    if (!stepped.ok) return lostRace(stepped.error) ? current(deps, id) : stepped
    // A call of another pass is in flight: leave the Decision as it is. Going on to the owner now would page him for work
    // the factory is about to settle.
    if (stepped.value === BUSY) return current(deps, id)
    // The Judge has not seen it yet (its call failed and tries are left): the default may still come due, the owner waits.
    if (stepped.value === RETRY) {
      judging = true
      continue
    }
    if (stepped.value) return ok(settledOf(stepped.value))
  }
  if (judging) return current(deps, id)
  const owner = await ownerStep(deps, first.value.decision)
  if (!owner.ok) return owner
  return current(deps, id)
}

async function current(deps: CheckpointDeps, id: DecisionId): Step<Settled> {
  return deps.uow.run(async ({ checkpoints }) => {
    const decision = await checkpoints.decision(id)
    return decision ? ok(settledOf(decision)) : err({ kind: 'not_found', what: 'Decision', id } as const)
  })
}

/**
 * What a step came to: it settled the Decision, it passed it on (null), another pass's call is running or the Decision
 * changed under the call (`busy`: the next pass takes it up), or the Judge failed with tries left (`retry`).
 */
const BUSY = 'busy' as const
const RETRY = 'retry' as const
type Stepped = DecisionRecord | typeof BUSY | typeof RETRY | null
type StepResult = Step<Stepped>

/**
 * The Decision under its lock, when it is still open and still the form the call was made on. An amend while a call was in
 * flight clears the steps and changes the form: the late result must answer nothing.
 */
async function unchanged(
  checkpoints: CheckpointStores['checkpoints'],
  id: DecisionId,
  form: DecisionForm,
): Promise<DecisionRecord | null> {
  const fresh = await checkpoints.lockDecision(id)
  if (!fresh || statusOf(fresh) !== 'open') return null
  return formDigest(fresh.form) === formDigest(form) ? fresh : null
}

const answered = (outcome: Awaited<ReturnType<typeof answerIn>>): Result<DecisionRecord, CheckpointError> =>
  outcome.ok ? ok(outcome.value.decision) : outcome

/** Standing policy: the project's rules, read through a port. */
async function policyStep(deps: SettleDeps, decision: DecisionRecord): StepResult {
  const now = deps.clock.now()
  const claimed = await deps.uow.run(async ({ checkpoints }) =>
    ok(await checkpoints.claimStep(decision.id, 'policy', now, new Date(now.getTime() + STEP_LEASE_MS))),
  )
  if (!claimed.ok) return claimed
  if (claimed.value === 'in_flight') return ok(BUSY)
  if (claimed.value !== 'claimed') return ok(null)

  const rules = await deps.policies.rulesFor(decision.repo)
  const recorded = await deps.uow.run<Stepped, CheckpointError>(async (stores) => {
    const at = deps.clock.now()
    const { checkpoints } = stores
    if (!(await unchanged(checkpoints, decision.id, decision.form))) return ok(BUSY)
    if (!rules.ok) {
      await checkpoints.finishStep(decision.id, 'policy', {
        outcome: 'failed',
        detail: `${rules.error.kind}: ${rules.error.detail}`,
        at,
      })
      return ok(null)
    }
    const match = matchPolicy(rules.value, decision.form)
    if (!match) {
      await checkpoints.finishStep(decision.id, 'policy', { outcome: 'passed', detail: 'no rule matches', at })
      return ok(null)
    }
    await checkpoints.finishStep(decision.id, 'policy', { outcome: 'answered', detail: match.rule.when, at })
    const outcome = await answerIn(stores, deps, {
      decision,
      text: match.answer,
      by: 'policy',
      source: match.rule.reason,
      note: `Answered by the project's standing policy (${match.rule.reason}): ${match.answer}. The owner can overrule it with a note.`,
    })
    return outcome.ok && outcome.value.status === 'answered' ? answered(outcome) : outcome.ok ? ok(null) : outcome
  })
  return releaseOnError(deps, decision, 'policy', recorded)
}

/** The Judge: precedent from the ledger, then the `factory-ask` workflow through its port. */
async function judgeStep(deps: SettleDeps, decision: DecisionRecord, title: string): StepResult {
  const now = deps.clock.now()
  const claimed = await deps.uow.run<{ precedents: Precedent[]; tries: number } | Exclude<StepClaim, 'claimed'>, never>(
    async ({ checkpoints }) => {
      const claim = await checkpoints.claimStep(decision.id, 'judge', now, new Date(now.getTime() + STEP_LEASE_MS))
      if (claim !== 'claimed') return ok(claim)
      const terms = precedentTerms(decision.form.question)
      const tries = (await checkpoints.decision(decision.id))?.steps.find((step) => step.step === 'judge')?.tries ?? 1
      return ok({
        precedents: terms ? await checkpoints.precedents(terms, { excluding: decision.id, limit: 5 }) : [],
        tries,
      })
    },
  )
  if (!claimed.ok) return claimed
  if (claimed.value === 'in_flight') return ok(BUSY)
  if (claimed.value === 'retry_later') return ok(RETRY)
  if (claimed.value === 'done') return ok(null)

  const input = judgeInputOf({
    decision: decision.id,
    repo: decision.repo,
    issue: title,
    form: decision.form,
    precedents: claimed.value.precedents,
  })
  // The key names the try and the form: a retry or a re-judge of an amended form must not find the earlier run.
  const verdict = await deps.judge.judge(
    input,
    key('factory-ask', decision.id, claimed.value.tries, formDigest(decision.form)),
  )

  const recorded = await deps.uow.run<Stepped, CheckpointError>(async (stores) => {
    const at = deps.clock.now()
    const { checkpoints } = stores
    const fresh = await unchanged(checkpoints, decision.id, decision.form)
    const claim = fresh?.steps.find((step) => step.step === 'judge')
    // Amended, answered or withdrawn while the call ran: the Judge saw another form, so its verdict is dropped.
    if (claim?.outcome !== null) return ok(BUSY)
    const done = async (outcome: 'passed' | 'rejected' | 'failed', detail: string): Promise<Result<null, never>> => {
      await checkpoints.finishStep(decision.id, 'judge', { outcome, detail, at })
      return ok(null)
    }
    if (!verdict.ok) {
      const why = `${verdict.error.kind}: ${verdict.error.detail}`
      if (claim.tries < JUDGE_MAX_TRIES) {
        await checkpoints.finishStep(decision.id, 'judge', { outcome: 'failed', detail: why, at })
        return ok(RETRY)
      }
      return done('failed', `the Judge could not be reached after ${JUDGE_MAX_TRIES} tries: ${why}`)
    }
    if (verdict.value.verdict === 'owner') return done('passed', verdict.value.reason || 'the Judge passed it on')
    const guarded = guardVerdict(decision.form, verdict.value)
    if (!guarded.ok) return done('rejected', guarded.why)

    await checkpoints.finishStep(decision.id, 'judge', { outcome: 'answered', detail: verdict.value.reason, at })
    const outcome = await answerIn(stores, deps, {
      decision,
      text: guarded.answer,
      by: 'judge',
      source: guarded.source,
      note: `Answered by the Judge, not the owner, from ${guarded.source}: ${guarded.answer}. The owner can overrule it with a note.`,
    })
    return outcome.ok && outcome.value.status === 'answered' ? answered(outcome) : outcome.ok ? ok(null) : outcome
  })
  return releaseOnError(deps, decision, 'judge', recorded)
}

/**
 * A call was made and its record rolled back (the Issue moved under the answer, the database blinked): the step would stay
 * claimed for its whole lease and the Decision would sit untouched. Let go of the claim as `failed`, so the next pass goes on
 * to the next step. A lost race needs none of it: the Decision is answered.
 */
async function releaseOnError(
  deps: SettleDeps,
  decision: DecisionRecord,
  step: 'policy' | 'judge',
  recorded: Awaited<StepResult>,
): StepResult {
  if (recorded.ok || lostRace(recorded.error)) return recorded
  await deps.uow.run(async ({ checkpoints }) => {
    const detail = `the result could not be recorded: ${JSON.stringify(recorded.error)}`.slice(0, 300)
    await checkpoints.finishStep(decision.id, step, { outcome: 'failed', detail, at: deps.clock.now() })
    return ok(null)
  })
  return recorded
}

/** The default: a reversible option the lead named, taken once its wait has run out with no answer. */
async function defaultStep(deps: SettleDeps, decision: DecisionRecord): StepResult {
  return deps.uow.run<Stepped, CheckpointError>(async (stores) => {
    const at = deps.clock.now()
    const label = defaultDue(decision.form, decision.askedAt, at)
    if (label === null) return ok(null)
    if (!(await unchanged(stores.checkpoints, decision.id, decision.form))) return ok(BUSY)
    const option = decision.form.options.find((candidate) => candidate.label === label)
    if (!option?.reversible) return ok(null)
    await stores.checkpoints.recordStep(decision.id, 'default', { outcome: 'answered', detail: label, at })
    const minutes = decision.form.noAnswer.waitMinutes
    const outcome = await answerIn(stores, deps, {
      decision,
      text: label,
      by: 'default',
      source: `no answer within ${minutes} minutes: the default`,
      note: `No one answered within ${minutes} minutes, so the default was taken: ${label} (a reversible option). The owner can overrule it with a note.`,
    })
    return outcome.ok && outcome.value.status === 'answered' ? answered(outcome) : outcome.ok ? ok(null) : outcome
  })
}

/**
 * The owner: reached when nothing before him settled it and no default is still running down its wait. Recorded once
 * (the step), and he is paged once (the page's key), in the same transaction.
 */
async function ownerStep(deps: SettleDeps, decision: DecisionRecord): Step<null> {
  if (decision.form.noAnswer.default !== null) return ok(null)
  return deps.uow.run(async ({ work, checkpoints }: CheckpointStores) => {
    const at = deps.clock.now()
    // The Decision was read before the Judge ran, which can take minutes: the owner may have answered it since, or the
    // Issue stopped waiting. Read it again under its lock, so no page is planned for a Decision that is settled.
    const fresh = await checkpoints.lockDecision(decision.id)
    if (!fresh || statusOf(fresh) !== 'open') return ok(null)
    // Amended since it was read: its steps are cleared and the Judge has not seen this form. The next pass settles it afresh.
    if (formDigest(fresh.form) !== formDigest(decision.form)) return ok(null)
    const issue = await issueOf(work, fresh.issueId)
    if (!issue || !waitingOn(issue, 'decision', fresh.id)) {
      await checkpoints.withdrawDecision(fresh.id, 'the Issue no longer waits for it', at)
      await checkpoints.cancelPages(fresh.id, at)
      return ok(null)
    }
    const first = await checkpoints.recordStep(decision.id, 'owner', { outcome: 'open', detail: null, at })
    if (!first) return ok(null)
    await checkpoints.planPage(
      decisionPage({
        issue: { id: decision.issueId, repo: decision.repo },
        link: deepLink(deps.consoleUrl, decision.id),
        decision: decision.id,
        question: decision.form.question,
        recommendation: decision.form.recommendation,
      }),
      at,
    )
    return ok(null)
  })
}

/** One pass over the open Decisions, oldest first. The loops' tick (package 7) calls it; so does `checkpoint pass`. */
export async function settleOpen(deps: SettleDeps, limit = PASS_LIMIT): Step<Settled[]> {
  const open = await deps.uow.run(async ({ checkpoints }) => ok(await checkpoints.openDecisions(limit)))
  if (!open.ok) return open
  const settled: Settled[] = []
  for (const decision of open.value) {
    const result = await settleDecision(deps, decision.id)
    if (result.ok) settled.push(result.value)
    else console.error(`checkpoints: ${decision.id} could not be settled: ${JSON.stringify(result.error)}`)
  }
  return ok(settled)
}
