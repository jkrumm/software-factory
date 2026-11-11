import { join } from 'node:path'
import { cleanText, MAX_TITLE_CHARS, storable } from '@software-factory/contract'
import * as z from 'zod'
import type { Received, RepoSignals, Triaged } from '../../domains/intake/model.ts'
import type { IntakeSink, ProjectSignals, Writeback } from '../../domains/intake/ports.ts'
import { fingerprintOf } from '../../domains/intake/rules.ts'
import type { Clock } from '../../kernel/clock.ts'
import { helperEnv, runProcess } from './process.ts'
import type { RunProcess } from './process.ts'

const REMOTE_TIMEOUT_MS = 10_000
const HTTP_TIMEOUT_MS = 15_000
const MAX_BODY_CHARS = 4000
const PAGE_SIZE = 50
const NAME = /^[A-Za-z0-9._-]+$/
const MAX_WRITEBACKS = 20
const MAX_SUMMARY_CHARS = 300
const BACKLOG_PAGE_SIZE = 100
const MAX_BACKLOG_PAGES = 10
const COMMENTS_PAGE_SIZE = 100
const MAX_COMMENT_PAGES = 10
/** GitHub says "you cannot write here" (or the issue is gone): recorded, not retried every pass. */
const CANNOT_WRITE = new Set([403, 404, 410, 422])
/** The most one request reads; a head with more checks than this logs one line and the rest is unseen. */
const CHECKS_PAGE_SIZE = 100
const MAX_CHECK_NAME_CHARS = 200
/** A check run that ended in one of these is red. `cancelled` is not: nothing says it was a failure. */
const RED_CONCLUSIONS = new Set(['failure', 'timed_out', 'startup_failure'])
const RED_STATES = new Set(['failure', 'error'])
const LOOP_MARKER = /<!-- factory-loop:([A-Za-z0-9._-]+) -->/

export interface GithubPollerDeps {
  sink: IntakeSink
  projects: ProjectSignals
  /** the directory a project's `repo` names are under */
  sourceRoot: string
  /** `FACTORY_GITHUB_TOKEN`; without it the source is off */
  token: string | null
  /** the API base; a test or scenario points it at a local fake */
  apiUrl?: string
  run?: RunProcess
  fetch?: typeof fetch
  log?: (line: string) => void
  /** not read here; accepted so the three pollers share one shape */
  clock?: Clock
  /** `FACTORY_GITHUB_BACKLOG`: the first pass after a start also files every older open issue (once per process) */
  backlog?: boolean
}

const Issues = z.array(
  z.looseObject({
    number: z.number().int(),
    title: z.string(),
    body: z.string().nullish(),
    html_url: z.string(),
    created_at: z.string(),
    labels: z.array(z.looseObject({ name: z.string() })),
    user: z.looseObject({ login: z.string() }).nullish(),
    pull_request: z.unknown().optional(),
  }),
)
type GithubIssue = z.output<typeof Issues>[number]

const GithubRepo = z.looseObject({ default_branch: z.string().min(1) })

const CheckRuns = z.looseObject({
  check_runs: z.array(
    z.looseObject({
      name: z.string(),
      head_sha: z.string(),
      status: z.string(),
      conclusion: z.string().nullish(),
      html_url: z.string().nullish(),
    }),
  ),
})

const CommitStatus = z.looseObject({
  sha: z.string(),
  statuses: z.array(z.looseObject({ context: z.string(), state: z.string(), target_url: z.string().nullish() })),
})

const PULLS_PAGE_SIZE = 100
const Pulls = z.array(z.looseObject({ head: z.looseObject({ ref: z.string() }) }))

const Comments = z.array(z.looseObject({ body: z.string().nullish() }))

/** A request that did not give a usable answer: the status or the kind of failure, never a body. */
class HttpError extends Error {
  constructor(readonly status: number | string) {
    super(`github ${status}`)
  }
}

const statusOf = (error: unknown): number | string => (error instanceof HttpError ? error.status : 'error')

interface Check {
  name: string
  sha: string
  state: 'down' | 'up'
  kind: 'check_run' | 'status'
  /** the run's conclusion or the status's state */
  result: string
  url: string | null
}

const markerOf = (issueId: string): string => `<!-- factory-issue:${issueId} -->`

const plainName = (name: string): boolean => NAME.test(name) && !/^\.+$/.test(name)

/** `owner/name` of an `origin` that is github.com over https or ssh; anything else is not ours to poll. */
export function parseRemote(url: string): { owner: string; name: string } | undefined {
  const found =
    /^https:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?$/.exec(url) ??
    /^git@github\.com:([^/]+)\/([^/]+?)(?:\.git)?$/.exec(url)
  const [, owner, name] = found ?? []
  if (!owner || !name || !plainName(owner) || !plainName(name)) return undefined
  return { owner, name }
}

/** A check's name is a third party's text: cleaned and clipped, and the same everywhere it is used as a key. */
const checkName = (name: string): string => cleanText(name.slice(0, MAX_CHECK_NAME_CHARS)) || 'unnamed'

function checkReceived(project: RepoSignals, repo: string, branch: string, check: Check): Received {
  const name = checkName(check.name)
  const subject = `${repo}:${name}`
  const title = cleanText(
    `${check.state === 'down' ? 'Failing' : 'Passing'} check "${name}" on ${repo} (${branch})`.slice(
      0,
      MAX_TITLE_CHARS,
    ),
  )
  return {
    signal: {
      source: 'checks',
      kind: 'alert',
      origin: 'github',
      trust: 'machine',
      repo: project.repo,
      fingerprint: `checks:${subject}`,
      title,
      text: title,
      link: check.url,
      madeBy: null,
      probe: false,
    },
    alert: {
      subject,
      event: `${check.state}@${check.sha}:${name}`,
      status: check.state,
      facts: storable({
        check: name,
        kind: check.kind,
        result: check.result,
        sha: check.sha,
        branch,
        ...(check.url ? { url: check.url } : {}),
      }),
    },
  }
}

/** How an issue came in: through the label, as the owner's own, or not at all (a stranger's, held). */
type Admitted = 'label' | 'author' | null

/**
 * One open issue as a signal. `admitted` is how the poller let it in (the label or the author query; null is a stranger's,
 * held). The backlog sweep passes `backlog` with no `admitted`: it writes nothing to GitHub, so the facts carry
 * `writeback: false` (and a promote of the held one honours that), and `trusted` (the label's and the owner's own issues)
 * decides the trust instead of `admitted`.
 */
function issueReceived(
  project: RepoSignals,
  repo: string,
  issue: GithubIssue,
  how: { event: string; admitted: Admitted; backlog?: { trusted: boolean } },
): Received {
  const { event, admitted, backlog } = how
  const trusted = backlog ? backlog.trusted : admitted !== null
  const title = cleanText(issue.title.slice(0, MAX_TITLE_CHARS)) || `${repo}#${issue.number}`
  const body = (issue.body ?? '').slice(0, MAX_BODY_CHARS)
  return {
    signal: {
      source: 'github',
      kind: 'request',
      origin: 'github',
      trust: trusted ? 'machine' : 'outside',
      repo: project.repo,
      fingerprint: fingerprintOf(repo, title),
      title,
      text: String(storable(body)),
      link: issue.html_url,
      madeBy: LOOP_MARKER.exec(body)?.[1] ?? null,
      probe: false,
    },
    alert: {
      subject: `${repo}#${issue.number}`,
      event,
      status: 'event',
      facts: storable({
        url: issue.html_url,
        number: issue.number,
        labels: issue.labels.map((label) => label.name),
        ...(issue.user ? { author: issue.user.login } : {}),
        body,
        ...(admitted ? { admitted } : {}),
        ...(backlog ? { backlog: true } : {}),
        writeback: admitted !== null,
      }),
    },
  }
}

/**
 * The GitHub source: per project the label query, the author query, the open issues of strangers (held), and the red
 * checks of the default branch head; then the write-back of closed Issues. The issue text is someone else's and is data:
 * the repo of a signal is the project's, never read from it, and nothing of it reaches a URL or a command.
 */
export function githubPoller(deps: GithubPollerDeps): { enabled: boolean; pass(): Promise<void> } {
  const log = deps.log ?? ((line: string) => console.error(line))
  const enabled = Boolean(deps.token)
  if (!enabled) log('github intake is off: FACTORY_GITHUB_TOKEN not set')
  const api = (deps.apiUrl ?? 'https://api.github.com').replace(/\/+$/, '')
  const doFetch = deps.fetch ?? fetch
  const run = deps.run ?? runProcess

  const request = (url: string, write?: { method: 'POST' | 'PATCH'; body: unknown }): Promise<Response> =>
    doFetch(url, {
      ...(write ? { method: write.method, body: JSON.stringify(write.body) } : {}),
      headers: {
        Authorization: `Bearer ${deps.token ?? ''}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'software-factory',
        ...(write ? { 'Content-Type': 'application/json' } : {}),
      },
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    })

  /** One 200 JSON answer in the shape asked for; anything else throws an HttpError. */
  async function read<T>(url: string, schema: z.ZodType<T>): Promise<T> {
    const response = await request(url)
    if (response.status !== 200) throw new HttpError(response.status)
    let json: unknown
    try {
      json = await response.json()
    } catch {
      throw new HttpError('unparsable')
    }
    const parsed = schema.safeParse(json)
    if (!parsed.success) throw new HttpError('unparsable')
    return parsed.data
  }

  async function file(received: Received): Promise<Triaged | undefined> {
    const answer = await deps.sink.receive(received)
    if (answer.ok) return answer.value
    log(`github intake: ${received.alert?.subject ?? received.signal.source} not filed (${answer.error.kind})`)
    return undefined
  }

  /**
   * A failing check filed as a new Issue (not a re-poll, not an amendment): the leads with an open pull request hear that
   * the default branch is red. A pull request list that cannot be read means no note this time.
   */
  async function warnPulls(repo: string, project: RepoSignals, received: Received, answer: Triaged): Promise<void> {
    const { alert } = received
    if (alert?.status !== 'down' || answer.outcome !== 'filed' || answer.detail !== 'new' || !answer.issue) return
    const facts = (alert.facts ?? {}) as { check?: unknown; branch?: unknown }
    let pulls: string[]
    try {
      const open = await read(`${api}/repos/${repo}/pulls?state=open&per_page=${PULLS_PAGE_SIZE}`, Pulls)
      if (open.length >= PULLS_PAGE_SIZE) log(`github intake: ${repo} a full page of pull requests, more may be unseen`)
      pulls = open.map((pull) => pull.head.ref)
    } catch (error) {
      log(`github intake: ${repo} pull requests ${statusOf(error)}, the leads are not told`)
      return
    }
    if (pulls.length === 0) return
    const told = await deps.sink.noteRedBranch({
      issue: answer.issue,
      repo: project.repo,
      branch: typeof facts.branch === 'string' ? facts.branch : 'the default branch',
      check: typeof facts.check === 'string' ? facts.check : alert.subject,
      link: received.signal.link,
      pulls,
    })
    if (!told.ok) log(`github intake: ${repo} the leads were not told (${told.error.kind})`)
  }

  async function remoteOf(repo: string): Promise<{ owner: string; name: string } | undefined> {
    try {
      const done = await run(
        ['git', '-C', join(deps.sourceRoot, repo), 'remote', 'get-url', 'origin'],
        REMOTE_TIMEOUT_MS,
        helperEnv({ GIT_TERMINAL_PROMPT: '0' }),
      )
      return done.exit === 0 ? parseRemote(done.stdout.trim()) : undefined
    } catch {
      return undefined
    }
  }

  /** One page of issues; a failure is one line without the token or the body, and an empty list. */
  async function listIssues(url: string, repo: string, fullPage: string | null): Promise<GithubIssue[]> {
    try {
      const issues = await read(url, Issues)
      if (fullPage && issues.length >= PAGE_SIZE) log(`github intake: ${repo} ${fullPage}`)
      return issues
    } catch (error) {
      log(`github intake: ${repo} issues ${statusOf(error)}`)
      return []
    }
  }

  /**
   * One project's issues. The label query admits any author; in author mode a second query admits the owner's own new
   * issues; a third reads the rest of the open issues and hands them over as held. One GitHub issue is one subject
   * however it came in, and the label wins.
   */
  async function pollIssues(project: RepoSignals, owner: string, name: string): Promise<Received[]> {
    const github = project.github
    if (!github) return []
    const repo = `${owner}/${name}`
    const base = `${api}/repos/${repo}/issues`
    const seen = new Set<number>()
    const found: Received[] = []
    const sinceAt = github.since ? new Date(github.since) : null
    const authorMode =
      github.author && sinceAt && !Number.isNaN(sinceAt.getTime()) ? { author: github.author, since: sinceAt } : null
    const author = authorMode?.author.toLowerCase()
    // The owner's own issue is `author` whichever query found it; only those are closed on GitHub by the write-back.
    const admittedOf = (issue: GithubIssue): Admitted =>
      author !== undefined && issue.user?.login.toLowerCase() === author ? 'author' : 'label'
    const add = (issue: GithubIssue, event: 'labeled' | 'opened' | 'seen', admitted: Admitted) => {
      seen.add(issue.number)
      found.push(issueReceived(project, repo, issue, { event, admitted }))
    }

    const labelled = await listIssues(
      `${base}?labels=${encodeURIComponent(github.label)}&state=open&per_page=${PAGE_SIZE}&sort=created&direction=asc`,
      repo,
      'a full page, newer labelled issues may be unseen',
    )
    for (const issue of labelled) {
      if (issue.pull_request === undefined && !seen.has(issue.number)) add(issue, 'labeled', admittedOf(issue))
    }

    if (authorMode) {
      const { since } = authorMode
      const own = await listIssues(
        `${base}?creator=${encodeURIComponent(authorMode.author)}&state=open&since=${since.toISOString()}&per_page=${PAGE_SIZE}&sort=created&direction=desc`,
        repo,
        'a full page, older issues of the author may be unseen',
      )
      for (const issue of own) {
        const created = Date.parse(issue.created_at)
        if (issue.pull_request !== undefined || seen.has(issue.number)) continue
        if (Number.isNaN(created) || created < since.getTime()) continue
        if (issue.user?.login.toLowerCase() !== author) continue
        add(issue, 'opened', 'author')
      }
    }

    const everyone = await listIssues(
      `${base}?state=open&per_page=${PAGE_SIZE}&sort=created&direction=desc`,
      repo,
      null,
    )
    const label = github.label.toLowerCase()
    for (const issue of everyone) {
      if (issue.pull_request !== undefined || seen.has(issue.number)) continue
      // A labelled issue the label query did not return (its page was full, or it failed) is not a stranger's.
      if (issue.labels.some((l) => l.name.toLowerCase() === label)) continue
      // The owner's own issues come in through the author query only: the ones before its cut-over are neither filed nor held.
      if (author !== undefined && issue.user?.login.toLowerCase() === author) continue
      add(issue, 'seen', null)
    }
    return found
  }

  /**
   * The default branch head's checks. A check run or commit status is a stateful subject `<owner>/<repo>:<name>`: red is
   * `down`, green is `up`, running, neutral, skipped and cancelled say nothing. A green check is sent only while its
   * subject is open, so a healthy repo costs nothing. A failure is one line and no signals.
   */
  async function pollChecks(project: RepoSignals, owner: string, name: string): Promise<Received[]> {
    const repo = `${owner}/${name}`
    let step = 'repo'
    try {
      const info = await read(`${api}/repos/${repo}`, GithubRepo)
      const branch = info.default_branch
      const ref = `${api}/repos/${repo}/commits/${encodeURIComponent(branch)}`
      step = 'check-runs'
      const runs = await read(`${ref}/check-runs?filter=latest&per_page=${CHECKS_PAGE_SIZE}`, CheckRuns)
      step = 'status'
      const combined = await read(`${ref}/status?per_page=${CHECKS_PAGE_SIZE}`, CommitStatus)
      if (runs.check_runs.length >= CHECKS_PAGE_SIZE || combined.statuses.length >= CHECKS_PAGE_SIZE) {
        log(`github intake: ${repo} a full page of checks, more may be unseen`)
      }

      const checks = new Map<string, Check>()
      for (const item of runs.check_runs) {
        const state = item.status === 'completed' ? stateOfConclusion(item.conclusion) : undefined
        if (!state) continue
        checks.set(item.name, {
          name: item.name,
          sha: item.head_sha,
          state,
          kind: 'check_run',
          result: item.conclusion ?? '',
          url: item.html_url ?? null,
        })
      }
      for (const status of combined.statuses) {
        const state = RED_STATES.has(status.state) ? 'down' : status.state === 'success' ? 'up' : undefined
        if (!state || checks.has(status.context)) continue
        checks.set(status.context, {
          name: status.context,
          sha: combined.sha,
          state,
          kind: 'status',
          result: status.state,
          url: status.target_url ?? null,
        })
      }

      step = 'episodes'
      const open = await openChecks(repo)
      return [...checks.values()]
        .filter((check) => check.state === 'down' || open.has(`${repo}:${checkName(check.name)}`))
        .map((check) => checkReceived(project, repo, branch, check))
    } catch (error) {
      log(`github intake: ${repo} ${step} ${statusOf(error)}`)
      return []
    }
  }

  /** The `checks` subjects of one repo with an Issue that is not closed or a `down` waiting to settle. */
  async function openChecks(repo: string): Promise<Set<string>> {
    const subjects = await deps.sink.subjects('checks', `${repo}:`)
    if (!subjects.ok) {
      log(`github intake: ${repo} open checks unknown (${subjects.error.kind})`)
      return new Set()
    }
    return new Set(subjects.value.filter((s) => s.open).map((s) => s.subject))
  }

  /**
   * Every open issue of one project, oldest first, pull requests left out. `complete` is false when a page failed: the
   * issues already read are still filed, and the sweep runs again on the next pass (idempotent).
   */
  async function backlogOf(repo: string): Promise<{ issues: GithubIssue[]; complete: boolean }> {
    const all: GithubIssue[] = []
    for (let page = 1; page <= MAX_BACKLOG_PAGES; page++) {
      let issues: GithubIssue[]
      try {
        issues = await read(
          `${api}/repos/${repo}/issues?state=open&per_page=${BACKLOG_PAGE_SIZE}&page=${page}&sort=created&direction=asc`,
          Issues,
        )
      } catch (error) {
        log(`github backlog: ${repo} page ${page} ${statusOf(error)}, incomplete`)
        return { issues: all, complete: false }
      }
      all.push(...issues.filter((issue) => issue.pull_request === undefined))
      if (issues.length < BACKLOG_PAGE_SIZE) return { issues: all, complete: true }
    }
    log(`github backlog: ${repo} more than ${MAX_BACKLOG_PAGES * BACKLOG_PAGE_SIZE} open issues, the newest are unseen`)
    return { issues: all, complete: true }
  }

  /**
   * The older open issues: each goes through intake as any issue of the poller does (triage amends or joins open Issues,
   * an outsider's is held), and one line per issue says what became of it. Nothing is written to GitHub. Returns false
   * when a repo could not be read whole.
   */
  async function sweepBacklog(projects: readonly RepoSignals[]): Promise<boolean> {
    let complete = true
    for (const project of projects) {
      if (project.work || !project.github) continue
      const remote = await remoteOf(project.repo)
      if (!remote) {
        log(`github backlog: ${project.repo} has no github.com origin, skipped`)
        continue
      }
      const repo = `${remote.owner}/${remote.name}`
      const label = project.github.label.toLowerCase()
      const author = project.github.author?.toLowerCase()
      const found = await backlogOf(repo)
      complete &&= found.complete
      log(`github backlog: ${repo} ${found.issues.length} open`)
      for (const issue of found.issues) {
        const trusted =
          issue.labels.some((l) => l.name.toLowerCase() === label) ||
          (author !== undefined && issue.user?.login.toLowerCase() === author)
        const received = issueReceived(project, repo, issue, {
          event: trusted ? 'backlog' : 'seen',
          admitted: null,
          backlog: { trusted },
        })
        const answer = await deps.sink.receive(received)
        log(
          answer.ok
            ? `github backlog: ${repo}#${issue.number} ${answer.value.outcome}/${answer.value.detail} ${answer.value.issue ?? answer.value.signal ?? '-'}`
            : `github backlog: ${repo}#${issue.number} not filed (${answer.error.kind})`,
        )
      }
    }
    return complete
  }

  async function pollProjects(projects: readonly RepoSignals[]): Promise<void> {
    let skippedHost = false
    for (const project of projects) {
      // A work repo hears the owner only (NL18): nothing of it is read.
      if (project.work || !project.github) continue
      const remote = await remoteOf(project.repo)
      if (!remote) {
        skippedHost = true
        continue
      }
      for (const received of await pollIssues(project, remote.owner, remote.name)) await file(received)
      if (!project.github.checks) continue
      const slug = `${remote.owner}/${remote.name}`
      for (const received of await pollChecks(project, remote.owner, remote.name)) {
        const answer = await file(received)
        if (answer) await warnPulls(slug, project, received, answer)
      }
    }
    if (skippedHost) log('github intake: a project has no github.com origin and is skipped')
  }

  /** `written`, `already` (the marker was there) or `refused-<status>`; anything to retry throws. */
  async function writeOne(back: Writeback, repo: string, number: string): Promise<string> {
    const url = `${api}/repos/${repo}/issues/${number}`
    /** `false` when GitHub refuses; a status to retry throws. */
    const accepted = (response: Response): boolean => {
      if (CANNOT_WRITE.has(response.status)) return false
      if (response.status < 200 || response.status >= 300) throw new HttpError(response.status)
      return true
    }
    const marker = markerOf(back.issueId)
    let marked = false
    for (let page = 1; page <= MAX_COMMENT_PAGES && !marked; page++) {
      const listed = await request(`${url}/comments?per_page=${COMMENTS_PAGE_SIZE}&page=${page}`)
      if (!accepted(listed)) return `refused-${listed.status}`
      const parsed = Comments.safeParse(await listed.json())
      if (!parsed.success) throw new HttpError('unparsable')
      marked = parsed.data.some((comment) => comment.body?.includes(marker))
      if (parsed.data.length < COMMENTS_PAGE_SIZE) break
    }
    let result = 'already'
    if (!marked) {
      const posted = await request(`${url}/comments`, {
        method: 'POST',
        body: { body: `${marker}\n${sentenceOf(back)}` },
      })
      if (!accepted(posted)) return `refused-${posted.status}`
      result = 'written'
    }
    if (back.outcome === 'done' && back.admitted === 'author') {
      const closed = await request(url, { method: 'PATCH', body: { state: 'closed', state_reason: 'completed' } })
      if (!accepted(closed)) return `refused-${closed.status}`
    }
    return result
  }

  /**
   * Tells GitHub what became of an Issue the intake filed: one comment under a marker on every one and, when the work is
   * done and the issue was admitted as the owner's own, the GitHub issue closed. Closing a stranger's issue is the
   * owner's call. The comment is plain and carries no internal id beyond the marker, no host and not the full summary:
   * the repo may be public. A refusal is recorded and not retried; a network error or a 5xx is retried next pass.
   */
  async function writeBack(): Promise<void> {
    const pending = await deps.sink.pendingWritebacks(MAX_WRITEBACKS)
    if (!pending.ok) {
      log(`github intake: write-backs unknown (${pending.error.kind})`)
      return
    }
    for (const back of pending.value) {
      const found = /^([^/#]+)\/([^/#]+)#(\d+)$/.exec(back.subject)
      const [, owner, name, number] = found ?? []
      if (!owner || !name || !number || !plainName(owner) || !plainName(name)) continue
      const repo = `${owner}/${name}`
      let result: string
      try {
        result = await writeOne(back, repo, number)
      } catch (error) {
        log(`github intake: write-back to ${repo} failed (${statusOf(error)})`)
        continue
      }
      if (result.startsWith('refused')) log(`github intake: write-back to ${repo} ${result}`)
      const recorded = await deps.sink.wroteBack(back.issueId, result)
      if (!recorded.ok) log(`github intake: write-back to ${repo} not recorded (${recorded.error.kind})`)
    }
  }

  let swept = !deps.backlog
  return {
    enabled,
    async pass() {
      if (!enabled) return
      const polled = await deps.projects.polled()
      if (polled.ok) {
        if (!swept) swept = await sweepBacklog(polled.value)
        await pollProjects(polled.value)
      } else log(`github intake: projects unknown (${polled.error.kind})`)
      await writeBack()
    },
  }
}

const stateOfConclusion = (conclusion: string | null | undefined): 'down' | 'up' | undefined => {
  if (conclusion === 'success') return 'up'
  return conclusion && RED_CONCLUSIONS.has(conclusion) ? 'down' : undefined
}

function sentenceOf(back: Writeback): string {
  if (back.outcome !== 'done') return `Closed by the factory without a change: ${back.outcome}.`
  const first = cleanText((back.summary ?? '').split('\n')[0] ?? '').slice(0, MAX_SUMMARY_CHARS)
  return first ? `Done by the factory. ${first}` : 'Done by the factory.'
}
