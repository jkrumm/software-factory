import {
  kindOfPayload,
  DEFAULT_RESUME_RULES,
  type ErrorPoint,
  type Pending,
  planResumes,
  type ResumeRules,
  resumePrefix,
  type Step,
} from '../domains/leads/apierror.ts'
import { leadKey } from '../domains/leads/names.ts'
import type { ApiErrorPorts, AuthMarkRow, LeadAttempt, LoginErrands, TranscriptTails } from '../domains/leads/ports.ts'
import { deriveSession, type HookFact, type SessionView } from '../domains/leads/session.ts'
import { ok } from '../kernel/result.ts'
import { type LeadDeps, loadIssue } from './leads.ts'

/** The resume rules in force: the domain's, with the waits and the stagger the settings name. The steward reads the same ones. */
export const resumeRulesOf = (input: { delaysMs: readonly number[]; staggerMs: number }): ResumeRules => ({
  ...DEFAULT_RESUME_RULES,
  delaysMs: input.delaysMs,
  staggerMs: input.staggerMs,
})

/** The API-error path's ports from its parts and the settings: the rules (the waits, the stagger) are the domain's, the numbers the settings'. */
export function apiErrorPorts(input: {
  tails: TranscriptTails
  errands: LoginErrands
  delaysMs: readonly number[]
  staggerMs: number
  detectAfterMs: number
  probeEveryMs: number
}): ApiErrorPorts {
  return {
    tails: input.tails,
    errands: input.errands,
    rules: resumeRulesOf(input),
    detectAfterMs: input.detectAfterMs,
    probeEveryMs: input.probeEveryMs,
  }
}

/** What the API-error path of one pass did. */
export interface ApiErrorPass {
  /** sessions found through their transcript (no `StopFailure` hook told of them) */
  detected: number
  /** `continue` typed (or a draft submitted) */
  resumed: number
  /** accounts marked "not signed in", each with its Errand */
  marked: number
  /** account marks closed because the owner's Errand is done */
  cleared: number
  /** edge incidents recorded or grown */
  edges: number
}

/** The recent errors that make an edge incident are read over this long. */
const POINT_HORIZON_MS = 30 * 60_000

/** What the path keeps between passes: when each session's transcript was last read. Losing it costs one read. */
export interface ApiErrorMemory {
  probed: Map<string, number>
}

export const apiErrorMemory = (): ApiErrorMemory => ({ probed: new Map() })

interface Entry {
  row: LeadAttempt
  name: string
  facts: HookFact[]
  view: SessionView
  /** this attempt's `continue` deliveries, as claimed: key and time */
  resumes: { key: string; at: Date }[]
}

interface Loaded {
  entries: Entry[]
  marks: AuthMarkRow[]
}

/** The leads the factory answers: a started attempt of a `working` or `watching` Issue, with its session derived and its resumes. */
async function load(deps: LeadDeps): Promise<Loaded | null> {
  const loaded = await deps.uow.run(async ({ work, leads }) => {
    const entries: Entry[] = []
    for (const row of await leads.followed()) {
      const issue = await loadIssue(work, row.issueId)
      if (!issue || issue.issue.attempt !== row.attempt || !row.terminal) continue
      const { state } = issue.issue
      if (state !== 'working' && state !== 'watching') continue
      const name = leadKey(row.issueId, row.attempt)
      const facts = await leads.hookFacts(name)
      const resumes = (await leads.resumesOf(row.issueId, row.attempt)).map((d) => ({ key: d.key, at: d.claimedAt }))
      entries.push({ row, name, facts, view: deriveSession(facts), resumes })
    }
    return ok({ entries, marks: await leads.authMarks() })
  })
  return loaded.ok ? loaded.value : null
}

/**
 * A turn that ends on an API error fires `StopFailure`, not `Stop`; a session whose hook did not run (an install that
 * predates it, a hook that failed) shows a turn that never ends. A turn open and silent for `detectAfterMs` has the end of
 * its transcript read, at most every `probeEveryMs`, and an API error written after the turn began is recorded as the same
 * fact the hook would have stored. Returns how many it found.
 */
async function detect(deps: LeadDeps, entries: readonly Entry[], memory: ApiErrorMemory): Promise<number> {
  const ports = deps.apiErrors
  if (!ports) return 0
  const now = deps.clock.now().getTime()
  let found = 0
  for (const { row, name, view } of entries) {
    if (view.state !== 'working' || !view.turnStartedAt || !view.transcriptPath) continue
    const quiet = now - Math.max(view.lastEventAt?.getTime() ?? 0, view.turnStartedAt.getTime())
    if (quiet < ports.detectAfterMs) continue
    if (now - (memory.probed.get(name) ?? 0) < ports.probeEveryMs) continue
    memory.probed.set(name, now)
    const tail = await ports.tails.apiError(view.transcriptPath)
    if (!tail.ok || !tail.value || tail.value.at <= view.turnStartedAt) continue
    // A rate limit is the account's wall, which its own hook and stall answer; only the other errors are found here.
    if (tail.value.error === 'rate_limit') continue
    const { at, error, status, text } = tail.value
    const stored = await deps.uow.run(async ({ leads }) =>
      ok(
        await leads.appendHook({
          issue: row.issueId,
          attempt: row.attempt,
          session: name,
          // the turn and the error's own time: a replay of the same read is the same key
          fact: {
            key: `${name}:api_error:${view.turns}:tail:${at.getTime()}`,
            kind: 'api_error',
            at,
            payload: {
              ...(error ? { error } : {}),
              ...(status === null ? {} : { status }),
              message: text,
              source: 'transcript',
            },
          },
          receivedAt: deps.clock.now(),
        }),
      ),
    )
    if (stored.ok && stored.value) found++
  }
  return found
}

/** The errors of the last half hour that a burst is found in: transient ones only, one per fact. */
function pointsOf(entries: readonly Entry[], now: Date): ErrorPoint[] {
  const from = now.getTime() - POINT_HORIZON_MS
  return entries.flatMap(({ name, facts }) =>
    facts.flatMap((fact) =>
      fact.kind === 'api_error' && fact.at.getTime() >= from && kindOfPayload(fact.payload).class === 'transient'
        ? [{ session: name, key: fact.key, at: fact.at }]
        : [],
    ),
  )
}

function pendingOf(entries: readonly Entry[], marks: readonly AuthMarkRow[]): Pending[] {
  return entries.flatMap(({ row, name, view, resumes }) => {
    const incident = view.apiIncident
    // `idle`: a turn that started since is working again, and its own end or its next error is the next fact.
    if (!incident || view.state !== 'idle') return []
    const prefix = resumePrefix(name, incident.key)
    const mark = marks.find((m) => m.account === row.account)
    return [
      {
        session: name,
        issue: row.issueId,
        attempt: row.attempt,
        account: row.account,
        incident,
        resumes: resumes.filter((r) => r.key.startsWith(prefix)).map((r) => r.at),
        mark: mark ? { markedAt: mark.markedAt, clearedAt: mark.clearedAt } : null,
      },
    ]
  })
}

/** One `continue`: claimed first (the key is the delivery's, so a replay finds it), then typed into the lead's terminal. */
async function resume(deps: LeadDeps, step: Extract<Step, { kind: 'resume' }>): Promise<boolean> {
  const { pending, key, text } = step
  const claimed = await deps.uow.run(async ({ leads }) =>
    ok(
      await leads.claimDelivery({
        key,
        issueId: pending.issue,
        attempt: pending.attempt,
        kind: 'resume',
        text,
        claimedAt: deps.clock.now(),
      }),
    ),
  )
  if (!claimed.ok || !claimed.value) return false
  // Nothing typed is no resume: a lead with no live terminal, or a screen that is not the API-error state ('busy'), gives the claim
  // back and the next pass looks again. A call that told us nothing ('uncertain') may have typed, so its claim stays spent.
  const release = async (): Promise<false> => {
    await deps.uow.run(async ({ leads }) => {
      await leads.unclaimDelivery(key)
      return ok(undefined)
    })
    return false
  }
  const found = await deps.terminals.find(pending.session)
  const live = found.ok ? found.value.find((terminal) => terminal.live) : undefined
  if (!live) return release()
  const typed = await deps.terminals.resume({ terminal: live.address, text })
  if (typed.ok && typed.value === 'busy') return release()
  if (!typed.ok) return false
  const at = deps.clock.now()
  await deps.uow.run(async ({ leads }) => {
    await leads.markTyped(key, at, true)
    return ok(undefined)
  })
  return true
}

/** An account whose login failed: the Errand is raised once (its key is the account's) and the account is marked. */
async function markAccount(deps: LeadDeps, step: Extract<Step, { kind: 'mark_account' }>): Promise<boolean> {
  const ports = deps.apiErrors
  if (!ports) return false
  const errandKey = `account-login:${step.account}`
  const raised = await ports.errands.raise({ account: step.account, key: errandKey, label: step.label })
  if (!raised.ok) return false
  const at = deps.clock.now()
  const marked = await deps.uow.run(async ({ leads }) => {
    await leads.markAuth({ account: step.account, at, errandKey, label: step.label })
    return ok(undefined)
  })
  return marked.ok
}

/** Marks whose Errand is no longer open close: the account answers again, and its leads are resumed as a transient error is. */
async function clearMarks(deps: LeadDeps, marks: readonly AuthMarkRow[]): Promise<number> {
  const ports = deps.apiErrors
  const open = marks.filter((mark) => mark.clearedAt === null)
  if (!ports || open.length === 0) return 0
  const errands = await ports.errands.open()
  if (!errands.ok) return 0
  let cleared = 0
  for (const mark of open) {
    if (errands.value.has(mark.errandKey)) continue
    const at = deps.clock.now()
    const done = await deps.uow.run(async ({ leads }) => {
      await leads.clearAuth(mark.account, at)
      return ok(undefined)
    })
    if (done.ok) cleared++
  }
  return cleared
}

/**
 * The API-error path of the lead tick: finds the sessions whose turn ended on an API error, answers each by its class, and
 * leaves the rest to the steward.
 *  - transient (a Cloudflare 403, 429, 5xx, a timeout): `continue` after 1 minute, then 3, then 10, five times at most; an
 *    edge incident (three or more leads within five minutes) shares one clock, is staggered and is one friction row;
 *  - auth (a 401, a revoked token): the account is marked, never admitted on again until its Errand is done, and the Errand
 *    "log in account X" is raised once per account; nothing is moved.
 * Every step finds its own work done, so a pass twice in a row types nothing twice.
 */
export async function handleApiErrors(deps: LeadDeps, memory: ApiErrorMemory): Promise<ApiErrorPass> {
  const pass: ApiErrorPass = { detected: 0, resumed: 0, marked: 0, cleared: 0, edges: 0 }
  const ports = deps.apiErrors
  if (!ports) return pass
  let loaded = await load(deps)
  if (!loaded) return pass
  pass.detected = await detect(deps, loaded.entries, memory)
  if (pass.detected > 0) loaded = (await load(deps)) ?? loaded
  pass.cleared = await clearMarks(deps, loaded.marks)
  if (pass.cleared > 0) loaded = (await load(deps)) ?? loaded

  const now = deps.clock.now()
  const plan = planResumes({
    now,
    pending: pendingOf(loaded.entries, loaded.marks),
    points: pointsOf(loaded.entries, now),
    rules: ports.rules,
  })
  // The owner's plan sessions hit the same edge: counted with the incident, never resumed (they are his, not the factory's).
  const plans = plan.edges.length > 0 ? await deps.terminals.planErrors() : null
  const planCount = plans?.ok ? plans.value.length : 0
  for (const edge of plan.edges) {
    const recorded = await deps.uow.run(async ({ leads }) => {
      await leads.recordEdge({
        key: edge.key,
        firstAt: edge.from,
        lastAt: edge.to,
        leads: edge.sessions.length,
        plans: planCount,
        at: now,
      })
      return ok(undefined)
    })
    if (recorded.ok) pass.edges++
  }
  for (const step of plan.steps) {
    if (step.kind === 'resume') {
      if (await resume(deps, step)) pass.resumed++
    } else if (await markAccount(deps, step)) pass.marked++
  }
  return pass
}
