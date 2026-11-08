import { afterAll, beforeAll, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { SignalAck } from '@software-factory/contract'
import { type Lab, startLab } from '../planning/lab.ts'
import { callsOf, runLoop, script } from './support.ts'

/**
 * The screen loop against the real server and Postgres with the fake agw: the Judge looks at held signals and promotes,
 * dismisses or leaves them. `factory-screen` is scripted by a phrase of the signal (`FACTORY_FAKE_SCREEN_SCRIPT`); every pass
 * is driven through `factory loop run screen` (the interval is off).
 */
let lab: Lab
let dir: string
let screenScript: string

beforeAll(async () => {
  dir = await mkdtemp('/tmp/factory-screen-')
  screenScript = join(dir, 'screen.json')
  await script(screenScript, [])
  lab = await startLab({
    repos: {
      app: { project: 'apiVersion: factory/v2\nname: app\nleads: 2\n' },
      shop: { project: 'apiVersion: factory/v2\nname: shop\nleads: 2\n' },
    },
    env: { FACTORY_FAKE_SCREEN_SCRIPT: screenScript },
  })
  expect((await lab.cli(['project', 'sync'])).code).toBe(0)
})

afterAll(async () => {
  await lab.stop()
  await rm(dir, { recursive: true, force: true })
})

const sql = () => lab.world.db.sql

const held = async (title: string, repo: string | null = 'app'): Promise<string> => {
  const body = { from: 'feedback:app', title, text: `${title} (details)` }
  const out = await lab.cli(['signal', 'file', '--body', JSON.stringify(body)])
  expect(out.code).toBe(0)
  const ack = SignalAck.parse(out.json)
  expect(ack.outcome).toBe('held')
  const id = ack.signal as string
  // an app's feedback takes its repo from the door route, never the payload: the route's effect is set here
  if (repo) await sql()`UPDATE factory.intake_signals SET repo = ${repo} WHERE id = ${id}`
  return id
}

const row = async (id: string) => {
  const [r] = await sql()`
    SELECT state, dismissed_by, dismissed_reason, issue_id, repo, screen_note, screened_at, screen_attempts, screen_retry_at
    FROM factory.intake_signals WHERE id = ${id}`
  return r as Record<string, unknown>
}

const screenCalls = async () => (await callsOf(lab, 'factory-screen')).length

const needs = async () =>
  lab.cli(['read', 'needs']).then((r) => r.json) as Promise<{
    items: { id: string; kind: string; judge: string | null }[]
  }>

test('a pass dismisses the probe and the duplicate, leaves the unclear one with its recommendation, and screens it once', async () => {
  const existing = await lab.file('app', 'Pay button dead on Safari checkout')
  const probe = await held('probe from the app')
  const dup = await held('Checkout pay button does nothing in Safari')
  const unclear = await held('It feels slow sometimes')
  await script(screenScript, [
    {
      match: 'probe from the app',
      answer: { verdict: 'dismiss', reason: 'a test signal', repo: null, duplicateOf: null, recommendation: null },
    },
    {
      match: 'does nothing in safari',
      answer: {
        verdict: 'dismiss',
        reason: 'the same report as the open bug',
        repo: null,
        duplicateOf: existing,
        recommendation: null,
      },
    },
    {
      match: 'feels slow',
      answer: {
        verdict: 'leave',
        reason: 'too vague to act on',
        repo: null,
        duplicateOf: null,
        recommendation: 'Ask the reporter which screen is slow',
      },
    },
  ])

  const ran = await runLoop(lab, 'screen')
  expect(ran).toMatchObject({ started: true, error: null })
  expect(ran.summary).toContain('dismissed 2')
  expect(ran.summary).toContain('left 1')

  expect(await row(probe)).toMatchObject({
    state: 'dismissed',
    dismissed_by: 'judge',
    dismissed_reason: 'a test signal',
  })
  const duplicate = await row(dup)
  expect(duplicate).toMatchObject({ state: 'dismissed', dismissed_by: 'judge' })
  expect(duplicate.dismissed_reason).toContain(`duplicate of ${existing}`)
  const left = await row(unclear)
  expect(left).toMatchObject({ state: 'held', screen_note: 'Ask the reporter which screen is slow' })
  expect(left.screened_at).not.toBeNull()

  const item = (await needs()).items.find((i) => i.id === unclear)
  expect(item).toMatchObject({ kind: 'held_signal', judge: 'Ask the reporter which screen is slow' })

  const calls = await screenCalls()
  expect(calls).toBe(3)
  const second = await runLoop(lab, 'screen')
  expect(second.summary).toBe('no held signal to screen')
  expect(await screenCalls()).toBe(calls)
}, 30000)

test('a promote verdict files an Issue in the repo the signal names; one that names an unknown repo is left', async () => {
  const named = await held('Add a dark theme to the app')
  const unnamed = await held('Dark mode for the shop please', null)
  const bogus = await held('Rename the moon repo', null)
  await script(screenScript, [
    {
      match: 'dark theme',
      answer: { verdict: 'promote', reason: 'a clear request', repo: null, duplicateOf: null, recommendation: null },
    },
    {
      match: 'dark mode for the shop',
      answer: { verdict: 'promote', reason: 'the shop asked', repo: 'shop', duplicateOf: null, recommendation: null },
    },
    {
      match: 'moon repo',
      answer: { verdict: 'promote', reason: 'sure', repo: 'moon', duplicateOf: null, recommendation: null },
    },
  ])
  const ran = await runLoop(lab, 'screen')
  expect(ran.summary).toContain('promoted 2')

  expect(await row(named)).toMatchObject({ state: 'promoted', repo: 'app' })
  expect(await row(unnamed)).toMatchObject({ state: 'promoted', repo: 'shop' })
  const [first, second] = [(await row(named)).issue_id, (await row(unnamed)).issue_id]
  const issues = await sql()`SELECT repo FROM factory.issues WHERE id IN (${first}, ${second}) ORDER BY repo`
  expect(issues.map((i: { repo: string }) => i.repo)).toEqual(['app', 'shop'])
  const refused = await row(bogus)
  expect(refused).toMatchObject({ state: 'held' })
  expect(String(refused.screen_note)).toContain('screen named an unknown repo')
}, 30000)

test('a duplicate of an Issue the Judge was not shown is left, not dismissed', async () => {
  const id = await held('Totally unrelated thing happens')
  await script(screenScript, [
    {
      match: 'unrelated thing',
      answer: { verdict: 'dismiss', reason: 'dup', repo: null, duplicateOf: 'issue_999', recommendation: null },
    },
  ])
  await runLoop(lab, 'screen')
  const r = await row(id)
  expect(r).toMatchObject({ state: 'held' })
  expect(String(r.screen_note)).toContain('issue_999')
}, 30000)

test('the owner dismissing a signal while the Judge is on it is no error', async () => {
  const id = await held('Owner is quicker than the Judge')
  await script(screenScript, [
    {
      match: 'quicker than the judge',
      answer: { verdict: 'dismiss', reason: 'noise', repo: null, duplicateOf: null, recommendation: null },
    },
  ])
  // the owner acts first; the pass finds nothing held to screen, and a claim that raced is a refusal counted, not an error
  expect((await lab.cli(['signal', 'dismiss', id, '--reason', 'mine'])).code).toBe(0)
  const ran = await runLoop(lab, 'screen')
  expect(ran.error).toBeNull()
  expect(await row(id)).toMatchObject({ state: 'dismissed', dismissed_by: 'owner', dismissed_reason: 'mine' })
}, 30000)

test('a missing factory-screen leaves everything held, records the attempts and says so; the loop pass still ends ok', async () => {
  const id = await held('Needs the workflow that is missing')
  await script(screenScript, [{ match: 'missing', answer: null, fail: true }])
  const before = await screenCalls()
  const ran = await runLoop(lab, 'screen')
  expect(ran.error).toBeNull()
  expect(ran.summary).toContain('screen workflow unavailable')
  expect(await screenCalls()).toBe(before + 1)
  const r = await row(id)
  expect(r).toMatchObject({ state: 'held', screen_attempts: 1, screened_at: null })
  expect(r.screen_retry_at).not.toBeNull()

  // backing off: the next pass does not ask again
  await runLoop(lab, 'screen')
  expect(await screenCalls()).toBe(before + 1)

  // due again: asked once more, the attempt counted; after five the signal is left alone for good
  for (let attempt = 2; attempt <= 5; attempt++) {
    await sql()`UPDATE factory.intake_signals SET screen_retry_at = now() - interval '1 minute' WHERE id = ${id}`
    await runLoop(lab, 'screen')
    expect((await row(id)).screen_attempts).toBe(attempt)
  }
  await sql()`UPDATE factory.intake_signals SET screen_retry_at = now() - interval '1 minute' WHERE id = ${id}`
  const calls = await screenCalls()
  await runLoop(lab, 'screen')
  expect(await screenCalls()).toBe(calls)
  expect(await row(id)).toMatchObject({ state: 'held', screen_attempts: 5 })
}, 60000)
