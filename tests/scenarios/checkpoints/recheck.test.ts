import { afterAll, beforeAll, expect, test } from 'bun:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { AskReply, DecisionView, ErrandReply, PassReply } from '@software-factory/contract'
import { admitted, fileIssue, tick } from '../flow.ts'
import { factory, type ServerProcess, type World } from '../harness.ts'
import { type Lab, startLab } from '../planning/lab.ts'

/**
 * A checkpoint that stayed in front of the owner past `FACTORY_CHECKPOINT_RECHECK_MS` (the 6 h default here) is looked at
 * once more, against the real server and Postgres with the fake agw. Time moves by back-dating the facts in their own
 * tables, the Issue's events with them, so what happens after is a new event.
 */
let lab: Lab
let world: World
let server: ServerProcess
let dir: string
let judgeScript: string
let issues = 0

const PROJECTS = ['closed', 'settled', 'kept', 'fresh'].map((name) => `example-recheck-${name}`)

beforeAll(async () => {
  dir = await mkdtemp('/tmp/factory-recheck-')
  judgeScript = join(dir, 'judge.json')
  await writeFile(judgeScript, '[]')
  lab = await startLab({
    leads: true,
    repos: Object.fromEntries(PROJECTS.map((name) => [name, { project: `apiVersion: factory/v2\nname: ${name}\n` }])),
    env: {
      FACTORY_LEADS_PER_ACCOUNT: '16',
      FACTORY_DATA_DIR: join(dir, 'data'),
      FACTORY_FAKE_ASK_SCRIPT: judgeScript,
    },
  })
  world = lab.world
  server = lab.server
  expect((await lab.cli(['project', 'sync'])).code).toBe(0)
})

afterAll(async () => {
  await lab.stop()
  await rm(dir, { recursive: true, force: true })
})

async function workingIssue(repo: string): Promise<string> {
  const issue = await fileIssue(lab, { repo, title: `recheck scenario issue ${++issues}` })
  await admitted(lab, issue)
  await tick(lab)
  return issue
}

async function cli(...args: string[]) {
  const run = await factory(world, [...args, '--format', 'json'], { FACTORY_URL: server.url })
  return { ...run, json: run.out.trim() ? (JSON.parse(run.out) as unknown) : null }
}

const body = (value: unknown): string[] => ['--body', JSON.stringify(value)]

async function ok<T>(parse: (json: unknown) => T, ...args: string[]): Promise<T> {
  const run = await cli(...args)
  if (run.code !== 0) throw new Error(`factory ${args.join(' ')} exited ${run.code}: ${run.err}`)
  return parse(run.json)
}

async function askCalls(): Promise<{ stdin: string }[]> {
  const lines = (await readFile(join(world.bin, 'calls.jsonl'), 'utf8')).split('\n').filter(Boolean)
  return lines
    .map((line) => JSON.parse(line) as { tool: string; args: string[]; stdin?: string })
    .filter((call) => call.args[0] === 'factory-ask')
    .map((call) => ({ stdin: call.stdin ?? '' }))
}

const pass = () => ok((json) => PassReply.parse(json), 'checkpoint', 'pass')

const FORM = (question: string) => ({
  attempt: 1,
  question,
  recommendation: 'pino',
  checked: 'Read the package sizes and the Bun notes.',
  options: [
    { label: 'pino', reversible: true, cost: 'one dependency, fast' },
    { label: 'winston', reversible: true, cost: 'heavier, more transports' },
  ],
  noAnswer: { consequence: 'The lead logs with console until someone answers.' },
})

/** Asks a Decision the Judge passes on and lets the pass bring it to the owner. */
async function atOwner(repo: string, question: string): Promise<{ issueId: string; id: string }> {
  const issueId = await workingIssue(repo)
  const asked = await ok((json) => AskReply.parse(json), 'issue', 'ask', issueId, ...body(FORM(question)))
  const passed = await pass()
  expect(passed.decisions).toContainEqual({ decision: asked.decision.id, status: 'open', settledBy: null })
  return { issueId, id: asked.decision.id }
}

/** Everything about an Issue and its checkpoints happened `hours` hours ago. */
async function backdate(issueId: string, hours: number): Promise<void> {
  const { sql } = world.db
  const ago = `${hours} hours`
  await sql`UPDATE factory.issue_events SET at = at - ${ago}::interval WHERE issue_id = ${issueId}`
  await sql`UPDATE factory.decisions SET asked_at = asked_at - ${ago}::interval WHERE issue_id = ${issueId}`
  await sql`
    UPDATE factory.decision_steps SET at = at - ${ago}::interval
    WHERE at IS NOT NULL AND decision_id IN (SELECT id FROM factory.decisions WHERE issue_id = ${issueId})`
  await sql`
    UPDATE factory.errands SET raised_at = raised_at - ${ago}::interval,
      reached_owner_at = reached_owner_at - ${ago}::interval
    WHERE issue_id = ${issueId}`
}

async function rechecks(
  checkpoint: string,
): Promise<{ outcome: string; by: string; reason: string; version: number }[]> {
  const rows: { outcome: string; by: string; reason: string; through_version: number }[] = await world.db.sql`
    SELECT outcome, by, reason, through_version FROM factory.checkpoint_rechecks
    WHERE checkpoint_id = ${checkpoint} ORDER BY through_version`
  return rows.map((row) => ({ outcome: row.outcome, by: row.by, reason: row.reason, version: row.through_version }))
}

/** The change stream's rows for a checkpoint's looks: what "Since you were here" reads. */
async function rechecked(checkpoint: string): Promise<{ kind: string; outcome: string }[]> {
  const rows: { kind: string; detail: Record<string, string> | string }[] = await world.db.sql`
    SELECT kind, detail FROM factory.changes WHERE subject = 'rechecked' ORDER BY seq`
  return rows
    .map((row) => ({ kind: row.kind, detail: typeof row.detail === 'string' ? JSON.parse(row.detail) : row.detail }))
    .filter((row) => row.detail[row.kind] === checkpoint)
    .map((row) => ({ kind: row.kind, outcome: row.detail.outcome as string }))
}

test('a stale Decision and a stale Errand whose Issue is closed are withdrawn with the reason, before the settle steps', async () => {
  const decided = await atOwner('example-recheck-closed', 'Which cache layer for the session store?')
  const errandIssue = await workingIssue('example-recheck-closed')
  const raised = await ok(
    (json) => ErrandReply.parse(json),
    'errand',
    'raise',
    errandIssue,
    ...body({ attempt: 1, summary: 'Approve the build in the portal', detail: 'Release > Build 42 > Approve' }),
  )
  expect((await pass()).errands).toEqual([{ errand: raised.errand.id, outcome: 'reached_owner' }])
  const calls = (await askCalls()).length

  // the Issues close after 7 hours at the owner; the recheck pass runs first, so it owns the reason
  await backdate(decided.issueId, 7)
  await backdate(errandIssue, 7)
  await cli('issue', 'cancel', decided.issueId, '--reason', 'not needed')
  await cli('issue', 'cancel', errandIssue, '--reason', 'not needed')
  const passed = await pass()
  expect(passed.rechecks).toEqual(
    expect.arrayContaining([
      { checkpoint: decided.id, kind: 'decision', outcome: 'withdrawn' },
      { checkpoint: raised.errand.id, kind: 'errand', outcome: 'withdrawn' },
    ]),
  )
  const shown = await ok((json) => DecisionView.parse(json), 'decision', 'show', decided.id)
  expect(shown).toMatchObject({ status: 'withdrawn', withdrawnReason: 'the Issue is closed' })
  const [done]: { done_note: string | null }[] = await world.db.sql`
    SELECT done_note FROM factory.errands WHERE id = ${raised.errand.id}`
  expect(done?.done_note).toBe('the Issue is closed')

  expect(await rechecks(decided.id)).toMatchObject([
    { outcome: 'withdrawn', by: 'factory', reason: 'the Issue is closed' },
  ])
  expect(await rechecks(raised.errand.id)).toMatchObject([{ outcome: 'withdrawn', by: 'factory' }])
  expect(await rechecked(decided.id)).toEqual([{ kind: 'decision', outcome: 'withdrawn' }])
  expect(await rechecked(raised.errand.id)).toEqual([{ kind: 'errand', outcome: 'withdrawn' }])
  // the Judge was never asked for them again
  expect(await askCalls()).toHaveLength(calls)
  // and a further pass finds nothing to do
  expect((await pass()).rechecks).toEqual([])
})

test('a stale Decision the Judge passed on is settled by it on the recheck once a note arrived, and the lead hears it', async () => {
  const { issueId, id } = await atOwner('example-recheck-settled', 'Which retention for the export files?')
  await backdate(issueId, 7)
  const before = (await askCalls()).length

  // no new event on the Issue: nothing is checked, and the Judge is not asked
  expect((await pass()).rechecks).toEqual([])
  expect(await askCalls()).toHaveLength(before)

  await ok((json) => json, 'issue', 'note', issueId, 'The export files are tiny: thirty days is plenty, take pino.')
  await writeFile(
    judgeScript,
    JSON.stringify([
      {
        match: 'retention for the export files',
        verdict: { verdict: 'answer', answer: 'pino', reason: 'the owner said so', source: "the owner's note" },
      },
    ]),
  )
  const passed = await pass()
  expect(passed.rechecks).toEqual([{ checkpoint: id, kind: 'decision', outcome: 'settled' }])
  expect(passed.decisions).toEqual([])

  const calls = await askCalls()
  expect(calls).toHaveLength(before + 1)
  const given = JSON.parse(calls.at(-1)?.stdin ?? '{}') as { checked: string }
  expect(given.checked).toContain('Read the package sizes and the Bun notes.')
  expect(given.checked).toContain('Rechecked after 6 h')
  expect(given.checked).toContain('The export files are tiny')

  expect(await ok((json) => DecisionView.parse(json), 'decision', 'show', id)).toMatchObject({
    status: 'answered',
    settledBy: 'judge',
    answer: 'pino',
  })
  const events: { kind: string; actor: string }[] = await world.db.sql`
    SELECT kind, actor FROM factory.issue_events WHERE issue_id = ${issueId} AND result = 'applied' ORDER BY version`
  expect(events.slice(-2)).toEqual([
    { kind: 'noted', actor: 'judge' },
    { kind: 'answered', actor: 'judge' },
  ])
  const effects: { kind: string }[] = await world.db.sql`
    SELECT kind FROM factory.issue_effects WHERE issue_id = ${issueId} ORDER BY position`
  expect(effects.map((effect) => effect.kind)).toContain('note_lead')
  expect(await rechecks(id)).toMatchObject([{ outcome: 'settled', by: 'judge', reason: 'the owner said so' }])
  expect(await rechecked(id)).toEqual([{ kind: 'decision', outcome: 'settled' }])
})

test('a stale Decision the Judge still passes on stays: kept once, and looked at again only after a new Issue event', async () => {
  const { issueId, id } = await atOwner('example-recheck-kept', 'Which colour for the status badge?')
  await backdate(issueId, 7)
  await ok((json) => json, 'issue', 'note', issueId, 'Pick whatever suits the console.')
  const before = (await askCalls()).length

  expect((await pass()).rechecks).toEqual([{ checkpoint: id, kind: 'decision', outcome: 'kept' }])
  expect(await askCalls()).toHaveLength(before + 1)
  const [first] = await rechecks(id)
  expect(first).toMatchObject({ outcome: 'kept', by: 'judge', reason: 'nothing scripted: a taste question' })
  expect(await ok((json) => DecisionView.parse(json), 'decision', 'show', id)).toMatchObject({ status: 'open' })

  // the same state, however often and however much later: no second call
  for (let i = 0; i < 2; i++) expect((await pass()).rechecks).toEqual([])
  await world.db.sql`UPDATE factory.checkpoint_rechecks SET at = at - interval '7 hours' WHERE checkpoint_id = ${id}`
  expect((await pass()).rechecks).toEqual([])
  expect(await askCalls()).toHaveLength(before + 1)

  // a new Issue event, and the wait since the last look run out: once more
  await ok((json) => json, 'issue', 'note', issueId, 'Actually, blue.')
  expect((await pass()).rechecks).toEqual([{ checkpoint: id, kind: 'decision', outcome: 'kept' }])
  expect(await askCalls()).toHaveLength(before + 2)
  const looks = await rechecks(id)
  expect(looks).toHaveLength(2)
  expect(looks[1]?.version).toBeGreaterThan(looks[0]?.version ?? 0)
  expect((await pass()).rechecks).toEqual([])
  expect(await askCalls()).toHaveLength(before + 2)
  expect(await rechecked(id)).toEqual([
    { kind: 'decision', outcome: 'kept' },
    { kind: 'decision', outcome: 'kept' },
  ])
})

test('a Decision below the threshold is not rechecked, new events or not', async () => {
  const { issueId, id } = await atOwner('example-recheck-fresh', 'Which font for the badge label?')
  await backdate(issueId, 5)
  await ok((json) => json, 'issue', 'note', issueId, 'Any font is fine.')
  const before = (await askCalls()).length
  expect((await pass()).rechecks).toEqual([])
  expect(await askCalls()).toHaveLength(before)
  expect(await rechecks(id)).toEqual([])
})
