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

/** The open Issues of the repo, other than this one, that an edge may name. */
export const MAX_CANDIDATES = 40

/**
 * Deterministic first. An incident, an Issue an alert filed (a failing check, a job, a monitor) and an Issue with nothing
 * open beside it in its repo need no edges: settle now. Anything else (a person's or an agent's request, a GitHub issue)
 * asks `factory-triage` for the Issues it must wait for.
 */
export function settleRule(facts: SettlingFacts, candidates: readonly TriageCandidate[]): 'now' | 'ask' {
  if (facts.kind === 'incident' || facts.fromAlert) return 'now'
  return candidates.length === 0 ? 'now' : 'ask'
}

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

export type SettleChecked = { ok: true; after: IssueId[]; reason: string } | { ok: false; why: string }

/**
 * An answer is held to what it was shown (the workflow's guard, checked again here): only open Issues it saw, never the
 * Issue itself, none twice. A cycle or a blocker that closed meanwhile is refused later by planning's own use case.
 */
export function checkSettle(shown: readonly TriageCandidate[], issue: IssueId, answer: TriageAnswer): SettleChecked {
  if (answer.amend !== null) return { ok: false, why: 'a settle answer amends nothing' }
  const seen = new Set<string>(shown.map((c) => c.id))
  for (const id of answer.after) {
    if (id === issue) return { ok: false, why: `${id} cannot wait for itself` }
    if (!seen.has(id)) return { ok: false, why: `${id} is not an Issue it was shown` }
  }
  if (new Set(answer.after).size !== answer.after.length) return { ok: false, why: 'an edge is named twice' }
  return { ok: true, after: answer.after as IssueId[], reason: answer.reason }
}
