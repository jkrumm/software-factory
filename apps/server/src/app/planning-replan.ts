import { cleanText } from '@software-factory/contract'
import {
  outsideProject,
  replanNote,
  replanTitle,
  type ReplanTrigger,
  type StalledHead,
} from '../domains/planning/replan.ts'
import { repoTextOf } from '../domains/planning/sync.ts'
import type { OwnerActor } from '../kernel/events.ts'
import type { Issue } from '../domains/work/issue.ts'
import { replay } from '../domains/work/machine.ts'
import { type IssueId, issueNumber } from '../kernel/ids.ts'
import { key } from '../kernel/keys.ts'
import { err, ok, type PortError, type Result } from '../kernel/result.ts'
import { fileIn, type IssueWriteError, recordIn } from './issues.ts'
import { cancelIssue, took } from './issue-owner.ts'
import { addAfter, removeAfter } from './planning-chain.ts'
import type { PlanningDeps, PlanningError } from './planning-deps.ts'

export interface ReplanInput {
  project: string
  trigger: ReplanTrigger
  ask?: string | undefined
  stalled?: StalledHead | undefined
  /** who files an owner Replan; the stalled trigger files as the factory */
  actor: OwnerActor
}

export interface Replanned {
  issue: Issue
  /** false when nothing new was filed */
  filed: boolean
  /** true when an open Replan of the project stood already */
  existing: boolean
}

const refused = (error: IssueWriteError): PortError => ({ kind: 'refused', detail: JSON.stringify(error) })

/**
 * Files the project's Replan: an ordinary `chore` Issue whose lead reads the plan and proposes changes as a Spec. At most
 * one is open per project: while it is, a repeated call files nothing (an owner's ask is added to it as a note) and a
 * replayed stalled pass finds its key. The first note carries the playbook, and the factory settles it itself (no triage).
 */
export async function fileReplan(
  deps: PlanningDeps,
  input: ReplanInput,
): Promise<Result<Replanned, PlanningError | PortError>> {
  return deps.uow.run<Replanned, PlanningError | PortError>(async (stores) => {
    await stores.capacity.lock()
    const project = (await stores.planning.projects()).find((p) => p.name === input.project)
    if (!project) return err({ kind: 'unknown_project', project: input.project })
    const owner = input.trigger === 'owner'
    const ask = input.ask ? cleanText(input.ask) : ''

    const open = await stores.planning.openReplan(project.name)
    if (open) {
      if (owner && ask) {
        const noted = await recordIn(stores.work, deps, {
          issueId: open,
          key: key('replan', project.name, 'ask', deps.ids.next('replan')),
          event: { kind: 'noted', payload: { text: `ask: ${ask}` }, actor: input.actor },
        })
        if (!noted.ok) return err(refused(noted.error))
        return ok({ issue: noted.value.issue, filed: false, existing: true })
      }
      const history = await stores.work.history(open)
      if (!history) return err({ kind: 'unknown_issue', issue: open })
      return ok({ issue: replay(open, history), filed: false, existing: true })
    }

    const head = input.stalled
    const base = owner
      ? key('replan', project.name, deps.ids.next('replan'))
      : key('replan', project.name, head?.issue ?? 'none', head?.since ?? 'none')
    const filed = await fileIn(stores.work, deps, {
      key: base,
      event: {
        kind: 'filed',
        payload: {
          repo: repoTextOf(project),
          title: replanTitle(project.name),
          kind: 'chore',
          origin: owner ? 'you' : 'factory',
        },
        actor: owner ? input.actor : 'factory',
      },
    })
    if (!filed.ok) return err(refused(filed.error))
    const issue = filed.value.issue
    // A replayed stalled pass: the Replan was filed (and may be closed since); nothing more is written.
    if (filed.value.result === 'replayed') return ok({ issue, filed: false, existing: false })

    const noted = await recordIn(stores.work, deps, {
      issueId: issue.id,
      key: key(base, 'note'),
      event: {
        kind: 'noted',
        payload: { text: replanNote({ project: project.name, trigger: input.trigger, ask, stalled: head }) },
        actor: 'factory',
      },
    })
    if (!noted.ok) return err(refused(noted.error))
    const settled = await recordIn(stores.work, deps, {
      issueId: issue.id,
      key: key(base, 'settled'),
      event: { kind: 'settled', payload: {}, actor: 'factory' },
    })
    if (!settled.ok) return err(refused(settled.error))
    await stores.planning.recordReplan({
      issue: issue.id,
      project: project.name,
      trigger: input.trigger,
      ask: ask || null,
      at: deps.clock.now(),
    })
    return ok({ issue: settled.value.issue, filed: true, existing: false })
  })
}

export interface ReplanApplyInput {
  issue: IssueId
  attempt: number
  call?: string | undefined
  edges: {
    add: readonly { issue: IssueId; after: readonly IssueId[] }[]
    remove: readonly { issue: IssueId; after: readonly IssueId[] }[]
  }
  cancel: readonly { issue: IssueId; reason: string }[]
}

export interface ReplanOpResult {
  op: 'add' | 'remove' | 'cancel'
  issue: IssueId
  ok: boolean
  detail: string | null
}

/** The principal an applied Replan acts as: the owner's approved Spec, not the owner's hands (no owner touch). */
const APPLY_ACTOR: OwnerActor = 'orchestrator'

const APPLIED = ['working', 'watching']

/** Why one op did not run, in a line. */
function detailOf(error: PlanningError | PortError): string {
  switch (error.kind) {
    case 'wrong_state':
      return `wrong_state: ${error.detail}`
    case 'cycle':
      return `cycle: ${error.path.map((issue) => `Issue ${issueNumber(issue)}`).join(' waits for ')}`
    case 'unknown_edge':
      return `unknown_edge: Issue ${issueNumber(error.issue)} has no stored edge after Issue ${issueNumber(error.after)}`
    case 'issue_closed':
      return `issue_closed: Issue ${issueNumber(error.issue)}`
    case 'unknown_issue':
      return `unknown_issue: Issue ${issueNumber(error.issue)}`
    case 'refused':
      return `refused: ${error.detail}`
    default:
      return error.kind
  }
}

/**
 * A Replan's lead applies its approved proposal: edges added and removed, Issues cancelled. The gate runs first and
 * refuses the whole call (nothing applied) unless the Issue is a Replan, the lead's current attempt works on it, its
 * latest Spec revision is approved, and every dependent or cancel target is an Issue of the Replan's own project.
 * Then each op runs through the owner's functions, as the orchestrator, and answers for itself: a refused op does not
 * stop the others, and a replayed call changes nothing more.
 */
export async function applyReplan(
  deps: PlanningDeps,
  input: ReplanApplyInput,
): Promise<Result<ReplanOpResult[], PlanningError | PortError>> {
  const gated = await deps.uow.run<null, PlanningError>(async (stores) => {
    const history = await stores.work.history(input.issue)
    if (!history) return err({ kind: 'unknown_issue', issue: input.issue })
    const replan = await stores.planning.replanOf(input.issue)
    if (!replan) return err({ kind: 'not_a_replan', issue: input.issue })
    const current = replay(input.issue, history)
    if (!APPLIED.includes(current.state) || current.attempt !== input.attempt) {
      return err({
        kind: 'wrong_state',
        issue: input.issue,
        detail: `Issue ${issueNumber(input.issue)} is ${current.state} at attempt ${current.attempt}: only its working or watching lead of attempt ${current.attempt} applies a Replan (you sent attempt ${input.attempt})`,
      })
    }
    if (!(await stores.planning.specApproved(input.issue))) return err({ kind: 'not_approved', issue: input.issue })

    const project = (await stores.planning.projects()).find((p) => p.name === replan.project)
    if (!project) return err({ kind: 'unknown_project', project: replan.project })
    const dependents = [...input.edges.add, ...input.edges.remove].map((edge) => edge.issue)
    const cancels = input.cancel.map((target) => target.issue)
    const known = await stores.reads.repoStatesOf([input.issue, ...dependents, ...cancels])
    const outside = outsideProject({ replan: input.issue, repo: repoTextOf(project), dependents, cancels, known })
    if (outside.length > 0) return err({ kind: 'outside_project', project: project.name, issues: outside })
    return ok(null)
  })
  if (!gated.ok) return gated

  const call = input.call ?? deps.ids.next('call')
  const results: ReplanOpResult[] = []
  const note = (issue: IssueId, edge: IssueId[]) =>
    deps.uow.run<null, IssueWriteError>(async ({ work }) => {
      const noted = await recordIn(work, deps, {
        issueId: issue,
        key: key('replan', input.issue, call, 'edges', issue),
        event: {
          kind: 'noted',
          payload: {
            text: `edges changed by Replan ${input.issue}: now after ${edge.map((e) => `Issue ${issueNumber(e)}`).join(', ')}`,
          },
          actor: 'factory',
        },
      })
      return noted.ok ? ok(null) : noted
    })

  for (const op of input.edges.add) {
    const added = await addAfter(deps, { issue: op.issue, after: op.after, running: true })
    if (!added.ok) {
      results.push({ op: 'add', issue: op.issue, ok: false, detail: detailOf(added.error) })
      continue
    }
    if (added.value.edges > 0) {
      const noted = await note(op.issue, [...op.after])
      if (!noted.ok) return err({ kind: 'refused', detail: JSON.stringify(noted.error) })
    }
    results.push({ op: 'add', issue: op.issue, ok: true, detail: `${added.value.edges} edge(s) added` })
  }

  for (const op of input.edges.remove) {
    const removed = await removeAfter(deps, { issue: op.issue, after: op.after, actor: APPLY_ACTOR })
    results.push(
      removed.ok
        ? { op: 'remove', issue: op.issue, ok: true, detail: `${removed.value.removed} edge(s) removed` }
        : { op: 'remove', issue: op.issue, ok: false, detail: detailOf(removed.error) },
    )
  }

  for (const op of input.cancel) {
    const cancelled = await cancelIssue(deps, {
      issueId: op.issue,
      reason: `Replan ${input.issue}: ${op.reason}`,
      actor: APPLY_ACTOR,
      call: `${input.issue}:${call}`,
    })
    if (!cancelled.ok) {
      const detail =
        cancelled.error.kind === 'unknown_issue' ? `unknown_issue: ${op.issue}` : JSON.stringify(cancelled.error)
      results.push({ op: 'cancel', issue: op.issue, ok: false, detail })
      continue
    }
    results.push({
      op: 'cancel',
      issue: op.issue,
      ok: took(cancelled.value),
      detail: took(cancelled.value) ? null : (cancelled.value.event.detail ?? cancelled.value.result),
    })
  }
  return ok(results)
}
