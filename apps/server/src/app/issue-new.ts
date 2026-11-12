import { cleanText, parseSeat, type ResolvedSeat } from '@software-factory/contract'
import type { CheckpointStore } from '../domains/checkpoints/ports.ts'
import { projectOf, repoNameOf, repoTextOf } from '../domains/planning/sync.ts'
import type { Issue } from '../domains/work/issue.ts'
import type { OwnerActor } from '../kernel/events.ts'
import type { IssueId } from '../kernel/ids.ts'
import { key } from '../kernel/keys.ts'
import { err, ok, type PortError, type Result } from '../kernel/result.ts'
import { fileIn, type IssueWriteError, recordIn } from './issues.ts'
import { attachSpec, type FiledSpecDeps, type StoredSpec, storeSpecBlob } from './filed-spec.ts'
import { addEdges } from './planning-chain.ts'
import type { PlanningDeps, PlanningError, PlanningStores } from './planning-deps.ts'
import { resolveSeat, type SeatRefused, type SeatRoles } from './seat.ts'
import type { UnitOfWork } from './unit-of-work.ts'

export interface NewIssueInput {
  /** an absolute path inside a source root, or a repo's directory name */
  repo: string
  title: string
  facts?: Record<string, unknown> | undefined
  /** the lead's seat as the request gave it, unchecked: `{tier, effort}` or `{role}` */
  seat?: Record<string, unknown> | undefined
  /** the resource class, already a valid lane name */
  lane?: string | undefined
  /** `spec`: the lead owes a Spec before it builds */
  checkpoint?: 'spec' | undefined
  /** a Spec the filer wrote (markdown): stored with the Issue, which the queue holds until it has a verdict; implies the `spec` checkpoint */
  spec?: string | undefined
  /** its title; default: the first `# ` heading, else the Issue's title */
  specTitle?: string | undefined
  text?: string | undefined
  /** a repeated key files nothing again */
  key?: string | undefined
  source: 'request' | 'alert'
  after: readonly IssueId[]
  /** waits for nothing, and says so: like a non-empty `after`, it states the edges, so settling adds none */
  alone?: boolean | undefined
  /** who files it: the owner, or the orchestrator for him (a filing is not a touch either way) */
  actor: OwnerActor
}

export type NewIssueError =
  /** the repo is not a directory inside the allowed roots (`realpath` on both sides): nothing is stored */
  { kind: 'repo_outside_roots'; detail: string } | SeatRefused | PlanningError | IssueWriteError

export interface NewIssued {
  issue: Issue
  /** false when the key was filed before */
  filed: boolean
}

export interface NewIssueDeps extends Omit<PlanningDeps, 'uow'>, Pick<FiledSpecDeps, 'blobs' | 'consoleUrl'> {
  /** planning's stores, and the checkpoints' for the Spec a filer attaches */
  uow: UnitOfWork<PlanningStores & { checkpoints: CheckpointStore }>
  /** the trust boundary: the repo's real path, or a refusal when it is outside the roots (`adapters/git/repos.ts`) */
  locate(repo: string): Promise<Result<string, PortError>>
  /** the role table, for a seat that names a role */
  roles: SeatRoles
}

/** What the lead reads of the request: the text, then the facts as `name: value` lines. */
export function requestNote(input: Pick<NewIssueInput, 'text' | 'facts'>): string {
  const facts = Object.entries(input.facts ?? {}).map(
    ([name, value]) => `${name}: ${typeof value === 'string' ? value : JSON.stringify(value)}`,
  )
  return [input.text ? cleanText(input.text) : '', ...facts].filter(Boolean).join('\n')
}

/**
 * The owner files an Issue by hand, the way a plan row files one: `filed` under a key (idempotent), the edges it waits
 * for (each must exist and be open, else nothing is filed), and the text and facts as the first note its lead reads.
 * It begins `settling`; the triage loop settles it.
 */
export async function fileNewIssue(
  deps: NewIssueDeps,
  input: NewIssueInput,
): Promise<Result<NewIssued, NewIssueError | PortError>> {
  const located = await deps.locate(input.repo)
  if (!located.ok) {
    return located.error.kind === 'refused'
      ? err({ kind: 'repo_outside_roots', detail: located.error.detail })
      : located
  }
  const request = key('request', input.key ?? deps.ids.next('request'))
  let seat: ResolvedSeat | undefined
  if (input.seat !== undefined) {
    const parsed = parseSeat(input.seat)
    if (!parsed.ok) return err({ kind: 'seat_refused', field: parsed.field, detail: parsed.detail })
    // A repeated key files nothing, so its replay never reads the role table: the Issue is there whatever the table says.
    const before =
      input.key === undefined ? null : await deps.uow.run(async ({ work }) => ok(await work.eventByKey(request)))
    if (before !== null && !before.ok) return before
    if (!before?.value) {
      const resolved = await resolveSeat(deps.roles, parsed.seat)
      if (!resolved.ok) return resolved
      seat = resolved.value
    }
  }
  const title = cleanText(input.title) || 'untitled'
  let spec: StoredSpec | undefined
  if (input.spec !== undefined) {
    const stored = await storeSpecBlob(deps, { content: input.spec, given: input.specTitle, fallback: title })
    if (!stored.ok) return stored
    spec = stored.value
  }
  return deps.uow.run<NewIssued, NewIssueError>(async (stores) => {
    // The edges are checked against the open chain and then written: two filings at once must not both pass.
    await stores.capacity.lock()
    const project = projectOf(await stores.planning.projects(), located.value)
    const filed = await fileIn(stores.work, deps, {
      key: request,
      event: {
        kind: 'filed',
        payload: {
          repo: project ? repoTextOf(project) : repoNameOf(located.value),
          title,
          kind: input.source === 'alert' ? 'incident' : 'feature',
          origin: input.source === 'alert' ? 'application' : 'you',
          ...(seat ? { seat } : {}),
          ...(input.lane ? { lane: input.lane } : {}),
          ...(input.checkpoint || spec ? { checkpoint: 'spec' as const } : {}),
          ...(input.after.length > 0 || input.alone ? { edges: 'stated' as const } : {}),
        },
        actor: input.actor,
      },
    })
    if (!filed.ok) return filed
    if (filed.value.result === 'replayed') return ok({ issue: filed.value.issue, filed: false })
    const issue = filed.value.issue
    const edges = await addEdges(stores, deps, issue.id, input.after)
    if (!edges.ok) return edges
    if (spec) {
      const attached = await attachSpec(deps, stores.checkpoints, issue, spec)
      if (!attached.ok) return attached
    }
    const text = requestNote(input)
    if (!text) return ok({ issue, filed: true })
    const noted = await recordIn(stores.work, deps, {
      issueId: issue.id,
      key: key('request', request, 'note'),
      event: { kind: 'noted', payload: { text }, actor: input.actor },
    })
    return noted.ok ? ok({ issue: noted.value.issue, filed: true }) : noted
  })
}
