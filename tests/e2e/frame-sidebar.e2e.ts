import type { Page } from '@playwright/test'
import { expect, test } from './fixtures.ts'
import { api, needsCount } from './seed.ts'

/** The sidebar: logo and wordmark, the global nav with counts and keys, collapse, and the page's own section. */
const NAV = [
  { label: 'Needs you', path: '/needs-you', key: 'N' },
  { label: 'Flow', path: '/flow', key: 'F' },
  { label: 'Chain', path: '/chain', key: 'C' },
  { label: 'Improve', path: '/improve', key: 'I' },
] as const

const STATES = ['settling', 'queued', 'working', 'waiting', 'watching'] as const
interface Flow {
  states: Record<(typeof STATES)[number], { count: number; issues: { repo: string; origin: string }[] }>
  closedRecently: { repo: string; origin: string }[]
}
const KIND_WORD = { decision: 'Decisions', review: 'Reviews', errand: 'Errands', held_signal: 'Held signals' } as const

const aside = (page: Page) => page.locator('aside')
const nav = (page: Page) => page.getByRole('navigation', { name: 'Main' })
const section = (page: Page, name: string) => aside(page).getByRole('group', { name })
const toggle = (page: Page, name: string, label: RegExp | string) =>
  section(page, name).getByRole('link', { name: label })

test('the logo and the wordmark are at the top', async ({ page }) => {
  await page.goto('/needs-you')
  await expect(page.getByTestId('sidebar-logo')).toBeVisible()
  const box = await page.getByTestId('sidebar-logo').boundingBox()
  expect(box?.width).toBe(28)
  expect(box?.height).toBe(28)
  await expect(aside(page).getByText('Factory', { exact: true })).toBeVisible()
})

test('each entry navigates and shows its key on hover', async ({ page }) => {
  await page.goto('/needs-you')
  for (const { label, path, key } of NAV) {
    const link = nav(page).getByRole('link', { name: new RegExp(`^${label}`) })
    await link.hover()
    await expect(link.locator('kbd')).toBeVisible()
    await expect(link.locator('kbd')).toContainText(key)
    await link.click()
    await expect(page).toHaveURL(new RegExp(`${path}$`))
    await expect(link).toHaveAttribute('data-status', 'active')
  }
})

test('the counts are the API: waiting on Needs you, working on Flow', async ({ page, apiUrl }) => {
  const needs = await needsCount(apiUrl)
  const flow = await api<Flow>(apiUrl, '/v1/flow')
  await page.goto('/chain')
  await expect(nav(page).getByLabel(`${needs} waiting`)).toHaveText(String(needs))
  const working = flow.states.working.count
  if (working > 0) await expect(nav(page).getByLabel(`${working} working`)).toHaveText(String(working))
  else await expect(nav(page).getByLabel(/\d+ working/)).toHaveCount(0)
})

test('it collapses to icons, keeps the choice across a reload and expands again', async ({ page }) => {
  await page.goto('/flow')
  const width = async () => (await aside(page).boundingBox())?.width ?? 0
  await expect.poll(width).toBeCloseTo(224, 0)
  await expect(section(page, 'Projects')).toBeVisible()

  await page.getByRole('button', { name: 'Collapse sidebar' }).click()
  await expect(aside(page)).toHaveAttribute('data-collapsed', 'true')
  await expect.poll(width).toBeCloseTo(56, 0)
  await expect(section(page, 'Projects')).toBeHidden()
  await expect(aside(page).getByText('Factory', { exact: true })).toBeHidden()
  await expect(nav(page).getByRole('link', { name: 'Flow' })).toBeVisible()
  await nav(page).getByRole('link', { name: 'Chain' }).hover()
  await expect(page.locator('[data-slot="tooltip-content"]')).toContainText('Chain')

  await page.reload()
  await expect(aside(page)).toHaveAttribute('data-collapsed', 'true')
  await expect(section(page, 'Projects')).toBeHidden()

  await page.getByRole('button', { name: 'Expand sidebar' }).click()
  await expect(aside(page)).toHaveAttribute('data-collapsed', 'false')
  await page.reload()
  await expect(aside(page)).toHaveAttribute('data-collapsed', 'false')
  await expect(section(page, 'Projects')).toBeVisible()
})

test('collapsed, the active filters show as removable chips and the window switch stays', async ({ page }) => {
  await page.goto('/flow?project=argo')
  const chips = page.getByRole('group', { name: 'Active filters' })
  await expect(chips).toBeHidden()
  await page.getByRole('button', { name: 'Collapse sidebar' }).click()
  await expect(chips.getByRole('link', { name: 'Remove filter Project: argo' })).toBeVisible()
  await chips.getByRole('link', { name: 'Remove filter Project: argo' }).click()
  await expect(page).not.toHaveURL(/project=/)
  await expect(chips).toBeHidden()

  await page.goto('/chain?project=pearl')
  await expect(chips.getByRole('link', { name: 'Remove filter Project: pearl' })).toBeVisible()
  await page.goto('/needs-you?kind=errand')
  await expect(chips.getByRole('link', { name: 'Remove filter Kind: Errands' })).toBeVisible()
  await page.goto('/improve')
  await expect(page.getByRole('navigation', { name: 'Window' })).toBeVisible()
  await expect(nav(page).getByRole('link', { name: /^Needs you/ })).toHaveAttribute('aria-label', /waiting/)
  await page.getByRole('button', { name: 'Expand sidebar' }).click()
})

test('a kind with nothing waiting says so and links back', async ({ page, apiUrl }) => {
  const { counts } = await api<{ counts: Record<keyof typeof KIND_WORD, number> }>(apiUrl, '/v1/needs')
  const empty = (Object.keys(KIND_WORD) as (keyof typeof KIND_WORD)[]).find((k) => counts[k] === 0)
  if (!empty) return
  await page.goto(`/needs-you?kind=${empty}`)
  await expect(page.getByText('Nothing of this kind waits.')).toBeVisible()
  await page.getByRole('link', { name: 'Show everything that waits' }).click()
  await expect(page).not.toHaveURL(/kind=/)
})

test('Flow: projects and origins toggle the URL and the board, All clears', async ({ page, apiUrl }) => {
  const flow = await api<Flow>(apiUrl, '/v1/flow')
  const all = [...STATES.flatMap((s) => flow.states[s].issues), ...flow.closedRecently]
  const repo = all[0]?.repo
  if (!repo) throw new Error('the seeded flow is empty')
  const inRepo = (s: (typeof STATES)[number]) => flow.states[s].issues.filter((i) => i.repo === repo).length

  await page.goto('/flow')
  const link = toggle(page, 'Projects', new RegExp(`^${repo}\\s*\\d+$`))
  await expect(link).toHaveAttribute('aria-pressed', 'false')
  await expect(link).toContainText(String(all.filter((i) => i.repo === repo).length))
  await link.click()
  await expect(page).toHaveURL(new RegExp(`project=${repo}`))
  await expect(link).toHaveAttribute('aria-pressed', 'true')
  await expect(page.getByRole('region', { name: /^Queued/ }).getByRole('heading')).toHaveText(
    `Queued ${inRepo('queued')}`,
  )

  const origin = all.find((i) => i.repo === repo)?.origin
  expect(origin).toBeTruthy()
  await section(page, 'Origin')
    .getByRole('link', { name: /^(?!All)/ })
    .first()
    .click()
  await expect(page).toHaveURL(/origin=/)

  await toggle(page, 'Origin', /^All$/).click()
  await toggle(page, 'Projects', /^All$/).click()
  await expect(page).not.toHaveURL(/project=|origin=/)
  await expect(toggle(page, 'Projects', /^All$/)).toHaveAttribute('aria-pressed', 'true')

  // the in-page selects are for the phone only
  await expect(page.locator('main select').first()).toBeHidden()
})

test('Flow: ?state shows one column full width with a link back to all', async ({ page, apiUrl }) => {
  const flow = await api<Flow>(apiUrl, '/v1/flow')
  await page.goto('/flow?state=waiting')
  const region = page.getByRole('region', { name: /^Waiting/ })
  await expect(region.getByRole('heading')).toHaveText(`Waiting ${flow.states.waiting.count}`)
  await expect(page.getByRole('region')).toHaveCount(1)
  await expect(region.getByRole('listitem')).toHaveCount(flow.states.waiting.count)
  await expect(page.getByRole('region', { name: /^Working/ })).toHaveCount(0)

  await page.goto('/flow?state=nope')
  await expect(page.getByRole('region')).toHaveCount(6)

  await page.goto('/flow?state=waiting&project=argo')
  await page.getByRole('link', { name: 'Show all states' }).click()
  await expect(page).toHaveURL(/\/flow\?project=argo$/)
  await expect(page.getByRole('region')).toHaveCount(6)
})

test('Needs you: a kind in the sidebar shows only that kind, a second click shows all', async ({ page, apiUrl }) => {
  const { counts } = await api<{ counts: Record<keyof typeof KIND_WORD, number> }>(apiUrl, '/v1/needs')
  const kinds = (Object.keys(KIND_WORD) as (keyof typeof KIND_WORD)[]).filter((k) => counts[k] > 0)
  expect(kinds.length).toBeGreaterThan(1)
  const kind = kinds[0]
  if (!kind) throw new Error('no kind waits')
  await page.goto('/needs-you')
  await expect(section(page, 'Kinds').getByRole('link')).toHaveCount(5)
  const link = toggle(page, 'Kinds', new RegExp(`^${KIND_WORD[kind]}\\s*${counts[kind]}$`))
  await link.click()
  await expect(page).toHaveURL(new RegExp(`kind=${kind}`))
  await expect(link).toHaveAttribute('aria-pressed', 'true')
  const headings = page.locator('main h2')
  await expect(headings).toHaveCount(1)
  await expect(headings).toContainText(KIND_WORD[kind])

  await link.click()
  await expect(page).not.toHaveURL(/kind=/)
  await expect(headings).toHaveCount(kinds.length)
})

test('Chain: the sidebar lists the projects and toggles the filter', async ({ page }) => {
  await page.goto('/chain')
  const links = section(page, 'Projects').getByRole('link')
  await expect(links.first()).toHaveText('All')
  expect(await links.count()).toBeGreaterThan(2)
  const first = links.nth(1)
  await first.click()
  await expect(page).toHaveURL(/\/chain\?project=/)
  await expect(first).toHaveAttribute('aria-pressed', 'true')
  await first.click()
  await expect(page).toHaveURL(/\/chain$/)
})

test('Improve: the window is in the sidebar and the page has no switch of its own', async ({ page }) => {
  await page.goto('/improve')
  await expect(toggle(page, 'Window', '7 days')).toHaveAttribute('aria-current', 'page')
  await expect(page.getByRole('navigation', { name: 'Window' })).toBeHidden()
  await toggle(page, 'Window', '30 days').click()
  await expect(page).toHaveURL(/\/improve\?days=30$/)
  await expect(toggle(page, 'Window', '30 days')).toHaveAttribute('aria-current', 'page')
})

test('the section leaves with the page', async ({ page }) => {
  await page.goto('/flow')
  await expect(section(page, 'Projects')).toBeVisible()
  await nav(page).getByRole('link', { name: 'Improve' }).click()
  await expect(section(page, 'Projects')).toHaveCount(0)
  await expect(section(page, 'Window')).toBeVisible()
})

test.describe('phone', () => {
  test.use({ viewport: { width: 390, height: 844 } })

  test('there is no sidebar; the board keeps its own selects and the state picks the tab', async ({ page }) => {
    await page.goto('/flow')
    await expect(aside(page)).toBeHidden()
    await expect(page.locator('main select').first()).toBeVisible()
    await page.goto('/flow?state=waiting')
    await expect(page.getByRole('tab', { name: /^Waiting/ })).toHaveAttribute('aria-selected', 'true')
  })
})
