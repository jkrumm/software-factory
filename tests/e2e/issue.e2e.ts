import type { Locator, Page } from '@playwright/test'
import type { ReadIssueDetail } from '@software-factory/contract'
import { expect, test } from './fixtures.ts'
import type { SeededChain } from './seed-chain.ts'
import type { SeededHistory } from './seed-history.ts'
import { api } from './seed.ts'

/**
 * The Issue page against the real server: Issues seeded by seed-history.ts and seed-chain.ts. The rich one has two attempts
 * (the first lead was lost), a signal and its amendment, a note, two answered Decisions, a Spec and a Concept with different
 * verdicts, a ship with a passed watch and a second ship whose watch regressed; the working one has a live lead. The page is
 * read-only and shows nothing the API does not say, so each figure is compared with `GET /v1/issues/<n>`. This file runs before
 * needs-you (alphabetical) and settles nothing on the owner's list.
 */
const seeded = (): SeededHistory => JSON.parse(process.env.E2E_HISTORY ?? '{}') as SeededHistory
const chained = (): SeededChain => JSON.parse(process.env.E2E_CHAIN ?? '{}') as SeededChain
const numberOf = (ref: string) => ref.replace('issue_', '')
const detailOf = (apiUrl: string, ref: string) => api<ReadIssueDetail>(apiUrl, `/v1/issues/${numberOf(ref)}`)

const TABS = ['overview', 'activity', 'evidence', 'checkpoints'] as const
type Tab = (typeof TABS)[number]
const TAB_NAME: Record<Tab, string> = {
  overview: 'Overview',
  activity: 'Activity',
  evidence: 'Evidence',
  checkpoints: 'Checkpoints',
}
const SESSION_WORD: Record<string, string> = {
  starting: 'Starting',
  working: 'Working',
  idle: 'Idle between turns',
  waiting: 'Waiting',
  walled: 'Stopped at its account limit',
  blocked: 'Blocked',
  stuck: 'Stuck',
  dead: 'Gone',
}

const open = async (page: Page, ref: string, tab?: Tab) => {
  await page.goto(`/issues/${numberOf(ref)}${tab && tab !== 'overview' ? `?tab=${tab}` : ''}`)
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
}
const tabOf = (page: Page, tab: Tab): Locator => page.getByRole('tab', { name: new RegExp(`^${TAB_NAME[tab]}`) })
const section = (scope: Locator | Page, name: string | RegExp): Locator => scope.getByRole('region', { name })
const panel = (page: Page): Locator => page.getByRole('tabpanel')
const aside = (page: Page): Locator => page.getByRole('complementary', { name: 'About this Issue' })
const fact = (scope: Locator | Page, label: string): Locator =>
  scope
    .locator('dt', { hasText: new RegExp(`^${label}$`) })
    .first()
    .locator('xpath=following-sibling::dd[1]')
const figure = async (locator: Locator) => Number((await locator.innerText()).replaceAll(',', ''))
const count = (n: number) => n.toLocaleString('en-US')
const stat = (page: Page, title: string): Locator =>
  page.getByRole('article').filter({ has: page.getByRole('heading', { name: title, exact: true }) })

const NO_IDS = /issue_\d+|lead-\d+|#\d+|\b(decision|artifact|errand|signal)_[a-z0-9]+/

async function noIds(page: Page, ids: string[] = []) {
  const text = await page.locator('body').innerText()
  expect(text.match(NO_IDS)?.[0]).toBeUndefined()
  for (const id of ids) expect(text).not.toContain(id)
}

const idsOf = (issue: ReadIssueDetail) => [
  issue.ref,
  ...issue.asks.map((a) => a.id),
  ...issue.artifacts.map((a) => a.id),
  ...issue.sessions.map((s) => s.id),
]

test('the header shows title, kind, state, project, regressions and the facts', async ({ page, apiUrl }) => {
  const { rich } = seeded()
  const issue = await detailOf(apiUrl, rich)
  expect(issue.sessions).toHaveLength(2)
  await open(page, rich)
  await expect(page.getByRole('heading', { level: 1, name: issue.title })).toBeVisible()
  if (issue.kind)
    await expect(
      page.getByText(issue.kind.charAt(0).toUpperCase() + issue.kind.slice(1), { exact: true }).first(),
    ).toBeVisible()
  const header = page.locator('main header').first()
  await expect(header.getByText(/^(Being settled|Queued|Working|Waiting|Watching|Done|Closed)/).first()).toBeVisible()
  const project = page.getByRole('link', { name: issue.repoName, exact: true }).first()
  await expect(project).toHaveAttribute('href', `/flow?project=${issue.repoName}`)
  await project.click()
  await expect(page).toHaveURL(new RegExp(`/flow\\?project=${issue.repoName}$`))
  await page.goBack()

  const regressions = Math.max(
    issue.timeline.filter((line) => line.kind === 'regressed').length,
    issue.shipping.filter((ship) => ship.watch?.answer === 'regressed').length,
  )
  expect(regressions).toBeGreaterThan(0)
  await expect(page.getByText(`Regressed ${regressions}×`)).toBeVisible()
  expect(await figure(fact(page, 'Attempts'))).toBe(issue.insights.attempts)
  await noIds(page, idsOf(issue))
})

test('the working Issue has no regression badge and shows its live attempt', async ({ page, apiUrl }) => {
  const { working } = seeded()
  const issue = await detailOf(apiUrl, working)
  expect(issue.sessions.length).toBeGreaterThan(0)
  await open(page, working)
  await expect(page.getByRole('heading', { level: 1, name: issue.title })).toBeVisible()
  await expect(page.getByText(/^Regressed \d+×$/)).toHaveCount(0)
  const attempts = section(page, 'Attempts')
  const live = issue.sessions.at(-1)
  if (!live) throw new Error('no attempt')
  const row = attempts.getByRole('listitem').nth(issue.sessions.length - 1)
  await expect(row).toContainText(`Attempt ${issue.sessions.length}`)
  await expect(row).toContainText(SESSION_WORD[live.state] ?? '')
  await expect(row).toContainText(`Turn ${live.turn}`)
  await expect(page.getByText('Waiting on you')).toHaveCount(0)
  await noIds(page, idsOf(issue))
})

test('the tabs are reachable by click and by link, keep the tab on reload and count what the API holds', async ({
  page,
  apiUrl,
}) => {
  const { rich } = seeded()
  const issue = await detailOf(apiUrl, rich)
  const counts: Record<Tab, number | null> = {
    overview: null,
    activity: issue.timeline.length,
    evidence: issue.shipping.length + issue.evidence.length,
    checkpoints: issue.asks.length + issue.artifacts.length,
  }
  await open(page, rich)
  await expect(page.getByRole('tablist', { name: 'Issue sections' })).toBeVisible()
  await expect(tabOf(page, 'overview')).toHaveAttribute('aria-selected', 'true')
  for (const tab of TABS) {
    const n = counts[tab]
    if (n !== null) await expect(tabOf(page, tab)).toHaveAccessibleName(new RegExp(`^${TAB_NAME[tab]}\\s*${n}`))
  }

  for (const tab of TABS.slice(1)) {
    await tabOf(page, tab).click()
    await expect(page).toHaveURL(new RegExp(`\\?tab=${tab}$`))
    await expect(tabOf(page, tab)).toHaveAttribute('aria-selected', 'true')
    for (const other of TABS.filter((t) => t !== tab))
      await expect(tabOf(page, other)).toHaveAttribute('aria-selected', 'false')
    await page.reload()
    await expect(tabOf(page, tab)).toHaveAttribute('aria-selected', 'true')
    await noIds(page, idsOf(issue))
  }
  await tabOf(page, 'overview').click()
  await expect(page).not.toHaveURL(/tab=/)

  for (const tab of TABS) {
    await page.goto(`/issues/${numberOf(rich)}?tab=${tab}`)
    await expect(tabOf(page, tab)).toHaveAttribute('aria-selected', 'true')
  }
  await page.goto(`/issues/${numberOf(rich)}?tab=x`)
  await expect(tabOf(page, 'overview')).toHaveAttribute('aria-selected', 'true')
  await expect(section(page, 'What it is')).toBeVisible()
})

test('the arrow keys move between the tabs', async ({ page }) => {
  const { rich } = seeded()
  await open(page, rich)
  await tabOf(page, 'overview').focus()
  await page.keyboard.press('ArrowRight')
  await expect(tabOf(page, 'activity')).toBeFocused()
  await page.keyboard.press('Enter')
  await expect(tabOf(page, 'activity')).toHaveAttribute('aria-selected', 'true')
  await page.keyboard.press('ArrowRight')
  await page.keyboard.press('ArrowRight')
  await expect(tabOf(page, 'checkpoints')).toBeFocused()
  await page.keyboard.press('Enter')
  await expect(tabOf(page, 'checkpoints')).toHaveAttribute('aria-selected', 'true')
  await page.keyboard.press('ArrowLeft')
  await expect(tabOf(page, 'evidence')).toBeFocused()
})

test('the overview figures are the totals of the API, with a bar per attempt', async ({ page, apiUrl }) => {
  const { rich } = seeded()
  const issue = await detailOf(apiUrl, rich)
  await open(page, rich)
  const { insights } = issue
  await expect(stat(page, 'Turns').locator('span.proportional-nums')).toHaveText(count(insights.turns))
  await expect(stat(page, 'Tokens out').locator('span.proportional-nums')).toHaveText(count(insights.tokens.output))
  await expect(stat(page, 'Tokens out')).toContainText(count(insights.tokens.input))
  await expect(stat(page, 'Working time').locator('span.proportional-nums')).toHaveText(/^[\d.]+ (ms|s|min)$/)
  for (const [title, pick] of [
    ['Turns', (s: ReadIssueDetail['sessions'][number]) => s.insights.turns],
    ['Tokens out', (s: ReadIssueDetail['sessions'][number]) => s.insights.tokens.output],
  ] as const) {
    const chart = stat(page, title).getByRole('group', { name: new RegExp(`^${title}: 2 values`) })
    await expect(chart).toBeVisible()
    for (const [i, session] of issue.sessions.entries()) {
      const row = chart.getByRole('row', { name: new RegExp(`^Attempt ${i + 1}`) })
      await expect(row.getByRole('cell')).toHaveText(count(pick(session)))
    }
  }

  const attempts = section(page, 'Attempts')
  await expect(attempts.getByRole('heading', { level: 2 })).toHaveText('Attempts')
  await expect(attempts.getByRole('listitem')).toHaveCount(issue.sessions.length)
  for (const [i, session] of issue.sessions.entries()) {
    const row = attempts.getByRole('listitem').nth(i)
    await expect(row).toContainText(`Attempt ${i + 1}`)
    await expect(row).toContainText(SESSION_WORD[session.state] ?? '')
    await expect(row).toContainText(`Turn ${session.turn}`)
  }

  const triage = section(page, 'How it came to be')
  await expect(triage.getByText('Filed by you')).toBeVisible()
  await expect(triage.getByText('Amended by you')).toBeVisible()
  await expect(triage.getByText('The job fails silently when the disk is full.')).toBeVisible()
  await expect(triage.getByText('It also needs to report the last run time.')).toBeVisible()
  await noIds(page, idsOf(issue))
})

test('the activity is one row per event, oldest first, under its attempt', async ({ page, apiUrl }) => {
  const { rich } = seeded()
  const issue = await detailOf(apiUrl, rich)
  await open(page, rich, 'activity')
  const rows = panel(page).getByRole('listitem')
  await expect(rows).toHaveCount(issue.timeline.length)
  const texts = await rows.allInnerTexts()
  for (const [i, line] of issue.timeline.entries()) expect(texts[i]).toContain(line.text)
  await expect(rows.first()).toContainText(issue.timeline[0]?.text ?? '')
  await expect(rows.last()).toContainText(issue.timeline.at(-1)?.text ?? '')

  const headings = await panel(page).getByRole('heading', { level: 3 }).allInnerTexts()
  expect(headings.filter((h) => /^Attempt \d+$/.test(h))).toEqual(['Attempt 1', 'Attempt 2'])
  await expect(panel(page).getByText(`${issue.timeline.length} events over`)).toBeVisible()

  const gone = issue.timeline.find((line) => line.kind === 'lead_gone')
  if (!gone) throw new Error('the rich Issue lost no lead')
  await expect(section(page, 'Attempt 1').getByRole('listitem').filter({ hasText: gone.text })).toBeVisible()
  const attemptTwo = await section(page, 'Attempt 2').getByRole('listitem').allInnerTexts()
  expect(attemptTwo.length).toBeGreaterThan(0)
  expect(attemptTwo.join('\n')).not.toContain(gone.text)
  await noIds(page, idsOf(issue))
})

test('the evidence lists both ships with their watch, acceptance and checks', async ({ page, apiUrl }) => {
  const { rich } = seeded()
  const issue = await detailOf(apiUrl, rich)
  await open(page, rich, 'evidence')
  const passed = issue.shipping.find((ship) => ship.watch?.answer === 'passed')
  const regressed = issue.shipping.find((ship) => ship.watch?.answer === 'regressed')
  if (!passed || !regressed) throw new Error('the rich Issue needs a passed and a regressed ship')
  expect(passed.attempt).toBe(1)
  expect(regressed.attempt).toBe(2)

  const first = section(page, /attempt 1$/)
  await expect(first.getByText('Passed', { exact: true })).toBeVisible()
  await expect(first.getByText('2 commits')).toBeVisible()
  await expect(first.getByText('a1b2c3d b2c3d4e')).toBeVisible()
  await expect(first.getByText('Review: present')).toBeVisible()
  await expect(first.getByText(/Watch: Passed .* window of 1 minute/)).toBeVisible()
  await expect(first.getByText('Met', { exact: true })).toBeVisible()
  await expect(first.getByText('the export downloads')).toBeVisible()
  await expect(first.getByText('Not met', { exact: true })).toBeVisible()
  await expect(first.getByText('no CSV header yet')).toBeVisible()
  await expect(first.getByText('All 2 checks passed.')).toBeVisible()

  const second = section(page, /attempt 2$/)
  await expect(second.getByText('Regressed', { exact: true })).toBeVisible()
  await expect(second.getByText('1 commit', { exact: true })).toBeVisible()
  await expect(second.getByText('c3d4e5f')).toBeVisible()
  await expect(second.getByText(/Watch: Regressed .* window of 1 minute/)).toBeVisible()
  await expect(second.getByText('the probe reports free disk space')).toBeVisible()
  await expect(second.getByText('the probe fails the job on a full disk')).toBeVisible()
  expect(regressed.checks).toHaveLength(1)
  expect(regressed.checks[0]?.result).toBe('red')
  await expect(second.getByText(regressed.checks[0]?.summary ?? 'missing')).toBeVisible()
  const order = await panel(page).getByRole('heading', { level: 2 }).allInnerTexts()
  expect(order.findIndex((h) => h.endsWith('attempt 2'))).toBeLessThan(order.findIndex((h) => h.endsWith('attempt 1')))

  expect(issue.evidence.length).toBeGreaterThan(0)
  const fold = page.getByRole('button', { name: /^Recorded evidence/ })
  await expect(fold).toHaveAttribute('aria-expanded', 'false')
  await fold.click()
  await expect(fold).toHaveAttribute('aria-expanded', 'true')
  await expect(panel(page).locator('li', { hasText: /\d+ min ago|just now/ })).not.toHaveCount(0)
  expect(await fold.innerText()).toContain(String(issue.evidence.length))
  await noIds(page, idsOf(issue))
})

test('the checkpoints show the Decisions with their options, the artifacts and the notes', async ({ page, apiUrl }) => {
  const { rich } = seeded()
  const issue = await detailOf(apiUrl, rich)
  expect(issue.asks).toHaveLength(2)
  expect(issue.artifacts).toHaveLength(2)
  await open(page, rich, 'checkpoints')
  const decisions = section(page, 'Decisions')
  for (const ask of issue.asks) {
    expect(ask.status).toBe('answered')
    const block = decisions.getByRole('listitem').filter({ hasText: ask.question }).first()
    await expect(block).toBeVisible()
    await expect(block.getByText('Answered', { exact: true })).toBeVisible()
    await expect(block.getByText('by you')).toBeVisible()
    for (const option of ask.options) {
      const line = block.locator('ul > li').filter({ has: page.getByText(option, { exact: true }) })
      await expect(line).toBeVisible()
      await expect(line.getByText('Recommended', { exact: true })).toHaveCount(
        ask.recommendation.startsWith(option) ? 1 : 0,
      )
      await expect(line.getByText('Answer', { exact: true })).toHaveCount(option === ask.answer ? 1 : 0)
    }
  }
  await expect(decisions.getByText('Read how the other jobs report a full disk.').first()).toBeVisible()

  const artifacts = section(page, 'Specs, Concepts and Reports')
  await expect(artifacts.getByRole('link')).toHaveCount(2)
  const spec = issue.artifacts.find((a) => a.title === 'The probe spec')
  const concept = issue.artifacts.find((a) => a.title === 'The probe alerting concept')
  if (!spec || !concept) throw new Error('the rich Issue lacks its artifacts')
  expect(spec.verdict).toBe('looks_good')
  expect(concept.verdict).toBe('no_longer_applies')
  await expect(artifacts.getByRole('link', { name: /The probe spec/ })).toContainText('Looks good')
  await expect(artifacts.getByRole('link', { name: /The probe spec/ })).toContainText(`${spec.revisions} revision`)
  await expect(artifacts.getByRole('link', { name: /The probe alerting concept/ })).not.toContainText('Looks good')
  await expect(artifacts.getByRole('link', { name: /The probe alerting concept/ })).not.toContainText('No verdict yet')
  await artifacts.getByRole('link', { name: /The probe spec/ }).click()
  await expect(page).toHaveURL(new RegExp(`/artifacts/${spec.id}$`))
  await page.goBack()
  await expect(tabOf(page, 'checkpoints')).toHaveAttribute('aria-selected', 'true')

  const notes = section(page, 'Notes you sent')
  await expect(notes.getByText('Use the existing /health route, do not add a second one.')).toBeVisible()
  await expect(notes.getByText(/Delivered to the lead|Sent, not confirmed yet|In the next brief/).first()).toBeVisible()
  await noIds(page, idsOf(issue))
})

test('the aside lists what the Issue waits on and what waits on it', async ({ page, apiUrl }) => {
  const { gate, done, middle, last } = chained()
  const [gateIssue, doneIssue, lastIssue] = await Promise.all([gate, done, last].map((ref) => detailOf(apiUrl, ref)))
  await open(page, middle)
  const side = aside(page)
  const waits = side.getByRole('heading', { name: 'Waits on' }).locator('xpath=following-sibling::ul[1]')
  await expect(waits.getByRole('listitem')).toHaveCount(2)
  await expect(waits.getByRole('listitem').filter({ hasText: gateIssue?.title ?? '' })).toContainText('Blocking')
  await expect(waits.getByRole('listitem').filter({ hasText: doneIssue?.title ?? '' })).toContainText('Done')
  const blocks = side.getByRole('heading', { name: 'Blocks' }).locator('xpath=following-sibling::ul[1]')
  await expect(blocks.getByRole('listitem')).toHaveCount(1)
  await expect(blocks.getByRole('listitem').filter({ hasText: lastIssue?.title ?? '' })).toContainText('Blocking')
  await noIds(page)

  await waits.getByRole('link', { name: gateIssue?.title ?? '' }).click()
  await expect(page).toHaveURL(new RegExp(`/issues/${numberOf(gate)}$`))
  await expect(page.getByRole('heading', { level: 1, name: gateIssue?.title })).toBeVisible()
  await page.goBack()
  await blocks.getByRole('link', { name: lastIssue?.title ?? '' }).click()
  await expect(page.getByRole('heading', { level: 1, name: lastIssue?.title })).toBeVisible()
  await expect(page).toHaveURL(new RegExp(`/issues/${numberOf(last)}$`))
})

test('an Issue with no chain says it waits on nothing', async ({ page }) => {
  const { rich } = seeded()
  await open(page, rich)
  await expect(aside(page).getByText('This Issue waits on nothing and nothing waits on it.')).toBeVisible()
  await expect(section(aside(page), 'Properties')).toBeVisible()
})

test('an unknown Issue says so', async ({ page }) => {
  await page.goto('/issues/999999')
  await expect(page.getByText('No such Issue')).toBeVisible()
})

test('a note filed through the API appears without a reload', async ({ page, apiUrl }) => {
  const { working } = seeded()
  await open(page, working, 'checkpoints')
  await expect(section(page, 'Notes you sent').getByText('You sent no note.')).toBeVisible()
  await page.evaluate('window.__kept = true')
  await api(apiUrl, `/issues/${working}/note`, { text: 'Keep the change small.' })
  await expect(section(page, 'Notes you sent').getByText('Keep the change small.')).toBeVisible()
  expect(await page.evaluate('window.__kept')).toBe(true)
})

const scrolls = async (page: Page) =>
  (await page.evaluate(
    '({ scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth })',
  )) as { scroll: number; client: number }

test('the page uses the width of a large screen', async ({ page }) => {
  const { rich } = seeded()
  await open(page, rich)
  await expect(section(page, 'What it is')).toBeVisible()
  const main = await page.locator('[data-slot="tabs"]').boundingBox()
  const side = await aside(page).boundingBox()
  if (!main || !side) throw new Error('no layout')
  expect(main.width).toBeGreaterThan(900)
  expect(side.x).toBeGreaterThan(main.x + main.width - 1)
  const widths = await scrolls(page)
  expect(widths.scroll).toBeLessThanOrEqual(widths.client)
})

test.describe('on a phone', () => {
  test.use({ viewport: { width: 390, height: 844 } })

  test('every tab stacks and does not scroll sideways, with the aside below', async ({ page }) => {
    const { rich } = seeded()
    await open(page, rich)
    for (const tab of TABS) {
      await tabOf(page, tab).scrollIntoViewIfNeeded()
      await tabOf(page, tab).click()
      await expect(tabOf(page, tab)).toHaveAttribute('aria-selected', 'true')
      const current = page.getByRole('tabpanel', { name: new RegExp(`^${TAB_NAME[tab]}`) })
      await expect(current).toBeVisible()
      await page.waitForLoadState('networkidle')
      const widths = await scrolls(page)
      expect(widths.scroll, `${tab} scrolls sideways`).toBeLessThanOrEqual(widths.client)
      const edges = (await page.evaluate(`(() => {
        const rect = (selector) => document.querySelector(selector)?.getBoundingClientRect()
        const tabs = rect('[data-slot="tabs"]')
        const side = rect('aside[aria-label="About this Issue"]')
        return { tabsBottom: tabs?.bottom, sideTop: side?.top }
      })()`)) as { tabsBottom: number; sideTop: number }
      expect(edges.sideTop, `${tab}: the aside starts below the tabs`).toBeGreaterThanOrEqual(edges.tabsBottom - 1)
    }
  })
})
