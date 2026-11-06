import type { SQL } from 'bun'
import { z } from 'zod'
import { notifyAsk } from '../notify/rules.ts'
import { record } from '../notify/outbox.ts'
import { stewardMessage } from '../notify/text.ts'
import { type AgwOptions, callAgw } from './agw-call.ts'
import { enqueue } from './inbox.ts'
import { factsOf, planOf, repoName } from './judge-input.ts'
import { markEvent } from './shared.ts'

/**
 * The ask judge (docs/design.md §4 "The ask judge"): a decision ask and a spent steward escalation are judged by the `agw factory-ask`
 * workflow before the owner hears of them. The factory calls no model: the workflow answers from the repo's plan documents or says the
 * owner must. A verdict `answer` is filed as an inbox `answer` (or `note`) from the steward; anything else, and every failure, leaves
 * the ask exactly as it was and tells the owner. The judge is never called inside a transaction.
 */

/** What `agw factory-ask` is asked, already scrubbed and cut. */
export interface AskInput {
  question: string
  options: string[]
  default: string | null
  facts: string
  plan: string
  repo: string
}

export interface AskJudge {
  /** The workflow's output, unchecked; `key` is the ask's, so one asked again after a restart finds its run. */
  judge(input: AskInput, key: string): Promise<unknown>
}

export class AskJudgeFailed extends Error {}

const MAX_QUESTION = 2000
const MAX_OPTIONS = 10
const MAX_OPTION = 1000

/** `agw factory-ask --format json` with the ask on stdin under `ask`; the run, its pending loop and its failures are `callAgw`'s. */
export class AgwAskJudge implements AskJudge {
  constructor(private readonly options: AgwOptions) {}

  judge(input: AskInput, key: string): Promise<unknown> {
    const ask = {
      ...input,
      question: input.question.slice(0, MAX_QUESTION),
      options: input.options
        .filter((option) => option !== '')
        .slice(0, MAX_OPTIONS)
        .map((option) => option.slice(0, MAX_OPTION)),
      default: input.default ? input.default.slice(0, MAX_OPTION) : null,
    }
    return callAgw(this.options, {
      workflow: 'factory-ask',
      label: 'ask',
      idempotencyKey: key,
      stdin: JSON.stringify({ ask }),
      failure: (message) => new AskJudgeFailed(message),
    })
  }
}

const Verdict = z.object({
  verdict: z.enum(['answer', 'owner']),
  answer: z.string(),
  reason: z.string(),
  source: z.string(),
})

/** A declared default is taken only when it is a choice to leave things open, never a statement of fact about the world. */
const LEAVE_OPEN =
  /^(?:do nothing|leave\b|keep (?:it |this |that |them )?(?:as[ -]is|open|unchanged)|skip\b|defer\b|wait\b|hold\b|not now\b)/i
const NOTHING_NEEDED = /^(?:nothing|none|no changes?)(?: (?:needed|to do|for now|yet))?[.!]?$/i

export function isDoNothing(text: string | null): boolean {
  const clean = (text ?? '').trim().replace(/^["'“‘(\s]+/, '')
  return LEAVE_OPEN.test(clean) || NOTHING_NEEDED.test(clean)
}

const same = (a: string, b: string): boolean => a.trim().toLowerCase() === b.trim().toLowerCase()

/** The source a visible repo's do-nothing default is filed under: nothing of that repo went to a model. */
export const VISIBLE_SOURCE = 'default (nothing of this repo is sent to a model)'

export type Guarded = { ok: true; answer: string; source: string } | { ok: false; why: string }

/**
 * The factory's checks on an `answer` verdict, after the workflow: with options the answer is exactly one of them; it names a source; and
 * a declared default (the source says so, or the answer equals it) stands only when it is a do-nothing choice.
 */
export function guard(
  ask: { options: readonly string[]; default: string | null },
  verdict: z.infer<typeof Verdict>,
): Guarded {
  const answer = verdict.answer.trim()
  const source = verdict.source.trim()
  if (answer === '') return { ok: false, why: 'the answer is empty' }
  if (source === '') return { ok: false, why: 'the answer names no source' }
  const chosen = ask.options.length > 0 ? ask.options.find((option) => option.trim() === answer) : answer
  if (chosen === undefined) return { ok: false, why: 'the answer is not one of the options' }
  const fromDefault = /^default/i.test(source)
  const isDefault = ask.default !== null && same(chosen, ask.default)
  if (fromDefault || isDefault) {
    if (ask.default === null) return { ok: false, why: 'the source is a default that was not declared' }
    if (!isDefault) return { ok: false, why: 'the source is the default, the answer is not' }
    if (!isDoNothing(ask.default))
      return { ok: false, why: 'the default states a fact; it is not a leave-it-open choice' }
  }
  return { ok: true, answer: chosen.trim(), source }
}

export const ASK_MARK = (decision: number | string): string => `ask_judged:${decision}`
export const STEWARD_MARK = (issue: number, cause: string): string => `steward_judged:${issue}:${cause}`

type Outcome = 'answered' | 'owner' | 'failed' | 'rejected' | 'visible'

interface Judged {
  outcome: Outcome
  verdict: string | null
  reason: string
  source: string
  answer: string
}

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error))

interface IssueFields {
  id: number
  title: string
  facts: unknown
  repo: string
  state: string
  /** a business Issue's question is the owner's whatever default the lead named (the lifecycle rule of `expireDecision`) */
  business: boolean
}

type Item =
  | {
      kind: 'ask'
      key: string
      issue: IssueFields
      decision: number
      question: string
      options: string[]
      default: string | null
    }
  | { kind: 'escalation'; key: string; issue: IssueFields; cause: string; tried: string[] }

export interface AskJudgementDeps {
  sql: SQL
  now: () => Date
  /** without it every ask stands, as it was before the judge */
  judge?: AskJudge
  /** whether a repo path is IuRoot's (`Places.isVisible`): nothing of it goes to the judge */
  visible?: () => Promise<(path: string) => boolean>
  /** most judgments running at once; the rest wait for a later pass */
  concurrency?: number
  /** swapped by the tests */
  plan?: (repoPath: string) => Promise<string>
}

/**
 * Judges the open decisions and the spent escalations that have no verdict yet. `start` returns at once when a judge is wired (a run can
 * take minutes and the tick must not); each judgment stores its marker when done. A restart loses what was in flight: the next pass
 * asks again under the same idempotency key. Without a judge the item is settled in the pass, as a failure: the owner hears of it.
 */
export class AskJudgement {
  private readonly inflight = new Map<string, Promise<void>>()

  constructor(private readonly deps: AskJudgementDeps) {}

  async start(): Promise<void> {
    const { judge } = this.deps
    const room = judge ? (this.deps.concurrency ?? 2) - this.inflight.size : 50
    if (room <= 0) return
    const items = (await this.pending(room)).slice(0, room)
    if (items.length === 0) return
    const visible = (await this.deps.visible?.()) ?? (() => false)
    for (const item of items) {
      const run = this.settle(item, visible(item.issue.repo)).catch((error: unknown) => {
        // The store failed (the database went away): there is no marker, and the next pass tries again.
        console.error('ask judge failed to store', { item: item.key, reason: message(error) })
      })
      if (!judge) {
        await run
        continue
      }
      this.inflight.set(
        item.key,
        run.finally(() => this.inflight.delete(item.key)),
      )
    }
  }

  /** Waits for what is running now. The tests use it; the server never waits for a judgment. */
  async settled(): Promise<void> {
    await Promise.all(this.inflight.values())
  }

  private async pending(limit: number): Promise<Item[]> {
    const { sql } = this.deps
    const skip = ['', ...this.inflight.keys()]
    const asks: {
      id: string
      issue_id: number
      question: string
      options: unknown
      default_option: string | null
      title: string
      facts: unknown
      repo: string
      state: string
      business: boolean
    }[] = await sql`
      SELECT d.id, d.issue_id, d.question, d.options, d.default_option, i.title, i.facts, i.repo, i.state,
             (i.class = 'business' OR i.classify->>'class' = 'business') IS TRUE AS business
      FROM factory.decisions d JOIN factory.issues i ON i.id = d.issue_id
      WHERE d.answered_at IS NULL AND i.state <> 'closed'
        AND NOT EXISTS (SELECT 1 FROM factory.issue_events m WHERE m.key = 'ask_judged:' || d.id)
        AND 'ask:' || d.id NOT IN ${sql(skip)}
      ORDER BY d.id LIMIT ${limit}`
    const spent: {
      issue_id: number
      payload: { cause?: string; tried?: string[] } | null
      title: string
      facts: unknown
      repo: string
      state: string
      business: boolean
    }[] = await sql`
      SELECT e.issue_id, e.payload, i.title, i.facts, i.repo, i.state,
             (i.class = 'business' OR i.classify->>'class' = 'business') IS TRUE AS business
      FROM factory.issue_events e JOIN factory.issues i ON i.id = e.issue_id
      WHERE e.kind = 'steward_exhausted' AND i.state <> 'closed'
        AND NOT EXISTS (SELECT 1 FROM factory.issue_events m WHERE m.key = 'steward_judged:' || e.issue_id || ':' || (e.payload->>'cause'))
        AND NOT EXISTS (SELECT 1 FROM factory.notifications n WHERE n.key = 'notify:steward:' || e.issue_id || ':' || (e.payload->>'cause'))
        AND 'esc:' || e.issue_id || ':' || (e.payload->>'cause') NOT IN ${sql(skip)}
      ORDER BY e.id LIMIT ${limit}`
    const issueOf = (row: {
      issue_id: number
      title: string
      facts: unknown
      repo: string
      state: string
      business: boolean
    }): IssueFields => ({
      id: row.issue_id,
      title: row.title,
      facts: row.facts,
      repo: row.repo,
      state: row.state,
      business: row.business,
    })
    return [
      ...asks.map((row): Item => ({
        kind: 'ask',
        key: `ask:${row.id}`,
        issue: issueOf(row),
        decision: Number(row.id),
        question: row.question,
        options: Array.isArray(row.options) ? row.options.filter((o): o is string => typeof o === 'string') : [],
        default: row.default_option,
      })),
      ...spent.flatMap((row): Item[] =>
        row.payload?.cause
          ? [
              {
                kind: 'escalation',
                key: `esc:${row.issue_id}:${row.payload.cause}`,
                issue: issueOf(row),
                cause: row.payload.cause,
                tried: row.payload.tried ?? [],
              },
            ]
          : [],
      ),
    ]
  }

  /** The verdict for one item, through the guards; no database write. */
  private async verdictOf(item: Item, visible: boolean): Promise<Judged> {
    const ask =
      item.kind === 'ask'
        ? { question: item.question, options: item.options, default: item.default }
        : {
            question: `The steward spent its retries on Issue ${item.issue.id} (cause ${item.cause}); what it tried: ${item.tried.join('; ') || 'nothing recorded'}; what should happen next?`,
            options: [],
            default: null,
          }
    const failed = (
      reason: string,
      outcome: Outcome = 'failed',
      verdict: string | null = null,
      source = '',
    ): Judged => ({
      outcome,
      verdict,
      reason,
      source,
      answer: '',
    })
    if (item.issue.business) return failed("a business Issue's question is the owner's", 'owner')
    // Off (no judge wired) sends every ask to the owner, the visible do-nothing shortcut included.
    const { judge } = this.deps
    if (!judge) return failed('no judge is wired')
    if (visible) {
      // Nothing of a visible repo goes to a model: only a declared do-nothing default can settle its ask.
      if (item.kind === 'ask' && item.default !== null && isDoNothing(item.default)) {
        return {
          outcome: 'answered',
          verdict: 'answer',
          reason: 'a declared leave-it-open default',
          source: VISIBLE_SOURCE,
          answer: item.default.trim(),
        }
      }
      return failed('the repo is visible: nothing is sent to a model', 'visible')
    }
    try {
      const plan = await (this.deps.plan ?? planOf)(item.issue.repo)
      const key =
        item.kind === 'ask' ? `factory-ask-${item.decision}` : `factory-ask-esc-${item.issue.id}-${item.cause}`
      const raw = await judge.judge({ ...ask, facts: factsOf(item.issue), plan, repo: repoName(item.issue.repo) }, key)
      const parsed = Verdict.safeParse(raw)
      if (!parsed.success) return failed(`the verdict does not parse: ${parsed.error.issues[0]?.message ?? 'unknown'}`)
      const verdict = parsed.data
      if (verdict.verdict === 'owner') return failed(verdict.reason, 'owner', 'owner', verdict.source)
      const guarded = guard(ask, verdict)
      if (!guarded.ok) return failed(guarded.why, 'rejected', 'answer', verdict.source)
      return {
        outcome: 'answered',
        verdict: 'answer',
        reason: verdict.reason,
        source: guarded.source,
        answer: guarded.answer,
      }
    } catch (error) {
      return failed(message(error))
    }
  }

  private async settle(item: Item, visible: boolean): Promise<void> {
    const judged = await this.verdictOf(item, visible)
    const now = this.deps.now()
    const { sql } = this.deps
    const marker = { verdict: judged.verdict, reason: judged.reason, source: judged.source, outcome: judged.outcome }
    if (item.kind === 'ask') {
      await sql.begin(async (tx) => {
        const { issue } = item
        if (judged.outcome === 'answered') {
          await enqueue(tx, {
            issueId: issue.id,
            key: `judge:${item.decision}`,
            kind: 'answer',
            at: now,
            payload: {
              answer: judged.answer,
              who: 'steward',
              decision: item.decision,
              source: judged.source,
              reason: judged.reason,
              text: `your question was answered by the steward, not the owner, from ${judged.source}: ${judged.answer}. The owner can overrule it with a note.`,
            },
          })
        } else {
          await notifyAsk(tx, {
            issue,
            decision: item.decision,
            question: item.question,
            options: item.options,
            default: item.default,
            now,
          })
        }
        await markEvent(tx, issue.id, ASK_MARK(item.decision), 'ask_judged', now, marker)
      })
      return
    }
    await sql.begin(async (tx) => {
      const { issue } = item
      if (judged.outcome === 'answered') {
        await enqueue(tx, {
          issueId: issue.id,
          key: `steward-judge:${issue.id}:${item.cause}`,
          kind: 'note',
          at: now,
          payload: {
            who: 'steward',
            cause: item.cause,
            text: `the steward spent its retries (${item.cause}); the factory's judge answers from ${judged.source}: ${judged.answer}. The owner can overrule it with a note.`,
            ...(issue.state === 'waiting' ? { wake: true } : {}),
          },
        })
      } else {
        await record(tx, stewardMessage({ issue, cause: item.cause, tried: item.tried }), now)
      }
      await markEvent(tx, issue.id, STEWARD_MARK(issue.id, item.cause), 'steward_judged', now, marker)
    })
  }
}
