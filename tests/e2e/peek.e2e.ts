import type { Page } from '@playwright/test'
import { expect, test } from './fixtures.ts'
import { api } from './seed.ts'

/**
 * The peek (Issue 664): a plain click on a link to an Issue or an artifact opens it in a right-side panel over the page,
 * Escape and back close it with the page where it was, the address carries it, and a modifier click or "Open full page"
 * is the full page.
 */
interface Item {
  id: string
  title: string
  repo: string
}
interface Flow {
  states: Record<string, { count: number; issues: Item[] }>
}

const numberOf = (id: string) => id.replace('issue_', '')
const panel = (page: Page) => page.getByRole('dialog').and(page.locator('[data-peek-panel]'))
/** The Overview's list of Issues (collapsed until a filter is set), and one row of it. */
const list = (page: Page) => page.getByTestId('flow-list')
const row = (page: Page, title: string) => list(page).getByRole('row').filter({ hasText: title })

async function firstWorking(apiUrl: string): Promise<Item> {
  const flow = await api<Flow>(apiUrl, '/v1/flow')
  const item = flow.states.working?.issues[0]
  if (!item) throw new Error('the seed has no working Issue')
  return item
}

test('from the Overview, a row opens the Issue in the peek and Escape leaves the list where it was', async ({
  page,
  apiUrl,
}) => {
  const working = await firstWorking(apiUrl)
  await page.goto(`/?project=${working.repo}&state=running`)
  const card = row(page, working.title)
  await expect(card).toBeVisible()
  // a mark on the live list: the page underneath must never be remounted, or its scroll and filters would be lost
  await list(page).evaluate((el) => el.setAttribute('data-kept', 'yes'))
  const before = page.url()
  await card.getByRole('link', { name: working.title }).click()

  await expect(panel(page)).toBeVisible()
  await expect(panel(page).getByRole('heading', { level: 1, name: working.title })).toBeVisible()
  expect(new URL(page.url()).searchParams.get('peek')).toBe(`issues/${numberOf(working.id)}`)
  expect(new URL(page.url()).searchParams.get('project')).toBe(working.repo)
  // the row that is open is marked
  await expect(card).toHaveAttribute('aria-current', 'true')
  // the list is still there underneath
  await expect(list(page)).toBeVisible()

  await page.keyboard.press('Escape')
  await expect(panel(page)).toBeHidden()
  expect(page.url()).toBe(before)
  await expect(list(page)).toHaveAttribute('data-kept', 'yes')
  await expect(card).toBeVisible()
  // focus is back on the link that opened it
  await expect(card.getByRole('link', { name: working.title })).toBeFocused()
})

test('the peek address reloads into the same state, and back closes it', async ({ page, apiUrl }) => {
  const working = await firstWorking(apiUrl)
  await page.goto('/?state=running')
  await row(page, working.title).getByRole('link', { name: working.title, exact: true }).click()
  await expect(panel(page)).toBeVisible()
  const opened = page.url()

  await page.reload()
  await expect(panel(page)).toBeVisible()
  await expect(panel(page).getByRole('heading', { level: 1, name: working.title })).toBeVisible()
  expect(page.url()).toBe(opened)

  // a tab picked inside the panel is in the address too
  await panel(page)
    .getByRole('tab', { name: /^Activity/ })
    .click()
  await expect(page).toHaveURL(/peekTab=activity/)
  await page.reload()
  await expect(panel(page).getByRole('tab', { name: /^Activity/ })).toHaveAttribute('aria-selected', 'true')

  await page.goBack()
  await expect(panel(page)).toBeHidden()
  await expect(page).toHaveURL(/\/\?state=running$/)
  await page.goForward()
  await expect(panel(page)).toBeVisible()
})

test('another card swaps what the peek shows in one history step; Escape closes it all', async ({ page, apiUrl }) => {
  const flow = await api<Flow>(apiUrl, '/v1/flow')
  const open = Object.values(flow.states).flatMap((s) => s.issues)
  const a = open[0]
  const b = open.find((issue) => issue.id !== a?.id && issue.repo === a?.repo)
  if (!a || !b) throw new Error('the seed has fewer than two open Issues of one project')
  await page.goto(`/?project=${a.repo}`)
  await page.getByRole('link', { name: a.title, exact: true }).first().click()
  await expect(panel(page).getByRole('heading', { level: 1, name: a.title })).toBeVisible()
  await page.getByRole('link', { name: b.title, exact: true }).first().click()
  await expect(panel(page).getByRole('heading', { level: 1, name: b.title })).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(panel(page)).toBeHidden()
  await expect(page).toHaveURL(new RegExp(`/\\?project=${a.repo}$`))
  // one step back leaves the Overview, not an older peek
  await page.goBack()
  await expect(page).not.toHaveURL(/\?project=/)
})

test('a modifier click and "Open full page" go to the page', async ({ page, apiUrl, context }) => {
  const working = await firstWorking(apiUrl)
  await page.goto('/?state=running')
  const link = row(page, working.title).getByRole('link', { name: working.title, exact: true })
  const [tab] = await Promise.all([context.waitForEvent('page'), link.click({ modifiers: ['ControlOrMeta'] })])
  expect(new URL(tab.url()).pathname).toBe(`/issues/${numberOf(working.id)}`)
  await tab.close()
  await expect(panel(page)).toBeHidden()

  await link.click()
  await expect(panel(page)).toBeVisible()
  await panel(page).getByRole('link', { name: 'Open full page' }).click()
  await expect(page).toHaveURL(new RegExp(`/issues/${numberOf(working.id)}$`))
  await expect(panel(page)).toBeHidden()
  await expect(page.getByRole('heading', { level: 1, name: working.title })).toBeVisible()
})

test('on the Issue page itself a link goes to the page, no peek opens', async ({ page, apiUrl }) => {
  const working = await firstWorking(apiUrl)
  await page.goto(`/issues/${numberOf(working.id)}`)
  await expect(page.getByRole('heading', { level: 1, name: working.title })).toBeVisible()
  await page.getByRole('link', { name: 'See it on the Chain' }).click()
  await expect(page).toHaveURL(/\/chain$/)
  await expect(panel(page)).toBeHidden()
})

test('from the Chain, a node opens the Issue in the peek', async ({ page }) => {
  await page.goto('/chain')
  const node = page
    .getByTestId('chain-node')
    .filter({ has: page.locator('a[href^="/issues/"]') })
    .first()
  await expect(node).toBeVisible()
  const title = (await node.getByRole('heading').first().innerText()).trim()
  await node.locator('a[href^="/issues/"]').click()
  await expect(panel(page).getByRole('heading', { level: 1, name: title })).toBeVisible()
  await expect(page.getByRole('region', { name: 'Dependency chain' })).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(panel(page)).toBeHidden()
  await expect(page).toHaveURL(/\/chain$/)
})

test('an artifact opens in the peek with its document and comments', async ({ page }) => {
  const { shotSpec } = JSON.parse(process.env.E2E_ARTIFACTS ?? '{}') as { shotSpec: string }
  await page.goto(`/needs-you?peek=artifacts/${shotSpec}`)
  await expect(panel(page)).toBeVisible()
  await expect(panel(page).getByRole('heading', { level: 1 }).first()).toBeVisible()
  await expect(panel(page).getByRole('complementary', { name: 'Comments' })).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(panel(page)).toBeHidden()
  await expect(page).toHaveURL(/\/needs-you$/)
})

test('an artifact with revisions switches revision inside the panel and has no comparison there', async ({ page }) => {
  const { revised } = JSON.parse(process.env.E2E_ARTIFACTS ?? '{}') as { revised: string }
  await page.goto(`/needs-you?peek=artifacts/${revised}`)
  await expect(panel(page)).toBeVisible()
  await expect(panel(page).getByLabel('Compare with')).toHaveCount(0)
  const revisions = panel(page).getByRole('navigation', { name: 'Revisions' })
  await revisions.getByRole('link', { name: '1', exact: true }).click()
  await expect(page).toHaveURL(/peekRevision=1/)
  await expect(panel(page)).toBeVisible()
  await expect(revisions.getByRole('link', { name: '1', exact: true })).toHaveAttribute('aria-current', 'page')
})

test('Escape belongs to the palette while it is open, and to a field while it has focus', async ({ page, apiUrl }) => {
  const working = await firstWorking(apiUrl)
  await page.goto(`/?peek=issues/${numberOf(working.id)}`)
  await expect(panel(page)).toBeVisible()
  await page.keyboard.press('ControlOrMeta+K')
  const palette = page.getByRole('dialog').filter({ has: page.getByRole('combobox') })
  await expect(palette).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(palette).toBeHidden()
  await expect(panel(page)).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(panel(page)).toBeHidden()
})
