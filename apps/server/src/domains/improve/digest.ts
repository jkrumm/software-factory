import type { DigestAnswer } from '@software-factory/contract'
import {
  DIGEST_WINDOW_MS,
  type DigestIssue,
  type DigestProject,
  groupByProject,
  shipped,
} from '../../kernel/digest-scope.ts'
import { type IssueId, issueNumber } from '../../kernel/ids.ts'

/**
 * The digest loop's rules: which Issues belong to a project, what its digest says, and when a project needs a new one. The
 * digest is built from the Issues' titles, states and outcomes, no model. Pure.
 */

export { countsOf, DIGEST_WINDOW_MS, groupByProject } from '../../kernel/digest-scope.ts'
export type { DigestIssue, DigestProject } from '../../kernel/digest-scope.ts'

/** What a stored digest was made by (the `route` column): the code, not an agw route. */
export const DIGEST_ROUTE = 'code'

const MAX_SHIPPED = 5
const MAX_NEXT = 4
const MAX_RISKS = 3
const MAX_THEMES = 5
const MAX_HEADLINE = 140
const MAX_BULLET = 200

/** The newest stored digest of a project, as the loop compares against. */
export interface LatestDigest {
  hash: string
  at: Date
  headline: string
}

/** A digest as stored (`migrations/1014_project_digests.sql`): a fact, a new row per change. */
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

const number = (issue: { id: string }): number => issueNumber(issue.id as IssueId)
const byNumber = (a: { id: string }, b: { id: string }): number => number(a) - number(b)

const bullet = (text: string, issue: { id: IssueId }): DigestAnswer['shipped'][number] => ({
  text: oneLine(text, MAX_BULLET),
  ids: [issue.id],
})

/**
 * What a project's Issues say, in words the Issues already hold. Shipped: the Issues done or healed in the last 7 days,
 * newest first. Next: what is running, then what is ready, lowest number first. Risks: a paused Issue with its reason, and an
 * Issue dropped or cancelled in the window with its outcome. The headline counts them and names the newest shipped title;
 * the themes are the kinds of what shipped.
 */
export function digestOf(issues: readonly DigestIssue[], now: Date): DigestAnswer {
  const from = now.getTime() - DIGEST_WINDOW_MS
  const closed = issues.filter((issue) => issue.state === 'closed' && issue.at.getTime() >= from)
  const done = closed.filter(shipped).sort((a, b) => b.at.getTime() - a.at.getTime() || number(b) - number(a))
  const open = issues.filter((issue) => issue.state !== 'closed').sort(byNumber)
  const running = open.filter((issue) => issue.state === 'working' || issue.state === 'watching')
  const ready = open.filter((issue) => issue.state === 'queued' || issue.state === 'settling')
  const paused = open.filter((issue) => issue.state === 'waiting')
  const ended = closed
    .filter((issue) => !shipped(issue))
    .sort((a, b) => b.at.getTime() - a.at.getTime() || number(b) - number(a))

  const newest = done[0]
  const lead = newest ? `${done.length} shipped, the newest: ${newest.title}` : 'Nothing shipped in 7 days'
  const rest = open.length > 0 ? `; ${open.length} open` : ''
  return {
    headline: oneLine(`${lead}${rest}`, MAX_HEADLINE),
    shipped: done.slice(0, MAX_SHIPPED).map((issue) => bullet(issue.title, issue)),
    next: [...running, ...ready].slice(0, MAX_NEXT).map((issue) => bullet(issue.title, issue)),
    risks: [
      ...paused.map((issue) => bullet(`${issue.title}: ${issue.waitReason ?? 'paused'}`, issue)),
      ...ended.map((issue) => bullet(`${issue.title}: ${issue.outcome ?? 'closed'}`, issue)),
    ].slice(0, MAX_RISKS),
    themes: [...new Set(done.map((issue) => oneLine(issue.kind, 30)))].slice(0, MAX_THEMES),
  }
}

/** What the digest says: equal hashes are an unchanged project. */
export function digestHash(digest: DigestAnswer): string {
  return new Bun.CryptoHasher('sha256').update(JSON.stringify(digest)).digest('hex')
}

export interface DigestStore {
  project: string
  digest: DigestAnswer
  hash: string
}

export interface DigestPlan {
  /** a project whose digest differs from its newest stored one, or has none */
  stores: DigestStore[]
  /** projects whose digest is the newest stored one */
  unchanged: string[]
  /** projects with no Issue open or closed in the window: no digest */
  idle: number
}

/** Which projects get a new digest row now. A project with nothing open and nothing closed in the window gets none. */
export function planDigests(input: {
  projects: readonly DigestProject[]
  issues: readonly DigestIssue[]
  latest: ReadonlyMap<string, LatestDigest>
  now: Date
}): DigestPlan {
  const groups = groupByProject(input.projects, input.issues)
  const plan: DigestPlan = { stores: [], unchanged: [], idle: 0 }
  const since = input.now.getTime() - DIGEST_WINDOW_MS
  for (const project of input.projects) {
    const issues = (groups.get(project.name) ?? []).filter(
      (issue) => issue.state !== 'closed' || issue.at.getTime() >= since,
    )
    if (issues.length === 0) {
      plan.idle++
      continue
    }
    const digest = digestOf(issues, input.now)
    const hash = digestHash(digest)
    if (input.latest.get(project.name)?.hash === hash) plan.unchanged.push(project.name)
    else plan.stores.push({ project: project.name, digest, hash })
  }
  return plan
}

export function digestSummary(done: { stored: number; unchanged: number; idle: number }): string {
  return `${done.stored} digest(s) stored; ${done.unchanged} unchanged, ${done.idle} idle`
}
