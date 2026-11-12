import type { DigestAnswer, DigestRequest } from '@software-factory/contract'
import { DIGEST_WINDOW_MS, type DigestIssue, type DigestProject, groupByProject } from '../../kernel/digest-scope.ts'
import { type IssueId, issueNumber } from '../../kernel/ids.ts'

/**
 * The digest loop's rules (`factory digest` summarises one project's Issues): which Issues belong to a project, what is
 * sent, when a project needs a new digest, and what is kept of the answer. Pure; the model is the agw workflow's.
 */

export { countsOf, DIGEST_WINDOW_MS, groupByProject, projectOfRepo } from '../../kernel/digest-scope.ts'
export type { DigestCounts, DigestIssue, DigestProject, DigestState } from '../../kernel/digest-scope.ts'

/** The agw route the digest is made on, stored with each digest (`agw routes` maps it to a model). */
export const DIGEST_ROUTE = 'factory.digest'

/** The bounds `factory digest` takes. */
const MAX_DONE = 100
const MAX_OPEN = 60
const MAX_AFTER = 10
const MAX_TITLE = 200
const MAX_REASON = 300

/** The newest stored digest of a project, as the loop compares against. */
export interface LatestDigest {
  hash: string
  at: Date
  headline: string
}

/** A digest as stored (`migrations/1014_project_digests.sql`): a fact, a new row per call. */
export interface DigestRecord {
  project: string
  at: Date
  hash: string
  route: string
  digest: DigestAnswer
}

/** One line, cut at `max` characters. */
const oneLine = (text: string, max: number): string => {
  const one = text.replace(/\s+/g, ' ').trim() || '-'
  return one.length <= max ? one : `${one.slice(0, max - 1).trimEnd()}…`
}

const byNumber = (a: { id: string }, b: { id: string }): number =>
  issueNumber(a.id as IssueId) - issueNumber(b.id as IssueId)

/**
 * What `factory digest` is sent: the Issues closed in the last 7 days (newest first) and every open one, by what they are
 * doing now. A settling Issue is queued, a watching one is working. Every list is cut to the bound the workflow takes.
 */
export function requestOf(input: {
  project: string
  issues: readonly DigestIssue[]
  now: Date
  previous: Pick<LatestDigest, 'headline' | 'at'> | null
}): DigestRequest {
  const { now } = input
  const from = new Date(now.getTime() - DIGEST_WINDOW_MS)
  const done = input.issues
    .filter((issue) => issue.state === 'closed' && issue.at >= from)
    .sort((a, b) => b.at.getTime() - a.at.getTime() || byNumber(b, a))
    .slice(0, MAX_DONE)
    .map((issue) => ({
      id: issue.id,
      title: oneLine(issue.title, MAX_TITLE),
      kind: issue.kind,
      closedAt: issue.at.toISOString(),
      outcome: issue.outcome ?? 'closed',
    }))
  const open = input.issues.filter((issue) => issue.state !== 'closed').sort(byNumber)
  const working = open
    .filter((issue) => issue.state === 'working' || issue.state === 'watching')
    .slice(0, MAX_OPEN)
    .map((issue) => ({
      id: issue.id,
      title: oneLine(issue.title, MAX_TITLE),
      kind: issue.kind,
      since: issue.at.toISOString(),
    }))
  const queued = open
    .filter((issue) => issue.state === 'queued' || issue.state === 'settling')
    .slice(0, MAX_OPEN)
    .map((issue) => ({
      id: issue.id,
      title: oneLine(issue.title, MAX_TITLE),
      ...(issue.after.length > 0 ? { after: [...issue.after].sort().slice(0, MAX_AFTER) } : {}),
    }))
  const waiting = open
    .filter((issue) => issue.state === 'waiting')
    .slice(0, MAX_OPEN)
    .map((issue) => ({
      id: issue.id,
      title: oneLine(issue.title, MAX_TITLE),
      reason: oneLine(issue.waitReason ?? 'waiting', MAX_REASON),
    }))
  return {
    project: input.project,
    window: { from: from.toISOString(), to: now.toISOString() },
    done,
    working,
    queued,
    waiting,
    ...(input.previous
      ? { previous: { headline: oneLine(input.previous.headline, 500), at: input.previous.at.toISOString() } }
      : {}),
  }
}

/** What the Issues say, without the window or the previous headline: equal hashes are an unchanged project. */
export function inputHash(request: DigestRequest): string {
  const { done, working, queued, waiting, project } = request
  return new Bun.CryptoHasher('sha256')
    .update(JSON.stringify({ project, done, working, queued, waiting }))
    .digest('hex')
}

export interface DigestCall {
  project: string
  request: DigestRequest
  hash: string
}

export interface DigestPlan {
  /** one call each: a project whose Issues changed since its newest digest */
  calls: DigestCall[]
  /** projects whose Issues are what the newest digest was made from */
  unchanged: string[]
  /** projects with no Issue open or closed in the window: no call */
  idle: number
}

/** Which projects need a digest now. A project with nothing open and nothing closed in the window gets no call. */
export function planDigests(input: {
  projects: readonly DigestProject[]
  issues: readonly DigestIssue[]
  latest: ReadonlyMap<string, LatestDigest>
  now: Date
}): DigestPlan {
  const groups = groupByProject(input.projects, input.issues)
  const plan: DigestPlan = { calls: [], unchanged: [], idle: 0 }
  for (const project of input.projects) {
    const since = input.now.getTime() - DIGEST_WINDOW_MS
    const issues = (groups.get(project.name) ?? []).filter(
      (issue) => issue.state !== 'closed' || issue.at.getTime() >= since,
    )
    if (issues.length === 0) {
      plan.idle++
      continue
    }
    const previous = input.latest.get(project.name) ?? null
    const request = requestOf({ project: project.name, issues, now: input.now, previous })
    const hash = inputHash(request)
    if (previous?.hash === hash) plan.unchanged.push(project.name)
    else plan.calls.push({ project: project.name, request, hash })
  }
  return plan
}

/** The ids of every Issue the request names. */
const idsOf = (request: DigestRequest): Set<string> =>
  new Set([...request.done, ...request.working, ...request.queued, ...request.waiting].map((issue) => issue.id))

/** The answer without a bullet that cites an Issue the request did not name (the workflow drops them too; checked again here). */
export function checkDigest(answer: DigestAnswer, request: DigestRequest): DigestAnswer {
  const known = idsOf(request)
  const keep = (bullets: DigestAnswer['shipped']): DigestAnswer['shipped'] =>
    bullets.filter((bullet) => bullet.ids.length > 0 && bullet.ids.every((id) => known.has(id)))
  return { ...answer, shipped: keep(answer.shipped), next: keep(answer.next), risks: keep(answer.risks) }
}

export function digestSummary(done: {
  called: number
  stored: number
  failed: number
  unchanged: number
  idle: number
}): string {
  if (done.called === 0) {
    return `no call: ${done.unchanged} project(s) unchanged, ${done.idle} idle`
  }
  return `${done.stored} digest(s) stored of ${done.called} call(s)${done.failed ? `, ${done.failed} failed` : ''}; ${done.unchanged} unchanged, ${done.idle} idle`
}
