import { ClassifyAnswer, type Effort, type RoleTable, type Tier } from '@software-factory/contract'
import { basename } from 'node:path'
import type { SQL } from 'bun'
import { type AgwOptions, callAgw } from './agw-call.ts'
import { logEvent } from './shared.ts'

/** What Classify is asked: the Issue's words and facts (data), and the projects the classifier may name. */
export interface ClassifyInput {
  id: number
  title: string
  facts: unknown
  repo: string
  source: string
  projects: string[]
}

/**
 * The factory never calls a model (SF2): Classify is an `agw` workflow, reached through this port. The answer is whatever the
 * workflow said, unchecked; `classifyIssue` parses it. A rejection is a failed classify, never a stuck Issue.
 */
export interface Classifier {
  classify(input: ClassifyInput): Promise<unknown>
}

/** What `agw factory-classify` accepts. */
const MAX_TITLE = 300
const MAX_FACTS = 20_000

export class ClassifyFailed extends Error {}

/**
 * `agw factory-classify --format json` with the Issue on stdin as JSON (the facts stay a value under `facts`, never part of an
 * instruction); the run, its pending loop and its failures are `callAgw`'s.
 */
export class AgwClassifier implements Classifier {
  constructor(private readonly options: AgwOptions) {}

  classify(input: ClassifyInput): Promise<unknown> {
    // The workflow's limits: facts a string of at most 20,000 characters and a title of 300 (more is refused, so it is cut);
    // repo and source are identifiers, so the repo goes by its directory's name, the project's name.
    const stdin = JSON.stringify({
      title: input.title.slice(0, MAX_TITLE),
      facts: (JSON.stringify(input.facts) ?? '{}').slice(0, MAX_FACTS),
      repo: basename(input.repo),
      source: input.source,
      projects: input.projects,
    })
    return callAgw(this.options, {
      workflow: 'factory-classify',
      label: 'classify',
      idempotencyKey: `factory-classify-${input.id}`,
      stdin,
      failure: (message) => new ClassifyFailed(message),
    })
  }
}

const TIER_ORDER: readonly Tier[] = ['haiku', 'sonnet', 'opus']
const EFFORT_ORDER: readonly Effort[] = ['low', 'medium', 'high', 'xhigh', 'max']

/** The most a lead is ever started at, whatever the role table says. */
export const LEAD_CEILING = { tier: 'opus', effort: 'high' } as const satisfies { tier: Tier; effort: Effort }

const lower = <T extends string>(order: readonly T[], a: T, b: T): T => (order.indexOf(a) <= order.indexOf(b) ? a : b)

/** The `lead` entry of the role table is the level a lead runs at; nothing goes above `opus/high`. */
export function leadBounds(roles: RoleTable): { tier: Tier; effort: Effort } {
  const lead = roles.get('lead')
  return {
    tier: lower(TIER_ORDER, lead?.tier ?? LEAD_CEILING.tier, LEAD_CEILING.tier),
    effort: lower(EFFORT_ORDER, lead?.effort ?? LEAD_CEILING.effort, LEAD_CEILING.effort),
  }
}

/**
 * The tier and effort an Issue lead is started at: the role table's `lead` row (cut to `opus/high`), whatever Classify asked. Classify's
 * labels stay stored and shown; they no longer move the lead (a `chore` asked `haiku/low` and its lead dropped the work rather than wait).
 * `clamped` says the row differs from what Classify asked. Asked at Classify and again at the start, against the table of that moment.
 */
export function leadLevel(
  asked: { tier: Tier; effort: Effort },
  roles: RoleTable,
): { tier: Tier; effort: Effort; clamped: boolean } {
  const { tier, effort } = leadBounds(roles)
  return { tier, effort, clamped: tier !== asked.tier || effort !== asked.effort }
}

interface ToClassify {
  id: number
  title: string
  facts: unknown
  repo: string
  source: string
}

export interface ClassifyDeps {
  sql: SQL
  classifier: Classifier
  roles: RoleTable
  now: () => Date
  /** most classifies running at once; the rest wait for a later pass */
  concurrency?: number
}

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error))

/**
 * Classifies one Issue and stores the outcome, in one transaction with its `issue_events` line. A classify that fails, times
 * out or does not parse stores the role table's `lead` as the defaults and says why: the Issue is admitted all the same, never
 * stuck. Only the first outcome counts (`classified_at IS NULL`), so a classify that finishes twice stores once.
 */
export async function classifyIssue(deps: ClassifyDeps, issue: ToClassify): Promise<'answered' | 'defaulted'> {
  const { sql, roles } = deps
  let answer: ClassifyAnswer | undefined
  let failure: string | undefined
  try {
    const projects: { name: string }[] = await sql`SELECT name FROM factory.projects ORDER BY name`
    const raw = await deps.classifier.classify({ ...issue, projects: projects.map((p) => p.name) })
    const parsed = ClassifyAnswer.safeParse(raw)
    if (parsed.success) answer = parsed.data
    else failure = `the answer does not parse: ${parsed.error.issues[0]?.message ?? 'unknown'}`
  } catch (error) {
    failure = message(error)
  }

  const now = deps.now()
  const lead = answer ? leadLevel(answer, roles) : { ...leadBounds(roles), clamped: false }
  const stored = answer
    ? { ...answer, tier: lead.tier, effort: lead.effort, asked: { tier: answer.tier, effort: answer.effort } }
    : { failure }
  await sql.begin(async (tx) => {
    const rows = await tx`
      UPDATE factory.issues
      SET kind = COALESCE(kind, ${answer?.kind ?? null}), class = COALESCE(class, ${answer?.class ?? null}), size = ${answer?.size ?? null},
          lead_tier = ${lead.tier}, lead_effort = ${lead.effort}, classify = ${stored}, classified_at = ${now}
      WHERE id = ${issue.id} AND classified_at IS NULL
      RETURNING id`
    if (rows.length === 0) return
    await logEvent(
      tx,
      {
        issueId: issue.id,
        key: `classified:${issue.id}`,
        kind: answer ? 'classified' : 'classify_failed',
        from: null,
        to: null,
        at: now,
      },
      answer
        ? {
            kind: answer.kind,
            class: answer.class,
            size: answer.size,
            tier: lead.tier,
            effort: lead.effort,
            clamped: lead.clamped,
          }
        : { detail: failure, tier: lead.tier, effort: lead.effort },
    )
  })
  return answer ? 'answered' : 'defaulted'
}

/**
 * Starts Classify for the queued Issues that have none, and returns at once: a classify can take minutes and the tick must not
 * (its health is judged on it), so each one runs on its own and stores its result when done. An Issue is admitted from the pass after.
 * A restart loses what was in flight; the next pass asks again, the Issue still having no `classified_at`.
 */
export class Classification {
  private readonly inflight = new Map<number, Promise<void>>()

  constructor(private readonly deps: ClassifyDeps) {}

  async start(): Promise<void> {
    const room = (this.deps.concurrency ?? 2) - this.inflight.size
    if (room <= 0) return
    const skip = [0, ...this.inflight.keys()]
    const issues: ToClassify[] = await this.deps.sql`
      SELECT id, title, facts, repo, source FROM factory.issues
      WHERE state = 'queued' AND classified_at IS NULL AND id NOT IN ${this.deps.sql(skip)}
      ORDER BY id LIMIT ${room}`
    for (const issue of issues) {
      const running = classifyIssue(this.deps, issue)
        .then(() => undefined)
        .catch((error: unknown) => {
          // The store failed (the database went away): the Issue still has no `classified_at`, and the next pass tries again.
          console.error('classify failed to store', { issue: issue.id, reason: message(error) })
        })
        .finally(() => this.inflight.delete(issue.id))
      this.inflight.set(issue.id, running)
    }
  }

  /** Waits for what is running now. The tests use it; the server never waits for a classify. */
  async settled(): Promise<void> {
    await Promise.all(this.inflight.values())
  }
}
