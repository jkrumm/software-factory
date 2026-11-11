import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { type QualityView, type ReopenAnswer, ShipAnswer } from '@software-factory/contract'
import { stateOf as issueState, tick } from '../flow.ts'
import { factory, type ServerProcess, type World } from '../harness.ts'
import { type LeadsWorld, startLeadsWorld } from '../leads/support.ts'

/** The server's environment for a quality scenario: a quick tick, no settle, a short retry. */
export const QUALITY_ENV = {
  FACTORY_TICK_MS: '100',
  // Admission and triage happen when the scenario asks (a reopened Issue stays queued; the scenario settles what it files).
  FACTORY_LOOP_PLANNING_MS: '0',
  FACTORY_LOOP_TRIAGE_MS: '0',
  FACTORY_VERIFY_SETTLE_MS: '0',
  FACTORY_VERIFY_RETRY_MS: '100',
}

/** Make's targets: what the watch runs. `red` in the clone turns `make verify` red; `make version` prints HEAD. */
export const MAKEFILE = 'verify:\n\t@test ! -e red\nversion:\n\t@git rev-parse HEAD\ndeploy:\n\t@true\n'

export interface Answer<T = unknown> {
  code: number
  /** the answer on success; on a refusal the error body (`{ error, code }`) the CLI printed on stdout */
  json: T
  /** a refusal's message, from that body */
  refusal: string
  err: string
}

/**
 * An Issue whose attempt 1 has a lead working: admitted, and started by the leads' own tick against the fake `hc`, so
 * the attempt row (the repo's directory, the branch, the commit its worktree was cut from) is the one quality reads.
 */
export async function workingIssue(lw: LeadsWorld, title: string): Promise<string> {
  const id = await lw.admitted(title)
  await tick(lw)
  // The terminal carries the lead's name (`lead-<n>-<attempt>`) as its key, whether it still lives or finished.
  const name = `lead-${id.slice('issue_'.length)}-1`
  await until('the lead to start', async () => lw.terminals().some((t) => t.labels['factory.key'] === name))
  await until('the Issue to work', async () => (await stateOf(lw.world, id)) === 'working')
  return id
}

/** The project file of a quality world unless the scenario brings its own: `make deploy` deploys, so the watch reads `make version`. */
export const projectMake = (holdSeconds = 0): string =>
  `apiVersion: factory/v2\nname: example\nleads: 8\ndeploy:\n  mode: make\n  hold: ${holdSeconds}s\n`

/**
 * A git repo like the leads' scenarios make, with a Makefile and a project file committed, pushed and synced before any
 * worktree is cut. `project: null` leaves the repo without a `project.yaml`.
 */
export async function startQualityWorld(
  env: Record<string, string> = {},
  options: { makefile?: string; project?: string | null; github?: FakeCi } = {},
): Promise<LeadsWorld> {
  const github: Record<string, string> = options.github
    ? { FACTORY_GITHUB_TOKEN: 'ghp_fake_0123456789', FACTORY_GITHUB_API_URL: options.github.url }
    : {}
  const lw = await startLeadsWorld({ ...QUALITY_ENV, FACTORY_GITHUB_POLL: 'off', ...github, ...env })
  if (options.github) await asGithubOrigin(lw)
  await commit(lw, 'Makefile', options.makefile ?? MAKEFILE, 'chore: make contract')
  if (options.project === null) {
    await gitIn(lw, 'rm', '-q', 'project.yaml')
    await gitIn(lw, 'commit', '-q', '-m', 'chore: no project file')
    await gitIn(lw, 'push', '-q', 'origin', 'master')
  } else await commit(lw, 'project.yaml', options.project ?? projectMake(), 'chore: project file')
  const synced = await lw.cli(['project', 'sync'])
  if (synced.code !== 0) throw new Error(`project sync exited ${synced.code}: ${synced.err}`)
  return lw
}

async function git(cwd: string, ...args: string[]): Promise<string> {
  const proc = Bun.spawn(['git', ...args], {
    cwd,
    stdout: 'pipe',
    stderr: 'pipe',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 't',
      GIT_AUTHOR_EMAIL: 't@example.com',
      GIT_COMMITTER_NAME: 't',
      GIT_COMMITTER_EMAIL: 't@example.com',
    },
  })
  const [out, err, code] = await Promise.all([proc.stdout.text(), proc.stderr.text(), proc.exited])
  if (code !== 0) throw new Error(`git ${args.join(' ')} exited ${code}: ${err}`)
  return out.trim()
}

export const gitIn = (lw: LeadsWorld, ...args: string[]) => git(lw.repo, ...args)

/** Writes a file in the repo's main checkout, commits it and pushes `master`; returns the commit. */
export async function commit(lw: LeadsWorld, file: string, text: string, message = `change ${file}`): Promise<string> {
  await mkdir(dirname(join(lw.repo, file)), { recursive: true })
  await writeFile(join(lw.repo, file), text)
  await git(lw.repo, 'add', '-A')
  await git(lw.repo, 'commit', '-q', '-m', message)
  await git(lw.repo, 'push', '-q', 'origin', 'master')
  return git(lw.repo, 'rev-parse', 'HEAD')
}

/** Where the Issue stands as `state[:wait][:outcome]`, read-only. */
export async function stateOf(world: World, id: string): Promise<string> {
  const { state, wait, outcome } = await issueState(world, id)
  return [state, wait, outcome].filter(Boolean).join(':')
}

export async function until<T>(what: string, look: () => Promise<T | undefined | false>, ms = 45_000): Promise<T> {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    const found = await look()
    if (found) return found
    await Bun.sleep(100)
  }
  throw new Error(`gave up waiting for ${what}`)
}

function parse<T>(raw: { code: number; out: string; err: string }): Answer<T> {
  const json = (raw.out ? JSON.parse(raw.out) : null) as T
  // A failure is one JSON line on stderr: `{ error: { kind, code, message, hint, details } }`.
  const refusal =
    raw.code === 0 ? '' : String((JSON.parse(raw.err) as { error?: { message?: unknown } }).error?.message ?? '')
  return { code: raw.code, json, refusal, err: raw.err }
}

export async function ship(
  world: World,
  server: ServerProcess,
  id: string,
  body: { attempt?: number; call: string; commits: string[]; acceptance?: string[] },
): Promise<Answer<ShipAnswer>> {
  const raw = await factory(
    world,
    ['issue', 'ship', id, '--body', JSON.stringify({ attempt: 1, ...body }), '--format', 'json'],
    { FACTORY_URL: server.url },
  )
  const answer = parse<ShipAnswer>(raw)
  if (answer.code === 0) ShipAnswer.parse(answer.json)
  return answer
}

export async function reopen(
  world: World,
  server: ServerProcess,
  id: string,
  body: { call: string; reason: string },
): Promise<Answer<ReopenAnswer>> {
  const raw = await factory(world, ['issue', 'reopen', id, '--body', JSON.stringify(body), '--format', 'json'], {
    FACTORY_URL: server.url,
  })
  return parse<ReopenAnswer>(raw)
}

export async function show(world: World, server: ServerProcess, id: string): Promise<QualityView> {
  const raw = await factory(world, ['issue', 'quality', id, '--format', 'json'], { FACTORY_URL: server.url })
  if (raw.code !== 0) throw new Error(`issue quality exited ${raw.code}: ${raw.err}`)
  return JSON.parse(raw.out) as QualityView
}

/** What agw's review reads answer from now on: `covered`, `none` or `uncovered`; `null` leaves them unscripted (they fail). */
export async function scriptReview(world: World, mode: 'covered' | 'none' | 'uncovered' | null): Promise<void> {
  const file = join(world.bin, 'review-mode')
  if (mode === null) await Bun.write(file, '').then(() => Bun.file(file).delete())
  else await writeFile(file, mode)
}

/** The project file of a project that ships by pull request: the Watch also reads CI for the landed commit. */
export const projectPr = (holdSeconds = 0): string =>
  `${projectMake(holdSeconds)}ship:\n  - { paths: ['**'], via: pr }\n`

/**
 * The repo's origin reads as a github.com address (the CI reader names the repository by it) while fetch and push still
 * go to the bare repo: `url.<bare>.insteadOf` rewrites for git's transport and `remote.origin.url` stays as written.
 */
async function asGithubOrigin(lw: LeadsWorld): Promise<void> {
  const bare = await git(lw.repo, 'remote', 'get-url', 'origin')
  await git(lw.repo, 'config', `url.${bare}.insteadOf`, FAKE_ORIGIN)
  await git(lw.repo, 'remote', 'set-url', 'origin', FAKE_ORIGIN)
}

const FAKE_ORIGIN = 'https://github.com/o/example.git'

export interface FakeCiRun {
  name: string
  status: 'completed' | 'in_progress'
  conclusion: 'success' | 'failure' | null
}

/** A GitHub API that serves pull requests of a commit and check runs of a commit, as the scenario sets them. */
export interface FakeCi {
  url: string
  /** the commit landed through pull request `number`, whose head is `head` */
  pull(sha: string, number: number, head: string): void
  /** the check runs of a commit from now on */
  runs(sha: string, runs: FakeCiRun[]): void
  /** every request answers 500 */
  down(on: boolean): void
  /** `path` of every request, in order */
  requests: string[]
  stop(): void
}

export function fakeCi(): FakeCi {
  const pulls = new Map<string, { number: number; head: string }>()
  const runs = new Map<string, FakeCiRun[]>()
  let down = false
  const requests: string[] = []
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch(req) {
      const path = new URL(req.url).pathname
      requests.push(path)
      if (down) return new Response('down', { status: 500 })
      const found = /^\/repos\/o\/example\/commits\/([^/]+)\/(pulls|check-runs|status)$/.exec(path)
      const [, sha = '', what] = found ?? []
      if (what === 'pulls') {
        const pull = pulls.get(sha)
        return Response.json(
          pull
            ? [
                {
                  number: pull.number,
                  html_url: `https://github.com/o/example/pull/${pull.number}`,
                  merged_at: '2026-11-11T10:00:00Z',
                  head: { sha: pull.head },
                },
              ]
            : [],
        )
      }
      if (what === 'check-runs')
        return Response.json({
          check_runs: (runs.get(sha) ?? []).map((run) => ({
            head_sha: sha,
            ...run,
            html_url: `https://github.com/o/example/runs/${run.name}`,
          })),
        })
      if (what === 'status') return Response.json({ sha, statuses: [] })
      return new Response('not found', { status: 404 })
    },
  })
  return {
    url: `http://127.0.0.1:${server.port}`,
    pull: (sha, number, head) => void pulls.set(sha, { number, head }),
    runs: (sha, list) => void runs.set(sha, list),
    down: (on) => {
      down = on
    },
    requests,
    stop: () => void server.stop(true),
  }
}
