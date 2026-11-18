import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Page } from '@playwright/test'
import { patient } from '../scenarios/patience.ts'
import { serveBuild } from './build-swap.ts'
import { expect, test } from './fixtures.ts'
import { chip } from './shell-support.ts'

/**
 * The Console is current without a hard reload (Issue 1800): a build swapped under an open page takes over by itself, an
 * update that cannot be applied says so with one button, and data older than its poll interval is said to be old.
 * The clock is the page's: a minute of "waiting" passes in a fast-forward, the worker's install takes real time.
 */
const buildOf = (page: Page): Promise<string | null> =>
  chip(page)
    .getAttribute('data-build', { timeout: 1000 })
    .catch(() => null)

async function openUnderClock(page: Page, url: string): Promise<string> {
  await page.clock.install()
  await page.goto(`${url}/needs-you`)
  await expect(chip(page)).toBeVisible()
  await page.waitForFunction('navigator.serviceWorker.controller !== null')
  const id = await buildOf(page)
  if (!id) throw new Error('the strip names no build')
  return id
}

test('a build swapped under an open page is the one on screen once its tab is hidden, with no reload by hand', async ({
  page,
  consoleUrl,
}, info) => {
  info.setTimeout(patient(90_000))
  const dir = await mkdtemp(join(tmpdir(), 'console-swap-'))
  const site = await serveBuild(dir, consoleUrl)
  try {
    const before = await openUnderClock(page, site.url)
    const after = await site.swap(before)
    expect(after).not.toBe(before)
    // a minute passes: the window asks for a new worker and takes it, and a reading tab stays on its bundle until it is hidden
    await expect
      .poll(
        async () => {
          await page.clock.fastForward(10_000).catch(() => undefined)
          await page
            .evaluate(
              `(() => {
                Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' })
                document.dispatchEvent(new Event('visibilitychange'))
              })()`,
            )
            .catch(() => undefined)
          return buildOf(page)
        },
        { timeout: patient(60_000), intervals: [500] },
      )
      .toBe(after)
    await expect(chip(page)).toBeVisible()
    await expect(page.getByTestId('update-notice')).toHaveCount(0)
  } finally {
    await site.stop()
    await rm(dir, { recursive: true, force: true })
  }
})

test('an update that cannot be applied for two minutes says so, and its button loads the new build', async ({
  page,
  consoleUrl,
}, info) => {
  info.setTimeout(patient(90_000))
  const dir = await mkdtemp(join(tmpdir(), 'console-swap-'))
  const site = await serveBuild(dir, consoleUrl)
  try {
    const before = await openUnderClock(page, site.url)
    // a draft in a field: the page must not reload under it
    await page.evaluate(`{
      const field = document.createElement('textarea')
      field.value = 'half a sentence'
      document.body.append(field)
      field.focus()
    }`)
    const after = await site.swap(before)
    await expect
      .poll(
        async () => {
          await page.clock.fastForward(20_000)
          return page.getByTestId('update-notice').count()
        },
        { timeout: patient(60_000), intervals: [500] },
      )
      .toBe(1)
    expect(await buildOf(page)).toBe(before)
    await page.getByRole('button', { name: 'Update now' }).click()
    await expect.poll(() => buildOf(page), { timeout: patient(30_000) }).toBe(after)
    await expect(page.getByTestId('update-notice')).toHaveCount(0)
  } finally {
    await site.stop()
    await rm(dir, { recursive: true, force: true })
  }
})

test('data older than its poll interval is said to be old, and the lamp says which reads', async ({ page }) => {
  await page.clock.install()
  await page.goto('/needs-you')
  await expect(chip(page)).toBeVisible()
  await expect(page.locator('article').first()).toBeVisible()
  await expect(page.getByTestId('stale-notice')).toHaveCount(0)
  await page.route('**/v1/**', (route) => route.abort())
  await page.clock.fastForward(150_000)
  await expect(page.getByTestId('stale-notice')).toContainText('Needs you')
  await page.getByRole('button', { name: /^Connection/ }).click()
  await expect(page.getByText('Stale reads')).toBeVisible()
  await expect(page.getByTestId('build-age')).toContainText('build')
})
