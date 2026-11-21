import type { SpecScreenAnswer, SpecSource } from '@software-factory/contract'
import * as z from 'zod'
import { WORKFLOWS } from '../../kernel/workflows.ts'
import type { Verdict } from './artifact.ts'

/**
 * The Spec screen (Issue 1096, made rules-only by Issue 2732): a Spec revision reaches the owner only when it is his to read.
 * A lead's Spec is its plan and never waits; four kinds wait for him by rule (`specPathOf`). The `factory-spec-screen`
 * workflow is no longer called; its answer check below leaves with it in a later change.
 */

/** Failed calls before the Spec reaches the owner unscreened; the wait between them. */
export const SPEC_SCREEN_MAX_TRIES = WORKFLOWS.specScreen.retry.tries
export const SPEC_SCREEN_BACKOFF_MS = WORKFLOWS.specScreen.retry.backoffMs

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
  /** the filer set `checkpoint: gate`: only the owner's own verdict ends it, so no screen settles it */
  gate: boolean
}

/** Who made the Spec owed: the Replan's own proposal, the filer, triage's flag, or the lead's judgment. */
export function specSourceOf(origin: SpecOrigin): SpecSource {
  if (origin.replan) return 'replan'
  if (origin.filedSpec) return 'filer'
  if (origin.triaged) return 'triage'
  if (origin.filedWithCheckpoint) return 'filer'
  return 'lead'
}

/**
 * The changes a Replan's Spec proposes, as its fenced `replan` block states them (the Replan playbook, step 4). Strict and
 * with every key required bar `free` (added later; a block without it frees no row): a block that leaves one out or
 * misnames one says nothing a rule may settle on, so it goes to the owner instead.
 */
const ReplanBlock = z.strictObject({
  /** the plan rows the proposal adds, changes or drops, by key: every change to a row but a removed `after` */
  plan: z.array(z.string()),
  /** the plan rows whose only change is an `after` entry taken out: freed, like a removed edge */
  free: z.array(z.string()).default([]),
  edges: z.strictObject({ add: z.array(z.unknown()), remove: z.array(z.unknown()) }),
  cancel: z.array(z.unknown()),
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
 * Where a Spec revision goes, by rule alone (Issue 2732: no workflow reads a Spec):
 * - `owner`: it waits for the owner's verdict, and he is paged;
 * - `settled`: it waits, and the factory settles it by rule with its own looks_good;
 * - `plan`: the lead's plan. It does not wait and pages no one; the owner may still comment on it at any time.
 */
export type SpecPath = { path: 'owner' | 'settled' | 'plan'; reason: string }

/** The reason a lead's Spec carries: what `artifact submit` answers and the screen row records. */
export const PLAN_REASON = "a lead's Spec is its plan: it does not wait for the owner"

/**
 * Four Specs wait for the owner, everything else is the lead's plan:
 * - a revision after the owner asked for changes is his to read again: he asked for it;
 * - a Spec of an owner gate (`checkpoint: gate`): only his own verdict ends it;
 * - a Spec its filer attached is handed over for his review on purpose;
 * - a Replan whose block changes a plan row or cancels an Issue (or whose block does not parse, so no rule reads a guess).
 * A Replan whose block does neither only reorders (it frees Issues or rows from a stalled head, or adds an edge): it is
 * settled by rule, and the lead applies it on its defaults. An edge is reversible with one call, a freed row's `after`
 * with one plan edit.
 */
export function specPathOf(input: RuleInput): SpecPath {
  if (input.revision > 1 && input.earlier.includes('changes')) {
    return { path: 'owner', reason: 'a revision the owner asked for with his verdict of changes' }
  }
  if (input.origin.gate) {
    return { path: 'owner', reason: 'an owner gate: only the owner gives its verdict' }
  }
  if (input.origin.filedSpec) {
    return { path: 'owner', reason: 'its filer attached it with the Issue for the owner to review' }
  }
  if (input.origin.replan) {
    const block = replanBlockOf(input.content)
    if (block?.plan.length === 0 && block.cancel.length === 0) {
      const issues = block.edges.remove.length
      const rows = new Set(block.free).size
      const freed = [
        ...(issues > 0 ? [issues === 1 ? 'an Issue' : `${issues} Issues`] : []),
        ...(rows > 0 ? [rows === 1 ? 'a plan row' : `${rows} plan rows`] : []),
      ]
      const what =
        rows > 0
          ? 'a Replan that changes a plan row only by a removed after and cancels nothing'
          : 'a Replan that changes no plan row and cancels nothing'
      return {
        path: 'settled',
        reason:
          freed.length > 0
            ? `${what}: it only frees ${freed.join(' and ')} from ${issues + rows === 1 ? 'a wait' : 'their waits'}`
            : what,
      }
    }
    return {
      path: 'owner',
      reason: block
        ? 'a Replan that changes a plan row or cancels an Issue'
        : 'a Replan whose replan block is missing or does not parse',
    }
  }
  return { path: 'plan', reason: PLAN_REASON }
}

/**
 * The screen's look at a revision that waits: the owner's pass, or the factory's settle. A lead's plan that waits all the
 * same (handed over before Issue 2732, or revised while its Issue still waited on it) is settled, so its Issue works again.
 */
export function screenSpecByRule(input: RuleInput): RuleOutcome {
  const { path, reason } = specPathOf(input)
  return { outcome: path === 'owner' ? 'passed' : 'settled', reason }
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

/** The note the lead hears when the screen settles its Spec. */
export const settledNote = (reason: string): string =>
  `The Spec screen settled it without the owner: ${reason}. Build on your defaults; the owner can still overrule them with a note.`
