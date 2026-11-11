import { join } from 'node:path'
import type { Page } from '@playwright/test'
import { expect, test } from './fixtures.ts'
import { api } from './seed.ts'

/**
 * How fast the Console feels (Issue 659): every screen holds a skeleton while its data loads, an answer from a server newer
 * than the bundle never shows a banner before content, and an item the owner pointed at opens without a wait.
 * Read-only: nothing here settles a need, so the files after it find the seed as it was.
 */
const OUT = join(import.meta.dir, 'out', 'screenshots')
const busy = (page: Page) => page.locator('[aria-busy="true"]')
const BANNER = /older than the server/

/** Counts how often a skeleton was on screen from now on (it comes and goes within a frame, so polling for it would miss it). */
async function watchSkeletons(page: Page) {
  await page.evaluate(`
    window.__skeletons = 0
    new MutationObserver(() => {
      if (document.querySelector('[aria-busy="true"]')) window.__skeletons += 1
    }).observe(document.body, { childList: true, subtree: true })
  `)
}
const skeletonsSeen = (page: Page): Promise<number> => page.evaluate('window.__skeletons')

/** A request that is never answered: the screen stays on what it shows while it loads. */
const hang = (page: Page, pattern: RegExp) => page.route(pattern, () => undefined)

test('Needs you holds its skeleton until the data arrives, and never says the Console is old', async ({ page }) => {
  await page.route('**/v1/needs', async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 1200))
    await route.continue()
  })
  await page.goto('/needs-you')
  await expect(busy(page).first()).toBeVisible()
  await expect(page.getByText(BANNER)).toHaveCount(0)
  await expect(page.locator('article').first()).toBeVisible()
  await expect(busy(page)).toHaveCount(0)
})

test('an answer that does not match this bundle shows the skeleton, not the update banner', async ({ page }) => {
  await page.route('**/v1/needs', (route) => route.fulfill({ json: { at: 5, items: 'nothing', counts: null } }))
  await page.goto('/needs-you')
  await expect(busy(page).first()).toBeVisible()
  await page.waitForTimeout(1500)
  await expect(busy(page).first()).toBeVisible()
  await expect(page.getByText(BANNER)).toHaveCount(0)
  await expect(page.getByText('Loading', { exact: true })).toHaveCount(0)
})

test('a server that only added a field is read as it is: the content shows, no update is waited for', async ({
  page,
}) => {
  await page.route('**/v1/needs', async (route) => {
    const response = await route.fetch()
    const body = (await response.json()) as Record<string, unknown>
    await route.fulfill({ response, json: { ...body, addedByANewerServer: { anything: true } } })
  })
  await page.goto('/needs-you')
  await expect(page.locator('article').first()).toBeVisible()
  await expect(page.getByText(BANNER)).toHaveCount(0)
  await expect(busy(page)).toHaveCount(0)
})

test('a review opened after a hover shows its artifact with no skeleton', async ({ page, apiUrl }) => {
  const { items } = await api<{ items: { kind: string; id: string; title: string }[] }>(apiUrl, '/v1/needs')
  const review = items.find((item) => item.kind === 'review')
  if (!review) throw new Error('the seed holds no review')
  // the read takes a second: only a read that began at the hover is done by the click
  await page.route(`**/v1/artifacts/${review.id}`, async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 1000))
    await route.continue()
  })
  await page.goto('/needs-you')
  const card = page.locator('article').filter({ hasText: review.title })
  await card.hover()
  await page.waitForResponse((response) => response.url().includes(`/v1/artifacts/${review.id}`))
  await watchSkeletons(page)
  await card.getByRole('heading').getByRole('link').click()
  await expect(card.getByRole('link', { name: 'Open the full page' })).toBeVisible()
  expect(await skeletonsSeen(page)).toBe(0)

  // the page it links to opens on the same data: no skeleton either
  await card.getByRole('link', { name: 'Open the full page' }).hover()
  await watchSkeletons(page)
  await card.getByRole('link', { name: 'Open the full page' }).click()
  await expect(page.getByRole('heading', { level: 1, name: review.title })).toBeVisible()
  expect(await skeletonsSeen(page)).toBe(0)
})

const SCREENS = [
  { name: 'needs-you', path: '/needs-you' },
  { name: 'flow', path: '/flow' },
  { name: 'chain', path: '/chain' },
  { name: 'improve', path: '/improve' },
  { name: 'artifact', path: () => `/artifacts/${JSON.parse(process.env.E2E_ARTIFACTS ?? '{}').shotReport}` },
  { name: 'issue', path: () => `/issues/${JSON.parse(process.env.E2E_HISTORY ?? '{}').rich.replace('issue_', '')}` },
] as const

const VARIANTS = [
  { name: 'desktop-xl-dark', viewport: { width: 1800, height: 1200 }, colorScheme: 'dark' },
  { name: 'desktop-xl-light', viewport: { width: 1800, height: 1200 }, colorScheme: 'light' },
  { name: 'desktop-dark', viewport: { width: 1280, height: 800 }, colorScheme: 'dark' },
  { name: 'phone-dark', viewport: { width: 390, height: 844 }, colorScheme: 'dark' },
] as const

for (const variant of VARIANTS) {
  test.describe(`skeletons ${variant.name}`, () => {
    test.use({ viewport: variant.viewport, colorScheme: variant.colorScheme })

    test('every screen on its skeleton', async ({ page }) => {
      await hang(page, /\/v1\/(?!stream)/)
      for (const { name, path } of SCREENS) {
        await page.goto(typeof path === 'function' ? path() : path)
        await expect(busy(page).first()).toBeVisible()
        await page.screenshot({ path: join(OUT, `skeleton-${variant.name}-${name}.png`), animations: 'disabled' })
      }
    })
  })
}
