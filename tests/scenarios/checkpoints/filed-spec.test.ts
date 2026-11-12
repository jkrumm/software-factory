import { afterAll, beforeAll, expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { ArtifactReply, PassReply } from '@software-factory/contract'
import { admit, settle, stateOf, tick } from '../flow.ts'
import { factory, type ServerProcess, type World } from '../harness.ts'
import { type Lab, startLab } from '../planning/lab.ts'

/**
 * A Spec that comes with the Issue (`issue new --spec @file`), against the real server and Postgres: the Issue is filed
 * and settled as any, the queue holds it (reason `spec`) until the Spec has a verdict, the owner's or the factory's after
 * 24 hours, and the lead that then starts is told about the Spec instead of being asked for one.
 */
const REPOS = ['example-filed-a', 'example-filed-b', 'example-filed-c']
let lab: Lab
let world: World
let server: ServerProcess
let dir: string

beforeAll(async () => {
  dir = await mkdtemp('/tmp/factory-filed-spec-')
  lab = await startLab({
    leads: true,
    repos: Object.fromEntries(REPOS.map((name) => [name, { project: `apiVersion: factory/v2\nname: ${name}\n` }])),
    env: { FACTORY_LEADS_PER_ACCOUNT: '16', FACTORY_DATA_DIR: join(dir, 'data') },
  })
  world = lab.world
  server = lab.server
  expect((await lab.cli(['project', 'sync'])).code).toBe(0)
})

afterAll(async () => {
  await lab.stop()
  await rm(dir, { recursive: true, force: true })
})

async function cli(...args: string[]) {
  const run = await factory(world, [...args, '--format', 'json'], { FACTORY_URL: server.url })
  return { ...run, json: run.out.trim() ? (JSON.parse(run.out) as unknown) : null }
}

async function ok<T>(parse: (json: unknown) => T, ...args: string[]): Promise<T> {
  const run = await cli(...args)
  if (run.code !== 0) throw new Error(`factory ${args.join(' ')} exited ${run.code}: ${run.err}`)
  return parse(run.json)
}

const flow = () => ({ world, server })
const body = (value: unknown): string[] => ['--body', JSON.stringify(value)]
const SPEC = '# Route spec\n\nWhat I will build.\n\n## Open choices\n\n1. A default.\n'

/** Files an Issue with the Spec in a file, as the filing session does. */
async function file(repo: string, title: string, extra: string[] = []) {
  const path = join(dir, `${repo}.md`)
  await writeFile(path, SPEC)
  const filed = await cli(
    'issue',
    'new',
    '--repo',
    repo,
    '--title',
    title,
    '--key',
    `filed-spec-${repo}`,
    '--spec',
    `@${path}`,
    ...extra,
  )
  if (filed.code !== 0) throw new Error(`issue new exited ${filed.code}: ${filed.err}`)
  const issue = (filed.json as { issue: string }).issue
  const [artifact]: { id: string; title: string; kind: string; author: string; key: string }[] = await world.db.sql`
    SELECT id, title, kind, author, key FROM factory.artifacts WHERE issue_id = ${issue}`
  return { issue, artifact }
}

/** One admission pass: whether it admitted the Issue, and the reason the queue gives it. */
async function look(issue: string) {
  const passed = await admit(flow())
  return {
    admitted: passed.admitted.some((a) => a.issue === issue),
    reason: passed.queue.find((entry) => entry.issue === issue)?.reason?.kind ?? null,
  }
}

async function backdate(issueId: string, hours: number): Promise<void> {
  const { sql } = world.db
  const ago = `${hours} hours`
  await sql`UPDATE factory.issue_events SET at = at - ${ago}::interval WHERE issue_id = ${issueId}`
  await sql`
    UPDATE factory.artifact_revisions SET created_at = created_at - ${ago}::interval
    WHERE artifact_id IN (SELECT id FROM factory.artifacts WHERE issue_id = ${issueId})`
  await sql`UPDATE factory.artifacts SET created_at = created_at - ${ago}::interval WHERE issue_id = ${issueId}`
}

test('filed with a Spec: stored once, queued behind its verdict, admitted after the owner gave it, the brief names it', async () => {
  const { issue, artifact } = await file('example-filed-a', 'a new public route')
  // the artifact is the Spec of the file, titled by its heading, and the Issue carries the checkpoint
  expect(artifact).toMatchObject({ title: 'Route spec', kind: 'spec', author: 'factory', key: `filed-spec:${issue}` })
  const [filed]: { checkpoint: string | null }[] = await world.db.sql`
    SELECT payload->>'checkpoint' AS checkpoint FROM factory.issue_events WHERE issue_id = ${issue} AND kind = 'filed'`
  expect(filed?.checkpoint).toBe('spec')
  const shown = await cli('artifact', 'show', artifact?.id ?? '')
  expect((shown.json as { artifact: { revisions: unknown[] } }).artifact.revisions).toHaveLength(1)

  // the same filing again stores nothing twice
  const again = await cli(
    'issue',
    'new',
    '--repo',
    'example-filed-a',
    '--title',
    'a new public route',
    '--key',
    'filed-spec-example-filed-a',
    '--spec',
    SPEC,
  )
  expect(again.json).toMatchObject({ issue, filed: false })
  const [stored]: { n: number }[] = await world.db
    .sql`SELECT count(*)::int AS n FROM factory.artifacts WHERE issue_id = ${issue}`
  expect(stored?.n).toBe(1)

  // settled, it stays queued: no lead, no wait, the reason is the Spec
  await settle(flow(), issue)
  expect(await stateOf(world, issue)).toMatchObject({ state: 'queued', wait: null })
  expect(await look(issue)).toEqual({ admitted: false, reason: 'spec' })

  // the owner's verdict, with a note: it ends the hold and the lead hears the note
  const verdict = await ok(
    (json) => ArtifactReply.parse(json),
    'artifact',
    'verdict',
    artifact?.id ?? '',
    ...body({ verdict: 'with_notes', note: 'Name the lock.' }),
  )
  expect(verdict).toMatchObject({ result: 'applied', verdict: { verdict: 'with_notes' } })
  expect(await stateOf(world, issue)).toMatchObject({ state: 'queued' })
  expect((await look(issue)).admitted || (await stateOf(world, issue)).state === 'working').toBe(true)
  await tick(lab)

  const [brief]: { text: string }[] = await world.db.sql`
    SELECT text FROM factory.lead_deliveries WHERE issue_id = ${issue} AND kind = 'brief'`
  expect(brief?.text).toContain('filed with its Spec')
  expect(brief?.text).toContain(artifact?.id ?? 'missing')
  expect(brief?.text).toContain('Its verdict: with_notes')
  expect(brief?.text).toContain('Name the lock.')
  expect(brief?.text).not.toContain('submit a one-page Spec (order 3) before you build')
})

test('no verdict in a day: the factory records looks_good and the lead starts on the defaults', async () => {
  const { issue, artifact } = await file('example-filed-b', 'another route')
  await settle(flow(), issue)
  expect(await look(issue)).toEqual({ admitted: false, reason: 'spec' })

  await backdate(issue, 23)
  const early = await ok((json) => PassReply.parse(json), 'checkpoint', 'pass')
  expect(early.reviews).toEqual([])
  expect(await look(issue)).toEqual({ admitted: false, reason: 'spec' })

  await backdate(issue, 2)
  const late = await ok((json) => PassReply.parse(json), 'checkpoint', 'pass')
  expect(late.reviews).toEqual([{ artifact: artifact?.id ?? '', outcome: 'defaulted' }])
  const [verdict]: { verdict: string; note: string }[] = await world.db.sql`
    SELECT verdict, note FROM factory.verdicts WHERE artifact_id = ${artifact?.id ?? ''}`
  expect(verdict?.verdict).toBe('looks_good')
  expect(verdict?.note).toContain('no verdict in 24 hours')
  expect((await look(issue)).admitted || (await stateOf(world, issue)).state === 'working').toBe(true)
})

test('a Spec title is given or taken from the file; a title alone is refused', async () => {
  const { artifact } = await file('example-filed-c', 'titled', ['--spec-title', 'Given title'])
  expect(artifact?.title).toBe('Given title')
  const run = await cli('issue', 'new', '--repo', 'example-filed-c', '--title', 'no spec', '--spec-title', 'Orphan')
  expect(run.code).not.toBe(0)
})
