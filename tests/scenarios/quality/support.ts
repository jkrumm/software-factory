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

/** A git repo like the leads' scenarios make, with a Makefile committed and pushed before any worktree is cut. */
export async function startQualityWorld(env: Record<string, string> = {}): Promise<LeadsWorld> {
  const lw = await startLeadsWorld({ ...QUALITY_ENV, ...env })
  await commit(lw, 'Makefile', MAKEFILE, 'chore: make contract')
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

export async function until<T>(what: string, look: () => Promise<T | undefined | false>, ms = 20_000): Promise<T> {
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
  body: { attempt?: number; call: string; commits: string[] },
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
