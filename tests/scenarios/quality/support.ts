import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { type QualityView, type ReopenAnswer, ShipAnswer } from '@software-factory/contract'
import { factory, type ServerProcess, type World } from '../harness.ts'

/** The server's environment for a quality scenario: a quick tick, no settle, a short retry, the entry into the write path. */
export const QUALITY_ENV = {
  FACTORY_INTERNAL_TEST_ROUTES: '1',
  FACTORY_TICK_MS: '100',
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

async function post(server: ServerProcess, path: string, body: unknown): Promise<unknown> {
  const response = await fetch(`${server.url}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  const text = await response.text()
  if (response.status !== 200) throw new Error(`${path} answered ${response.status}: ${text}`)
  return JSON.parse(text)
}

const event = (server: ServerProcess, id: string, body: object) =>
  post(server, `/internal/test/issues/${id}/events`, body) as Promise<{
    result: string
    detail: string | null
    issue: { id: string; state: string; waitReason: string | null; outcome: string | null; version: number }
  }>

/** An Issue in `repo` whose attempt 1 has a lead working, filed the way intake and the lead's package will. */
export async function workingIssue(server: ServerProcess, repo: string, tag: string): Promise<string> {
  const filed = (await post(server, '/internal/test/issues', {
    key: `filed:scenario:${tag}`,
    kind: 'filed',
    payload: { repo, title: `the change ${tag}`, kind: 'bug', origin: 'you' },
    actor: 'factory',
  })) as { issue: { id: string } }
  const id = filed.issue.id
  await event(server, id, { key: `${id}:settled`, kind: 'settled', payload: {}, actor: 'factory' })
  await event(server, id, { key: `${id}:admitted:1`, kind: 'admitted', payload: {}, actor: 'factory' })
  await event(server, id, {
    key: `${id}:lead_started:1`,
    kind: 'lead_started',
    payload: { attempt: 1, terminal: `lead-${id}-1` },
    actor: 'factory',
  })
  return id
}

let notes = 0

/** Where the Issue stands, read the one way there is until package 8: a note from the owner answers with the Issue. */
export async function stateOf(server: ServerProcess, id: string): Promise<string> {
  const answer = await event(server, id, {
    key: `${id}:look:${++notes}`,
    kind: 'noted',
    payload: { text: 'where does it stand' },
    actor: 'owner',
  })
  const { state, waitReason, outcome } = answer.issue
  return [state, waitReason, outcome].filter(Boolean).join(':')
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
  const refusal = raw.code === 0 ? '' : String((json as { error?: unknown } | null)?.error ?? '')
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
    ['quality', 'ship', id, '--body', JSON.stringify({ attempt: 1, ...body }), '--format', 'json'],
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
  const raw = await factory(world, ['quality', 'reopen', id, '--body', JSON.stringify(body), '--format', 'json'], {
    FACTORY_URL: server.url,
  })
  return parse<ReopenAnswer>(raw)
}

export async function show(world: World, server: ServerProcess, id: string): Promise<QualityView> {
  const raw = await factory(world, ['quality', 'show', id, '--format', 'json'], { FACTORY_URL: server.url })
  if (raw.code !== 0) throw new Error(`quality show exited ${raw.code}: ${raw.err}`)
  return JSON.parse(raw.out) as QualityView
}

/** What agw's review reads answer from now on: `covered`, `none` or `uncovered`; `null` leaves them unscripted (they fail). */
export async function scriptReview(world: World, mode: 'covered' | 'none' | 'uncovered' | null): Promise<void> {
  const file = join(world.bin, 'review-mode')
  if (mode === null) await Bun.write(file, '').then(() => Bun.file(file).delete())
  else await writeFile(file, mode)
}
