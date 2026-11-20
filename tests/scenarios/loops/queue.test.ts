import { afterAll, beforeAll, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { ChainModel } from '@software-factory/contract'
import { fileIssue, must, settle } from '../flow.ts'
import { type Lab, startLab } from '../planning/lab.ts'
import { callsOf, loops, runLoop, script } from './support.ts'

/**
 * The queue loop against the real server and Postgres with the fake agw: a repo's queued Issues are filed through the
 * routes, `factory-queue` is scripted per repo (`"repo":"<name>"` in its input), and every pass is driven through
 * `factory loop run queue` (the intervals are off).
 */
let lab: Lab
let dir: string
let queueScript: string
const REPOS = ['q1', 'q2', 'q3', 'q4', 'q5', 'q6', 'q7', 'q8', 'q9', 'q10', 'q11', 'q12', 'q13', 'q14', 'q15', 'q16']

beforeAll(async () => {
  dir = await mkdtemp('/tmp/factory-queue-')
  queueScript = join(dir, 'queue.json')
  await script(queueScript, [])
  lab = await startLab({
    leads: true,
    repos: Object.fromEntries(REPOS.map((r) => [r, { project: `apiVersion: factory/v2\nname: ${r}\nleads: 8\n` }])),
    env: { FACTORY_QUEUE_GAP_MS: '3600000', FACTORY_FAKE_QUEUE_SCRIPT: queueScript },
  })
  expect((await lab.cli(['project', 'sync'])).code).toBe(0)
})

afterAll(async () => {
  await lab.stop()
  await rm(dir, { recursive: true, force: true })
})

const sql = () => lab.world.db.sql

const queued = async (repo: string, title: string, after: string[] = []): Promise<string> => {
  const issue = await fileIssue(lab, { repo, title })
  await settle(lab, issue, after)
  return issue
}

const answers = (repo: string, edges: [string, string][], order: string[] = []) =>
  script(queueScript, [
    {
      match: `"repo":"${repo}"`,
      answer: {
        edges: edges.map(([issue, after]) => ({ issue, after, reason: 'the same files' })),
        order,
        reason: 'scripted',
      },
    },
  ])

const asksFor = async (repo: string) => (await callsOf(lab, 'factory-queue')).filter((c) => c.input.repo === repo)

const edgesOf = async (repo: string): Promise<string[]> =>
  (
    await sql()`SELECT e.issue_id, e.after_issue FROM factory.planning_edges e JOIN factory.issues i ON i.id = e.issue_id
      WHERE i.repo = ${repo} ORDER BY e.issue_id, e.after_issue`
  ).map((e: { issue_id: string; after_issue: string }) => `${e.issue_id}>${e.after_issue}`)

const json = <T>(value: unknown): T => (typeof value === 'string' ? (JSON.parse(value) as T) : (value as T))

interface Ask {
  key: string
  outcome: string | null
  answer: { order: string[] } | null
  applied: { issue: string; after: string }[] | null
  refused: { issue: string; after: string; why: string }[] | null
  after_shape: string | null
}

const asksRecorded = async (repo: string): Promise<Ask[]> => {
  const rows: Record<string, unknown>[] =
    await sql()`SELECT * FROM factory.queue_asks WHERE repo = ${repo} ORDER BY round`
  return rows.map((row) => ({
    key: row.key as string,
    outcome: row.outcome as string | null,
    answer: json(row.answer),
    applied: json(row.applied),
    refused: json(row.refused),
    after_shape: row.after_shape as string | null,
  }))
}

test('two queued Issues: the scripted edge is applied, the ask is recorded, and no second pass or kick asks again', async () => {
  const a = await queued('q1', 'Rework the checkout summary')
  const b = await queued('q1', 'Add the coupon line to the checkout summary')
  await answers('q1', [[b, a]], [a, b])

  const ran = await runLoop(lab, 'queue')
  expect(ran.error).toBeNull()
  expect(ran.summary).toContain('asked 1, applied 1 edge(s)')
  expect(await edgesOf('q1')).toEqual([`${b}>${a}`])

  const chain = ChainModel.parse((await must(lab, ['read', 'chain'])).json)
  expect(chain.blocking[b]).toEqual([a])
  expect(chain.blocking[a] ?? []).toEqual([])

  const [ask] = await asksFor('q1')
  expect(ask?.input.issues).toHaveLength(2)
  const [recorded] = await asksRecorded('q1')
  expect(recorded).toMatchObject({ outcome: 'answered', applied: [{ issue: b, after: a }], refused: [] })
  expect(recorded?.after_shape).toMatch(/^[0-9a-f]{16}$/)
  expect(recorded?.answer?.order).toEqual([a, b])

  await runLoop(lab, 'queue')
  await Bun.sleep(300)
  expect(await asksFor('q1')).toHaveLength(1)
  const queue = (await loops(lab)).find((loop) => loop.name === 'queue')
  expect(queue?.runs).toBeGreaterThanOrEqual(2)
  expect(await asksFor('q1')).toHaveLength(1)
})

test('one Issue that waits for nothing leaves nothing to order: no call', async () => {
  await queued('q2', 'The only queued Issue')
  const ran = await runLoop(lab, 'queue')
  expect(ran.error).toBeNull()
  expect(await asksFor('q2')).toHaveLength(0)
  expect(await asksRecorded('q2')).toHaveLength(0)
})

test('an edge that would close a cycle is refused and the other edge of the answer still applies', async () => {
  const a = await queued('q3', 'Cycle first')
  const b = await queued('q3', 'Cycle second', [a])
  const c = await queued('q3', 'Cycle third')
  await answers('q3', [
    [a, b],
    [c, a],
  ])

  const ran = await runLoop(lab, 'queue')
  expect(ran.summary).toContain('applied 1 edge(s), refused 1')
  expect(await edgesOf('q3')).toEqual([`${b}>${a}`, `${c}>${a}`].sort())
  const [recorded] = await asksRecorded('q3')
  expect(recorded?.applied).toMatchObject([{ issue: c, after: a }])
  expect(recorded?.refused).toMatchObject([{ issue: a, after: b, why: 'planning: cycle' }])
})

test('an edge against the owner’s priority is refused', async () => {
  const a = await queued('q4', 'Ranked high')
  const b = await queued('q4', 'Ranked low')
  const c = await queued('q4', 'Ranked even')
  await must(lab, ['issue', 'prio', a, '5'])
  await answers('q4', [
    [a, b],
    [c, b],
  ])

  const ran = await runLoop(lab, 'queue')
  expect(ran.summary).toContain('applied 1 edge(s), refused 1')
  expect(await edgesOf('q4')).toEqual([`${c}>${b}`])
  const [recorded] = await asksRecorded('q4')
  expect(recorded?.refused).toMatchObject([{ issue: a, after: b, why: 'against the owner’s priority' }])
})

test('an edge naming an Issue that was not shown is refused', async () => {
  const other = await queued('q9', 'Lives in another repo')
  const a = await queued('q5', 'Shown first')
  const b = await queued('q5', 'Shown second')
  await answers('q5', [
    [b, 'issue_9999'],
    [b, other],
    [a, b],
  ])

  const ran = await runLoop(lab, 'queue')
  expect(ran.summary).toContain('applied 1 edge(s), refused 2')
  expect(await edgesOf('q5')).toEqual([`${a}>${b}`])
  const [recorded] = await asksRecorded('q5')
  expect(recorded?.refused?.map((r) => r.why)).toEqual([
    'the Issue to wait for was not shown',
    'the Issue to wait for was not shown',
  ])
})

test('budget: a changed shape inside the gap is not asked, after the gap it is', async () => {
  await queued('q6', 'Budget first')
  await queued('q6', 'Budget second')
  await answers('q6', [])
  expect((await runLoop(lab, 'queue')).summary).toContain('asked 1')
  expect(await asksFor('q6')).toHaveLength(1)

  await queued('q6', 'Budget third')
  const early = await runLoop(lab, 'queue')
  expect(early.summary).toContain('asked 0')
  expect(early.summary).toContain('skipped for budget 1')
  expect(await asksFor('q6')).toHaveLength(1)

  await sql()`UPDATE factory.queue_asks SET claimed_at = claimed_at - interval '2 hours' WHERE repo = 'q6'`
  expect((await runLoop(lab, 'queue')).summary).toContain('asked 1')
  expect(await asksFor('q6')).toHaveLength(2)
})

test('an agw answer that does not parse is recorded as failed and retried only after the retry window', async () => {
  const a = await queued('q7', 'Failing first')
  const b = await queued('q7', 'Failing second')
  await script(queueScript, [{ match: '"repo":"q7"', answer: { edges: 'none' } }])

  const first = await runLoop(lab, 'queue')
  expect(first.summary).toContain('asked 1')
  expect(first.summary).toContain('1 problem(s)')
  expect((await asksRecorded('q7')).map((r) => r.outcome)).toEqual(['failed'])

  await runLoop(lab, 'queue')
  expect(await asksFor('q7')).toHaveLength(1)

  await answers('q7', [[b, a]])
  await sql()`UPDATE factory.queue_asks
    SET claimed_at = claimed_at - interval '20 minutes', lease_until = lease_until - interval '20 minutes',
        finished_at = finished_at - interval '20 minutes'
    WHERE repo = 'q7'`
  const retried = await runLoop(lab, 'queue')
  expect(retried.summary).toContain('applied 1 edge(s)')
  expect(await asksFor('q7')).toHaveLength(2)
  expect((await asksRecorded('q7')).map((r) => r.outcome)).toEqual(['failed', 'answered'])
  expect(await edgesOf('q7')).toEqual([`${b}>${a}`])
})

test('a queue ask that fails or answers unavailable is not an asked shape: the shape is asked again once the retry window has passed', async () => {
  const a = await queued('q16', 'Unavailable first')
  const b = await queued('q16', 'Unavailable second')
  const aged = () => sql()`UPDATE factory.queue_asks
    SET claimed_at = claimed_at - interval '20 minutes', lease_until = lease_until - interval '20 minutes',
        finished_at = finished_at - interval '20 minutes'
    WHERE repo = 'q16'`

  await script(queueScript, [{ match: '"repo":"q16"', fail: true }])
  expect((await runLoop(lab, 'queue')).summary).toContain('asked 1')
  expect((await asksRecorded('q16')).map((r) => r.outcome)).toEqual(['failed'])

  // agw answers the empty answer, with its reason: queue unavailable
  await aged()
  await script(queueScript, [
    { match: '"repo":"q16"', answer: { edges: [], order: [], reason: 'queue unavailable: timeout' } },
  ])
  const unavailable = await runLoop(lab, 'queue')
  expect(unavailable.summary).toContain('asked 1')
  expect(unavailable.summary).toContain('1 problem(s)')
  expect((await asksRecorded('q16')).map((r) => r.outcome)).toEqual(['failed', 'failed'])
  expect(await edgesOf('q16')).toEqual([])

  // the same shape is asked once more on the next pass after the window, and the answer then counts
  await aged()
  await answers('q16', [[b, a]], [a, b])
  expect((await runLoop(lab, 'queue')).summary).toContain('applied 1 edge(s)')
  expect((await asksRecorded('q16')).map((r) => r.outcome)).toEqual(['failed', 'failed', 'answered'])
  expect(await asksFor('q16')).toHaveLength(3)
  expect(await edgesOf('q16')).toEqual([`${b}>${a}`])
})

test('an answer stored but not applied (a crash in between) is applied on the next pass without a second call', async () => {
  const a = await queued('q8', 'Crash first')
  const b = await queued('q8', 'Crash second')
  await answers('q8', [[b, a]])
  await runLoop(lab, 'queue')
  expect(await edgesOf('q8')).toEqual([`${b}>${a}`])

  await sql()`DELETE FROM factory.planning_edges WHERE issue_id = ${b}`
  await sql()`UPDATE factory.queue_asks SET applied = NULL, refused = NULL, after_shape = NULL WHERE repo = 'q8'`
  const ran = await runLoop(lab, 'queue')
  expect(ran.summary).toContain('asked 0, applied 1 edge(s)')
  expect(await edgesOf('q8')).toEqual([`${b}>${a}`])
  expect(await asksFor('q8')).toHaveLength(1)
  expect((await asksRecorded('q8'))[0]?.applied).toMatchObject([{ issue: b, after: a }])
})

test('a cycle already in the data: no ask, and the problem names the path', async () => {
  const repo = 'q9'
  const a = await queued(repo, 'Loop first')
  const b = await queued(repo, 'Loop second')
  await queued(repo, 'Loop third')
  await sql()`INSERT INTO factory.planning_edges (issue_id, after_issue, created_at) VALUES (${a}, ${b}, now()), (${b}, ${a}, now())`
  const before = (await asksFor(repo)).length

  const ran = await runLoop(lab, 'queue')
  expect(ran.error).toBeNull()
  expect(ran.summary).toContain('the chain has a cycle')
  expect(ran.summary).toMatch(/issue_\d+ -> issue_\d+ -> issue_\d+/)
  expect((await asksFor(repo)).length).toBe(before)
})

// ---- the sweep and the edge measure ---------------------------------------------------------------------------------------

/** What an accepted ship leaves as evidence: the paths its commits touched. */
const shipped = async (issue: string, paths: string[]): Promise<void> => {
  const payload = JSON.stringify({ commits: [], landedAt: null, mergedAt: null, deploys: true, paths })
  await sql()`
    INSERT INTO factory.quality_evidence (id, issue_id, attempt, source_key, kind, at, payload)
    VALUES (${`evidence-${issue}`}, ${issue}, 1, ${`ship-${issue}`}, 'commits', now(), ${payload}::text::jsonb)`
}

/** An edge the factory added, as the queue loop or triage leaves it. */
const inferred = (issue: string, after: string, by = 'queue: the same files') =>
  sql()`INSERT INTO factory.planning_edges (issue_id, after_issue, created_at, inferred_by) VALUES (${issue}, ${after}, now(), ${by})`

const removalsOf = (repo: string) =>
  sql()`SELECT r.issue_id, r.after_issue, r.kind, r.reason, r.inferred_by FROM factory.queue_edge_removals r
    JOIN factory.issues i ON i.id = r.issue_id WHERE i.repo = ${repo}` as Promise<
    { issue_id: string; after_issue: string; kind: string; reason: string; inferred_by: string }[]
  >

const notesOf = async (issue: string): Promise<string[]> =>
  (
    await sql()`SELECT payload->>'text' AS text FROM factory.issue_events WHERE issue_id = ${issue} AND kind = 'noted' ORDER BY version`
  ).map((r: { text: string }) => r.text)

test('a factory-added edge between Issues with disjoint files is taken back with its reason, and both Issues are candidates', async () => {
  const a = await queued('q10', 'Rework the pricing table')
  const b = await queued('q10', 'Add the changelog page')
  await inferred(b, a)
  await shipped(a, ['apps/web/pricing.ts', 'docs/plan.yaml'])
  await shipped(b, ['apps/web/changelog.ts', 'docs/plan.yaml'])
  await answers('q10', [], [b, a])

  const ran = await runLoop(lab, 'queue')
  expect(ran.error).toBeNull()
  expect(ran.summary).toContain('took back 1')
  expect(await edgesOf('q10')).toEqual([])
  const [removal] = await removalsOf('q10')
  expect(removal).toMatchObject({ issue_id: b, after_issue: a, kind: 'disjoint', inferred_by: 'queue: the same files' })
  expect(removal?.reason).toContain('disjoint')
  expect((await notesOf(b)).some((text) => text.includes('took back the edge') && text.includes('disjoint'))).toBe(true)

  const chain = ChainModel.parse((await must(lab, ['read', 'chain'])).json)
  expect(chain.blocking[b] ?? []).toEqual([])
  expect((await asksFor('q10')).length).toBe(1)
})

test('an edge whose Issues share a file is kept', async () => {
  const a = await queued('q11', 'Change the checkout')
  const b = await queued('q11', 'Also change the checkout')
  await inferred(b, a)
  await shipped(a, ['apps/web/checkout.ts'])
  await shipped(b, ['apps/web/checkout.ts', 'apps/web/coupon.ts'])
  await answers('q11', [], [])

  await runLoop(lab, 'queue')
  expect(await edgesOf('q11')).toEqual([`${b}>${a}`])
  expect(await removalsOf('q11')).toEqual([])
})

test('evidence cut at the sample cap says nothing of the files: the edge stays', async () => {
  const a = await queued('q15', 'Large change one')
  const b = await queued('q15', 'Large change two')
  await inferred(b, a)
  await shipped(
    a,
    Array.from({ length: 100 }, (_, n) => `one/${n}.ts`),
  )
  await shipped(b, ['two/only.ts'])
  await answers('q15', [], [])

  await runLoop(lab, 'queue')
  expect(await edgesOf('q15')).toEqual([`${b}>${a}`])
  expect(await removalsOf('q15')).toEqual([])
})

test('an edge the owner or a filer stated is never taken back, whatever the files say', async () => {
  const a = await queued('q12', 'The stated blocker')
  const b = await queued('q12', 'Waits because it was told to', [a])
  await shipped(a, ['apps/web/a.ts'])
  await shipped(b, ['apps/web/b.ts'])
  await sql()`UPDATE factory.issues SET state = 'waiting', wait_reason = 'decision' WHERE id = ${a}`
  await sql()`UPDATE factory.issue_events SET at = at - interval '48 hours' WHERE issue_id = ${a}`
  await answers('q12', [], [])

  const ran = await runLoop(lab, 'queue')
  expect(ran.summary).toContain('took back 0')
  expect(await edgesOf('q12')).toEqual([`${b}>${a}`])
  expect(await removalsOf('q12')).toEqual([])
})

test('an edge behind a blocker that has waited on the owner for hours is taken back; one that waited briefly is kept', async () => {
  const a = await queued('q13', 'Waits on a Decision')
  const b = await queued('q13', 'Held behind it')
  const c = await queued('q13', 'Waits on a Decision just now')
  const d = await queued('q13', 'Held behind the second')
  await inferred(b, a)
  await inferred(d, c)
  await sql()`UPDATE factory.issues SET state = 'waiting', wait_reason = 'decision' WHERE id IN (${a}, ${c})`
  await sql()`UPDATE factory.issue_events SET at = at - interval '8 hours' WHERE issue_id = ${a}`
  await answers('q13', [], [])

  const ran = await runLoop(lab, 'queue')
  expect(ran.summary).toContain('took back 1')
  expect(await edgesOf('q13')).toEqual([`${d}>${c}`])
  const [removal] = await removalsOf('q13')
  expect(removal).toMatchObject({ issue_id: b, after_issue: a, kind: 'owner_wait' })
  expect(removal?.reason).toContain('waited on the owner')
})

test('the capacity-loop read reports the share of factory-added edges that were not needed', async () => {
  const model = (await must(lab, ['read', 'capacity-loop', '--days', '7'])).json as {
    edges: {
      notNeededShare: number | null
      bySource: {
        source: string
        added: number
        needed: number
        notNeeded: number
        removed: number
        stopped: boolean
      }[]
    }
  }
  const queue = model.edges.bySource.find((s) => s.source === 'queue')
  // q10's edge was taken back with disjoint files (not needed), q11's was kept with a shared file (needed); the rest shipped nothing
  expect(queue).toMatchObject({ needed: 1, notNeeded: 1, removed: 2, stopped: false })
  expect(queue?.added).toBeGreaterThanOrEqual(4)
  expect(model.edges.notNeededShare).toBe(0.5)
})

test('a source whose measured edges were mostly not needed gets no more edges from the loop', async () => {
  // twelve pairs that shipped disjoint files and whose edge the queue loop had added: the kind is mostly not needed
  for (let n = 0; n < 12; n++) {
    const issue = `issue_${9000 + 2 * n}`
    const after = `issue_${9001 + 2 * n}`
    for (const id of [issue, after]) {
      await sql()`INSERT INTO factory.issues (id, repo, state, outcome, version) VALUES (${id}, 'history', 'closed', 'done', 2)`
      await shipped(id, [`history/${id}.ts`])
    }
    await sql()`INSERT INTO factory.planning_edges (issue_id, after_issue, created_at, satisfied_at, inferred_by)
      VALUES (${issue}, ${after}, now(), now(), 'queue: guessed the same files')`
  }
  const a = await queued('q14', 'Stopped first')
  const b = await queued('q14', 'Stopped second')
  await answers('q14', [[b, a]], [a, b])

  const ran = await runLoop(lab, 'queue')
  expect(ran.summary).toContain('applied 0 edge(s), refused 1')
  expect(await edgesOf('q14')).toEqual([])
  const [recorded] = await asksRecorded('q14')
  expect(recorded?.refused?.[0]?.why).toContain('mostly not needed')
  const model = (await must(lab, ['read', 'capacity-loop', '--days', '7'])).json as {
    edges: { bySource: { source: string; stopped: boolean }[] }
  }
  expect(model.edges.bySource.find((s) => s.source === 'queue')?.stopped).toBe(true)
  // the model's order is still stored: it is the tie-break of the admission order
  expect(recorded?.answer?.order).toEqual([a, b])
})
