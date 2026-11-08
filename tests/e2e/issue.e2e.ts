import type { Locator, Page } from '@playwright/test'
import type { ReadIssueDetail } from '@software-factory/contract'
import { expect, test } from './fixtures.ts'
import type { SeededHistory } from './seed-history.ts'
import { api } from './seed.ts'

/**
 * The Issue page against the real server: two Issues seeded by seed-history.ts. The rich one has a signal and its amendment,
 * a note, an answered Decision, a Spec with a verdict and a ship with a passed watch; the working one has a live lead. The
 * page is read-only and shows nothing the API does not say, so each figure is compared with `GET /v1/issues/<n>`. This file
 * runs before needs-you (alphabetical) and settles nothing on the owner's list.
 */
const seeded = (): SeededHistory => JSON.parse(process.env.E2E_HISTORY ?? '{}') as SeededHistory
const numberOf = (ref: string) => ref.replace('issue_', '')
const detailOf = (apiUrl: string, ref: string) => api<ReadIssueDetail>(apiUrl, `/v1/issues/${numberOf(ref)}`)

const section = (page: Page, name: string): Locator => page.getByRole('region', { name, exact: true })
const stat = (scope: Locator | Page, label: string): Locator =>
  scope.locator('dt', { hasText: new RegExp(`^${label}$`) }).locator('xpath=following-sibling::dd[1]')
const figure = async (locator: Locator) => Number((await locator.innerText()).replaceAll(',', ''))

const NO_IDS = /issue_\d+|lead-\d+|#\d+|\b(decision|artifact|errand|signal)_[a-z0-9]+/

async function noIds(page: Page, ids: string[] = []) {
  const text = await page.locator('body').innerText()
  expect(text).not.toMatch(NO_IDS)
  for (const id of ids) expect(text).not.toContain(id)
}

test('the rich Issue shows each section with what was seeded, and no id', async ({ page, apiUrl }) => {
  const { rich } = seeded()
  const api_ = await detailOf(apiUrl, rich)
  await page.goto(`/issues/${numberOf(rich)}`)
  await expect(page.getByRole('heading', { level: 1, name: api_.title })).toBeVisible()
  await expect(page.getByText(api_.summary ?? '', { exact: true })).toBeVisible()
  await expect(page.getByText(api_.repoName, { exact: true })).toBeVisible()

  // how it came to be
  const triage = section(page, 'How it came to be')
  await expect(triage.getByText('Filed by you')).toBeVisible()
  await expect(triage.getByText('Amended by you')).toBeVisible()
  await expect(triage.getByText('The job fails silently when the disk is full.')).toBeVisible()
  await expect(triage.getByText('It also needs to report the last run time.')).toBeVisible()
  await expect(triage.getByText('Add a health probe to the export job').first()).toBeVisible()

  // notes
  const notes = section(page, 'Notes you sent')
  await expect(notes.getByText('Use the existing /health route, do not add a second one.')).toBeVisible()
  await expect(notes.getByText(/Delivered to the lead|Sent, not confirmed yet|In the next brief/)).toBeVisible()

  // decisions
  const decisions = section(page, 'Decisions')
  await expect(decisions.getByText('Should the probe fail the job or only warn?')).toBeVisible()
  await expect(decisions.getByText('Answered', { exact: true })).toBeVisible()
  await expect(decisions.getByText('Answer: warn')).toBeVisible()
  await expect(decisions.getByText('by you')).toBeVisible()
  await expect(decisions.getByText('Read how the other jobs report a full disk.')).toBeVisible()
  await expect(decisions.getByText('fail', { exact: true })).toBeVisible()
  await expect(decisions.getByRole('link')).toHaveCount(0)

  // artifacts
  const artifacts = section(page, 'Artifacts')
  await expect(artifacts.getByText('The probe spec')).toBeVisible()
  await expect(artifacts.getByText('Looks good')).toBeVisible()
  await expect(artifacts.getByText(/^1 revision$/)).toBeVisible()
  await artifacts.getByRole('link', { name: 'Open the artifact' }).click()
  await expect(page).toHaveURL(new RegExp(`/artifacts/${api_.artifacts[0]?.id}$`))
  await page.goBack()

  // shipping and evidence (open by default)
  const shipping = section(page, 'Shipping and evidence')
  await expect(shipping.getByText('Accepted', { exact: true })).toBeVisible()
  await expect(shipping.getByText('2 commits')).toBeVisible()
  await expect(shipping.getByText('a1b2c3d b2c3d4e')).toBeVisible()
  await expect(shipping.getByText('Review: present')).toBeVisible()
  await expect(shipping.getByText(/Watch: Passed .* window of 1 minute/)).toBeVisible()
  await expect(shipping.getByText('All 2 checks passed.')).toBeVisible()
  await expect(shipping.getByText('Evidence', { exact: true })).toBeVisible()

  // history, closed until opened, oldest first, in plain words with no session id
  const history = section(page, 'History, oldest first')
  await expect(history.locator('details')).not.toHaveAttribute('open', '')
  await history.getByText('History, oldest first').click()
  await expect(history.locator('li').first()).toBeVisible()
  expect(await history.locator('li').count()).toBe(api_.timeline.length)
  await expect(history.locator('li').first()).toContainText(api_.timeline[0]?.text ?? '')
  await expect(history.locator('li').last()).toContainText(api_.timeline.at(-1)?.text ?? '')

  await noIds(page, [
    api_.ref,
    ...api_.asks.map((a) => a.id),
    ...api_.artifacts.map((a) => a.id),
    ...api_.sessions.map((s) => s.id),
  ])
})

test("every number on the page is the API's", async ({ page, apiUrl }) => {
  const { rich } = seeded()
  const issue = await detailOf(apiUrl, rich)
  await page.goto(`/issues/${numberOf(rich)}`)
  const facts = section(page, 'Facts')
  await expect(stat(facts, 'Turns')).toBeVisible()
  expect(await figure(stat(facts, 'Turns'))).toBe(issue.insights.turns)
  expect(await figure(stat(facts, 'Attempts'))).toBe(issue.insights.attempts)
  expect(await figure(stat(facts, 'Tokens in'))).toBe(issue.insights.tokens.input)
  expect(await figure(stat(facts, 'Tokens out'))).toBe(issue.insights.tokens.output)
  expect(await figure(stat(facts, 'Cache read'))).toBe(issue.insights.tokens.cacheRead)
  expect(await figure(stat(facts, 'Cache write'))).toBe(issue.insights.tokens.cacheWrite)
  if (issue.insights.partial) {
    await expect(facts.getByText('Tool calls and subagents are not counted yet.')).toBeVisible()
    await expect(stat(facts, 'Tool calls')).toHaveCount(0)
  } else {
    expect(await figure(stat(facts, 'Tool calls'))).toBe(issue.insights.toolCalls)
    expect(await figure(stat(facts, 'Subagents'))).toBe(issue.insights.subagents)
  }
  if (issue.quota?.weeklyUsed != null)
    await expect(stat(facts, 'Weekly quota')).toContainText(`${Math.round(issue.quota.weeklyUsed)}%`)
  if (issue.account) await expect(stat(facts, 'Account')).toHaveText(issue.account)
  for (const model of issue.insights.models) await expect(stat(facts, 'Models')).toContainText(model)

  const sessions = section(page, 'Attempts')
  await expect(sessions.locator('article, div').first()).toBeVisible()
  for (const [i, session] of issue.sessions.entries()) {
    const card = sessions.locator('div.rounded-xl').nth(i)
    await expect(card.getByText(`Attempt ${i + 1}`)).toBeVisible()
    await expect(card.getByText(`Turn ${session.turn}`)).toBeVisible()
    expect(await figure(stat(card, 'Turns'))).toBe(session.insights.turns)
  }
  await expect(sessions.locator('h2')).toContainText(String(issue.sessions.length))

  const shipping = section(page, 'Shipping and evidence')
  const ship = issue.shipping[0]
  if (!ship) throw new Error('the rich Issue has no ship')
  await expect(shipping.getByText(`${ship.commits.length} commits`)).toBeVisible()
  await expect(shipping.getByText(`attempt ${ship.attempt}`)).toBeVisible()
  await expect(shipping.getByText(`window of ${(ship.watch?.windowMs ?? 0) / 60_000} minute`)).toBeVisible()
  expect(ship.checks).toHaveLength(1)
  await expect(shipping.getByText(ship.checks[0]?.summary ?? 'missing')).toBeVisible()
  expect(ship.watch?.answer).toBe('passed')
  expect(ship.checks.every((c) => c.result === 'green')).toBe(true)
  await expect(section(page, 'Notes you sent').locator('h2')).toContainText(String(issue.notes.length))
  const spec = issue.artifacts[0]
  await expect(section(page, 'Artifacts').getByText(`${spec?.revisions} revision`)).toBeVisible()
})

test('the working Issue shows its live attempt', async ({ page, apiUrl }) => {
  const { working } = seeded()
  const issue = await detailOf(apiUrl, working)
  expect(issue.sessions.length).toBeGreaterThan(0)
  await page.goto(`/issues/${numberOf(working)}`)
  await expect(page.getByRole('heading', { level: 1, name: issue.title })).toBeVisible()
  const sessions = section(page, 'Attempts')
  const live = issue.sessions.at(-1)
  if (!live) throw new Error('no attempt')
  await expect(sessions.getByText(`Attempt ${issue.sessions.length}`)).toBeVisible()
  await expect(
    sessions.getByText(live.state === 'working' ? 'Working' : /./, { exact: live.state === 'working' }).first(),
  ).toBeVisible()
  await expect(sessions.getByText(`Turn ${live.turn}`)).toBeVisible()
  await expect(page.getByText('Waiting on you')).toHaveCount(0)
  await noIds(page, [issue.ref, ...issue.sessions.map((s) => s.id)])
})

test('an unknown Issue says so', async ({ page }) => {
  await page.goto('/issues/999999')
  await expect(page.getByText('No such Issue')).toBeVisible()
})

test('a note filed through the API appears without a reload', async ({ page, apiUrl }) => {
  const { working } = seeded()
  await page.goto(`/issues/${numberOf(working)}`)
  await expect(section(page, 'Notes you sent').getByText('You sent no note.')).toBeVisible()
  await page.evaluate('window.__kept = true')
  await api(apiUrl, `/issues/${working}/note`, { text: 'Keep the change small.' })
  await expect(section(page, 'Notes you sent').getByText('Keep the change small.')).toBeVisible()
  expect(await page.evaluate('window.__kept')).toBe(true)
})

test.describe('on a phone', () => {
  test.use({ viewport: { width: 390, height: 844 } })

  test('the page stacks and does not scroll sideways', async ({ page, apiUrl }) => {
    const { rich } = seeded()
    await page.goto(`/issues/${numberOf(rich)}`)
    await expect(section(page, 'Facts')).toBeVisible()
    await section(page, 'History, oldest first').getByText('History, oldest first').click()
    const widths = (await page.evaluate(
      '({ scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth })',
    )) as { scroll: number; client: number }
    expect(widths.scroll).toBeLessThanOrEqual(widths.client)
    const issue = await detailOf(apiUrl, rich)
    await expect(page.getByRole('heading', { level: 1, name: issue.title })).toBeVisible()
  })
})
