import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { SQL } from 'bun'
import { fileIssue, must, run, settle, stateOf } from '../flow.ts'
import { type ServerProcess, startServer, startWorldOn, type World } from '../harness.ts'

/**
 * The cutover rehearsal's scenarios: the real server on a copy of the live data after the import (`scripts/rehearse.ts`
 * sets REHEARSAL_DATABASE_URL). Without it the file is skipped, so `make check` never needs the live data.
 */
const url = process.env.REHEARSAL_DATABASE_URL
const enabled = Boolean(url)
setDefaultTimeout(60_000)

let world: World
let server: ServerProcess
let sql: SQL
let root = ''
const REPO = 'software-factory'

const flow = () => ({ world, server })

beforeAll(async () => {
  if (!url) return
  sql = new SQL(url, { max: 2 })
  world = await startWorldOn({ url, sql, stop: async () => {} })
  root = await mkdtemp('/tmp/factory-cutover-roots-')
  await mkdir(join(root, REPO))
  server = await startServer(world, {
    env: {
      HOME: process.env.HOME ?? '/tmp',
      FACTORY_REPO_ROOTS: root,
      ...(process.env.REHEARSAL_DATA_DIR ? { FACTORY_DATA_DIR: process.env.REHEARSAL_DATA_DIR } : {}),
    },
  })
})

afterAll(async () => {
  if (!url) return
  await server.stop()
  await sql.close()
  await rm(root, { recursive: true, force: true })
})

const imported = async (): Promise<{ n: number; maxNumber: number }> => {
  const [row] =
    (await sql`SELECT count(*)::int AS n, COALESCE(max(legacy_id), 0)::int AS max FROM factory.import_issues`) as {
      n: number
      max: number
    }[]
  return { n: row?.n ?? 0, maxNumber: row?.max ?? 0 }
}

describe.skipIf(!enabled)('the new core on the imported data', () => {
  test('it is healthy, and the read API shows every imported Issue', async () => {
    const health = await must(flow(), ['health', 'get'])
    expect((health.json as { status: string }).status).toBe('ok')
    const { n } = await imported()
    expect(n).toBeGreaterThan(0)
    const list = await must(flow(), ['read', 'issues', '--state', 'all', '--limit', '500'])
    const issues = (list.json as { issues: unknown[] }).issues
    expect(issues.length).toBeGreaterThanOrEqual(n)
  })

  test('an imported Issue answers by its old number, with the state the old core left it in', async () => {
    const [closed] = (await sql`
      SELECT i.id, i.outcome FROM factory.issues i JOIN factory.import_issues m ON m.issue_id = i.id
      WHERE i.state = 'closed' AND i.outcome = 'done' ORDER BY i.id DESC LIMIT 1`) as { id: string; outcome: string }[]
    expect(closed).toBeDefined()
    if (!closed) return
    const number = closed.id.slice('issue_'.length)
    const shown = await must(flow(), ['issue', 'show', number])
    expect(JSON.stringify(shown.json)).toContain(closed.id)
    expect(await stateOf(world, closed.id)).toMatchObject({ state: 'closed', outcome: 'done' })
  })

  test('a new Issue takes a number past every old one, settles and queues', async () => {
    const { maxNumber } = await imported()
    const id = await fileIssue(flow(), { repo: REPO, title: 'rehearsal: a new Issue after the import' })
    expect(Number(id.slice('issue_'.length))).toBeGreaterThan(maxNumber)
    await settle(flow(), id)
    expect((await stateOf(world, id)).state).toBe('queued')
  })

  test('the owner reopens an imported closed Issue within 30 days, then cancels it; the old record stays', async () => {
    const [row] = (await sql`
      SELECT i.id FROM factory.issues i JOIN factory.import_issues m ON m.issue_id = i.id
      WHERE i.state = 'closed' AND i.id NOT IN (SELECT issue_id FROM factory.issue_events WHERE kind = 'reopened')
        AND (SELECT max(at) FROM factory.issue_events e WHERE e.issue_id = i.id) > now() - interval '25 days'
      ORDER BY i.id DESC LIMIT 1`) as { id: string }[]
    expect(row).toBeDefined()
    if (!row) return
    const before =
      (
        (await sql`SELECT count(*)::int AS n FROM factory.issue_events WHERE issue_id = ${row.id}`) as { n: number }[]
      )[0]?.n ?? 0
    const reopened = await must(flow(), [
      'issue',
      'reopen',
      row.id,
      '--reason',
      'rehearsal',
      '--call',
      'rehearsal-reopen',
    ])
    expect(reopened.code).toBe(0)
    expect((await stateOf(world, row.id)).state).toBe('queued')
    await must(flow(), ['issue', 'cancel', row.id, '--reason', 'rehearsal', '--call', 'rehearsal-cancel'])
    expect(await stateOf(world, row.id)).toMatchObject({ state: 'closed', outcome: 'cancelled' })
    const after =
      (
        (await sql`SELECT count(*)::int AS n FROM factory.issue_events WHERE issue_id = ${row.id}`) as { n: number }[]
      )[0]?.n ?? 0
    expect(after).toBeGreaterThan(before)
  })

  test('a note on a closed imported Issue is refused', async () => {
    const [row] = (await sql`
      SELECT i.id FROM factory.issues i JOIN factory.import_issues m ON m.issue_id = i.id WHERE i.state = 'closed' ORDER BY i.id LIMIT 1`) as {
      id: string
    }[]
    if (!row) return
    const refused = await run(flow(), ['issue', 'note', row.id, 'too late', '--call', 'rehearsal-note'])
    expect(refused.code).not.toBe(0)
  })

  test('the imported Decisions are in the ledger, each with a readable form', async () => {
    const [count] = (await sql`SELECT count(*)::int AS n FROM factory.decisions WHERE id LIKE 'decision_legacy-%'`) as {
      n: number
    }[]
    if (!count || count.n === 0) return
    const [one] =
      (await sql`SELECT id FROM factory.decisions WHERE id LIKE 'decision_legacy-%' ORDER BY id LIMIT 1`) as {
        id: string
      }[]
    const shown = await must(flow(), ['artifact', 'show', one?.id ?? ''])
    expect(JSON.stringify(shown.json)).toContain('imported from the old core')
  })

  test('the door keeps its routes', async () => {
    const routes = await must(flow(), ['door', 'routes'])
    const [row] = (await sql`SELECT count(*)::int AS n FROM factory.intake_door_routes`) as { n: number }[]
    expect(JSON.stringify(routes.json).length).toBeGreaterThan(2)
    expect(row?.n ?? 0).toBeGreaterThan(0)
  })

  test('the loops answer on demand against the imported data, and nothing starts a lead', async () => {
    for (const name of ['planning', 'steward', 'triage']) {
      const reply = await must(flow(), ['loop', 'run', name])
      expect(JSON.stringify(reply.json)).not.toContain('"error":"')
    }
    const [leads] = (await sql`SELECT count(*)::int AS n FROM factory.lead_attempts`) as { n: number }[]
    expect(leads?.n ?? 0).toBe(0)
  })
})
