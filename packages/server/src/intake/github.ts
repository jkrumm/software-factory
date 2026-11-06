import { createHash } from 'node:crypto'
import { cleanText, MAX_TITLE_CHARS, storable } from '@software-factory/contract'
import type { SQL } from 'bun'
import { z } from 'zod'
import { childEnv, runProcess } from '../exec.ts'
import { vetIntakeRepo } from '../issues/create.ts'
import { fileSignalIn, type Signal } from '../issues/signals.ts'
import { RepoRefused } from '../repos.ts'

/** The first pass comes this long after boot, so the tick's first minute is not shared with the network. */
const FIRST_PASS_MS = 30_000
const REMOTE_TIMEOUT_MS = 10_000
const HTTP_TIMEOUT_MS = 15_000
const MAX_BODY_CHARS = 4000
const PAGE_SIZE = 50
const NAME = /^[A-Za-z0-9._-]+$/

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
    labels: z.array(z.looseObject({ name: z.string() })),
    user: z.looseObject({ login: z.string() }).nullish(),
    pull_request: z.unknown().optional(),
  }),
)

interface Target {
  repo: string
  label: string
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
  }

  /** The projects that opted in, whose repo the intake may file in. */
  private async targets(): Promise<Target[]> {
    const rows: { repo: string; label: string | null }[] = await this.deps.sql`
      SELECT repo, manifest->'signals'->'github'->>'label' AS label FROM factory.projects
      WHERE NOT paused AND jsonb_typeof(manifest->'signals'->'github') = 'object' ORDER BY name`
    const targets: Target[] = []
    for (const row of rows) {
      try {
        await vetIntakeRepo('github', row.repo, this.deps.roots)
      } catch (error) {
        if (error instanceof RepoRefused) continue
        throw error
      }
      targets.push({ repo: row.repo, label: row.label || 'factory' })
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

  /** One project's labelled issues as signals; any failure is one line without the token or the body, and no signals. */
  private async poll(target: Target, owner: string, name: string): Promise<Signal[]> {
    const repo = `${owner}/${name}`
    const url =
      `https://api.github.com/repos/${owner}/${name}/issues?labels=${encodeURIComponent(target.label)}` +
      `&state=open&per_page=${PAGE_SIZE}&sort=created&direction=asc`
    let status: number | string = 'error'
    try {
      const response = await (this.deps.fetch ?? fetch)(url, {
        headers: {
          Authorization: `Bearer ${this.deps.token}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          'User-Agent': 'software-factory',
        },
        signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
      })
      status = response.status
      if (response.status !== 200) throw new Error('not 200')
      status = 'unparsable'
      const issues = GithubIssues.parse(await response.json())
      // Nothing is written back, so filed issues that stay open keep their place: a full page may hide newer ones.
      if (issues.length >= PAGE_SIZE)
        console.error('github intake: a full page, newer labelled issues may be unseen', { repo })
      return issues
        .filter((issue) => issue.pull_request === undefined)
        .map((issue) => {
          const title = cleanText(issue.title.slice(0, MAX_TITLE_CHARS)) || `${repo}#${issue.number}`
          return {
            source: 'github',
            subject: `${repo}#${issue.number}`,
            event: 'labeled',
            status: 'event',
            title,
            facts: storable({
              url: issue.html_url,
              number: issue.number,
              labels: issue.labels.map((l) => l.name),
              ...(issue.user ? { author: issue.user.login } : {}),
              body: (issue.body ?? '').slice(0, MAX_BODY_CHARS),
            }),
            repo: target.repo,
            fingerprint: fingerprintOf(owner, name, title),
          } satisfies Signal
        })
    } catch {
      console.error('github intake', { repo, status })
      return []
    }
  }
}
