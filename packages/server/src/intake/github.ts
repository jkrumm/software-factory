import { createHash } from 'node:crypto'
import { cleanText, MAX_TITLE_CHARS, storable } from '@software-factory/contract'
import type { SQL } from 'bun'
import { z } from 'zod'
import { childEnv, runProcess } from '../exec.ts'
import { vetIntakeRepo } from '../issues/create.ts'
import { fileSignalIn, type Signal } from '../issues/signals.ts'
import { markEvent } from '../issues/shared.ts'
import { RepoRefused } from '../repos.ts'

/** The first pass comes this long after boot, so the tick's first minute is not shared with the network. */
const FIRST_PASS_MS = 30_000
const REMOTE_TIMEOUT_MS = 10_000
const HTTP_TIMEOUT_MS = 15_000
const MAX_BODY_CHARS = 4000
const PAGE_SIZE = 50
const NAME = /^[A-Za-z0-9._-]+$/
const MAX_WRITEBACKS = 20
const MAX_SUMMARY_CHARS = 300
const COMMENTS_PAGE_SIZE = 100
const MAX_COMMENT_PAGES = 10
/** GitHub says "you cannot write here" (or the issue is gone): marked, not retried every pass. */
const CANNOT_WRITE = new Set([403, 404, 410, 422])

export interface GithubIntakeDeps {
  sql: SQL
  now: () => Date
  roots: readonly string[]
  /** `FACTORY_GITHUB_TOKEN`; without it the source is off */
  token: string | undefined
  /** the spacing of two passes (`FACTORY_GITHUB_POLL`) */
  everyMs: number
  /** the tests' fake */
  fetch?: typeof fetch
  run?: typeof runProcess
}

const GithubIssues = z.array(
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

/** The most one request reads; a head with more checks than this logs one line and the rest is unseen. */
const CHECKS_PAGE_SIZE = 100
const MAX_CHECK_NAME_CHARS = 200
/** A check run that ended in one of these is red. `cancelled` is not: nothing says it was a failure. */
const RED_CONCLUSIONS = new Set(['failure', 'timed_out', 'startup_failure'])
const RED_STATES = new Set(['failure', 'error'])

interface Target {
  repo: string
  label: string
  checks: boolean
  /** author mode: the login whose new issues come in without a label, from `since` on (ISO) */
  author?: string
  since?: string
}

type GithubIssue = z.output<typeof GithubIssues>[number]

const markerOf = (issueId: number): string => `<!-- factory-issue:${issueId} -->`

interface Check {
  name: string
  sha: string
  state: 'down' | 'up'
  kind: 'check_run' | 'status'
  /** the run's conclusion or the status's state */
  result: string
  url: string | null
}

/** `owner/name` of an `origin` that is github.com over https or ssh; anything else is not ours to poll. */
function parseRemote(url: string): { owner: string; name: string } | undefined {
  const found =
    /^https:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?$/.exec(url) ??
    /^git@github\.com:([^/]+)\/([^/]+?)(?:\.git)?$/.exec(url)
  const [, owner, name] = found ?? []
  if (!owner || !name || !NAME.test(owner) || !NAME.test(name)) return undefined
  if (/^\.+$/.test(owner) || /^\.+$/.test(name)) return undefined
  return { owner, name }
}

/** The same problem under another number: the title lower-cased, digits and punctuation out, whitespace one space. */
const fingerprintOf = (owner: string, name: string, title: string): string => {
  const normalized = title
    .toLowerCase()
    .replace(/[\p{N}\p{P}\p{S}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return createHash('sha256').update(`${owner}/${name}\n${normalized}`).digest('hex').slice(0, 16)
}

const stateOfConclusion = (conclusion: string | null | undefined): 'down' | 'up' | undefined => {
  if (conclusion === 'success') return 'up'
  return conclusion && RED_CONCLUSIONS.has(conclusion) ? 'down' : undefined
}

/** A check's name is a third party's text: cleaned and clipped, and the same everywhere it is used as a key. */
const subjectOf = (repo: string, name: string): string =>
  `${repo}:${cleanText(name.slice(0, MAX_CHECK_NAME_CHARS)) || 'unnamed'}`

function signalOfCheck(target: Target, repo: string, branch: string, check: Check): Signal {
  const subject = subjectOf(repo, check.name)
  const name = subject.slice(repo.length + 1)
  const title = cleanText(
    `${check.state === 'down' ? 'Failing' : 'Passing'} check "${name}" on ${repo} (${branch})`.slice(
      0,
      MAX_TITLE_CHARS,
    ),
  )
  return {
    source: 'checks',
    subject,
    event: `${check.state}@${check.sha}:${name}`,
    status: check.state,
    title,
    facts: storable({
      check: name,
      kind: check.kind,
      result: check.result,
      sha: check.sha,
      branch,
      ...(check.url ? { url: check.url } : {}),
    }),
    repo: target.repo,
  }
}

const errorOf = (error: unknown): string => (error instanceof Error ? error.message : String(error))

/**
 * The GitHub label source (design §4 "Intake"): a project whose manifest has `signals.github` is polled for open issues with its label,
 * and each becomes a signal. Self-paced: the tick calls `kick` and a pass starts only `everyMs` after the last one, one at a time.
 * Everything is read first (git and HTTP, outside any transaction); only then is each signal filed in a transaction of its own. The
 * issue's text is someone else's and is data: the project's repo comes from the manifest, never from it, and the author is not
 * copied into the title.
 */
export class GithubIntake {
  private nextAt: number
  private running: Promise<void> | undefined

  constructor(private readonly deps: GithubIntakeDeps) {
    this.nextAt = deps.now().getTime() + FIRST_PASS_MS
    if (!deps.token) console.error('github intake is off: FACTORY_GITHUB_TOKEN not set')
  }

  kick(): void {
    if (!this.deps.token || this.running) return
    const at = this.deps.now().getTime()
    if (at < this.nextAt) return
    this.nextAt = at + this.deps.everyMs
    this.running = this.pass()
      .catch((error: unknown) => console.error('github intake', { error: errorOf(error) }))
      .finally(() => {
        this.running = undefined
      })
  }

  async settled(): Promise<void> {
    await this.running
  }

  private async pass(): Promise<void> {
    const targets = await this.targets()
    const signals: Signal[] = []
    let skippedHost = false
    for (const target of targets) {
      const remote = await this.remoteOf(target.repo)
      if (!remote) {
        skippedHost = true
        continue
      }
      signals.push(...(await this.poll(target, remote.owner, remote.name)))
      if (target.checks) signals.push(...(await this.pollChecks(target, remote.owner, remote.name)))
    }
    if (skippedHost) console.error('github intake: a project has no github.com origin and is skipped')
    for (const signal of signals) {
      try {
        await this.deps.sql.begin((tx) =>
          fileSignalIn(tx, signal, { repoRoots: this.deps.roots, now: this.deps.now() }),
        )
      } catch (error) {
        console.error('github intake', { subject: signal.subject, error: errorOf(error) })
      }
    }
    await this.writeBack()
  }

  /** The projects that opted in, whose repo the intake may file in. */
  private async targets(): Promise<Target[]> {
    const rows: { repo: string; label: string | null; checks: boolean; author: string | null; since: string | null }[] =
      await this.deps.sql`
      SELECT repo, manifest->'signals'->'github'->>'label' AS label,
        manifest->'signals'->'github'->>'author' AS author, manifest->'signals'->'github'->>'since' AS since,
        COALESCE(manifest->'signals'->'github'->>'checks' = 'true', false) AS checks FROM factory.projects
      WHERE NOT paused AND jsonb_typeof(manifest->'signals'->'github') = 'object' ORDER BY name`
    const targets: Target[] = []
    for (const row of rows) {
      try {
        await vetIntakeRepo('github', row.repo, this.deps.roots)
      } catch (error) {
        if (error instanceof RepoRefused) continue
        throw error
      }
      const since = row.since ? new Date(row.since) : undefined
      targets.push({
        repo: row.repo,
        label: row.label || 'factory',
        checks: row.checks,
        ...(row.author && since && !Number.isNaN(since.getTime())
          ? { author: row.author, since: since.toISOString() }
          : {}),
      })
    }
    return targets
  }

  private async remoteOf(repo: string): Promise<{ owner: string; name: string } | undefined> {
    const run = this.deps.run ?? runProcess
    try {
      const done = await run(
        ['git', '-C', repo, 'remote', 'get-url', 'origin'],
        REMOTE_TIMEOUT_MS,
        childEnv({ GIT_TERMINAL_PROMPT: '0' }),
      )
      return done.exitCode === 0 ? parseRemote(done.stdout.trim()) : undefined
    } catch {
      return undefined
    }
  }

  private request(url: string, write?: { method: 'POST' | 'PATCH'; body: unknown }): Promise<Response> {
    return (this.deps.fetch ?? fetch)(url, {
      ...(write ? { method: write.method, body: JSON.stringify(write.body) } : {}),
      headers: {
        Authorization: `Bearer ${this.deps.token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'software-factory',
        ...(write ? { 'Content-Type': 'application/json' } : {}),
      },
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    })
  }

  /** One 200 JSON answer; anything else throws, and the caller's line names the step and the status, never the body. */
  private async getJson(url: string, step: { at: string; status: number | string }): Promise<unknown> {
    const response = await this.request(url)
    step.status = response.status
    if (response.status !== 200) throw new Error('not 200')
    step.status = 'unparsable'
    return response.json()
  }

  /**
   * The default branch head's checks as signals (design §4 "Intake", red checks). A check run or commit status is a stateful subject
   * `<owner>/<repo>:<name>`: red is `down`, green is `up`, running, neutral, skipped and cancelled say nothing. The event is the state
   * at the head sha, so a re-run on a new commit is a new event of the same episode and a pass on the same commit repeats nothing.
   * A green check is sent only while its episode is open or waiting to settle, so a healthy repo costs no transaction. Nothing is
   * written back; a failure is one line without the token or the body, and no signals.
   */
  private async pollChecks(target: Target, owner: string, name: string): Promise<Signal[]> {
    const repo = `${owner}/${name}`
    const step = { at: 'repo', status: 'error' as number | string }
    try {
      const info = GithubRepo.parse(await this.getJson(`https://api.github.com/repos/${owner}/${name}`, step))
      const branch = info.default_branch
      const ref = `https://api.github.com/repos/${owner}/${name}/commits/${encodeURIComponent(branch)}`
      step.at = 'check-runs'
      const runs = CheckRuns.parse(
        await this.getJson(`${ref}/check-runs?filter=latest&per_page=${CHECKS_PAGE_SIZE}`, step),
      )
      step.at = 'status'
      const combined = CommitStatus.parse(await this.getJson(`${ref}/status?per_page=${CHECKS_PAGE_SIZE}`, step))
      if (runs.check_runs.length >= CHECKS_PAGE_SIZE || combined.statuses.length >= CHECKS_PAGE_SIZE)
        console.error('github intake: a full page of checks, more may be unseen', { repo })

      const checks = new Map<string, Check>()
      for (const run of runs.check_runs) {
        const state = run.status === 'completed' ? stateOfConclusion(run.conclusion) : undefined
        if (state)
          checks.set(run.name, {
            name: run.name,
            sha: run.head_sha,
            state,
            kind: 'check_run',
            result: run.conclusion ?? '',
            url: run.html_url ?? null,
          })
      }
      for (const status of combined.statuses) {
        const state = RED_STATES.has(status.state) ? 'down' : status.state === 'success' ? 'up' : undefined
        if (state && !checks.has(status.context))
          checks.set(status.context, {
            name: status.context,
            sha: combined.sha,
            state,
            kind: 'status',
            result: status.state,
            url: status.target_url ?? null,
          })
      }

      step.at = 'episodes'
      const open = await this.openChecks(repo)
      return [...checks.values()]
        .filter((check) => check.state === 'down' || open.has(subjectOf(repo, check.name)))
        .map((check) => signalOfCheck(target, repo, branch, check))
    } catch {
      console.error('github intake', { repo, step: step.at, status: step.status })
      return []
    }
  }

  /** The `checks` subjects of one repo with an Issue that is not closed or a `down` waiting to settle. */
  private async openChecks(repo: string): Promise<Set<string>> {
    const prefix = `${repo}:`
    const rows: { subject: string }[] = await this.deps.sql`
      SELECT d.monitor AS subject FROM factory.door_issues d JOIN factory.issues i ON i.id = d.issue_id
      WHERE d.source = 'checks' AND starts_with(d.monitor, ${prefix}) AND i.state <> 'closed'
      UNION
      SELECT subject FROM factory.intake_pending WHERE source = 'checks' AND starts_with(subject, ${prefix})`
    return new Set(rows.map((row) => row.subject))
  }

  /**
   * One project's admitted issues as signals; any failure is one line without the token or the body, and no signals. The label query
   * admits any author; in author mode a second query admits the owner's own new issues. One GitHub issue is one subject whichever
   * way it came in, and the label wins.
   */
  private async poll(target: Target, owner: string, name: string): Promise<Signal[]> {
    const repo = `${owner}/${name}`
    const base = `https://api.github.com/repos/${owner}/${name}/issues`
    const labelled = await this.listIssues(
      `${base}?labels=${encodeURIComponent(target.label)}&state=open&per_page=${PAGE_SIZE}&sort=created&direction=asc`,
      repo,
      'a full page, newer labelled issues may be unseen',
    )
    const signals = labelled
      .filter((issue) => issue.pull_request === undefined)
      .map((issue) => signalOfIssue(target, owner, name, issue, 'labeled'))
    const { author, since } = target
    if (!author || !since) return signals

    const own = await this.listIssues(
      `${base}?creator=${encodeURIComponent(author)}&state=open&since=${since}&per_page=${PAGE_SIZE}&sort=created&direction=desc`,
      repo,
      'a full page, older issues of the author may be unseen',
    )
    const seen = new Set(signals.map((signal) => signal.subject))
    const sinceMs = Date.parse(since)
    for (const issue of own) {
      const created = Date.parse(issue.created_at)
      if (issue.pull_request !== undefined || Number.isNaN(created) || created < sinceMs) continue
      if (issue.user?.login.toLowerCase() !== author.toLowerCase()) continue
      const signal = signalOfIssue(target, owner, name, issue, 'opened')
      if (seen.has(signal.subject)) continue
      seen.add(signal.subject)
      signals.push(signal)
    }
    return signals
  }

  /** One page of issues; a failure is one line without the token or the body, and an empty list. */
  private async listIssues(url: string, repo: string, fullPage: string): Promise<GithubIssue[]> {
    let status: number | string = 'error'
    try {
      const response = await this.request(url)
      status = response.status
      if (response.status !== 200) throw new Error('not 200')
      status = 'unparsable'
      const issues = GithubIssues.parse(await response.json())
      if (issues.length >= PAGE_SIZE) console.error(`github intake: ${fullPage}`, { repo })
      return issues
    } catch {
      console.error('github intake', { repo, status })
      return []
    }
  }

  /**
   * Tells GitHub what became of an Issue the intake filed (`writeback` in its facts): one comment under a marker on every one and,
   * when the work is done and the issue was admitted as the owner's own (`admitted: author`), the GitHub issue closed. Closing a
   * stranger's issue is the owner's call. The comment is plain and carries no internal id, host or full summary: the repo
   * may be public. A refusal from GitHub is marked and not retried; a network error or a 5xx is retried next pass.
   */
  private async writeBack(): Promise<void> {
    const rows: { id: number; source_key: string; outcome: string | null; admitted: string | null }[] = await this.deps
      .sql`
      SELECT i.id, i.source_key, i.outcome, i.facts->'details'->>'admitted' AS admitted FROM factory.issues i
      WHERE i.source = 'github' AND i.state = 'closed' AND i.facts->'details'->>'writeback' = 'true'
        AND NOT EXISTS (
          SELECT 1 FROM factory.issue_events e WHERE e.issue_id = i.id AND e.key = 'github_writeback:' || i.id::text)
      ORDER BY i.closed_at, i.id LIMIT ${MAX_WRITEBACKS}`
    for (const row of rows) {
      const found = /^([^/#]+)\/([^/#]+)#(\d+)$/.exec(row.source_key)
      const [, owner, name, number] = found ?? []
      if (
        !owner ||
        !name ||
        !number ||
        !NAME.test(owner) ||
        !NAME.test(name) ||
        /^\.+$/.test(owner) ||
        /^\.+$/.test(name)
      )
        continue
      const repo = `${owner}/${name}`
      let status: number | string = 'error'
      try {
        const result = await this.writeOne(
          { id: row.id, outcome: row.outcome, admitted: row.admitted, repo, number },
          (value) => {
            status = value
          },
        )
        await markEvent(this.deps.sql, row.id, `github_writeback:${row.id}`, 'github_writeback', this.deps.now(), {
          result,
        })
        if (result !== 'written') console.error('github intake: write-back refused', { repo, status })
      } catch {
        console.error('github intake: write-back failed', { repo, status })
      }
    }
  }

  /** `written`, `already` (the marker was there) or `refused-<status>`; anything to retry throws. */
  private async writeOne(
    issue: { id: number; outcome: string | null; admitted: string | null; repo: string; number: string },
    setStatus: (status: number) => void,
  ): Promise<string> {
    const url = `https://api.github.com/repos/${issue.repo}/issues/${issue.number}`
    const answer = async (response: Response): Promise<'refused' | 'ok'> => {
      setStatus(response.status)
      if (CANNOT_WRITE.has(response.status)) return 'refused'
      if (response.status < 200 || response.status >= 300) throw new Error('not ok')
      return 'ok'
    }
    const marker = markerOf(issue.id)
    let marked = false
    for (let page = 1; page <= MAX_COMMENT_PAGES && !marked; page++) {
      const listed = await this.request(`${url}/comments?per_page=${COMMENTS_PAGE_SIZE}&page=${page}`)
      if ((await answer(listed)) === 'refused') return `refused-${listed.status}`
      const comments = z.array(z.looseObject({ body: z.string().nullish() })).parse(await listed.json())
      marked = comments.some((comment) => comment.body?.includes(marker))
      if (comments.length < COMMENTS_PAGE_SIZE) break
    }
    let result = 'already'
    if (!marked) {
      const posted = await this.request(`${url}/comments`, {
        method: 'POST',
        body: { body: `${marker}\n${await this.sentenceOf(issue.id, issue.outcome)}` },
      })
      if ((await answer(posted)) === 'refused') return `refused-${posted.status}`
      result = 'written'
    }
    if (issue.outcome === 'done' && issue.admitted === 'author') {
      const closed = await this.request(url, { method: 'PATCH', body: { state: 'closed', state_reason: 'completed' } })
      if ((await answer(closed)) === 'refused') return `refused-${closed.status}`
    }
    return result
  }

  private async sentenceOf(issueId: number, outcome: string | null): Promise<string> {
    if (outcome !== 'done') return `Closed by the factory without a change: ${outcome ?? 'unknown'}.`
    const [event]: { summary: string | null }[] = await this.deps.sql`
      SELECT payload->>'summary' AS summary FROM factory.issue_events
      WHERE issue_id = ${issueId} AND kind IN ('ship', 'close') ORDER BY at DESC, id DESC LIMIT 1`
    const first = cleanText((event?.summary ?? '').split('\n')[0] ?? '').slice(0, MAX_SUMMARY_CHARS)
    return first ? `Done by the factory. ${first}` : 'Done by the factory.'
  }
}

function signalOfIssue(
  target: Target,
  owner: string,
  name: string,
  issue: GithubIssue,
  event: 'labeled' | 'opened',
): Signal {
  // The owner's own issue is `author` whichever query found it; only those are closed on GitHub by the write-back.
  const admitted =
    target.author !== undefined && issue.user?.login.toLowerCase() === target.author.toLowerCase() ? 'author' : 'label'
  const repo = `${owner}/${name}`
  const title = cleanText(issue.title.slice(0, MAX_TITLE_CHARS)) || `${repo}#${issue.number}`
  return {
    source: 'github',
    subject: `${repo}#${issue.number}`,
    event,
    status: 'event',
    title,
    facts: storable({
      url: issue.html_url,
      number: issue.number,
      labels: issue.labels.map((l) => l.name),
      ...(issue.user ? { author: issue.user.login } : {}),
      body: (issue.body ?? '').slice(0, MAX_BODY_CHARS),
      admitted,
      writeback: true,
    }),
    repo: target.repo,
    fingerprint: fingerprintOf(owner, name, title),
  }
}
