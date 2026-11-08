import * as z from 'zod'
import type { Actor } from '../../kernel/events.ts'
import { idOf, type IssueId } from '../../kernel/ids.ts'
import { KINDS, ORIGINS } from './issue.ts'

const text = z.string().trim().min(1)
const attempt = z.number().int().min(1)
const issueRef = z.custom<IssueId>((value) => typeof value === 'string' && idOf('issue', value) !== null, {
  message: 'not an Issue id',
})
const checkpoint = z.object({ id: text, summary: text })

/** The verdicts on an artifact (`docs/language.md`, Verdict). */
export const VERDICTS = ['looks_good', 'with_notes', 'changes', 'no_longer_applies'] as const

/**
 * Every event an Issue takes, with its payload. The words are `docs/language.md`'s; an event that names an attempt, a
 * watch or a wait is for that one only, so a late one changes nothing.
 */
export const PAYLOADS = {
  /** triage made it an Issue: it begins `settling` */
  filed: z.object({ repo: text, title: text, kind: z.enum(KINDS), origin: z.enum(ORIGINS) }),
  /** triage and the chain are done: it may be queued; triage may refine an owner or agent request's kind (old events carry none) */
  settled: z.object({ kind: z.enum(KINDS).optional() }),
  /** capacity lets a lead start: the next attempt */
  admitted: z.object({}),
  /** the attempt's lead runs in its terminal */
  lead_started: z.object({ attempt, terminal: text }),
  /** the attempt's lead failed to start or ended */
  lead_gone: z.object({ attempt, detail: text }),
  /** an amend or a note reaches the lead */
  noted: z.object({ text, via: z.enum(['orchestrator']).optional() }),
  /** the lead raised a Decision and waits for its answer (or the steward did, for a stall it cannot end by itself) */
  asked: z.object({ attempt, decision: checkpoint }),
  /** a Decision got its answer */
  answered: z.object({ decision: text, answer: text }),
  /** the lead handed a Concept or Spec over for review and waits for the verdict */
  submitted: z.object({ attempt, artifact: checkpoint }),
  /** the owner's verdict on that artifact */
  verdict_given: z.object({ artifact: text, verdict: z.enum(VERDICTS) }),
  /** the lead needs the owner's hands */
  errand_raised: z.object({ attempt, errand: checkpoint }),
  /** the owner did the errand, or the screen turned it away (`turnedAway`: why) */
  errand_done: z.object({ errand: text, turnedAway: text.optional() }),
  /** the lead waits until a time, or until other Issues close (the steward defers a holder behind a queued Issue that needs its claim) */
  deferred: z.union([
    z.object({ attempt, until: z.iso.datetime({ offset: true }) }),
    // `why` is the steward's: it defers a holder behind the Issue that waits for the claim the holder keeps
    z.object({ attempt, after: z.array(issueRef).min(1).max(20), why: text.optional() }),
  ]),
  /** a machine cause stopped the work: the steward's to end */
  stalled: z.object({ attempt, cause: z.enum(['wall', 'unreported', 'blocked']), detail: text }),
  /** a wait ended without a person; `since` names the wait */
  woken: z.object({ since: z.number().int().min(1), detail: text }),
  /** the lead landed and deployed: the watch begins */
  shipped: z.object({ attempt }),
  /** verify ended the watch green */
  watch_passed: z.object({ watch: z.number().int().min(1) }),
  /** the change broke something: the watch it broke in, or none for a signal that speaks for the Issue as it is */
  regressed: z.object({ watch: z.number().int().min(1).nullable(), detail: text }),
  /** a closed Issue opens again: its own verb, the only way out of `closed` */
  reopened: z.object({ reason: text }),
  /** the owner's stop */
  cancelled: z.object({ reason: text }),
  /** ended without a watch: done or dropped by its lead, or healed before one started */
  closed: z.object({
    attempt: attempt.nullable(),
    outcome: z.enum(['done', 'dropped', 'healed']),
    reason: text,
  }),
} as const

export type EventKind = keyof typeof PAYLOADS
export const EVENT_KINDS = Object.keys(PAYLOADS) as EventKind[]
export type Payload<K extends EventKind> = z.infer<(typeof PAYLOADS)[K]>

/** An event as the machine reads it. */
export interface IssueEvent<K extends EventKind = EventKind> {
  kind: K
  payload: Payload<K>
  actor: Actor
}

/** Any event, narrowed by its kind. */
export type AnyIssueEvent = { [K in EventKind]: IssueEvent<K> }[EventKind]

/** Who may send each event; anyone else is refused. The owner is never the only way out of a machine wait. */
export const SENDERS: { [K in EventKind]: readonly Actor[] } = {
  filed: ['factory', 'owner', 'orchestrator'],
  settled: ['factory'],
  admitted: ['factory'],
  lead_started: ['factory'],
  lead_gone: ['factory'],
  noted: ['owner', 'orchestrator', 'factory', 'steward', 'judge'],
  asked: ['lead', 'steward'],
  answered: ['owner', 'orchestrator', 'judge', 'factory'],
  submitted: ['lead'],
  verdict_given: ['owner'],
  errand_raised: ['lead'],
  errand_done: ['owner', 'judge', 'factory'],
  deferred: ['lead', 'steward'],
  stalled: ['lead', 'factory'],
  woken: ['factory', 'steward', 'owner', 'orchestrator'],
  shipped: ['lead'],
  watch_passed: ['factory'],
  regressed: ['factory'],
  reopened: ['owner', 'orchestrator', 'factory'],
  cancelled: ['owner', 'orchestrator'],
  closed: ['lead', 'factory'],
}

const isKind = (kind: string): kind is EventKind => Object.hasOwn(PAYLOADS, kind)

/** An event from outside (a request, a stored row): its kind known and its payload as the schema has it. */
export function parseIssueEvent(raw: { kind: string; payload: unknown; actor: Actor }): AnyIssueEvent | string {
  if (!isKind(raw.kind)) return `unknown event kind ${raw.kind}`
  const parsed = PAYLOADS[raw.kind].safeParse(raw.payload)
  if (!parsed.success)
    return `${raw.kind}: ${parsed.error.issues.map((i) => `${i.path.join('.') || 'payload'} ${i.message}`).join('; ')}`
  return { kind: raw.kind, payload: parsed.data, actor: raw.actor } as AnyIssueEvent
}
