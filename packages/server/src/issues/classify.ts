import { ClassifyAnswer, type Effort, type RoleTable, type Tier } from '@software-factory/contract'
import { basename } from 'node:path'
import type { SQL } from 'bun'
import { childEnv, EXIT_TIMEOUT, runProcess } from '../exec.ts'
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

/** `agw` exits 10 for a run that is still going. */
const EXIT_PENDING = 10

/** One `agw` call: past this it is killed. A call waits at most the CLI's own budget (110 s by default), so this only guards a hang. */
export const DEFAULT_CALL_TIMEOUT_MS = 150_000
/**
 * All the waiting for one classify. A single model request is no worker, but a short limit turns a slow answer into a failure
 * (`rules/agent-limits.md`): this is a hang guard, and a classify that reaches it falls back to defaults like any failure.
 */
export const DEFAULT_CLASSIFY_DEADLINE_MS = 30 * 60_000

/** What `agw factory-classify` accepts. */
const MAX_TITLE = 300
const MAX_FACTS = 20_000

const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9-]{5,127}$/

/** The id of a pending run, from the JSON `agw` printed with exit 10. */
function runIdOf(stdout: string): string | undefined {
  try {
    const body = JSON.parse(stdout) as Record<string, unknown>
    const run = body.run as Record<string, unknown> | undefined
    const id = body.runId ?? body.run_id ?? run?.id ?? body.id
    return typeof id === 'string' && RUN_ID.test(id) ? id : undefined
  } catch {
    return undefined
  }
}

export class ClassifyFailed extends Error {}

export interface AgwClassifierOptions {
  /** the `agw` binary (`FACTORY_AGW_BIN`) */
  bin: string
  callTimeoutMs?: number
  deadlineMs?: number
  /** swapped by the tests */
  run?: typeof runProcess
  now?: () => number
}

/**
 * `agw factory-classify --format json` with the Issue on stdin as JSON (the facts stay a value under `facts`, never part of an
 * instruction). Exit 10 means the run is still going: `agw run wait <runId>` until the exit is not 10, as every `agw` caller
 * does. Exit 0 is read for `status` (`done`) and the workflow's `output`.
 */
export class AgwClassifier implements Classifier {
  private readonly run: typeof runProcess
  private readonly now: () => number

  constructor(private readonly options: AgwClassifierOptions) {
    this.run = options.run ?? runProcess
    this.now = options.now ?? Date.now
  }

  async classify(input: ClassifyInput): Promise<unknown> {
    const callMs = this.options.callTimeoutMs ?? DEFAULT_CALL_TIMEOUT_MS
    const deadline = this.now() + (this.options.deadlineMs ?? DEFAULT_CLASSIFY_DEADLINE_MS)
    // The workflow's limits: facts a string of at most 20,000 characters and a title of 300 (more is refused, so it is cut);
    // repo and source are identifiers, so the repo goes by its directory's name, the project's name.
    const stdin = JSON.stringify({
      title: input.title.slice(0, MAX_TITLE),
      facts: (JSON.stringify(input.facts) ?? '{}').slice(0, MAX_FACTS),
      repo: basename(input.repo),
      source: input.source,
      projects: input.projects,
    })
    // The key is the Issue's: a classify asked again after a restart finds its run instead of paying for a second.
    const command = [
      this.options.bin,
      'factory-classify',
      '--format',
      'json',
      '--idempotency-key',
      `factory-classify-${input.id}`,
    ]
    let result = await this.run(command, callMs, childEnv(), stdin)
    while (result.exitCode === EXIT_PENDING) {
      const runId = runIdOf(result.stdout)
      if (!runId) throw new ClassifyFailed('agw says the run is pending but names no run id')
      if (this.now() >= deadline) throw new ClassifyFailed(`classify run ${runId} did not finish in time`)
      result = await this.run([this.options.bin, 'run', 'wait', runId, '--format', 'json'], callMs, childEnv())
    }
    if (result.exitCode === EXIT_TIMEOUT) throw new ClassifyFailed('agw did not answer in time')
    if (result.exitCode !== 0) throw new ClassifyFailed(`agw exited ${result.exitCode}`)
    let body: unknown
    try {
      body = JSON.parse(result.stdout)
    } catch {
      throw new ClassifyFailed('agw printed no JSON')
    }
    const envelope = body as { status?: unknown; output?: unknown }
    if (envelope.status !== undefined && envelope.status !== 'done') {
      throw new ClassifyFailed(`the classify run is ${String(envelope.status)}`)
    }
    return envelope.output ?? body
  }
}

const TIER_ORDER: readonly Tier[] = ['haiku', 'sonnet', 'opus']
const EFFORT_ORDER: readonly Effort[] = ['low', 'medium', 'high', 'xhigh', 'max']

/** The most a lead is ever started at, whatever the role table says. */
export const LEAD_CEILING = { tier: 'opus', effort: 'high' } as const satisfies { tier: Tier; effort: Effort }

const lower = <T extends string>(order: readonly T[], a: T, b: T): T => (order.indexOf(a) <= order.indexOf(b) ? a : b)

/** The `lead` entry of the role table is the ceiling and the default; nothing goes above `opus/high`. */
export function leadBounds(roles: RoleTable): { tier: Tier; effort: Effort } {
  const lead = roles.get('lead')
  return {
    tier: lower(TIER_ORDER, lead?.tier ?? LEAD_CEILING.tier, LEAD_CEILING.tier),
    effort: lower(EFFORT_ORDER, lead?.effort ?? LEAD_CEILING.effort, LEAD_CEILING.effort),
  }
}

/** Tier and effort as Classify asked, cut to the ceiling. */
export function clampLead(
  asked: { tier: Tier; effort: Effort },
  ceiling: { tier: Tier; effort: Effort },
): { tier: Tier; effort: Effort; clamped: boolean } {
  const tier = lower(TIER_ORDER, asked.tier, ceiling.tier)
  const effort = lower(EFFORT_ORDER, asked.effort, ceiling.effort)
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
  const ceiling = leadBounds(roles)
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
  const lead = answer ? clampLead(answer, ceiling) : { ...ceiling, clamped: false }
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
