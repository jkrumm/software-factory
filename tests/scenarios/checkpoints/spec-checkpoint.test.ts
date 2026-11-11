import { afterAll, beforeAll, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { ArtifactReply, PassReply } from '@software-factory/contract'
import { admitted, tick } from '../flow.ts'
import { factory, type ServerProcess, type World } from '../harness.ts'
import { type Lab, startLab } from '../planning/lab.ts'

/**
 * The Spec checkpoint, against the real server and Postgres: an Issue filed with `--checkpoint spec` cannot ship until its
 * lead has submitted a Spec, and a Spec nobody answered in 24 hours lets the lead go on with its defaults, so the queue
 * never waits on the owner. Time moves by back-dating the facts in their own tables.
 */
/** A repo holds one lead at a time, so each Issue gets its own. */
const REPOS = ['example-spec-gate', 'example-spec-plain']
let lab: Lab
let world: World
let server: ServerProcess
let dir: string

beforeAll(async () => {
  dir = await mkdtemp('/tmp/factory-spec-checkpoint-')
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

const body = (value: unknown): string[] => ['--body', JSON.stringify(value)]
const stateOf = async (issue: string): Promise<string> => {
  const [row]: { state: string }[] = await world.db.sql`SELECT state FROM factory.issues WHERE id = ${issue}`
  return row?.state ?? 'missing'
}

/** An Issue filed with the checkpoint, admitted, its lead working. */
async function flagged(repo: string, title: string, checkpoint: string | null = 'spec'): Promise<string> {
  const args = ['issue', 'new', '--repo', repo, '--title', title, '--key', `spec-gate-${title}`]
  if (checkpoint) args.push('--checkpoint', checkpoint)
  const filed = await cli(...args)
  expect(filed.code).toBe(0)
  const issue = (filed.json as { issue: string }).issue
  await admitted(lab, issue)
  await tick(lab)
  return issue
}

const SHIP = (call: string) => body({ attempt: 1, call, commits: ['a'.repeat(40)] })

test('a flagged Issue cannot ship without a Spec; a Spec nobody answers in a day lets the lead go on; the ship is then judged on its commits', async () => {
  const issue = await flagged('example-spec-gate', 'a new public route')
  const [filed]: { checkpoint: string | null }[] = await world.db.sql`
    SELECT payload->>'checkpoint' AS checkpoint FROM factory.issue_events WHERE issue_id = ${issue} AND kind = 'filed'`
  expect(filed?.checkpoint).toBe('spec')

  // no Spec: the ship is refused before git is read
  const refused = await cli('issue', 'ship', issue, ...SHIP('ship-1'))
  expect(refused.code).not.toBe(0)
  expect(refused.err).toContain('checkpoint `spec`')
  expect(refused.err).toContain('no Spec was submitted')
  expect(await stateOf(issue)).toBe('working')

  // the lead hands over a Spec and waits for the verdict; the ship still has nothing to do while it waits
  const submitted = await ok(
    (json) => ArtifactReply.parse(json),
    'artifact',
    'submit',
    issue,
    ...body({ attempt: 1, kind: 'spec', title: 'The route spec', content: '# Route\n\nThree open choices.' }),
  )
  expect(submitted.issue).toMatchObject({ state: 'waiting', waitReason: 'review' })

  // 23 hours: the owner may still answer
  await backdate(issue, 23)
  expect((await pass()).reviews).toEqual([])
  expect(await stateOf(issue)).toBe('waiting')

  // past the wait: the factory records the verdict for the lead, who goes on with its defaults
  await backdate(issue, 2)
  expect((await pass()).reviews).toEqual([{ artifact: submitted.artifact.id, outcome: 'defaulted' }])
  expect(await stateOf(issue)).toBe('working')
  const [verdict]: { verdict: string; note: string }[] = await world.db.sql`
    SELECT verdict, note FROM factory.verdicts WHERE artifact_id = ${submitted.artifact.id}`
  expect(verdict?.verdict).toBe('looks_good')
  expect(verdict?.note).toContain('no verdict in 24 hours')
  const [counted]: { n: number }[] = await world.db.sql`
    SELECT count(*)::int AS n FROM factory.issue_effects WHERE issue_id = ${issue} AND kind = 'note_lead'`
  expect(counted?.n).toBe(1)

  // the Spec gate is behind it: the ship is now refused for the commit it names, not for a missing Spec
  const after = await cli('issue', 'ship', issue, ...SHIP('ship-2'))
  expect(after.err).not.toContain('no Spec was submitted')
})

test('an Issue filed without the checkpoint is never held to a Spec', async () => {
  const issue = await flagged('example-spec-plain', 'a small fix', null)
  const run = await cli('issue', 'ship', issue, ...SHIP('ship-1'))
  expect(run.err).not.toContain('no Spec was submitted')
})

test('the checkpoint is a word the filer cannot misspell', async () => {
  const run = await cli(
    'issue',
    'new',
    '--repo',
    'example-spec-gate',
    '--title',
    'bad checkpoint',
    '--checkpoint',
    'concept',
  )
  expect(run.code).not.toBe(0)
})

async function pass() {
  return ok((json) => PassReply.parse(json), 'checkpoint', 'pass')
}

/** Everything about an Issue and its checkpoints happened `hours` hours ago. */
async function backdate(issueId: string, hours: number): Promise<void> {
  const { sql } = world.db
  const ago = `${hours} hours`
  await sql`UPDATE factory.issue_events SET at = at - ${ago}::interval WHERE issue_id = ${issueId}`
  await sql`
    UPDATE factory.artifact_revisions SET created_at = created_at - ${ago}::interval
    WHERE artifact_id IN (SELECT id FROM factory.artifacts WHERE issue_id = ${issueId})`
  await sql`UPDATE factory.artifacts SET created_at = created_at - ${ago}::interval WHERE issue_id = ${issueId}`
}
