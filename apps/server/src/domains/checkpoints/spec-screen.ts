import {
  SPEC_SCREEN_CONTENT_MAX,
  type SpecPrecedent,
  type SpecScreenAnswer,
  type SpecScreenRequest,
  type SpecSource,
} from '@software-factory/contract'
import * as z from 'zod'
import { scrub } from '../../kernel/scrub.ts'
import type { Format, Verdict } from './artifact.ts'
import { JUDGE_BACKOFF_MS, JUDGE_MAX_TRIES } from './decision.ts'

/**
 * The Spec screen (Issue 1096): a Spec revision reaches the owner only when it is his to read. The owner said on 2026-11-14
 * that most Specs reaching him could have been decided by their lead (12 looks_good and 16 with_notes against 3 changes in
 * 14 days). The rules decide what they can, the `factory-spec-screen` workflow the rest; a screen that cannot be reached
 * passes the Spec to him after its last try, so a broken screen costs him a read, never a Spec he should have seen.
 */

/** Failed calls before the Spec reaches the owner unscreened; the wait between them. */
export const SPEC_SCREEN_MAX_TRIES = JUDGE_MAX_TRIES
export const SPEC_SCREEN_BACKOFF_MS = JUDGE_BACKOFF_MS

const REASON_MAX = 300

/** What the factory holds about where a Spec came from. */
export interface SpecOrigin {
  /** the Issue is a project's Replan */
  replan: boolean
  /** the filer attached this Spec with the Issue (`issue new --spec`) */
  filedSpec: boolean
  /** factory-triage set `checkpoint: spec` when it settled the Issue */
  triaged: boolean
  /** the filer set `checkpoint: spec` */
  filedWithCheckpoint: boolean
}

/** Who made the Spec owed: the Replan's own proposal, the filer, triage's flag, or the lead's judgment. */
export function specSourceOf(origin: SpecOrigin): SpecSource {
  if (origin.replan) return 'replan'
  if (origin.filedSpec) return 'filer'
  if (origin.triaged) return 'triage'
  if (origin.filedWithCheckpoint) return 'filer'
  return 'lead'
}

/** The changes a Replan's Spec proposes, as its fenced `replan` block states them (the Replan playbook, step 4). */
const ReplanBlock = z.object({
  /** the plan rows the proposal adds, changes or drops, by key */
  plan: z.array(z.string()).default([]),
  edges: z
    .object({ add: z.array(z.unknown()).default([]), remove: z.array(z.unknown()).default([]) })
    .default({ add: [], remove: [] }),
  cancel: z.array(z.unknown()).default([]),
})
export type ReplanBlock = z.infer<typeof ReplanBlock>

const REPLAN_FENCE = /```replan[ \t]*(?:\r?\n)?([\s\S]*?)```/

/** The Replan block of a Spec: null when there is none or it does not parse, so no rule reads a guess. */
export function replanBlockOf(content: string): ReplanBlock | null {
  const body = REPLAN_FENCE.exec(content)?.[1]
  if (body === undefined) return null
  let raw: unknown
  try {
    raw = JSON.parse(body)
  } catch {
    return null
  }
  const parsed = ReplanBlock.safeParse(raw)
  return parsed.success ? parsed.data : null
}

export interface RuleInput {
  revision: number
  /** the verdicts on the earlier revisions of this artifact */
  earlier: readonly Verdict[]
  origin: SpecOrigin
  content: string
}

export type RuleOutcome = { outcome: 'passed' | 'settled'; reason: string }

/**
 * The deterministic first look; null leaves the Spec to the workflow.
 * - A revision after the owner asked for changes is his to read again: he asked for it.
 * - A Spec its filer attached is handed over for the owner's review on purpose.
 * - A Replan whose block changes no plan row and cancels nothing only reorders open Issues (it frees one from a stalled
 *   head, or adds an edge): the lead applies it on its defaults. Edges are reversible with one call.
 */
export function screenSpecByRule(input: RuleInput): RuleOutcome | null {
  if (input.revision > 1 && input.earlier.includes('changes')) {
    return { outcome: 'passed', reason: 'a revision the owner asked for with his verdict of changes' }
  }
  if (input.origin.filedSpec) {
    return { outcome: 'passed', reason: 'its filer attached it with the Issue for the owner to review' }
  }
  if (input.origin.replan) {
    const block = replanBlockOf(input.content)
    if (block?.plan.length === 0 && block.cancel.length === 0) {
      const freed = block.edges.remove.length
      return {
        outcome: 'settled',
        reason:
          freed > 0
            ? `a Replan that changes no plan row and cancels nothing: it only frees ${freed === 1 ? 'an Issue' : `${freed} Issues`} from ${freed === 1 ? 'a wait' : 'their waits'}`
            : 'a Replan that changes no plan row and cancels nothing',
      }
    }
  }
  return null
}

export type SpecScreenChecked =
  | { action: 'pass'; note: string }
  | { action: 'settle'; reason: string }
  /** an answer that cannot be acted on: counted as a failed call */
  | { action: 'refused'; why: string }

/** The answer is held to its shape before anything is done: a settle needs the reason the lead hears. */
export function checkSpecScreen(answer: SpecScreenAnswer): SpecScreenChecked {
  const reason = answer.reason.trim().replace(/\s+/g, ' ').slice(0, REASON_MAX)
  if (answer.verdict === 'pass') return { action: 'pass', note: reason }
  if (reason !== '') return { action: 'settle', reason }
  return { action: 'refused', why: 'a settle without a reason' }
}

/** The Spec's content as the screen reads it: scrubbed, and cut with the cut said. */
export function screenedContent(content: string): string {
  const clean = scrub(content)
  if (clean.length <= SPEC_SCREEN_CONTENT_MAX) return clean
  return `${clean.slice(0, SPEC_SCREEN_CONTENT_MAX)}\n[cut: ${clean.length - SPEC_SCREEN_CONTENT_MAX} more characters]`
}

/** The request the workflow is shown: the Spec, its Issue and the owner's newest marks, every text scrubbed. */
export function specScreenRequest(input: {
  spec: { id: string; revision: number; title: string; format: Format; content: string; source: SpecSource }
  issue: { id: string; repo: string; title: string; kind: string }
  precedents: readonly SpecPrecedent[]
}): SpecScreenRequest {
  return {
    spec: {
      id: input.spec.id,
      revision: input.spec.revision,
      title: scrub(input.spec.title).slice(0, 200),
      source: input.spec.source,
      content: screenedContent(input.spec.content),
      format: input.spec.format,
    },
    issue: { ...input.issue, title: scrub(input.issue.title) },
    precedents: input.precedents.map(scrubPrecedent),
  }
}

export const scrubPrecedent = (precedent: SpecPrecedent): SpecPrecedent => ({
  ...precedent,
  title: scrub(precedent.title).slice(0, 200),
  note: precedent.note === null ? null : scrub(precedent.note).slice(0, 2000),
})

/** The note the lead hears when the screen settles its Spec. */
export const settledNote = (reason: string): string =>
  `The Spec screen settled it without the owner: ${reason}. Build on your defaults; the owner can still overrule them with a note.`
