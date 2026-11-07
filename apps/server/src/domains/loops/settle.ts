import type { TriageAnswer, TriageCandidate, TriageRequest } from '@software-factory/contract'
import type { IssueId } from '../../kernel/ids.ts'

/** What triage knows of one Issue that is still `settling`. */
export interface SettlingFacts {
  issue: IssueId
  repo: string
  title: string
  kind: 'feature' | 'bug' | 'chore' | 'docs' | 'incident'
  origin: string
  filedAt: Date
  /** a check, a job or a monitor filed it: the edges are known (none) */
  fromAlert: boolean
  /** the words it was filed with: the signal's text, empty when it has none */
  text: string
}

export type Refined = 'feature' | 'bug' | 'chore' | 'docs'

/** The open Issues of the repo, other than this one, that an edge may name. */
export const MAX_CANDIDATES = 40

/**
 * Deterministic first. An incident, an Issue an alert filed (a failing check, a job, a monitor) and an Issue with nothing
 * open beside it in its repo need no edges: settle now. Anything else (a person's or an agent's request, a GitHub issue)
 * asks `factory-triage` for the Issues it must wait for. An owner's or an agent's request is asked even with nothing open
 * beside it: triage may refine its kind.
 */
export function settleRule(facts: SettlingFacts, candidates: readonly TriageCandidate[]): 'now' | 'ask' {
  if (facts.kind === 'incident' || facts.fromAlert) return 'now'
  if (refinable(facts)) return 'ask'
  return candidates.length === 0 ? 'now' : 'ask'
}

/** An owner's or an agent's request, not an alert or an incident: its kind is a guess triage may correct. */
function refinable(facts: Pick<SettlingFacts, 'kind' | 'origin' | 'fromAlert'>): boolean {
  return facts.kind !== 'incident' && !facts.fromAlert && (facts.origin === 'you' || facts.origin === 'factory')
}

const REFINED_KINDS: readonly string[] = ['feature', 'bug', 'chore', 'docs']

export function settleRequest(
  facts: SettlingFacts,
  candidates: readonly TriageCandidate[],
  clean: (text: string) => string,
): Extract<TriageRequest, { mode: 'settle' }> {
  return {
    mode: 'settle',
    repo: facts.repo,
    candidates: candidates.slice(0, MAX_CANDIDATES).map((c) => ({ ...c, title: clean(c.title).slice(0, 500) || c.id })),
    issue: {
      id: facts.issue,
      title: clean(facts.title).slice(0, 500) || facts.issue,
      text: clean(facts.text).slice(0, 8_000),
      kind: facts.kind,
      origin: facts.origin,
    },
  }
}

export type SettleChecked =
  | { ok: true; after: IssueId[]; reason: string; kind: Refined | undefined }
  | { ok: false; why: string }

/**
 * An answer is held to what it was shown (the workflow's guard, checked again here): only open Issues it saw, never the
 * Issue itself, none twice. A cycle or a blocker that closed meanwhile is refused later by planning's own use case.
 */
export function checkSettle(
  shown: readonly TriageCandidate[],
  facts: Pick<SettlingFacts, 'issue' | 'kind' | 'origin' | 'fromAlert'>,
  answer: TriageAnswer,
): SettleChecked {
  const issue = facts.issue
  if (answer.amend !== null) return { ok: false, why: 'a settle answer amends nothing' }
  const seen = new Set<string>(shown.map((c) => c.id))
  for (const id of answer.after) {
    if (id === issue) return { ok: false, why: `${id} cannot wait for itself` }
    if (!seen.has(id)) return { ok: false, why: `${id} is not an Issue it was shown` }
  }
  if (new Set(answer.after).size !== answer.after.length) return { ok: false, why: 'an edge is named twice' }
  const refined =
    refinable(facts) && answer.kind && REFINED_KINDS.includes(answer.kind) && answer.kind !== facts.kind
      ? (answer.kind as Refined)
      : undefined
  return { ok: true, after: answer.after as IssueId[], reason: answer.reason, kind: refined }
}
