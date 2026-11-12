import { SPEC_WAIT_HOURS } from '@software-factory/contract'
import { type CiOutcome, judgeShip, type ReviewOutcome, type ShipVerdict } from '../domains/quality/gate.ts'
import type { AcceptanceEvidence } from '../domains/quality/evidence.ts'
import type { Ci, Commits, LeadCheckout, Projects, Review } from '../domains/quality/ports.ts'
import type { QualityStore, StoredEvidence } from '../domains/quality/store.ts'
import type { AnyIssueEvent } from '../domains/work/events.ts'
import type { Issue } from '../domains/work/issue.ts'
import { replay } from '../domains/work/machine.ts'
import type { WorkStore } from '../domains/work/ports.ts'
import type { Clock } from '../kernel/clock.ts'
import type { IdSource, IssueId } from '../kernel/ids.ts'
import { key } from '../kernel/keys.ts'
import { err, ok, type PortError, type Result } from '../kernel/result.ts'
import { type IssueWriteError, type Recorded, recordIn } from './issues.ts'
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
export const SPEC_OWED = `ship refused: this Issue carries the checkpoint \`spec\` and no Spec was submitted: hand over a one-page Spec with \`factory artifact submit --kind spec\` (at most three open choices, each with your default); with no verdict in ${SPEC_WAIT_HOURS} hours you go on with your defaults`

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

/** The git and agw reads of a ship: outside any transaction, the lead's call waits for them. */
async function judge(deps: ShipDeps, issue: Issue, input: ShipInput): Promise<ShipVerdict> {
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
  return judgeShip({
    reported: input.commits,
    commits,
    review,
    ci,
    acceptance: input.acceptance,
    ...(project.ok && project.value.deployPaths ? { deployPaths: project.value.deployPaths } : {}),
  })
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
  const eventKey = key('shipped', input.issueId, input.attempt, input.call)
  const event = shipped(input.attempt)
  const loaded = await deps.uow.run(async ({ work, quality }) => {
    const history = await work.history(input.issueId)
    if (!history) return err<IssueWriteError>({ kind: 'unknown_issue', issueId: input.issueId })
    const issue = replay(input.issueId, history)
    return ok({
      issue,
      accepted: await quality.shipAccepted(eventKey),
      specOwed: issue.checkpoint === 'spec' && !(await quality.specSubmitted(input.issueId)),
    })
  })
  if (!loaded.ok) return loaded
  const { issue, accepted, specOwed } = loaded.value

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

  const verdict: ShipVerdict = specOwed ? { accepted: false, error: SPEC_OWED } : await judge(deps, issue, input)
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
      return ok({ result: 'refused', detail: verdict.error, issue, evidence: [] })
    }
    const recorded = await recordIn(work, deps, { issueId: input.issueId, key: eventKey, event })
    if (!recorded.ok) return recorded
    const result = resultOf(recorded.value)
    if (result === 'refused') {
      // The machine said no (the Issue is closed, or it is another attempt): the refusal is the verb's error.
      const detail = recorded.value.event.detail
      await quality.recordShip({ ...ship, result: 'refused', detail: detail ?? 'the Issue refused the ship' }, [])
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
