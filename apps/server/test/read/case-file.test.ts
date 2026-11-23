import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { CASE_MAX_CHARS, caseChars, type JudgeCase } from '@software-factory/contract'
import { startTestCluster, type TestCluster } from '@software-factory/tests/pg'
import { gitAgentsHead } from '../../src/adapters/git/agents-head.ts'
import { loadMigrations, migrate } from '../../src/adapters/postgres/migrate.ts'
import { postgresUnitOfWork } from '../../src/adapters/postgres/unit-of-work.ts'
import { postgresWorkStore } from '../../src/adapters/postgres/work-store.ts'
import { casedAgw, fitCase } from '../../src/app/case-agw.ts'
import { fileIssue, recordIssueEvent } from '../../src/app/issues.ts'
import { deriveSession } from '../../src/domains/leads/session.ts'
import type { AnyIssueEvent } from '../../src/domains/work/events.ts'
import type { AgwPort } from '../../src/kernel/agw.ts'
import { fixedClock } from '../../src/kernel/clock.ts'
import { type IssueId, sequentialIds } from '../../src/kernel/ids.ts'
import { type Key, key } from '../../src/kernel/keys.ts'
import { ok } from '../../src/kernel/result.ts'
import { WORKFLOWS, type WorkflowName } from '../../src/kernel/workflows.ts'
import { readCaseFile } from '../../src/read/case-file.ts'
import { issueDetail } from '../../src/read/issues.ts'
import { redactIssueDetail } from '../../src/read/surface.ts'

const fixture = JSON.parse(
  await readFile(
    join(import.meta.dir, '..', '..', '..', '..', 'packages', 'contract', 'fixtures', 'loops.json'),
    'utf8',
  ),
)

let db: TestCluster
let checkout: string

beforeAll(async () => {
  db = await startTestCluster()
  // The repo's main checkout: AGENTS.md committed on its branch, an edit beside it that is not.
  checkout = await realpath(await mkdtemp('/tmp/case-file-repo-'))
  const git = (...args: string[]) =>
    spawnSync('git', ['-c', 'user.email=t@example.com', '-c', 'user.name=t', ...args], { cwd: checkout })
  git('init', '-q', '-b', 'master')
  await writeFile(join(checkout, 'AGENTS.md'), '# example\n\nRule: every change ships through a pull request.\n')
  git('add', 'AGENTS.md')
  git('commit', '-q', '-m', 'init')
  await writeFile(join(checkout, 'AGENTS.md'), '# example\n\nAn edit not committed.\n')
})

afterAll(async () => {
  await db.stop()
  await rm(checkout, { recursive: true, force: true })
})

const clock = fixedClock('2026-11-21T12:00:00Z')
let deps: Parameters<typeof fileIssue>[0]

beforeEach(async () => {
  await db.sql`DROP SCHEMA IF EXISTS factory CASCADE`
  await migrate(db.sql, await loadMigrations())
  deps = {
    uow: postgresUnitOfWork(db.sql, (tx) => ({ work: postgresWorkStore(tx) })),
    clock,
    ids: sequentialIds(),
  }
})

const value = <T>(result: { ok: true; value: T } | { ok: false; error: unknown }): T => {
  if (!result.ok) throw new Error(`expected ok, got ${JSON.stringify(result.error)}`)
  return result.value
}

const record = async (issueId: IssueId, name: string, event: AnyIssueEvent) =>
  value(await recordIssueEvent(deps, { issueId, key: key('test', issueId, name), event }))

/** An Issue filed with its words, settled, and worked on by attempt 1. */
async function issue(repo: string, title: string, words: string): Promise<IssueId> {
  const filed = value(
    await fileIssue(deps, {
      key: key('filed', title),
      event: { kind: 'filed', payload: { repo, title, kind: 'feature', origin: 'you' }, actor: 'factory' },
    }),
  )
  const id = filed.issue.id
  await record(id, 'words', { kind: 'noted', payload: { text: words }, actor: 'factory' })
  await record(id, 'settled', { kind: 'settled', payload: {}, actor: 'factory' })
  await record(id, 'admitted', { kind: 'admitted', payload: {}, actor: 'factory' })
  await record(id, 'started', { kind: 'lead_started', payload: { attempt: 1, terminal: 't1' }, actor: 'factory' })
  return id
}

interface World {
  subject: IssueId
  other: IssueId
  decision: string
  errand: string
}

/** The fixture Issue and everything around it: a project with a plan, a neighbour with an edge, earlier answers. */
async function world(repo: string, work = false): Promise<World> {
  const at = clock.now()
  await db.sql`
    INSERT INTO factory.planning_projects (name, repo, source, project, plan)
    VALUES (${repo}, ${checkout}, 'file', ${{ name: repo, ship: 'pr', ...(work ? { work: true } : {}) }},
      ${{
        version: 1,
        rows: [
          { key: 'log-format', title: 'Pick a log format', facts: { why: 'one format for every service' } },
          {
            key: 'logging',
            title: 'Add request logging',
            after: ['log-format'],
            facts: { why: 'the server logs nothing', acceptance: 'every request is one line' },
          },
          { key: 'log-alerts', title: 'Alert on error lines', after: ['logging'], facts: { why: 'errors go unseen' } },
        ],
      }})`
  const other = await issue(repo, 'Pick a log format', 'JSON lines, one object per request')
  const subject = await issue(
    repo,
    'Add request logging',
    'why: the server logs nothing\nacceptance: every request is one line',
  )
  await record(subject, 'owner-note', {
    kind: 'noted',
    payload: { text: 'Use pino, it is in the stack already' },
    actor: 'owner',
  })
  await db.sql`INSERT INTO factory.planning_edges (issue_id, after_issue, created_at) VALUES (${subject}, ${other}, ${at})`
  await db.sql`INSERT INTO factory.planning_filed_rows (project, row_key, issue_id, filed_at) VALUES (${repo}, 'logging', ${subject}, ${at})`
  const decisionRow = (id: string, issueId: IssueId, question: string) => ({
    id,
    key: `ask:${id}`,
    issue_id: issueId,
    repo,
    attempt: 1,
    question,
    recommendation: 'pino',
    checked: 'read the stack',
    options: JSON.stringify([
      { label: 'pino', reversible: true, cost: 'one dependency' },
      { label: 'winston', reversible: true, cost: 'heavier' },
    ]),
    no_answer: JSON.stringify({ consequence: 'waits', default: null, waitMinutes: null }),
    asked_at: at,
  })
  // An earlier Decision of the repo the Judge answered: this judge's precedent.
  await db.sql`INSERT INTO factory.decisions ${db.sql(decisionRow('decision_1', other, 'Which JSON layout for log lines?'))}`
  await db.sql`UPDATE factory.decisions SET answer = 'pino', settled_by = 'judge', source = 'file: AGENTS.md:3', answered_at = ${at} WHERE id = 'decision_1'`
  await db.sql`INSERT INTO factory.decision_steps (decision_id, step, outcome, detail, at) VALUES ('decision_1', 'judge', 'answered', 'the plan names it', ${at})`
  await db.sql`INSERT INTO factory.decisions ${db.sql(decisionRow('decision_2', subject, 'Which logging library?'))}`
  // An earlier answer of the steward in the repo.
  await db.sql`
    INSERT INTO factory.loop_calls (key, loop, issue_id, subject, round, claimed_at, lease_until, outcome, answer, finished_at)
    VALUES ('steward:other:1', 'steward', ${other}, 'wait:5', 1, ${at}, ${at}, 'answered',
      ${{ action: 'wake', note: 'the CI run is green now', reason: 'the block cleared' }}, ${at})`
  await db.sql`INSERT INTO factory.errands (id, key, issue_id, attempt, summary, raised_at) VALUES ('errand_1', 'errand:1', ${subject}, 1, 'Approve the log retention', ${at})`
  // The lead's session reported its transcript: the steward's pane is read from it.
  await db.sql`
    INSERT INTO factory.lead_hook_events (key, session, issue_id, attempt, kind, at, received_at, payload)
    VALUES ('hook:1', ${`lead-${subject.slice('issue_'.length)}-1`}, ${subject}, 1, 'session-start', ${at}, ${at},
      ${{ transcriptPath: '/tmp/transcript.jsonl' }})`
  return { subject, other, decision: 'decision_2', errand: 'errand_1' }
}

/** The agw port the case file wraps: it records every request it is sent and answers each from the fixture. */
function recorder() {
  const sent = new Map<WorkflowName, Record<string, unknown>>()
  const inner: AgwPort = {
    run: async (name, request) => {
      sent.set(name, request)
      return ok({}) as never
    },
  }
  const port = casedAgw(inner, {
    read: (subject) => readCaseFile(db.sql, subject),
    agents: gitAgentsHead({ timeoutMs: 5_000 }),
    lastWords: async (path) =>
      ok(path === '/tmp/transcript.jsonl' ? 'Waiting on the CI run of pull request 12.' : null),
  })
  return { port, sent }
}

/** One request per workflow, the fixture's example pointed at the world. */
function requests(repo: string, w: World): Record<WorkflowName, unknown> {
  return {
    judge: { ...fixture.judge.input, decision: w.decision, repo },
    steward: { ...fixture.steward.input, issue: w.subject, repo, attempt: 1 },
    settle: { ...fixture.triage.settleInput, repo, issue: { ...fixture.triage.settleInput.issue, id: w.subject } },
    amend: { ...fixture.triage.amendInput, repo },
    queue: { ...fixture.queue.input, repo },
    screen: { ...fixture.screen.input, signal: { ...fixture.screen.input.signal, repo } },
    errandScreen: { ...fixture.errand.input, issue: { ...fixture.errand.input.issue, id: w.subject, repo } },
    errandNeeded: { ...fixture.errandNeeded.input, errand: { ...fixture.errandNeeded.input.errand, id: w.errand } },
    hygiene: fixture.hygiene.input,
  }
}

/** The case a recorded request carried; a request that was never sent fails the test. */
function caseOf(sent: Map<WorkflowName, Record<string, unknown>>, name: WorkflowName): JudgeCase {
  const request = sent.get(name)
  if (!request) throw new Error(`no ${name} request was sent`)
  return request.case as JudgeCase
}

async function sendAll(repo: string, w: World) {
  const { port, sent } = recorder()
  for (const [name, request] of Object.entries(requests(repo, w)) as [WorkflowName, never][]) {
    await port.run(name, request, `test:${name}` as Key)
  }
  return sent
}

const ISSUE_SCOPED: WorkflowName[] = ['judge', 'steward', 'settle', 'errandScreen', 'errandNeeded']
const REPO_SCOPED: WorkflowName[] = ['amend', 'queue', 'screen']

describe('the case file', () => {
  test('every judge request carries the case parts of a fixture Issue, in the shape its workflow takes', async () => {
    const w = await world('example')
    const sent = await sendAll('example', w)
    for (const name of [...ISSUE_SCOPED, ...REPO_SCOPED]) {
      const request = sent.get(name)
      expect({ name, parses: WORKFLOWS[name].request.safeParse(request).success }).toEqual({ name, parses: true })
      const c = caseOf(sent, name)
      // the repo's brief: its project, and AGENTS.md as the branch has it, not the edit beside it
      expect(c.repo?.project).toContain('"ship": "pr"')
      expect(c.repo?.agents).toContain('every change ships through a pull request')
      expect(c.repo?.agents).not.toContain('not committed')
      expect(caseChars(c)).toBeLessThanOrEqual(CASE_MAX_CHARS)
    }
    for (const name of ISSUE_SCOPED) {
      const c = caseOf(sent, name)
      expect(c.issue?.text).toContain('Add request logging')
      expect(c.issue?.facts).toContain('the server logs nothing')
      expect(c.ownerNotes?.map((note) => note.text)).toEqual(['Use pino, it is in the stack already'])
      expect(c.plan).toContain('- key: logging (this Issue)')
      expect(c.plan).toContain('every request is one line')
      expect(c.plan).toContain('- key: log-format (this Issue waits for it)')
      expect(c.plan).toContain('- key: log-alerts (waits for this Issue)')
      expect(c.open).toEqual([
        {
          id: w.other,
          title: 'Pick a log format',
          summary: 'JSON lines, one object per request',
          state: 'working',
          after: [],
          before: [w.subject],
        },
      ])
    }
    // the repo-level judges see every open Issue with its summary and edges
    expect(caseOf(sent, 'queue').open?.map((o) => [o.id, o.summary, o.after])).toEqual([
      [w.subject, 'why: the server logs nothing\nacceptance: every request is one line', [w.other]],
      [w.other, 'JSON lines, one object per request', []],
    ])
    // this judge's earlier answers in the repo
    expect(caseOf(sent, 'judge').precedents).toEqual([
      {
        at: clock.now().toISOString(),
        subject: 'Which JSON layout for log lines?',
        answer: 'answered pino (the plan names it)',
        outcome: 'unknown',
      },
    ])
    expect(caseOf(sent, 'steward').precedents?.[0]?.answer).toContain('the CI run is green now')
    // only the steward reads the lead's pane
    expect(caseOf(sent, 'steward').pane).toBe('Waiting on the CI run of pull request 12.')
    for (const name of ['judge', 'settle', 'queue'] as const) expect(caseOf(sent, name).pane).toBeUndefined()
    // the Judge also gets the Issue as filed and the checkout it reads with its tools
    expect(sent.get('judge')?.facts).toContain('the server logs nothing')
    expect(sent.get('judge')?.checkout).toBe(checkout)
    // the hygiene judge takes no case
    expect(sent.get('hygiene')).not.toHaveProperty('case')
  })

  test("a work repo's case is built and sent, and the read surface still shows none of its words", async () => {
    const w = await world('work-repo-1', true)
    const sent = await sendAll('work-repo-1', w)
    const c = caseOf(sent, 'judge')
    expect(c.issue?.text).toContain('Add request logging')
    expect(c.ownerNotes?.[0]?.text).toContain('pino')
    expect(c.repo?.agents).toContain('every change ships through a pull request')
    const detail = await issueDetail({ sql: db.sql, clock, deriveSession }, { id: w.subject, quota: new Map() })
    expect(detail?.visible).toBe(true)
    const shown = JSON.stringify(redactIssueDetail(detail as NonNullable<typeof detail>))
    for (const words of ['Add request logging', 'pino', 'the server logs nothing', 'pull request'])
      expect(shown).not.toContain(words)
  })

  test('a case that cannot be read leaves the request as it was: the judgment goes ahead', async () => {
    const sent: unknown[] = []
    const port = casedAgw(
      {
        run: async (_name, request) => {
          sent.push(request)
          return ok({}) as never
        },
      },
      { read: async () => Promise.reject(new Error('the database blinked')), agents: async () => ok('') },
    )
    await port.run('queue', fixture.queue.input, 'test:queue' as Key)
    expect(sent).toEqual([fixture.queue.input])
  })

  test('a case over the cap leaves out the oldest open Issues first, never the Issue itself', () => {
    const long = 'x'.repeat(300)
    const open = Array.from({ length: 200 }, (_, i) => ({
      id: `issue_${i + 1}`,
      title: long,
      summary: long,
      state: 'queued',
      after: [],
      before: [],
    }))
    const fitted = fitCase({ issue: { text: 'the title', facts: 'f'.repeat(10_000) }, open })
    expect(caseChars(fitted)).toBeLessThanOrEqual(CASE_MAX_CHARS)
    expect(fitted.issue).toEqual({ text: 'the title', facts: 'f'.repeat(10_000) })
    expect(fitted.open?.[0]?.id).toBe('issue_1')
    expect(fitted.open?.length).toBeLessThan(200)
  })
})
