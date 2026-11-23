import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { KpiModel } from '@software-factory/contract'
import { startTestCluster, type TestCluster } from '@software-factory/tests/pg'
import { fakeAgw } from '../support/agw.ts'
import { fileBlobStore } from '../../src/adapters/blobs/filesystem.ts'
import { postgresCheckpointStore } from '../../src/adapters/postgres/checkpoint-store.ts'
import { postgresErrandStore } from '../../src/adapters/postgres/errand-store.ts'
import { loadMigrations, migrate } from '../../src/adapters/postgres/migrate.ts'
import { postgresUnitOfWork } from '../../src/adapters/postgres/unit-of-work.ts'
import { postgresWorkStore } from '../../src/adapters/postgres/work-store.ts'
import { postgresQualityStore } from '../../src/adapters/quality/store.ts'
import { annotateArtifact, giveVerdict, submitArtifact } from '../../src/app/checkpoints.ts'
import type { PageDeps } from '../../src/app/checkpoints-pages.ts'
import { recheckReviews } from '../../src/app/checkpoints-reviews.ts'
import { routeSpecs } from '../../src/app/checkpoints-specs.ts'
import type { CheckpointLoopDeps } from '../../src/app/checkpoints-loop.ts'
import { fileIssue, recordIssueEvent } from '../../src/app/issues.ts'
import type { ArtifactId } from '../../src/domains/checkpoints/artifact.ts'
import {
  PLAN_REASON,
  replanBlockOf,
  routeSpecByRule,
  specPathOf,
  specSourceOf,
} from '../../src/domains/checkpoints/spec-path.ts'
import type { AnyIssueEvent } from '../../src/domains/work/events.ts'
import { readFriction } from '../../src/read/friction.ts'
import { readFrictionEvidence } from '../../src/read/friction-evidence.ts'
import { readKpis } from '../../src/read/kpis.ts'
import { readNeeds } from '../../src/read/needs.ts'
import { type FixedClock, fixedClock } from '../../src/kernel/clock.ts'
import { type IssueId, sequentialIds } from '../../src/kernel/ids.ts'
import { key } from '../../src/kernel/keys.ts'
import { ok, type Result } from '../../src/kernel/result.ts'

const ORIGIN = { replan: false, filedSpec: false, triaged: false, filedWithCheckpoint: false, gate: false }

describe('the rules', () => {
  test("a lead's Spec is its plan; four kinds are the owner's to read", () => {
    const path = (input: Partial<Parameters<typeof specPathOf>[0]>) =>
      specPathOf({ revision: 1, earlier: [], origin: ORIGIN, content: '# A Spec', ...input }).path
    // whoever made it owed, a lead's Spec does not wait: the filer's checkpoint, triage, or the lead itself
    expect(path({})).toBe('plan')
    expect(path({ origin: { ...ORIGIN, filedWithCheckpoint: true } })).toBe('plan')
    expect(path({ origin: { ...ORIGIN, triaged: true } })).toBe('plan')
    expect(path({ revision: 2, earlier: ['with_notes'] })).toBe('plan')
    expect(specPathOf({ revision: 1, earlier: [], origin: ORIGIN, content: '' }).reason).toBe(PLAN_REASON)
    // a revision after Changes, a filed Spec and an owner gate (whatever its origin) are his
    expect(path({ revision: 2, earlier: ['changes'] })).toBe('owner')
    expect(path({ revision: 3, earlier: ['changes', 'with_notes'] })).toBe('owner')
    expect(path({ origin: { ...ORIGIN, filedSpec: true } })).toBe('owner')
    expect(path({ origin: { ...ORIGIN, replan: true, gate: true } })).toBe('owner')
    // the path pass settles a plan that waits all the same, and passes what is his
    expect(routeSpecByRule({ revision: 1, earlier: [], origin: ORIGIN, content: '' })).toEqual({
      outcome: 'settled',
      reason: PLAN_REASON,
    })
    expect(routeSpecByRule({ revision: 1, earlier: [], origin: { ...ORIGIN, gate: true }, content: '' }).outcome).toBe(
      'passed',
    )
  })

  test('a Replan that changes no plan row and cancels nothing is settled; one that does, or says nothing a rule reads, is his', () => {
    const replan = { ...ORIGIN, replan: true }
    const block = (body: unknown) => `# Replan\n\nFree 1043.\n\n\`\`\`replan\n${JSON.stringify(body)}\n\`\`\`\n`
    const none = { plan: [], edges: { add: [], remove: [] }, cancel: [] }
    const freeing = block({ ...none, edges: { add: [], remove: [{ issue: 'issue_1043', after: ['issue_867'] }] } })
    expect(specPathOf({ revision: 1, earlier: [], origin: replan, content: freeing })).toEqual({
      path: 'settled',
      reason: 'a Replan that changes no plan row and cancels nothing: it only frees an Issue from a wait',
    })
    // the block written on one line, as the playbook shows it, reads the same
    const inline = '```replan {"plan":[],"edges":{"add":[],"remove":[]},"cancel":[]} ```'
    expect(specPathOf({ revision: 1, earlier: [], origin: replan, content: inline }).path).toBe('settled')
    for (const content of [
      block({ ...none, plan: ['v2-store'] }),
      block({ ...none, cancel: [{ issue: 'issue_9', reason: 'shipped' }] }),
      // a block that leaves a key out or misnames one states nothing a rule may settle on
      block({}),
      block({ rows: ['v2-store'], edges: { add: [], remove: [] }, cancel: [] }),
      block({ ...none, rows: ['v2-store'] }),
      '# Replan\n\nNo block at all.',
      '```replan\n{not json\n```',
    ]) {
      expect(specPathOf({ revision: 1, earlier: [], origin: replan, content }).path).toBe('owner')
    }
    // the same block on a Spec that is not a Replan is the lead's plan
    expect(specPathOf({ revision: 1, earlier: [], origin: ORIGIN, content: freeing }).path).toBe('plan')
    expect(replanBlockOf(freeing)).toMatchObject({ plan: [], free: [], cancel: [] })
  })

  test('a Replan that only frees plan rows (a removed after) is settled; a row changed otherwise still waits', () => {
    const replan = { ...ORIGIN, replan: true }
    const block = (body: unknown) => `# Replan\n\n\`\`\`replan\n${JSON.stringify(body)}\n\`\`\`\n`
    const none = { plan: [], free: [], edges: { add: [], remove: [] }, cancel: [] }
    expect(
      routeSpecByRule({ revision: 1, earlier: [], origin: replan, content: block({ ...none, free: ['dev-host'] }) }),
    ).toEqual({
      outcome: 'settled',
      reason:
        'a Replan that changes a plan row only by a removed after and cancels nothing: it only frees a plan row from a wait',
    })
    const both = block({
      ...none,
      free: ['dev-host', 'db-server'],
      edges: { add: [], remove: [{ issue: 'issue_7', after: ['issue_5'] }] },
    })
    expect(routeSpecByRule({ revision: 1, earlier: [], origin: replan, content: both })?.reason).toBe(
      'a Replan that changes a plan row only by a removed after and cancels nothing: it only frees an Issue and 2 plan rows from their waits',
    )
    // a row named in `plan` changes otherwise, even when it is also freed: it is the owner's to read
    for (const content of [
      block({ ...none, free: ['dev-host'], plan: ['analytics'] }),
      block({ ...none, free: ['dev-host'], plan: ['dev-host'] }),
      block({ ...none, free: 'dev-host' }),
    ]) {
      expect(routeSpecByRule({ revision: 1, earlier: [], origin: replan, content }).outcome).toBe('passed')
    }
  })

  test('the source names who made the Spec owed', () => {
    expect(specSourceOf({ ...ORIGIN, replan: true, triaged: true })).toBe('replan')
    expect(specSourceOf({ ...ORIGIN, filedSpec: true })).toBe('filer')
    expect(specSourceOf({ ...ORIGIN, triaged: true })).toBe('triage')
    expect(specSourceOf({ ...ORIGIN, filedWithCheckpoint: true })).toBe('filer')
    expect(specSourceOf(ORIGIN)).toBe('lead')
  })
})

let db: TestCluster
let blobDir: string

beforeAll(async () => {
  db = await startTestCluster()
  blobDir = await mkdtemp('/tmp/factory-blobs-')
})

afterAll(async () => {
  await db.stop()
  await rm(blobDir, { recursive: true, force: true })
})

const clock: FixedClock = fixedClock('2026-11-14T08:00:00Z')
let deps: CheckpointLoopDeps & PageDeps

beforeEach(async () => {
  await db.sql`DROP SCHEMA IF EXISTS factory CASCADE`
  await migrate(db.sql, await loadMigrations())
  clock.set(new Date('2026-11-14T08:00:00Z'))
  const uow = postgresUnitOfWork(db.sql, (tx) => ({
    work: postgresWorkStore(tx),
    checkpoints: postgresCheckpointStore(tx),
    errands: postgresErrandStore(tx),
  }))
  deps = {
    uow,
    clock,
    ids: sequentialIds(),
    blobs: fileBlobStore(blobDir),
    consoleUrl: 'https://console.example.test',
    checks: { run: async () => ({ exit: 0, timedOut: false, output: '' }) },
    // no workflow reads a Spec: a call of any fails
    agw: fakeAgw({}),
    recheckAfterMs: 0,
    notifier: { send: () => Promise.resolve(ok(undefined)) },
  }
})

const value = <T, E>(result: Result<T, E>): T => {
  if (!result.ok) throw new Error(`expected ok, got ${JSON.stringify(result.error)}`)
  return result.value
}

const record = async (issueId: IssueId, name: string, event: AnyIssueEvent) =>
  value(await recordIssueEvent(deps, { issueId, key: key('test', issueId, name), event }))

/**
 * An Issue with a lead working: attempt 1. `checkpoint`: the filer set it; `triaged`: factory-triage set `spec` when it
 * settled it; `replan`: it is a project's Replan.
 */
async function workingIssue(
  input: { title?: string; triaged?: boolean; checkpoint?: 'spec' | 'gate'; replan?: boolean } = {},
): Promise<IssueId> {
  const filed = value(
    await fileIssue(deps, {
      key: key('filed', deps.ids.next('signal')),
      event: {
        kind: 'filed',
        payload: {
          repo: 'example',
          title: input.title ?? 'Raise the plan limit',
          kind: 'feature',
          origin: 'you',
          ...(input.checkpoint ? { checkpoint: input.checkpoint } : {}),
        },
        actor: 'factory',
      },
    }),
  )
  const id = filed.issue.id
  await record(id, 'settled', {
    kind: 'settled',
    payload: input.triaged ? { checkpoint: 'spec' } : {},
    actor: 'factory',
  })
  await record(id, 'admitted', { kind: 'admitted', payload: {}, actor: 'factory' })
  await record(id, 'lead_started', { kind: 'lead_started', payload: { attempt: 1, terminal: 't1' }, actor: 'factory' })
  if (input.replan) {
    await db.sql`INSERT INTO factory.replans (issue_id, project, trigger, created_at)
      VALUES (${id}, 'example', 'stalled', ${clock.now()})`
  }
  return id
}

/** A Spec opens with Build and Decided: a fixture that is only a title gets them after it. */
const FORM = '## Build\n\nIt.\n\n## Decided\n\nIt: why.\n\n'
const formed = (content: string) =>
  content.includes('## Build') ? content : content.replace(/^(# .*\n+)?/, (title) => `${title}${FORM}`)
const handOver = async (issueId: IssueId, title: string, content: string) =>
  value(await submitArtifact(deps, { issueId, attempt: 1, raw: { kind: 'spec', title, content: formed(content) } }))

const submit = async (issueId: IssueId, title: string, content: string): Promise<ArtifactId> =>
  (await handOver(issueId, title, content)).artifact.id

const pages = async (): Promise<number> =>
  Number((await db.sql`SELECT count(*)::int AS n FROM factory.checkpoint_pages`)[0].n)

const reviewsAtOwner = async (): Promise<string[]> =>
  (await readNeeds(db.sql, clock.now())).items.filter((item) => item.kind === 'review').map((item) => item.id)

const pathOf = async (artifactId: ArtifactId) =>
  (await db.sql`SELECT outcome, by, source, note, tries FROM factory.spec_screens WHERE artifact_id = ${artifactId}`)[0]

const stateOf = async (issueId: IssueId) =>
  (await db.sql`SELECT state, wait_reason FROM factory.issues WHERE id = ${issueId}`)[0]

const eventsOf = async (issueId: IssueId): Promise<string[]> =>
  (
    await db.sql`SELECT kind FROM factory.issue_events WHERE issue_id = ${issueId} AND result = 'applied' ORDER BY version`
  ).map((row: { kind: string }) => row.kind)

const notesOf = async (issueId: IssueId): Promise<{ text: string; actor: string }[]> =>
  await db.sql`SELECT payload->>'text' AS text, actor FROM factory.issue_events
    WHERE issue_id = ${issueId} AND kind = 'noted' AND result = 'applied' ORDER BY version`

describe("a lead's Spec is its plan", () => {
  test('on an Issue with the checkpoint spec it leaves the Issue working, pages no one, and is the Spec ship counts', async () => {
    const issueId = await workingIssue({ checkpoint: 'spec' })
    const handed = await handOver(issueId, 'A tile screen', '# Tile\n\n## Build\n\nA tile.\n\n## Decided\n\nOne query.')
    const spec = handed.artifact.id
    expect(handed).toMatchObject({ result: 'applied', issue: null, plan: true })
    expect(await stateOf(issueId)).toMatchObject({ state: 'working', wait_reason: null })
    expect(await eventsOf(issueId)).toEqual(['filed', 'settled', 'admitted', 'lead_started'])
    expect(await pathOf(spec)).toMatchObject({
      outcome: 'settled',
      by: 'rule',
      source: 'filer',
      note: PLAN_REASON,
      tries: 0,
    })
    expect(await reviewsAtOwner()).toEqual([])
    expect(await pages()).toBe(0)
    // the path pass has nothing left to decide, and gives no verdict for him
    expect(value(await routeSpecs(deps))).toEqual([])
    expect(await db.sql`SELECT 1 FROM factory.verdicts WHERE artifact_id = ${spec}`).toHaveLength(0)
    // the ship check counts it as the Spec the checkpoint owes
    expect(await postgresQualityStore(db.sql).specSubmitted(issueId)).toBe(true)
    // handing the same Spec over again is the same plan
    expect(
      await handOver(issueId, 'A tile screen', '# Tile\n\n## Build\n\nA tile.\n\n## Decided\n\nOne query.'),
    ).toMatchObject({ result: 'replayed', plan: true })
    // a day later there is no wait to default and nothing to withdraw: the plan stays without a verdict
    clock.set(new Date(clock.now().getTime() + 25 * 3_600_000))
    expect(value(await recheckReviews(deps))).toEqual([])
    expect(await db.sql`SELECT 1 FROM factory.verdicts WHERE artifact_id = ${spec}`).toHaveLength(0)
  })

  test('a plan is refused like any lead verb from another attempt or a closed Issue, and nothing is stored', async () => {
    const issueId = await workingIssue()
    const stale = await submitArtifact(deps, {
      issueId,
      attempt: 2,
      raw: { kind: 'spec', title: 'A stale plan', content: '# Stale\n\n## Build\n\nIt.\n\n## Decided\n\nIt: why.' },
    })
    expect(stale.ok ? null : stale.error).toMatchObject({
      kind: 'machine_refused',
      detail: expect.stringContaining('the Issue is on attempt 1'),
    })
    await record(issueId, 'cancelled', { kind: 'cancelled', payload: { reason: 'not needed' }, actor: 'owner' })
    const closed = await submitArtifact(deps, {
      issueId,
      attempt: 1,
      raw: { kind: 'spec', title: 'A late plan', content: '# Late\n\n## Build\n\nIt.\n\n## Decided\n\nIt: why.' },
    })
    expect(closed.ok ? null : closed.error).toMatchObject({ kind: 'machine_refused' })
    expect(await db.sql`SELECT 1 FROM factory.artifacts WHERE issue_id = ${issueId}`).toHaveLength(0)
    expect(await db.sql`SELECT 1 FROM factory.spec_screens`).toHaveLength(0)
  })

  test("the owner's comment and his verdict reach the lead as notes, and the Issue never waits", async () => {
    const issueId = await workingIssue({ triaged: true })
    const spec = await submit(issueId, 'Raise the plan file limit', '# Limit\n\nOne constant.')
    expect(await pathOf(spec)).toMatchObject({ outcome: 'settled', by: 'rule', source: 'triage' })

    value(
      await annotateArtifact(deps, {
        artifactId: spec,
        revision: null,
        author: 'owner',
        raw: { quote: 'One constant.', comment: 'Name it in the README too.' },
      }),
    )
    // the lead's own annotation is no note to itself
    value(
      await annotateArtifact(deps, {
        artifactId: spec,
        revision: null,
        author: 'lead',
        raw: { quote: 'One constant.', comment: 'Done.' },
      }),
    )
    value(await giveVerdict(deps, { artifactId: spec, verdict: 'with_notes', note: 'Fine.', revision: null }))
    const notes = await notesOf(issueId)
    expect(notes).toHaveLength(2)
    expect(notes[0]).toMatchObject({ actor: 'owner' })
    expect(notes[0]?.text).toContain('Name it in the README too.')
    expect(notes[0]?.text).toContain(`factory artifact annotation-reply ${spec}`)
    // With notes is retired: stored as Looks good, its note and the open comment reach the lead
    expect(notes[1]?.text).toContain('Looks good')
    expect(notes[1]?.text).toContain('Fine.')
    expect(await stateOf(issueId)).toMatchObject({ state: 'working' })
    expect(await eventsOf(issueId)).not.toContain('verdict_given')
    expect(await reviewsAtOwner()).toEqual([])
  })

  test('a plan that still waits from before the change is settled by rule, with no call, and its Issue works again', async () => {
    const issueId = await workingIssue()
    const spec = await submit(issueId, 'A Spec', '# A Spec')
    // as a Spec handed over before Issue 2732 stands: waiting, and not looked at
    await db.sql`DELETE FROM factory.spec_screens WHERE artifact_id = ${spec}`
    await record(issueId, 'submitted', {
      kind: 'submitted',
      payload: { attempt: 1, artifact: { id: spec, summary: 'A Spec' } },
      actor: 'lead',
    })
    expect(await stateOf(issueId)).toMatchObject({ state: 'waiting', wait_reason: 'review' })

    expect(value(await routeSpecs(deps))).toEqual([{ artifact: spec, revision: 1, outcome: 'settled' }])
    expect(await pathOf(spec)).toMatchObject({ outcome: 'settled', by: 'rule', source: 'lead' })
    const [verdict] = await db.sql`SELECT verdict, by, note FROM factory.verdicts WHERE artifact_id = ${spec}`
    expect(verdict).toMatchObject({ verdict: 'looks_good', by: 'factory' })
    expect(String(verdict.note)).toContain(PLAN_REASON)
    expect(await stateOf(issueId)).toMatchObject({ state: 'working' })
    expect(await pages()).toBe(0)
  })
})

describe('the Specs that wait', () => {
  test("an owner gate's Spec waits, reaches Needs you and pages him once its path passes it by rule", async () => {
    const issueId = await workingIssue({ checkpoint: 'gate' })
    const handed = await handOver(issueId, 'A product gate', '# Gate')
    expect(handed).toMatchObject({ issue: { state: 'waiting', waitReason: 'review' }, plan: false })
    expect(await reviewsAtOwner()).toEqual([])
    expect(value(await routeSpecs(deps))).toEqual([{ artifact: handed.artifact.id, revision: 1, outcome: 'passed' }])
    expect(await pathOf(handed.artifact.id)).toMatchObject({ outcome: 'passed', by: 'rule', source: 'filer' })
    expect(await reviewsAtOwner()).toEqual([handed.artifact.id])
    expect(await pages()).toBe(1)
    // a decided revision is never looked at again
    expect(value(await routeSpecs(deps))).toEqual([])
  })

  test('a Replan that changes a plan row waits for the owner; one that only frees an Issue is settled by rule', async () => {
    const rows = await workingIssue({ title: 'Replan: example', replan: true })
    const changing = await handOver(
      rows,
      'Replan: drop a row',
      '# Replan\n\n```replan\n{"plan":["v2-store"],"edges":{"add":[],"remove":[]},"cancel":[]}\n```\n',
    )
    expect(changing).toMatchObject({ issue: { state: 'waiting', waitReason: 'review' }, plan: false })

    const freeing = await workingIssue({ title: 'Replan: other', replan: true })
    const freed = await handOver(
      freeing,
      'Replan: free issue_7',
      '# Replan\n\nissue_7 waits on a stalled head for nothing.\n\n```replan\n{"plan":[],"edges":{"add":[],"remove":[{"issue":"issue_7","after":["issue_5"]}]},"cancel":[]}\n```\n',
    )
    expect(freed).toMatchObject({ issue: { state: 'waiting', waitReason: 'review' }, plan: false })

    expect(value(await routeSpecs(deps))).toEqual([
      { artifact: changing.artifact.id, revision: 1, outcome: 'passed' },
      { artifact: freed.artifact.id, revision: 1, outcome: 'settled' },
    ])
    expect(await pathOf(freed.artifact.id)).toMatchObject({ outcome: 'settled', by: 'rule', source: 'replan' })
    expect(await stateOf(freeing)).toMatchObject({ state: 'working' })
    expect(await stateOf(rows)).toMatchObject({ state: 'waiting', wait_reason: 'review' })
    expect(await reviewsAtOwner()).toEqual([changing.artifact.id])
  })

  test('his answer counts in the KPI and friction; a plan records its path and has no answer', async () => {
    const first = await workingIssue({ checkpoint: 'gate' })
    const gate = await submit(first, 'A product gate', '# Gate')
    value(await routeSpecs(deps))
    value(await giveVerdict(deps, { artifactId: gate, verdict: 'looks_good', note: null, revision: null }))
    // a plan has no verdict: it counts in neither
    const second = await workingIssue({ title: 'A new tile' })
    const tile = await submit(second, 'A new tile', '# Tile')
    expect(await pathOf(tile)).toMatchObject({ outcome: 'settled', by: 'rule', note: PLAN_REASON })

    // a window ends before its `now`: read a minute later
    clock.set(new Date(clock.now().getTime() + 60_000))
    const kpis = KpiModel.parse(await readKpis(db.sql, { now: clock.now(), days: 7 }))
    // one verdict is counted but is under the floor of three, so no share is claimed from it
    expect(kpis.kpis.find((k) => k.key === 'asks_not_needed')).toMatchObject({
      count: 1,
      n: 1,
      value: null,
      measured: false,
    })
    const friction = await readFriction(db.sql, { now: clock.now(), days: 7 })
    expect(friction.counts.find((c) => c.key === 'ask_unneeded:filer')).toMatchObject({
      group: 'ask_unneeded',
      count: 1,
    })
    expect(await readFrictionEvidence(db.sql, { now: clock.now(), days: 7 }, ['ask_unneeded:filer'])).toEqual({
      'ask_unneeded:filer': [first],
    })
  })
})
