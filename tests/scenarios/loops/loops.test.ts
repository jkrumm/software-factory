import { afterAll, beforeAll, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { AdmitAnswer, DecisionList, PageList, PassReply, SignalAck } from '@software-factory/contract'
import { admit, block, hitWall, loseLead, must, tick } from '../flow.ts'
import { type Lab, startLab } from '../planning/lab.ts'
import { blocked, callsOf, eventsOf, loops, runLoop, script, state, working } from './support.ts'

/**
 * The loops against the real server process and Postgres with the fake agw: the steward over stalled Issues, the Judge
 * through the agw port, triage for what intake files, and the guard that nothing stays `settling`. Every pass is driven
 * through `factory loop run <name>`; the loops' own intervals are off (`FACTORY_TICK_MS=0`), so nothing runs behind a test.
 */
let lab: Lab
let dir: string
let stewardScript: string
let triageScript: string
let askScript: string

beforeAll(async () => {
  dir = await mkdtemp('/tmp/factory-loops-')
  stewardScript = join(dir, 'steward.json')
  triageScript = join(dir, 'triage.json')
  askScript = join(dir, 'ask.json')
  await Promise.all([script(stewardScript, []), script(triageScript, []), script(askScript, [])])
  lab = await startLab({
    leads: true,
    repos: {
      app: { project: 'apiVersion: factory/v2\nname: app\nleads: 8\n' },
      shop: { project: 'apiVersion: factory/v2\nname: shop\nleads: 8\n' },
      solo: { project: 'apiVersion: factory/v2\nname: solo\nleads: 2\n' },
    },
    env: {
      FACTORY_LEADS_PER_ACCOUNT: '16',
      FACTORY_STEWARD_MIN_STALL_MS: '0',
      FACTORY_SETTLE_TIMEOUT_MS: '2000',
      FACTORY_FAKE_STEWARD_SCRIPT: stewardScript,
      FACTORY_FAKE_TRIAGE_SCRIPT: triageScript,
      FACTORY_FAKE_ASK_SCRIPT: askScript,
    },
  })
  expect((await lab.cli(['project', 'sync'])).code).toBe(0)
})

afterAll(async () => {
  await lab.stop()
  await rm(dir, { recursive: true, force: true })
})

const signal = async (repo: string, title: string, text = '') => {
  const out = await lab.cli(['signal', 'file', '--body', JSON.stringify({ from: 'owner:hermes', repo, title, text })])
  expect(out.code).toBe(0)
  return SignalAck.parse(out.json)
}

test('every timer of packages 3 to 6 runs through the loop runner: seven named loops, each with its interval', async () => {
  const all = await loops(lab)
  expect(all.map((loop) => loop.name)).toEqual(['leads', 'planning', 'watch', 'settle', 'send', 'steward', 'triage'])
  expect(all.every((loop) => loop.intervalMs === 0 && loop.runs === 0)).toBe(true)
  const ran = await runLoop(lab, 'planning')
  expect(ran).toMatchObject({ started: true, error: null })
  expect((await loops(lab)).find((loop) => loop.name === 'planning')?.runs).toBe(1)
  expect((await lab.cli(['loop', 'run', 'nothing'])).code).not.toBe(0)
})

test('a stalled Issue whose cause is gone is woken by the steward without agw', async () => {
  const issue = await working(lab, 'app', 'the account hit its window')
  // The lead's session reports the account's rate limit: the hook the factory reads as the window running out.
  expect((await hitWall(lab.world, issue)).code).toBe(0)
  expect(await state(lab, issue)).toMatchObject({ state: 'waiting', wait: 'wall' })

  const ran = await runLoop(lab, 'steward')
  expect(ran.error).toBeNull()
  expect(ran.summary).toContain('woken 1')
  expect(await state(lab, issue)).toMatchObject({ state: 'working', wait: null })
  expect((await eventsOf(lab, issue)).slice(-1)).toEqual([{ kind: 'woken', actor: 'steward' }])
  expect(await callsOf(lab, 'factory-steward')).toEqual([])

  // a pass again changes nothing
  const version = (await state(lab, issue)).version
  await runLoop(lab, 'steward')
  expect((await state(lab, issue)).version).toBe(version)
})

test('a note that arrived while a lead waited is delivered by the steward, without agw', async () => {
  const issue = await blocked(lab, 'app', 'blocked and then told', 'waiting for the vendor')
  await must(lab, ['issue', 'note', issue, 'the vendor answered: use the v2 endpoint'])
  await runLoop(lab, 'steward')
  expect(await state(lab, issue)).toMatchObject({ state: 'working' })
  expect(await callsOf(lab, 'factory-steward')).toEqual([])
})

test('a stall the rules do not say asks factory-steward once, acts on the answer, and a replayed pass asks nothing', async () => {
  const issue = await blocked(lab, 'app', 'needs the staging database', 'waiting for the staging DB')
  await script(stewardScript, [
    {
      match: 'staging db',
      answer: {
        action: 'wake',
        note: 'The staging database is reachable again.',
        reason: 'a note says so',
        decision: null,
      },
    },
  ])
  const ran = await runLoop(lab, 'steward')
  expect(ran.summary).toContain('asked 1')
  const calls = await callsOf(lab, 'factory-steward')
  expect(calls).toHaveLength(1)
  expect(calls[0]?.input).toMatchObject({ issue, repo: 'app', cause: 'blocked', detail: 'waiting for the staging DB' })
  expect(calls[0]?.args).toContain('--idempotency-key')
  expect(await state(lab, issue)).toMatchObject({ state: 'working', wait: null })
  expect((await eventsOf(lab, issue)).slice(-2)).toEqual([
    { kind: 'noted', actor: 'steward' },
    { kind: 'woken', actor: 'steward' },
  ])
  await runLoop(lab, 'steward')
  expect(await callsOf(lab, 'factory-steward')).toHaveLength(1)
})

test('an answer that ends nothing is a round spent: a replayed pass is still one call, and the Issue stays stalled', async () => {
  const issue = await blocked(lab, 'app', 'nobody can tell what this needs', 'unclear block xyzzy')
  const before = (await callsOf(lab, 'factory-steward')).length
  await runLoop(lab, 'steward')
  await runLoop(lab, 'steward')
  await runLoop(lab, 'steward')
  expect(await callsOf(lab, 'factory-steward')).toHaveLength(before + 1)
  expect(await state(lab, issue)).toMatchObject({ state: 'waiting', wait: 'blocked' })
  const rows = await lab.world.db.sql`SELECT outcome FROM factory.loop_calls WHERE issue_id = ${issue}`
  expect(rows.map((r: { outcome: string }) => r.outcome)).toEqual(['rejected'])
})

const DECISION = (question: string) => ({
  action: 'raise_decision',
  note: '',
  reason: 'the choice is not the steward’s',
  decision: {
    question,
    recommendation: 'try again',
    checked: 'The history shows one blocked report.',
    options: [
      { label: 'try again', reversible: true, cost: 'the lead is woken and may block again' },
      { label: 'drop', reversible: true, cost: 'the work is not done; it can be filed again' },
    ],
    noAnswer: { consequence: 'the Issue stays blocked', default: null, waitMinutes: null },
  },
})

test('a steward Decision reaches the owner only when policy, the Judge and the default do not settle it', async () => {
  const bySteward = await blocked(lab, 'app', 'blocked on the cache question', 'cache question blocks it')
  const byOwner = await blocked(lab, 'app', 'blocked on the owner question', 'owner question blocks it')
  await script(stewardScript, [
    { match: 'cache question', answer: DECISION('Should the cache question block Issue A?') },
    { match: 'owner question', answer: DECISION('Should the owner question block Issue B?') },
  ])
  // the Judge settles the first, passes the second on
  await script(askScript, [
    {
      match: 'cache question',
      verdict: {
        verdict: 'answer',
        answer: 'try again',
        reason: 'the plan says to retry',
        source: 'plan: docs/plan.md',
      },
    },
  ])

  const ran = await runLoop(lab, 'steward')
  expect(ran.summary).toContain('Decisions 2')
  for (const issue of [bySteward, byOwner])
    expect(await state(lab, issue)).toMatchObject({ state: 'waiting', wait: 'decision' })

  const pass = PassReply.parse((await lab.cli(['checkpoint', 'pass'])).json)
  expect(pass.decisions.filter((d) => d.settledBy === 'judge')).toHaveLength(1)
  expect(pass.decisions.filter((d) => d.status === 'open')).toHaveLength(1)
  expect(await state(lab, bySteward)).toMatchObject({ state: 'working' })
  expect(await state(lab, byOwner)).toMatchObject({ state: 'waiting', wait: 'decision' })

  const list = DecisionList.parse((await lab.cli(['decision', 'list'])).json).decisions
  const ofOwner = list.find((d) => d.issueId === byOwner)
  const pages = PageList.parse((await lab.cli(['page', 'list'])).json).pages
  expect(pages.filter((p) => p.kind === 'decision').map((p) => p.checkpoint)).toEqual([ofOwner?.id ?? ''])
  // the Judge was given the Decision itself, with its required fields
  const asked = await callsOf(lab, 'factory-ask')
  expect(asked.at(0)?.input).toMatchObject({ repo: 'app', recommendation: 'try again', options: expect.any(Array) })
})

test('a later stall of the same Issue is a new Decision, and a lead that is gone is never given one', async () => {
  const issue = await blocked(lab, 'app', 'blocked again and again', 'recurring block qwerty')
  await script(stewardScript, [{ match: 'qwerty', answer: DECISION('Should the recurring block stop the Issue?') }])
  await script(askScript, [
    {
      match: 'recurring block',
      verdict: {
        verdict: 'answer',
        answer: 'try again',
        reason: 'the plan says to retry',
        source: 'plan: docs/plan.md',
      },
    },
  ])
  for (const round of [1, 2]) {
    const stewarded = await runLoop(lab, 'steward')
    expect(stewarded.summary).toContain('Decisions 1')
    await lab.cli(['checkpoint', 'pass'])
    expect(await state(lab, issue)).toMatchObject({ state: 'working' })
    if (round === 1) await block(lab, issue, 'recurring block qwerty')
  }
  const decisions = DecisionList.parse((await lab.cli(['decision', 'list'])).json).decisions.filter(
    (d) => d.issueId === issue,
  )
  expect(decisions).toHaveLength(2)

  // a lead that is gone: the steward may requeue it, never raise a Decision (an answer would not start a new attempt)
  const gone = await working(lab, 'app', 'the lead vanished')
  // Its terminal is lost; the first two times capacity admits a new attempt and the leads' loop starts it, the third is a stall.
  for (const attempt of [1, 2]) {
    expect((await loseLead(lab, gone, attempt)).lost).toBe(1)
    expect((await admit(lab)).admitted.map((a) => [a.issue, a.attempt])).toEqual([[gone, attempt + 1]])
    await tick(lab)
  }
  expect((await loseLead(lab, gone, 3)).lost).toBe(1)
  expect(await state(lab, gone)).toMatchObject({ state: 'waiting', wait: 'lead_gone' })
  await script(stewardScript, [{ match: 'vanished', answer: DECISION('Should the vanished lead be retried?') }])
  await runLoop(lab, 'steward')
  expect(await state(lab, gone)).toMatchObject({ state: 'waiting', wait: 'lead_gone' })
  const after = DecisionList.parse((await lab.cli(['decision', 'list'])).json).decisions
  expect(after.filter((d) => d.issueId === gone)).toEqual([])
  const rows = await lab.world.db.sql`SELECT outcome FROM factory.loop_calls WHERE issue_id = ${gone}`
  expect(rows.map((r: { outcome: string }) => r.outcome)).toEqual(['rejected'])
})

test('a person’s signal that matches an open Issue only in part asks factory-triage and amends the Issue it names', async () => {
  const open = (await signal('app', 'The login page crashes on submit')).issue as string
  await script(triageScript, [
    {
      match: 'login page submit crash',
      answer: { amend: open, after: [], kind: null, size: null, reason: 'the same crash' },
    },
  ])
  const ack = await signal('app', 'login page submit crash again', 'it is the 500 from /session')
  expect(ack).toMatchObject({ outcome: 'amended', detail: 'matched', issue: open })
  const calls = (await callsOf(lab, 'factory-triage')).filter((call) => call.input.mode === 'amend')
  expect(calls).toHaveLength(1)
  expect(calls[0]?.input).toMatchObject({
    mode: 'amend',
    repo: 'app',
    signal: { title: 'login page submit crash again', source: 'owner:hermes' },
  })
  expect(JSON.stringify(calls[0]?.input.candidates)).toContain(open)
})

test('a triage answer naming an Issue it was not shown is refused: the signal is filed anew', async () => {
  await signal('shop', 'The export button does nothing at all')
  await script(triageScript, [
    {
      match: 'export button nothing',
      answer: { amend: 'issue_9999', after: [], kind: null, size: null, reason: 'a guess' },
    },
  ])
  const ack = await signal('shop', 'export button nothing happens')
  expect(ack).toMatchObject({ outcome: 'filed', detail: 'new' })
  const rows = await lab.world.db.sql`SELECT count(*)::int AS n FROM factory.issues WHERE repo = 'shop'`
  expect(rows[0].n).toBe(2)
})

test('nothing stays settling: an owner signal filed as a new Issue is admitted without anyone calling planning settle', async () => {
  const issue = (await signal('shop', 'Add a changelog page')).issue
  // 'shop' has other open Issues: hold them off with a title nothing else shares, and settle them first
  expect(issue).not.toBeNull()
  const id = issue as string
  expect(await state(lab, id)).toMatchObject({ state: 'settling' })
  await script(triageScript, [
    {
      match: 'changelog',
      answer: { amend: null, after: [], kind: null, size: 'small', reason: 'nothing to wait for' },
    },
  ])
  const ran = await runLoop(lab, 'triage')
  expect(ran.error).toBeNull()
  expect(await state(lab, id)).toMatchObject({ state: 'queued' })
  // it asked once for this Issue: others are open in the repo, so its edges were not known by rule
  const mine = (await callsOf(lab, 'factory-triage')).filter(
    (call) => (call.input.issue as { id?: string } | undefined)?.id === id,
  )
  expect(mine).toHaveLength(1)

  // an account takes one new lead per poll, oldest queued Issue first: poll and admit until this one's turn comes
  const admittedIssues: string[] = []
  for (let round = 0; round < 12 && !admittedIssues.includes(id); round++) {
    expect((await lab.cli(['capacity', 'refresh'])).code).toBe(0)
    const admitted = AdmitAnswer.parse((await lab.cli(['capacity', 'admit'])).json)
    admittedIssues.push(...admitted.admitted.map((a) => a.issue))
  }
  expect(admittedIssues).toContain(id)
  expect(await state(lab, id)).toMatchObject({ state: 'working' })
})

test('an Issue with nothing open beside it in its repo is settled by the rules, without agw', async () => {
  const id = (await signal('solo', 'Add a health page')).issue as string
  expect(await state(lab, id)).toMatchObject({ state: 'settling' })
  await runLoop(lab, 'triage')
  expect(await state(lab, id)).toMatchObject({ state: 'queued' })
  const mine = (await callsOf(lab, 'factory-triage')).filter(
    (call) => (call.input.issue as { id?: string } | undefined)?.id === id,
  )
  expect(mine).toEqual([])
})

test('triage names edges: the Issue waits for the Issue it was shown, and a refused answer leaves it settling until the steward settles it', async () => {
  const blocker = (await signal('app', 'Replace the session store entirely')).issue as string
  await runLoop(lab, 'triage')
  const waits = (await signal('app', 'Add session expiry to the new store')).issue as string
  await script(triageScript, [
    {
      match: 'session expiry',
      answer: { amend: null, after: [blocker], kind: null, size: 'medium', reason: 'builds on the store' },
    },
  ])
  const ran = await runLoop(lab, 'triage')
  expect(ran.summary).toContain('chained 1')
  expect(await state(lab, waits)).toMatchObject({ state: 'queued' })
  const edges = await lab.world.db.sql`SELECT after_issue FROM factory.planning_edges WHERE issue_id = ${waits}`
  expect(edges.map((e: { after_issue: string }) => e.after_issue)).toEqual([blocker])

  // an answer that names an Issue it was not shown is refused
  const stuck = (await signal('app', 'Document the retry policy')).issue as string
  await script(triageScript, [
    {
      match: 'retry policy',
      answer: { amend: null, after: ['issue_9999'], kind: null, size: null, reason: 'a guess' },
    },
  ])
  const refused = await runLoop(lab, 'triage')
  expect(refused.summary).toContain('refused 1')
  expect(await state(lab, stuck)).toMatchObject({ state: 'settling' })
  // a second pass inside the retry wait does not ask again
  const asked = (await callsOf(lab, 'factory-triage')).length
  await runLoop(lab, 'triage')
  expect((await callsOf(lab, 'factory-triage')).length).toBe(asked)
  // past the timeout the steward settles it with no edges
  await Bun.sleep(2100)
  const steward = await runLoop(lab, 'steward')
  expect(steward.summary).toContain('settled')
  expect(await state(lab, stuck)).toMatchObject({ state: 'queued' })
}, 40_000)
