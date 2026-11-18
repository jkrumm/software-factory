import { type Effort, SPEC_WAIT_HOURS, type Tier } from '@software-factory/contract'
import { reviewSeat } from '../domains/leads/reviewer.ts'
import { type CiOutcome, judgeShip, type ReviewOutcome, type ShipVerdict } from '../domains/quality/gate.ts'
import type { AcceptanceEvidence, ReviewEvidence } from '../domains/quality/evidence.ts'
import type { Ci, Commits, LeadCheckout, Projects, Review } from '../domains/quality/ports.ts'
import { ciStillRed, regressedOnCi } from '../domains/quality/watch.ts'
import type { QualityStore, StoredEvidence, UndisposedAnnotation } from '../domains/quality/store.ts'
import type { AnyIssueEvent } from '../domains/work/events.ts'
import type { Issue } from '../domains/work/issue.ts'
import { type AppliedRecord, replay } from '../domains/work/machine.ts'
import type { WorkStore } from '../domains/work/ports.ts'
import type { Clock } from '../kernel/clock.ts'
import type { IdSource, IssueId } from '../kernel/ids.ts'
import { type Key, key } from '../kernel/keys.ts'
import { err, ok, type PortError, type Result } from '../kernel/result.ts'
import { type IssueWriteError, type Recorded, recordIn } from './issues.ts'
import { moveUpIfDue } from './move-up.ts'
import type { UnitOfWork } from './unit-of-work.ts'

/** The stores the quality use cases write: the Issue's own, and the quality domain's. */
export type QualityUnit = UnitOfWork<{ work: WorkStore; quality: QualityStore }>

export interface ShipDeps {
  uow: QualityUnit
  clock: Clock
  ids: IdSource
  commits: Commits
  review: Review
  ci: Ci
  /** whether the project ships by pull request: a push-shipping project has no pull request whose CI to read */
  projects: Projects
  checkout: LeadCheckout
  /** the role table's `reviewer` and `reviewer-cheap` rows, for the seat a review's record names; unset or null: no review is recorded with a seat */
  reviewerRows?: () => Promise<{
    cheap: { tier: Tier; effort: Effort }
    reviewer: { tier: Tier; effort: Effort }
  } | null>
}

export interface ShipInput {
  issueId: IssueId
  attempt: number
  /** the lead's id for this call: the same call twice is one ship */
  call: string
  /** the merged commits the lead names */
  commits: readonly string[]
  /** what the lead states against each acceptance line; empty when it states nothing */
  acceptance: AcceptanceEvidence
}

export interface ShipAnswer {
  /** `refused`: the gate's or the machine's error is in `detail`, and nothing moved */
  result: 'applied' | 'replayed' | 'refused'
  detail: string | null
  issue: Issue
  /** what the ship proved: its commits, and its review or the record that there was none */
  evidence: StoredEvidence[]
}

/** What a flagged Issue's ship is refused with until its lead has submitted a Spec. */
const specOwedMessage = (checkpoint: 'spec' | 'gate'): string =>
  `ship refused: this Issue carries the checkpoint \`${checkpoint}\` and no Spec was submitted: hand over a one-page Spec with \`factory artifact submit --kind spec\` (at most three open choices, each with your default); ${
    checkpoint === 'gate'
      ? "only the owner's own verdict ends the wait: there is no default after the hours, so do not build before it"
      : `with no verdict in ${SPEC_WAIT_HOURS} hours you go on with your defaults`
  }`

/**
 * What a ship, or a close with outcome done, is refused with while the owner's annotations on its Specs and Concepts are
 * unanswered: each one named, with the verb that answers it. A close as dropped stays open.
 */
export function annotationsOwed(owed: readonly UndisposedAnnotation[], verb: 'ship' | 'close' = 'ship'): string {
  const cut = (quote: string) => (quote.length > 60 ? `${quote.slice(0, 59)}…` : quote)
  const list = owed.map((a) => `${a.id} on ${a.artifact} revision ${a.revision} (${JSON.stringify(cut(a.quote))})`)
  return `${verb} refused: ${owed.length} annotation(s) of the owner on this Issue's Spec or Concept have no disposition: ${list.join('; ')}. Answer each with \`factory artifact annotation-reply <artifact-id> <annotation-id> --attempt <n> --disposition applied|deferred|declined --note <text>\` (a deferral names the Issue or signal it filed, a decline its reason)`
}

const shipped = (attempt: number): AnyIssueEvent => ({ kind: 'shipped', payload: { attempt }, actor: 'lead' })

/** What recording the event came to, for the answer: a replay of a refusal is a refusal. */
function resultOf(recorded: Recorded): ShipAnswer['result'] {
  if (recorded.result === 'applied') return 'applied'
  if (recorded.result === 'replayed') return recorded.event.result === 'applied' ? 'replayed' : 'refused'
  return 'refused'
}

/**
 * Where an attempt's work is, for git and for make: the directory the lead's package located (an Issue names its repo,
 * which is a name inside the allowed roots), the lead's branch and its cut. With no lead on record the Issue's own repo
 * is the directory, and nothing is known of a branch.
 */
export async function checkoutOf(
  checkout: LeadCheckout,
  issue: { id: IssueId; repo: string },
  attempt: number,
): Promise<Result<{ repo: string; branch: string | null; cut: string | null }>> {
  const found = await checkout.of(issue.id, attempt)
  if (!found.ok) return found
  return ok({
    repo: found.value?.repo ?? issue.repo,
    branch: found.value?.branch ?? null,
    cut: found.value?.cut ?? null,
  })
}

/** The reviewer row the attempt's lead was assigned when it started (`lead_started`'s payload), or null: none was recorded. */
function assignedReviewer(history: readonly AppliedRecord[], attempt: number): string | null {
  const started = history.findLast(
    (record) => record.kind === 'lead_started' && (record.payload as { attempt?: number }).attempt === attempt,
  )
  const reviewer = (started?.payload as { reviewer?: unknown } | undefined)?.reviewer
  return typeof reviewer === 'string' ? reviewer : null
}

/**
 * The review evidence with its reviews' records: each covering thread of agw's ledger, with the seat it ran on (the
 * assigned row's, or agw's own for a deep review), and the row the lead was assigned. A ledger that cannot be read leaves
 * the evidence as it is; a record is a measure and never a gate.
 */
async function withThreads(
  deps: ShipDeps,
  input: { repo: string; review: ReviewEvidence; jobs: readonly string[]; reviewer: string | null },
): Promise<ReviewEvidence> {
  if (!input.reviewer) return input.review
  const rows = deps.reviewerRows ? await deps.reviewerRows() : null
  if (!rows || !deps.review.threads || input.jobs.length === 0) return { ...input.review, reviewer: input.reviewer }
  const read = await deps.review.threads({ repo: input.repo, jobs: input.jobs })
  if (!read.ok) return { ...input.review, reviewer: input.reviewer }
  const reviewer = input.reviewer
  return {
    ...input.review,
    reviewer,
    threads: read.value.map((thread) => ({
      ...thread,
      seat: reviewSeat({ assigned: reviewer, tier: thread.tier, routed: thread.routed, rows }),
    })),
  }
}

/** The git and agw reads of a ship: outside any transaction, the lead's call waits for them. */
async function judge(
  deps: ShipDeps,
  issue: Issue,
  input: ShipInput,
  context: { reviewer: string | null; afterCiRegression: boolean },
): Promise<ShipVerdict> {
  const { reviewer } = context
  const refuse = (why: string): ShipVerdict => ({ accepted: false, error: `ship refused: ${why}` })
  if (input.commits.length === 0) return refuse('ship names no merged commit')
  const checkout = await checkoutOf(deps.checkout, issue, input.attempt)
  if (!checkout.ok) return refuse(`the lead's checkout could not be read: ${checkout.error.detail}`)
  const { repo } = checkout.value
  const commits = await deps.commits.read({
    repo,
    branch: checkout.value.branch,
    cut: checkout.value.cut,
    reported: input.commits,
  })
  // agw is asked only for what git found on the default branch; any failure of it is a recorded absence, never a refusal (NL23).
  // The review (agw, minutes under load) and the CI (GitHub) are independent: asked together, so a slow review keeps the
  // whole of its limit instead of what the CI read left of the call.
  const readReview = async (): Promise<ReviewOutcome> => {
    if (!commits.ok || commits.value.reviewRanges.length === 0) return { read: null, problem: null }
    const read = await deps.review.read({ repo, ranges: commits.value.reviewRanges })
    return read.ok
      ? { read: read.value, problem: null }
      : { read: null, problem: `review could not be read: ${read.error.detail}` }
  }
  // GitHub is asked as agw is: a failure is a recorded `unknown`, never a refusal (NL23).
  // A project that ships by push has no pull request: its ship records no CI at all, which no friction counts.
  const project = await deps.projects.checksOf(repo)
  const readCi = async (): Promise<CiOutcome | null> => {
    if (!commits.ok) return { read: null, problem: null }
    if (project.ok && !project.value.ci) return null
    const read = await deps.ci.ofShip({ repo, commits: commits.value.commits })
    return read.ok
      ? { read: read.value, problem: null }
      : { read: null, problem: `CI could not be read: ${read.error.detail}` }
  }
  const [review, ci] = await Promise.all([readReview(), readCi()])
  const verdict = judgeShip({
    reported: input.commits,
    commits,
    review,
    ci,
    acceptance: input.acceptance,
    ...(project.ok && project.value.deployPaths ? { deployPaths: project.value.deployPaths } : {}),
  })
  if (!verdict.accepted) return verdict
  // The last Watch regressed on the default branch's CI: a ship is held while that CI is still red for the commit it
  // landed at. A CI that cannot be read never refuses (NL23).
  const landedAt = verdict.commits.mergedSha ?? verdict.commits.landedAt
  if (context.afterCiRegression && landedAt && project.ok && project.value.ci) {
    const state = await deps.ci.ofCommit({ repo, sha: landedAt })
    const refusal = ciStillRed(state.ok ? state.value : null, landedAt)
    if (refusal) return { accepted: false, error: refusal }
  }
  return {
    ...verdict,
    review: await withThreads(deps, { repo, review: verdict.review, jobs: review.read?.jobs ?? [], reviewer }),
  }
}

/**
 * The key of the `shipped` event this call stands for. A call the machine refused (the Issue waited for an Errand) stored
 * its refusal under the call's key, and the same call again would replay that refusal for ever, though the wait has
 * ended since: a refused or ignored call is decided again, under the next key in line (`ship-1`, `ship-1:retry:1`, ...).
 * An applied one is the answer of every repeat.
 */
async function shipKey(work: WorkStore, input: ShipInput): Promise<Key> {
  const base = key('shipped', input.issueId, input.attempt, input.call)
  for (let retry = 0; ; retry++) {
    const candidate = retry === 0 ? base : key('shipped', input.issueId, input.attempt, input.call, 'retry', retry)
    const stored = await work.eventByKey(candidate)
    if (!stored || stored.result === 'applied') return candidate
  }
}

/**
 * The lead's `ship`. The merged commits are checked outside any transaction: git for where they landed, agw for the
 * review, GitHub for the CI of its pull request. A ship the gate refuses is stored as refused with the verb's error and moves nothing. An accepted one records
 * `shipped` on the Issue (which plans the watch), its commits as evidence, its review as evidence or the record
 * that there was none, and what it states of the acceptance, in one transaction. The same call again gets the first answer without asking git.
 */
export async function shipIssue(
  deps: ShipDeps,
  input: ShipInput,
): Promise<Result<ShipAnswer, IssueWriteError | PortError>> {
  const event = shipped(input.attempt)
  const loaded = await deps.uow.run(async ({ work, quality }) => {
    const history = await work.history(input.issueId)
    if (!history) return err<IssueWriteError>({ kind: 'unknown_issue', issueId: input.issueId })
    const issue = replay(input.issueId, history)
    const eventKey = await shipKey(work, input)
    return ok({
      eventKey,
      issue,
      accepted: await quality.shipAccepted(eventKey),
      specOwed: issue.checkpoint && !(await quality.specSubmitted(input.issueId)) ? issue.checkpoint : null,
      annotationsOwed: await quality.undisposedAnnotations(input.issueId),
      reviewer: assignedReviewer(history, input.attempt),
      afterCiRegression: regressedOnCi((await quality.view(input.issueId)).watches),
    })
  })
  if (!loaded.ok) return loaded
  const { eventKey, issue, accepted, specOwed, annotationsOwed: owed, reviewer, afterCiRegression } = loaded.value

  if (accepted) {
    return deps.uow.run(async ({ work, quality }) => {
      const recorded = await recordIn(work, deps, { issueId: input.issueId, key: eventKey, event })
      if (!recorded.ok) return recorded
      const ship = (await quality.view(input.issueId)).ships.find((one) => one.eventKey === eventKey)
      return ok({
        result: resultOf(recorded.value),
        detail: recorded.value.event.detail,
        issue: recorded.value.issue,
        evidence: ship?.evidence ?? [],
      })
    })
  }

  const verdict: ShipVerdict = specOwed
    ? { accepted: false, error: specOwedMessage(specOwed) }
    : owed.length > 0
      ? { accepted: false, error: annotationsOwed(owed) }
      : await judge(deps, issue, input, { reviewer, afterCiRegression })
  return deps.uow.run<ShipAnswer, IssueWriteError>(async ({ work, quality }) => {
    const at = deps.clock.now()
    const ship = {
      id: deps.ids.next('ship'),
      issueId: input.issueId,
      attempt: input.attempt,
      eventKey,
      at,
      reported: input.commits,
    }
    if (!verdict.accepted) {
      await quality.recordShip({ ...ship, result: 'refused', detail: verdict.error }, [])
      // A light lead's second refused ship moves it up; the answer is still the refusal.
      const moved = await moveUpIfDue({ work, quality }, deps, { issueId: input.issueId })
      if (!moved.ok) return moved
      return ok({ result: 'refused', detail: verdict.error, issue, evidence: [] })
    }
    const recorded = await recordIn(work, deps, { issueId: input.issueId, key: eventKey, event })
    if (!recorded.ok) return recorded
    const result = resultOf(recorded.value)
    if (result === 'refused') {
      // The machine said no (the Issue is closed, or it is another attempt): the refusal is the verb's error.
      const detail = recorded.value.event.detail
      await quality.recordShip({ ...ship, result: 'refused', detail: detail ?? 'the Issue refused the ship' }, [])
      const moved = await moveUpIfDue({ work, quality }, deps, { issueId: input.issueId })
      if (!moved.ok) return moved
      return ok({ result, detail, issue: recorded.value.issue, evidence: [] })
    }
    const evidence: StoredEvidence[] = [
      { id: deps.ids.next('evidence'), kind: 'commits', payload: verdict.commits },
      { id: deps.ids.next('evidence'), kind: 'review', payload: verdict.review },
      { id: deps.ids.next('evidence'), kind: 'acceptance', payload: verdict.acceptance },
      ...(verdict.ci ? [{ id: deps.ids.next('evidence'), kind: 'ci' as const, payload: verdict.ci }] : []),
    ]
    await quality.recordShip({ ...ship, result: 'accepted', detail: null }, evidence)
    return ok({ result, detail: null, issue: recorded.value.issue, evidence })
  })
}
