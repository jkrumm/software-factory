import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { KpiModel, type SpecScreenAnswer, type SpecScreenRequest } from '@software-factory/contract'
import { startTestCluster, type TestCluster } from '@software-factory/tests/pg'
import { fileBlobStore } from '../../src/adapters/blobs/filesystem.ts'
import { postgresCheckpointStore } from '../../src/adapters/postgres/checkpoint-store.ts'
import { loadMigrations, migrate } from '../../src/adapters/postgres/migrate.ts'
import { postgresUnitOfWork } from '../../src/adapters/postgres/unit-of-work.ts'
import { postgresWorkStore } from '../../src/adapters/postgres/work-store.ts'
import { giveVerdict, markNeeded, submitArtifact } from '../../src/app/checkpoints.ts'
import type { PageDeps } from '../../src/app/checkpoints-pages.ts'
import { previewSpecScreen, screenSpecs } from '../../src/app/checkpoints-specs.ts'
import type { SettleDeps } from '../../src/app/checkpoints-settle.ts'
import { fileIssue, recordIssueEvent } from '../../src/app/issues.ts'
import type { ArtifactId } from '../../src/domains/checkpoints/artifact.ts'
import {
  checkSpecScreen,
  replanBlockOf,
  screenSpecByRule,
  SPEC_SCREEN_BACKOFF_MS,
  specSourceOf,
} from '../../src/domains/checkpoints/spec-screen.ts'
import type { AnyIssueEvent } from '../../src/domains/work/events.ts'
import { readFriction } from '../../src/read/friction.ts'
import { readFrictionEvidence } from '../../src/read/friction-evidence.ts'
import { readKpis } from '../../src/read/kpis.ts'
import { readNeeds } from '../../src/read/needs.ts'
import { type FixedClock, fixedClock } from '../../src/kernel/clock.ts'
import { type IssueId, sequentialIds } from '../../src/kernel/ids.ts'
import { key } from '../../src/kernel/keys.ts'
import { err, ok, portError, type Result } from '../../src/kernel/result.ts'

const ORIGIN = { replan: false, filedSpec: false, triaged: false, filedWithCheckpoint: false }

describe('the rules', () => {
  test('a revision after the owner asked for changes passes; a filed Spec passes', () => {
    expect(screenSpecByRule({ revision: 2, earlier: ['changes'], origin: ORIGIN, content: '' })).toMatchObject({
      outcome: 'passed',
    })
    expect(
      screenSpecByRule({ revision: 1, earlier: [], origin: { ...ORIGIN, filedSpec: true }, content: '' }),
    ).toMatchObject({ outcome: 'passed' })
    // a lead's Spec is the workflow's to judge
    expect(screenSpecByRule({ revision: 1, earlier: [], origin: ORIGIN, content: '# A Spec' })).toBeNull()
    expect(screenSpecByRule({ revision: 2, earlier: ['with_notes'], origin: ORIGIN, content: '' })).toBeNull()
  })

  test('a Replan that changes no plan row and cancels nothing is settled; anything else is not decided by rule', () => {
    const replan = { ...ORIGIN, replan: true }
    const block = (body: unknown) => `# Replan\n\nFree 1043.\n\n\`\`\`replan\n${JSON.stringify(body)}\n\`\`\`\n`
    const freeing = block({ plan: [], edges: { remove: [{ issue: 'issue_1043', after: ['issue_867'] }] }, cancel: [] })
    expect(screenSpecByRule({ revision: 1, earlier: [], origin: replan, content: freeing })).toEqual({
      outcome: 'settled',
      reason: 'a Replan that changes no plan row and cancels nothing: it only frees an Issue from a wait',
    })
    // the block written on one line, as the playbook shows it, reads the same
    const inline = '```replan {"plan":[],"edges":{"add":[],"remove":[]},"cancel":[]} ```'
    expect(screenSpecByRule({ revision: 1, earlier: [], origin: replan, content: inline })?.outcome).toBe('settled')
    for (const content of [
      block({ plan: ['v2-store'] }),
      block({ cancel: [{ issue: 'issue_9', reason: 'shipped' }] }),
      '# Replan\n\nNo block at all.',
      '```replan\n{not json\n```',
    ]) {
      expect(screenSpecByRule({ revision: 1, earlier: [], origin: replan, content })).toBeNull()
    }
    // the same block on a Spec that is not a Replan decides nothing
    expect(screenSpecByRule({ revision: 1, earlier: [], origin: ORIGIN, content: freeing })).toBeNull()
    expect(replanBlockOf(freeing)).toMatchObject({ plan: [], cancel: [] })
  })

  test('the source names who made the Spec owed', () => {
    expect(specSourceOf({ ...ORIGIN, replan: true, triaged: true })).toBe('replan')
    expect(specSourceOf({ ...ORIGIN, filedSpec: true })).toBe('filer')
    expect(specSourceOf({ ...ORIGIN, triaged: true })).toBe('triage')
    expect(specSourceOf({ ...ORIGIN, filedWithCheckpoint: true })).toBe('filer')
    expect(specSourceOf(ORIGIN)).toBe('lead')
  })

  test('a settle needs a reason; the reason is one line', () => {
    expect(checkSpecScreen({ verdict: 'settle', reason: 'a constant\n raise' })).toEqual({
      action: 'settle',
      reason: 'a constant raise',
    })
    expect(checkSpecScreen({ verdict: 'settle', reason: '   ' })).toMatchObject({ action: 'refused' })
    expect(checkSpecScreen({ verdict: 'pass', reason: 'an unseen screen' })).toEqual({
      action: 'pass',
      note: 'an unseen screen',
    })
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
let deps: SettleDeps & PageDeps
let calls: { request: SpecScreenRequest; key: string }[]
let answer: (request: SpecScreenRequest) => Result<SpecScreenAnswer>

beforeEach(async () => {
  await db.sql`DROP SCHEMA IF EXISTS factory CASCADE`
  await migrate(db.sql, await loadMigrations())
  clock.set(new Date('2026-11-14T08:00:00Z'))
  calls = []
  answer = () => ok({ verdict: 'pass', reason: 'a screen the owner has not seen' })
  const uow = postgresUnitOfWork(db.sql, (tx) => ({
    work: postgresWorkStore(tx),
    checkpoints: postgresCheckpointStore(tx),
  }))
  deps = {
    uow,
    clock,
    ids: sequentialIds(),
    blobs: fileBlobStore(blobDir),
    consoleUrl: 'https://console.example.test',
    checks: { run: async () => ({ exit: 0, timedOut: false, output: '' }) },
    policies: { rulesFor: () => Promise.resolve(ok([])) },
    judge: { judge: () => Promise.resolve(err(portError('gone', 'no judge'))) },
    errandScreen: { screen: () => Promise.resolve(err(portError('gone', 'no screen'))) },
    specScreen: {
      screen: (request, callKey) => {
        // The port is never called inside a transaction.
        expect(deps.uow.inTransaction()).toBe(false)
        calls.push({ request, key: callKey })
        return Promise.resolve(answer(request))
      },
    },
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

/** An Issue with a lead working: attempt 1. `triaged`: factory-triage set its checkpoint when it settled it. */
async function workingIssue(input: { title?: string; triaged?: boolean } = {}): Promise<IssueId> {
  const filed = value(
    await fileIssue(deps, {
      key: key('filed', deps.ids.next('signal')),
      event: {
        kind: 'filed',
        payload: { repo: 'example', title: input.title ?? 'Raise the plan limit', kind: 'feature', origin: 'you' },
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
  return id
}

const submit = async (issueId: IssueId, title: string, content: string): Promise<ArtifactId> =>
  value(await submitArtifact(deps, { issueId, attempt: 1, raw: { kind: 'spec', title, content } })).artifact.id

const pages = async (): Promise<number> =>
  Number((await db.sql`SELECT count(*)::int AS n FROM factory.checkpoint_pages`)[0].n)

const reviewsAtOwner = async (): Promise<string[]> =>
  (await readNeeds(db.sql, clock.now())).items.filter((item) => item.kind === 'review').map((item) => item.id)

const screenOf = async (artifactId: ArtifactId) =>
  (await db.sql`SELECT outcome, by, source, note, tries FROM factory.spec_screens WHERE artifact_id = ${artifactId}`)[0]

describe('the Spec screen', () => {
  test('a Spec waits for the screen, out of Needs you and unpaged; a pass puts it before the owner and pages him', async () => {
    const issueId = await workingIssue()
    const spec = await submit(issueId, 'A tile screen', '# Tile\n\nA new screen.')
    expect(await reviewsAtOwner()).toEqual([])
    expect(await pages()).toBe(0)

    expect(value(await screenSpecs(deps))).toEqual([{ artifact: spec, revision: 1, outcome: 'passed' }])
    expect(calls).toHaveLength(1)
    expect(calls[0]?.key).toBe(key('factory-spec-screen', spec, 1, 1))
    expect(calls[0]?.request).toMatchObject({
      spec: { id: spec, revision: 1, title: 'A tile screen', source: 'lead', format: 'markdown' },
      issue: { id: issueId, repo: 'example', kind: 'feature' },
      precedents: [],
    })
    expect(await screenOf(spec)).toMatchObject({ outcome: 'passed', by: 'judge', source: 'lead' })
    expect(await reviewsAtOwner()).toEqual([spec])
    expect(await pages()).toBe(1)
    // a decided revision is never looked at again
    expect(value(await screenSpecs(deps))).toEqual([])
    expect(calls).toHaveLength(1)
  })

  test('a settle is the factory looks_good with its reason: the lead hears it and builds, the owner never sees it', async () => {
    const issueId = await workingIssue({ triaged: true })
    const spec = await submit(issueId, 'Raise the plan file limit to 256 KiB', '# Limit\n\nOne constant.')
    answer = () => ok({ verdict: 'settle', reason: 'a one-constant change with a reversible default' })

    expect(value(await screenSpecs(deps))).toEqual([{ artifact: spec, revision: 1, outcome: 'settled' }])
    expect(await screenOf(spec)).toMatchObject({ outcome: 'settled', by: 'judge', source: 'triage' })
    const [verdict] = await db.sql`SELECT verdict, note FROM factory.verdicts WHERE artifact_id = ${spec}`
    expect(verdict.verdict).toBe('looks_good')
    expect(String(verdict.note)).toContain('The Spec screen settled it without the owner')
    const [issue] = await db.sql`SELECT state FROM factory.issues WHERE id = ${issueId}`
    expect(issue.state).toBe('working')
    const [given] = await db.sql`
      SELECT actor FROM factory.issue_events WHERE issue_id = ${issueId} AND kind = 'verdict_given'`
    expect(given.actor).toBe('factory')
    expect(await reviewsAtOwner()).toEqual([])
    expect(await pages()).toBe(0)
  })

  test('a screen that cannot be reached holds the Spec, retries after the backoff, and passes it after the last try', async () => {
    const issueId = await workingIssue()
    const spec = await submit(issueId, 'A Spec', '# A Spec')
    answer = () => err(portError('refused', 'unknown command'))

    expect(value(await screenSpecs(deps))).toEqual([{ artifact: spec, revision: 1, outcome: 'held' }])
    expect(await screenOf(spec)).toMatchObject({ outcome: null, tries: 1 })
    // not due yet: nothing is called
    expect(value(await screenSpecs(deps))).toEqual([])
    clock.set(new Date(clock.now().getTime() + SPEC_SCREEN_BACKOFF_MS))
    expect(value(await screenSpecs(deps))).toMatchObject([{ outcome: 'held' }])
    clock.set(new Date(clock.now().getTime() + SPEC_SCREEN_BACKOFF_MS))
    expect(value(await screenSpecs(deps))).toMatchObject([{ outcome: 'passed' }])
    expect(calls.map((call) => call.key)).toEqual([1, 2, 3].map((n) => key('factory-spec-screen', spec, 1, n)))
    expect(await screenOf(spec)).toMatchObject({ outcome: 'passed', by: 'failed', tries: 3 })
    expect(await reviewsAtOwner()).toEqual([spec])
  })

  test('a Replan that only frees an Issue is settled by rule, with no call', async () => {
    const issueId = await workingIssue({ title: 'Replan: example' })
    await db.sql`INSERT INTO factory.replans (issue_id, project, trigger, created_at)
      VALUES (${issueId}, 'example', 'stalled', ${clock.now()})`
    const content =
      '# Replan\n\nissue_7 waits on a stalled head for nothing.\n\n```replan\n{"plan":[],"edges":{"add":[],"remove":[{"issue":"issue_7","after":["issue_5"]}]},"cancel":[]}\n```\n'
    const spec = await submit(issueId, 'Replan: free issue_7', content)
    expect(value(await screenSpecs(deps))).toEqual([{ artifact: spec, revision: 1, outcome: 'settled' }])
    expect(calls).toHaveLength(0)
    expect(await screenOf(spec)).toMatchObject({ outcome: 'settled', by: 'rule', source: 'replan' })
  })

  test("the owner's mark is his precedent: the next screen and the preview carry it, and the KPI and friction count it", async () => {
    const first = await workingIssue({ triaged: true })
    const limit = await submit(first, 'Raise the plan limit', '# Limit')
    value(await screenSpecs(deps))
    value(
      await giveVerdict(deps, { artifactId: limit, verdict: 'looks_good', note: 'Shouldnt reach me', revision: null }),
    )
    const marked = value(await markNeeded(deps, { artifactId: limit, needed: false, revision: null }))
    expect(marked).toMatchObject({ revision: 1, neededMe: false })
    // the same mark again changes nothing; a Spec with no verdict cannot be marked
    expect(value(await markNeeded(deps, { artifactId: limit, needed: false, revision: null })).neededMe).toBe(false)

    const second = await workingIssue({ title: 'A new tile' })
    const tile = await submit(second, 'A new tile', '# Tile')
    expect((await markNeeded(deps, { artifactId: tile, needed: true, revision: null })).ok).toBe(false)

    const preview = value(await previewSpecScreen(deps, tile))
    expect(preview).toMatchObject({ revision: 1, screen: null, rule: null })
    expect(preview.request?.precedents).toEqual([
      {
        title: 'Raise the plan limit',
        repo: 'example',
        source: 'triage',
        screened: 'passed',
        needed: false,
        verdict: 'looks_good',
        note: 'Shouldnt reach me',
      },
    ])
    value(await screenSpecs(deps))
    expect(calls.at(-1)?.request.precedents).toEqual(preview.request?.precedents ?? [])

    // a window ends before its `now`: read a minute later
    clock.set(new Date(clock.now().getTime() + 60_000))
    const kpis = KpiModel.parse(await readKpis(db.sql, { now: clock.now(), days: 7 }))
    expect(kpis.kpis.find((k) => k.key === 'specs_not_needed')).toMatchObject({ count: 1, n: 1, value: 1 })
    const friction = await readFriction(db.sql, { now: clock.now(), days: 7 })
    expect(friction.counts.find((c) => c.key === 'spec_unneeded:triage')).toMatchObject({
      group: 'spec_unneeded',
      count: 1,
    })
    expect(await readFrictionEvidence(db.sql, { now: clock.now(), days: 7 }, ['spec_unneeded:triage'])).toEqual({
      'spec_unneeded:triage': [first],
    })
  })

  test("a verdict the owner gave while the screen held it ends the screen's work", async () => {
    const issueId = await workingIssue()
    const spec = await submit(issueId, 'A Spec', '# A Spec')
    value(await giveVerdict(deps, { artifactId: spec, verdict: 'with_notes', note: 'fine', revision: null }))
    expect(value(await screenSpecs(deps))).toEqual([])
    expect(calls).toHaveLength(0)
  })
})
