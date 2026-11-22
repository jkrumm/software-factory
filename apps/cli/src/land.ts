import { existsSync, readFileSync } from 'node:fs'
import { constants } from 'node:os'
import { basename, join } from 'node:path'
import {
  GREEN_READS,
  MERGE_METHODS,
  METHOD_FIELDS,
  type MergeMethod,
  allowedMethod,
  makefileIn,
  nextGreens,
  probeGuard,
  readChecks,
  redRun,
  scanGuard,
} from '@software-factory/contract'
import { parse } from 'yaml'
import { type Held, withLock } from './deploy-lock.ts'
import { usage } from './exit.ts'
import type { Io } from './operation.ts'
import { exitCodeOf } from './slot.ts'

const USAGE = 'usage: land [--pr <n>] [--method squash|rebase|merge] [--allow-red] [--no-ci] [--project <name>]'
type Method = MergeMethod
/** How often the CI wait looks again (`FACTORY_LAND_POLL_MS`). */
const DEFAULT_POLL_MS = 15_000
/** A head with no check this long after its push has no CI coming (`FACTORY_LAND_NO_RUN_MS`). */
const DEFAULT_NO_RUN_MS = 3 * 60_000
/** How often the wait for the merge window looks for a moved default branch (`FACTORY_LAND_REBASE_POLL_MS`). */
const DEFAULT_REBASE_POLL_MS = 60_000
/** The longest CI wait, the merge guard's own bound (`FACTORY_LAND_CI_MINUTES`). */
const DEFAULT_CI_MINUTES = 45

interface Options {
  pr?: string
  method?: Method
  allowRed: boolean
  noCi: boolean
  project?: string
}

/** A step that will not go on: which step, why, and the command to run next. */
class Refused extends Error {
  constructor(
    readonly step: string,
    readonly why: string,
    readonly next: string,
  ) {
    super(why)
  }
}

interface Ran {
  code: number
  out: string
  err: string
}

/** What the verb knows about the repo before it takes the window. */
interface Repo {
  root: string
  project: string
  mode: 'pr' | 'push'
  base: string
  branch: string
  thread: string
}

interface PullRequest {
  number: number
  state: string
  url: string
  headRefOid: string
  mergeCommit?: { oid: string } | null
}

interface Check {
  name: string
  bucket: string
  link?: string
}

interface CoveredCommit {
  sha: string
  subject?: string
  required?: string
  reason?: string
}

const number = (value: string | undefined, fallback: number): number => {
  const n = Number(value)
  return value !== undefined && value !== '' && Number.isFinite(n) && n >= 0 ? n : fallback
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))
const short = (sha: string) => sha.slice(0, 7)
const lastLines = (text: string, n = 8) => text.trim().split('\n').slice(-n).join('\n')

function json<T>(text: string): T | null {
  try {
    return JSON.parse(text) as T
  } catch {
    return null
  }
}

/** Runs commands in one directory; the child is passed to the lock's signal handling while it runs. */
class Shell {
  held: Held | undefined
  constructor(
    readonly cwd: string,
    readonly io: Io,
  ) {}

  async run(cmd: string[], options: { env?: Record<string, string>; inherit?: boolean } = {}): Promise<Ran> {
    let child: ReturnType<typeof Bun.spawn>
    try {
      child = Bun.spawn(cmd, {
        cwd: this.cwd,
        env: { ...this.io.env, ...options.env },
        stdin: 'ignore',
        // a command whose output is shown (make) writes it to stderr: stdout carries the landed commits alone
        stdout: options.inherit ? 2 : 'pipe',
        stderr: options.inherit ? 'inherit' : 'pipe',
        detached: true,
      })
    } catch (error) {
      return {
        code: 127,
        out: '',
        err: `cannot run ${cmd[0]}: ${error instanceof Error ? error.message : String(error)}`,
      }
    }
    this.held?.track(child)
    const [out, err] = await Promise.all([
      child.stdout instanceof ReadableStream ? new Response(child.stdout).text() : '',
      child.stderr instanceof ReadableStream ? new Response(child.stderr).text() : '',
      child.exited,
    ])
    this.held?.track(undefined)
    return { code: exitCodeOf(child), out, err }
  }

  /** The trimmed stdout, or null on a non-zero exit. */
  async read(cmd: string[]): Promise<string | null> {
    const ran = await this.run(cmd)
    return ran.code === 0 ? ran.out.trim() : null
  }
}

function parseOptions(words: readonly string[]): Options {
  const options: Options = { allowRed: false, noCi: false }
  for (let i = 0; i < words.length; i++) {
    const word = words[i] as string
    const [flag, inline] = word.includes('=')
      ? [word.slice(0, word.indexOf('=')), word.slice(word.indexOf('=') + 1)]
      : [word]
    const value = () => {
      const next = inline ?? words[++i]
      if (next === undefined) throw usage(`land: ${flag} needs a value`, USAGE)
      return next
    }
    if (flag === '--allow-red') options.allowRed = true
    else if (flag === '--no-ci') options.noCi = true
    else if (flag === '--pr') {
      const pr = value()
      if (!/^[1-9]\d*$/.test(pr)) throw usage(`land: --pr needs a pull request number, not ${pr}`, USAGE)
      options.pr = pr
    } else if (flag === '--method') {
      const method = value()
      if (!(MERGE_METHODS as readonly string[]).includes(method))
        throw usage(`land: --method is one of ${MERGE_METHODS.join(', ')}`, USAGE)
      options.method = method as Method
    } else if (flag === '--project') options.project = value()
    else throw usage(`land: unknown argument ${word}`, USAGE)
  }
  return options
}

/** `ship:` with any `via: pr` lands through a pull request; no project.yaml or only `via: push` pushes. */
function readProject(root: string): { name?: string; mode: 'pr' | 'push' } {
  const path = join(root, 'project.yaml')
  if (!existsSync(path)) return { mode: 'push' }
  const doc = parse(readFileSync(path, 'utf8')) as { name?: unknown; ship?: unknown } | null
  const ship = Array.isArray(doc?.ship) ? (doc.ship as { via?: unknown }[]) : []
  return {
    ...(typeof doc?.name === 'string' ? { name: doc.name } : {}),
    mode: ship.some((rule) => rule?.via === 'pr') ? 'pr' : 'push',
  }
}

/** A remote URL on a forge (not a local path) whose host is not GitHub. */
const notGitHub = (url: string): boolean =>
  /^(?:[a-z+]+:\/\/|[^/@\s]+@[^:/\s]+:)/i.test(url) && !/github\.com[:/]/i.test(url)

async function readRepo(sh: Shell, options: Options): Promise<Repo> {
  const root = sh.cwd
  const project = readProject(root)
  const url = await sh.read(['git', 'remote', 'get-url', 'origin'])
  if (url === null)
    throw new Refused('setup', 'the repo has no origin remote', 'git remote add origin <url>, then factory land again')
  const fromOrigin = (await sh.read(['git', 'symbolic-ref', '--short', 'refs/remotes/origin/HEAD']))?.replace(
    /^origin\//,
    '',
  )
  const base =
    fromOrigin ||
    json<{ defaultBranchRef?: { name?: string } }>(
      (await sh.read(['gh', 'repo', 'view', '--json', 'defaultBranchRef'])) ?? '',
    )?.defaultBranchRef?.name
  if (!base)
    throw new Refused(
      'setup',
      "origin's default branch is unknown",
      'git remote set-head origin --auto, then factory land again',
    )
  if (notGitHub(url))
    throw new Refused(
      'setup',
      `origin (${url}) is not on GitHub, and factory land speaks only gh`,
      `land by hand: git fetch origin ${base} && git rebase origin/${base} && git push --force-with-lease, wait for green CI on that head, then merge the request (glab mr merge)`,
    )
  const branch = await sh.read(['git', 'symbolic-ref', '--short', 'HEAD'])
  if (!branch) throw new Refused('setup', 'HEAD is detached', 'git switch <your branch>, then factory land again')
  const mode = project.mode
  if (mode === 'pr' && branch === base)
    throw new Refused(
      'setup',
      `this repo lands by pull request and HEAD is ${base} itself`,
      'git switch <your branch>, then factory land again',
    )
  const dirty = await sh.read(['git', 'status', '--porcelain', '--untracked-files=no'])
  if (dirty === null || dirty !== '')
    throw new Refused('setup', 'the worktree has uncommitted changes', 'commit them, then factory land again')
  const issue = /(?:^|\/)(\d+)-\d+$/.exec(branch)?.[1]
  return {
    root,
    project: options.project ?? project.name ?? basename(url).replace(/\.git$/, ''),
    mode,
    base,
    branch,
    thread: `factory-${issue ?? '<issue number>'}`,
  }
}

/** What gh prints when the repo was read and holds no such pull request (by branch, or by number). */
const NO_PULL_REQUEST = /no pull requests? found|could not resolve to a pullrequest/i
const NO_CHECKS = /no checks reported/i

/** The pull request, or null when gh read the repo and found none; any other gh failure refuses with gh's own words. */
async function pullRequest(sh: Shell, ref: string): Promise<PullRequest | null> {
  const ran = await sh.run(['gh', 'pr', 'view', ref, '--json', 'number,state,url,headRefOid,mergeCommit'])
  if (ran.code === 0) return json<PullRequest>(ran.out)
  const said = ran.err.trim() || ran.out.trim()
  if (NO_PULL_REQUEST.test(said)) return null
  const config = sh.io.env.GH_CONFIG_DIR
  throw new Refused(
    'pr',
    `gh could not read the pull request for ${/^\d+$/.test(ref) ? `#${ref}` : ref}: ${lastLines(said) || `gh exited ${ran.code} with no output`}`,
    `check the gh account first (gh auth status; GH_CONFIG_DIR is ${config ? config : 'unset'}), then factory land again`,
  )
}

/** The checks of the head; a failed read with no JSON is a blip, unless gh says there are no checks. */
async function checksOf(sh: Shell, ref: string, head: string): Promise<{ checks: Check[] } | { blip: string }> {
  const ran = await sh.run(['gh', 'pr', 'checks', ref, '--json', 'name,bucket,link'])
  const checks = json<Check[]>(ran.out)
  const said = ran.err.trim() || ran.out.trim()
  if (checks !== null || ran.code === 0 || NO_CHECKS.test(said)) return { checks: checks ?? [] }
  return {
    blip: `gh could not read the checks on ${short(head)}: ${lastLines(said) || `gh exited ${ran.code} with no output`}`,
  }
}

class Lander {
  private readonly out: (line: string) => void
  private readonly pollMs: number
  private readonly noRunMs: number
  private readonly ciMs: number
  private readonly rebasePollMs: number
  /** the default branch's sha the branch was last rebased onto, and when the wait last looked */
  private seen = ''
  private lookedAt = 0

  constructor(
    private readonly sh: Shell,
    private readonly repo: Repo,
    private readonly options: Options,
  ) {
    this.out = (line) => sh.io.err(`land: ${line}\n`)
    this.pollMs = number(sh.io.env.FACTORY_LAND_POLL_MS, DEFAULT_POLL_MS)
    this.noRunMs = number(sh.io.env.FACTORY_LAND_NO_RUN_MS, DEFAULT_NO_RUN_MS)
    this.ciMs = number(sh.io.env.FACTORY_LAND_CI_MINUTES, DEFAULT_CI_MINUTES) * 60_000
    this.rebasePollMs = number(sh.io.env.FACTORY_LAND_REBASE_POLL_MS, DEFAULT_REBASE_POLL_MS)
  }

  /**
   * Before the window is asked for: the branch on top of the default branch, so a conflict shows now, not after the wait,
   * and a clean rebase keeps its review (agw matches by patch) while the lead is not yet holding anybody up.
   */
  async prepare(): Promise<void> {
    this.seen = (await this.rebase()).base
  }

  /**
   * On every poll of the wait for the window: when the default branch moved, rebase again. A conflict ends the wait at once
   * (the lead resolves it now, not after the rest of the queue); a failed fetch is a blip and waits on.
   */
  async whileWaiting(): Promise<number | undefined> {
    if (Date.now() - this.lookedAt < this.rebasePollMs) return undefined
    this.lookedAt = Date.now()
    try {
      const sha = await this.fetch('wait')
      if (sha === this.seen) return undefined
      this.seen = (await this.rebase(sha)).base
    } catch (error) {
      if (!(error instanceof Refused)) throw error
      if (error.step === 'wait') return undefined
      reportRefusal(this.sh.io, error)
      return 1
    }
    return undefined
  }

  private get origin() {
    return `origin/${this.repo.base}`
  }

  private async fetch(step: string): Promise<string> {
    const fetched = await this.sh.run(['git', 'fetch', '--quiet', 'origin', this.repo.base])
    const sha = await this.sh.read(['git', 'rev-parse', this.origin])
    if (fetched.code !== 0 || !sha)
      throw new Refused(
        step,
        `git fetch origin ${this.repo.base} failed: ${lastLines(fetched.err || fetched.out)}`,
        'factory land again',
      )
    return sha
  }

  /** Step 2: the branch on top of the default branch; the plan merge driver resolves an append-only plan file. */
  private async rebase(fetched?: string): Promise<{ base: string; head: string }> {
    const base = fetched ?? (await this.fetch('rebase'))
    if ((await this.sh.run(['git', 'merge-base', '--is-ancestor', this.origin, 'HEAD'])).code === 0) {
      this.out(`rebase: already on ${this.origin} (${short(base)})`)
    } else {
      const ran = await this.sh.run([
        'git',
        '-c',
        'merge.plan.driver=factory plan merge %O %A %B',
        'rebase',
        this.origin,
      ])
      if (ran.code !== 0) {
        await this.sh.run(['git', 'rebase', '--abort'])
        throw new Refused(
          'rebase',
          `the rebase onto ${this.origin} stopped on a conflict, and was aborted: ${lastLines(ran.out + ran.err)}`,
          `git rebase ${this.origin}, resolve the conflict, run the repo's check, then factory land again`,
        )
      }
      const attributes = join(this.repo.root, '.gitattributes')
      if (existsSync(attributes) && /\smerge=plan\b/.test(readFileSync(attributes, 'utf8'))) {
        const check = await this.sh.run(['factory', 'plan', 'check'])
        if (check.code !== 0)
          throw new Refused(
            'rebase',
            `factory plan check failed after the rebase: ${lastLines(check.out + check.err)}`,
            'fix the plan file, commit, then factory land again',
          )
      }
      this.out(`rebase: onto ${this.origin} (${short(base)})`)
    }
    const head = await this.sh.read(['git', 'rev-parse', 'HEAD'])
    if (!head) throw new Refused('rebase', 'HEAD cannot be read', 'git status, then factory land again')
    return { base, head }
  }

  /** Step 3: every commit of the range that needs a review (standard or deep) sits under one. */
  private async review(base: string): Promise<void> {
    const uncovered = await this.uncovered(`${base}..HEAD`, 'review')
    if (uncovered.length === 0) {
      this.out('review: every commit that needs a review has one')
      return
    }
    const stale = uncovered.some((commit) => commit.reason === 'stale')
    const list = uncovered.map((c) =>
      `${short(c.sha)} (${c.required}${c.reason ? `, ${c.reason}` : ''}) ${c.subject ?? ''}`.trim(),
    )
    throw new Refused(
      'review',
      `${uncovered.length} commit(s) need a review: ${list.join('; ')}`,
      `/review ${base}..HEAD --thread ${this.repo.thread}${stale ? '-rebase' : ''}, then factory land again`,
    )
  }

  /** The commits of a range that `agw review covered` lists uncovered at standard or deep. */
  private async uncovered(range: string, step: string): Promise<CoveredCommit[]> {
    const cmd = ['agw', 'review', 'covered', '--cwd', this.repo.root, '--range', range, '--format', 'json']
    const ran = await this.sh.run(cmd)
    const answer = ran.code === 0 ? json<{ commits?: CoveredCommit[]; uncovered?: string[] }>(ran.out) : null
    if (!answer || !Array.isArray(answer.uncovered))
      throw new Refused(
        step,
        `agw review covered failed: ${lastLines(ran.err || ran.out) || `exit ${ran.code}`}`,
        `${cmd.join(' ')}, fix what it says, then factory land again`,
      )
    // an uncovered sha with no entry of its own is not known to be light: it blocks
    const bySha = new Map((answer.commits ?? []).map((commit) => [commit.sha, commit]))
    return answer.uncovered
      .map((sha) => bySha.get(sha) ?? { sha, required: 'unknown' })
      .filter((commit) => commit.required !== 'light' && commit.required !== 'none')
  }

  /** `--no-ci`: the repo's full gate on the rebased head, before it is pushed. */
  private async check(): Promise<void> {
    this.out('check: make check on the rebased head (--no-ci)')
    const ran = await this.sh.run(['make', '-C', this.repo.root, 'check'], { inherit: true })
    if (ran.code !== 0)
      throw new Refused(
        'check',
        `make check exited ${ran.code} on the rebased head`,
        'fix it, commit, then factory land again',
      )
  }

  private async push(head: string): Promise<void> {
    const target = this.repo.mode === 'pr' ? this.repo.branch : this.repo.base
    const listed = await this.sh.read(['git', 'ls-remote', 'origin', `refs/heads/${target}`])
    if (listed === null) throw new Refused('push', 'git ls-remote origin failed', 'factory land again')
    const remote = listed.split(/\s/)[0] ?? ''
    if (remote === head) {
      this.out(`push: origin ${target} is already ${short(head)}`)
      return
    }
    const cmd =
      this.repo.mode === 'pr'
        ? ['git', 'push', `--force-with-lease=refs/heads/${target}:${remote}`, 'origin', `HEAD:refs/heads/${target}`]
        : ['git', 'push', 'origin', `HEAD:refs/heads/${target}`]
    const ran = await this.sh.run(cmd)
    if (ran.code !== 0)
      throw new Refused(
        'push',
        `${cmd.join(' ')} failed: ${lastLines(ran.err || ran.out)}`,
        'factory land again (it rebases and pushes again)',
      )
    this.out(`push: ${short(head)} to origin ${target}`)
  }

  /** Step 5: every check of the pull request's head is pass or skipping; a red one refuses, nothing is re-run. */
  private async ci(pr: PullRequest, head: string): Promise<number | null> {
    const started = Date.now()
    let previous = ''
    let unread = ''
    let greens = 0
    for (;;) {
      const stopped = this.stopped()
      if (stopped !== null) return stopped
      // the verb's first read already told a wrong account from a missing pull request; a later failure is a blip, so poll again
      let blip = false
      const blipped = (why: string) => {
        blip = true
        if (why !== unread) this.out(`${why}; polling again`)
        unread = why
      }
      const view = await pullRequest(this.sh, String(pr.number)).catch((error: unknown) => {
        if (!(error instanceof Refused)) throw error
        blipped(error.why)
        return null
      })
      let state: string
      let anyCheck = false
      if (view?.headRefOid !== head) {
        greens = 0
        state = `the pull request does not show ${short(head)} yet`
      } else {
        const read = await checksOf(this.sh, String(pr.number), head)
        if ('blip' in read) blipped(read.blip)
        const checks = 'checks' in read ? read.checks : []
        const reading = readChecks(checks)
        if (reading.state === 'red')
          throw new Refused(
            'ci',
            `CI on ${short(head)} is red: ${checks
              .filter((c) => reading.failed.includes(c.name))
              .map((c) => `${c.name} ${c.bucket}${c.link ? ` (${c.link})` : ''}`)
              .join('; ')}`,
            'fix it and commit (a flake: gh run rerun --failed <run id>), then factory land again',
          )
        // a set that is all skipped (a path or `if` filter) is no CI at all, as the hygiene pass reads it
        anyCheck = reading.state !== 'none'
        greens = nextGreens(greens, reading)
        if (reading.state === 'green') {
          if (greens >= GREEN_READS) {
            this.out(`ci: green on ${short(head)} (${checks.length} checks)`)
            return null
          }
          state = `green on ${short(head)}, reading once more`
        } else if (reading.state === 'pending') {
          state = `waiting for ${checks
            .filter((c) => c.bucket !== 'pass' && c.bucket !== 'skipping')
            .map((c) => c.name)
            .join(', ')}`
        } else if ('blip' in read) {
          state = `the checks on ${short(head)} are not read yet`
        } else {
          state = checks.length > 0 ? 'only skipped checks so far' : 'no check yet'
        }
      }
      if (!blip) unread = ''
      const waited = Date.now() - started
      // a poll that could not read says nothing about whether a check ever started
      if (!anyCheck && !blip && waited >= this.noRunMs)
        throw new Refused(
          'ci',
          `no CI check on ${short(head)} after ${Math.round(waited / 1000)}s`,
          "find why no run started; only when every workflow's paths filter skips this change: factory land --no-ci",
        )
      if (waited >= this.ciMs)
        throw new Refused(
          'ci',
          `CI on ${short(head)} still runs after ${Math.round(waited / 60_000)} min`,
          'factory land again once it finished',
        )
      if (state !== previous) this.out(`ci: ${state}`)
      previous = state
      await sleep(this.pollMs)
    }
  }

  /**
   * Whether the repo has a `merge-guard` rule: the Makefile `make` reads (`GNUmakefile`, else `makefile`, else `Makefile`) is
   * scanned as the server scans it for the brief (`scanGuard`). One that includes another file and shows no such rule itself
   * asks `make -n merge-guard` under `LC_ALL=C`, and only make's message for the absent target itself reads as none.
   */
  private async hasGuard(): Promise<boolean> {
    const name = makefileIn((candidate) => existsSync(join(this.repo.root, candidate)))
    if (!name) return false
    const found = scanGuard(readFileSync(join(this.repo.root, name), 'utf8'))
    if (found !== 'included') return found === 'rule'
    const probe = await this.sh.run(['make', '-C', this.repo.root, '-n', 'merge-guard'], { env: { LC_ALL: 'C' } })
    const read = probeGuard({ exitCode: probe.code, output: probe.err + probe.out })
    if (read !== 'broken') return read === 'has'
    // a missing include or prerequisite is a broken guard
    throw new Refused(
      'guard',
      `make -n merge-guard failed, so whether the repo has a merge guard is unknown: ${lastLines(probe.err || probe.out)}`,
      'fix the Makefile, commit, then factory land again',
    )
  }

  /** Step 6: the repo's `make merge-guard`, or the same rule held here when it has none. */
  private async guard(): Promise<void> {
    const has = await this.hasGuard()
    if (has) {
      const ran = await this.sh.run(['make', '-C', this.repo.root, 'merge-guard'], {
        inherit: true,
        ...(this.options.allowRed ? { env: { MERGE_GUARD_ARGS: '--allow-red' } } : {}),
      })
      if (ran.code !== 0)
        throw new Refused(
          'guard',
          'make merge-guard refused (its reasons are above)',
          'fix what it names, then factory land again',
        )
      this.out('guard: make merge-guard is clear')
      return
    }
    await this.fetch('guard')
    if ((await this.sh.run(['git', 'merge-base', '--is-ancestor', this.origin, 'HEAD'])).code !== 0)
      throw new Refused('guard', `${this.origin} moved under the window`, 'factory land again')
    if (!this.options.allowRed) {
      const ran = await this.sh.run([
        'gh',
        'run',
        'list',
        '--branch',
        this.repo.base,
        '--limit',
        '10',
        '--json',
        'status,conclusion,url',
      ])
      const runs = ran.code === 0 ? json<{ status: string; conclusion: string; url: string }[]>(ran.out) : null
      if (runs === null)
        throw new Refused(
          'guard',
          `${this.repo.base}'s CI runs cannot be read: ${lastLines(ran.err)}`,
          'factory land again',
        )
      const red = redRun(runs)
      if (red)
        throw new Refused(
          'guard',
          `${this.repo.base}'s last finished CI run is ${red.conclusion} (${red.url})`,
          `fix ${this.repo.base} first; only the change that fixes it lands with factory land --allow-red`,
        )
    }
    this.out('guard: contains the default branch, which is not red')
  }

  private async method(): Promise<Method> {
    if (this.options.method) return this.options.method
    const ran = await this.sh.run(['gh', 'repo', 'view', '--json', METHOD_FIELDS])
    const method = allowedMethod(ran.code === 0 ? json<Record<string, boolean>>(ran.out) : null)
    if (!method)
      throw new Refused(
        'merge',
        'the merge methods the repo allows cannot be read',
        'factory land --method squash|rebase|merge',
      )
    return method
  }

  private async merge(pr: PullRequest, head: string): Promise<void> {
    const method = await this.method()
    const ran = await this.sh.run(['gh', 'pr', 'merge', String(pr.number), `--${method}`, '--match-head-commit', head])
    if (ran.code !== 0) {
      const text = lastLines(ran.err || ran.out)
      throw new Refused(
        'merge',
        `gh pr merge ${pr.number} --${method} failed: ${text}`,
        /review|approv/i.test(text)
          ? `it waits on another person's review: factory issue defer <id> --attempt <n> --review ${pr.url}`
          : 'fix what it names, then factory land again',
      )
    }
    this.out(`merge: #${pr.number} by ${method}`)
  }

  /** origin's default branch after the merge, or null with a warning: the merge is done, so a failed read never refuses. */
  private async fetchAfterMerge(): Promise<string | null> {
    try {
      return await this.fetch('report')
    } catch (error) {
      if (!(error instanceof Refused)) throw error
      this.out(`report: landed, but the landed commits cannot be read: ${error.why}`)
      return null
    }
  }

  /** The landed commits, and a squash or merge commit whose review no longer matches (agw matches by patch). */
  private async report(before: string): Promise<void> {
    const after = await this.fetchAfterMerge()
    if (after === null) return
    const log = (await this.sh.read(['git', 'log', '--oneline', `${before}..${after}`])) ?? ''
    this.out(`landed on ${this.repo.base}:`)
    for (const line of log.split('\n').filter(Boolean)) this.sh.io.out(`  ${line}\n`)
    if (this.repo.mode === 'push' || before === after) return
    try {
      for (const commit of await this.uncovered(`${before}..${after}`, 'report'))
        this.out(
          `report: ${short(commit.sha)} landed without a review that matches it (${commit.reason ?? 'uncovered'}): /review ${commit.sha}^..${commit.sha} --thread ${this.repo.thread}-landed before you ship`,
        )
    } catch (error) {
      if (!(error instanceof Refused)) throw error
      this.out(`report: ${error.why}`)
    }
  }

  private stopped(): number | null {
    const signal = this.sh.held?.stopped()
    return signal ? 128 + (constants.signals[signal] ?? 1) : null
  }

  /** The window: rebase, review, (check), push, CI, guard, merge, report. */
  async land(pr: PullRequest | null): Promise<number> {
    this.out(`lock: holding the merge window of ${this.repo.project}`)
    const { base, head } = await this.rebase()
    if (base === head) {
      if (this.repo.mode === 'push') {
        this.out(`nothing to land: HEAD is ${this.origin}`)
        return 0
      }
      throw new Refused(
        'rebase',
        `the branch has no commit beyond ${this.origin}`,
        'nothing to land: close the pull request, or commit the change',
      )
    }
    await this.review(base)
    if (this.options.noCi) await this.check()
    await this.push(head)
    if (this.repo.mode === 'push' || !pr) {
      await this.report(base)
      return 0
    }
    if (!this.options.noCi) {
      const stopped = await this.ci(pr, head)
      if (stopped !== null) return stopped
      await this.guard()
    }
    await this.merge(pr, head)
    await this.report(base)
    return 0
  }

  async alreadyMerged(pr: PullRequest): Promise<number> {
    this.out(`pr: #${pr.number} is already merged`)
    const oid = pr.mergeCommit?.oid
    if (oid && (await this.fetchAfterMerge()) !== null) {
      const line = await this.sh.read(['git', 'log', '--oneline', '-1', oid])
      if (line) this.sh.io.out(`  ${line}\n`)
    }
    return 0
  }
}

function reportRefusal(io: Io, error: Refused): void {
  io.err(`land: ${error.step}: refused: ${error.why}\nland: next: ${error.next}\n`)
}

async function refusing(io: Io, body: () => Promise<number>): Promise<number> {
  try {
    return await body()
  } catch (error) {
    if (!(error instanceof Refused)) throw error
    reportRefusal(io, error)
    return 1
  }
}

/**
 * `factory land`: lands the worktree's branch inside the repo's merge window, the recipe order 7 of a lead's brief once
 * spelled out in shell. For a repo that ships by pull request (`project.yaml` `ship:` has `via: pr`): a rebase on
 * origin's default branch before the lock is asked for (a conflict shows before the wait, and the wait rebases again whenever
 * the branch moves), the merge lock, rebase on origin's default branch, the review check (`agw review covered`), push, the head's CI by check bucket, the
 * repo's `make merge-guard` (or the same rule held here), `gh pr merge` by the method the repo allows, and the landed
 * commits. A repo that ships by push: lock, rebase, review, push to the default branch. Every refusal names its step and
 * the next command and exits 1 with nothing merged; 75 is a window not free in time. Every step is safe to repeat, so a
 * second run resumes. It does not deploy and does not ship.
 */
export async function landVerb(words: readonly string[], io: Io): Promise<number> {
  const options = parseOptions(words)
  return refusing(io, async () => {
    const top = await new Shell(process.cwd(), io).read(['git', 'rev-parse', '--show-toplevel'])
    if (!top) throw new Refused('setup', 'not inside a git work tree', 'cd <your worktree>, then factory land again')
    const sh = new Shell(top, io)
    const repo = await readRepo(sh, options)
    let pr: PullRequest | null = null
    if (repo.mode === 'pr') {
      pr = await pullRequest(sh, options.pr ?? repo.branch)
      if (!pr)
        throw new Refused(
          'pr',
          `no pull request for ${options.pr ? `#${options.pr}` : repo.branch}`,
          `git push -u origin ${repo.branch} && gh pr create --fill --base ${repo.base}, then factory land again`,
        )
      if (pr.state === 'MERGED') return new Lander(sh, repo, options).alreadyMerged(pr)
      if (pr.state !== 'OPEN')
        throw new Refused(
          'pr',
          `#${pr.number} is ${pr.state.toLowerCase()}`,
          `gh pr reopen ${pr.number}, then factory land again`,
        )
    }
    const lander = new Lander(sh, repo, options)
    await lander.prepare()
    return withLock({ project: repo.project, kind: 'merge', whileWaiting: () => lander.whileWaiting() }, io, (held) => {
      sh.held = held
      return refusing(io, () => lander.land(pr))
    })
  })
}
