import type { Page } from '@playwright/test'
import { expect, test } from './fixtures.ts'
import type { SeededArtifacts } from './seed-artifacts.ts'

const seeded = (): SeededArtifacts => JSON.parse(process.env.E2E_ARTIFACTS ?? '{}') as SeededArtifacts

const DOCUMENT = '[data-scroll-restoration-id="artifact-document"]'
/** one line of the document's text, with room: the position comes back within this */
const LINE_PX = 28

/** The page under the service worker, which is what makes a new worker's takeover a reload candidate. */
async function controlled(page: Page, path: string): Promise<void> {
  await page.goto(path)
  await page.evaluate('navigator.serviceWorker.ready.then(() => true)')
  // the worker controls the page from its next load on
  await page.reload()
  await expect.poll(() => page.evaluate('navigator.serviceWorker.controller !== null')).toBe(true)
}

/** A new worker has taken over: the one fact the page reads (`controllerchange`) as a bundle waiting to load. */
const takeover = (page: Page) => page.evaluate("navigator.serviceWorker.dispatchEvent(new Event('controllerchange'))")

/** The tab goes to the background. */
const hide = (page: Page) =>
  page.evaluate(`(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' })
    document.dispatchEvent(new Event('visibilitychange'))
  })()`)

const scrollTopOf = (page: Page) => page.locator(DOCUMENT).evaluate((element) => element.scrollTop)

test('an update reload while reading comes back at the same place', async ({ page }) => {
  await controlled(page, `/artifacts/${seeded().review}`)
  await expect(page.locator('main header h1')).toHaveText('Weather rollout')
  const middle = await page.locator(DOCUMENT).evaluate((element) => {
    element.scrollTop = (element.scrollHeight - element.clientHeight) / 2
    return element.scrollTop
  })
  expect(middle).toBeGreaterThan(300)

  await takeover(page)
  // the worker taking over alone reloads nothing: the screen has data
  await expect.poll(() => scrollTopOf(page)).toBe(middle)
  const reloaded = page.waitForEvent('load')
  await hide(page)
  await reloaded

  await expect(page.locator('main header h1')).toHaveText('Weather rollout')
  await expect.poll(async () => Math.abs((await scrollTopOf(page)) - middle)).toBeLessThanOrEqual(LINE_PX)
  expect(await page.evaluate("sessionStorage.getItem('console-scroll-keep')")).toBeNull()
})

test('a quiet tab with a new bundle waiting is not reloaded', async ({ page }) => {
  await page.clock.install()
  await controlled(page, `/artifacts/${seeded().review}`)
  await expect(page.locator('main header h1')).toHaveText('Weather rollout')
  await page.evaluate('window.__kept = true')

  await takeover(page)
  await page.clock.fastForward(120_000)
  await page.clock.runFor(10_000)
  expect(await page.evaluate('window.__kept')).toBe(true)
})
