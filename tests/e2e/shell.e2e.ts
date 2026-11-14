import { expect, test } from './fixtures.ts'
import { textWithoutBand } from './screen-text.ts'
import { badge, chip } from './shell-support.ts'
import { api, holdSignal, needsCount } from './seed.ts'

const SCREENS = [
  { label: 'Needs you', path: '/needs-you', key: 'N' },
  { label: 'Flow', path: '/flow', key: 'F' },
  { label: 'Chain', path: '/chain', key: 'C' },
  { label: 'Improve', path: '/improve', key: 'I' },
  { label: 'Throughput', path: '/throughput', key: 'T' },
] as const

test('the root redirects to Needs you, the badge is the API count and no id leaks onto the page', async ({
  page,
  apiUrl,
}) => {
  const count = await needsCount(apiUrl)
  expect(count).toBeGreaterThan(1)
  await page.goto('/')
  await expect(page).toHaveURL(/\/needs-you$/)
  await expect(badge(page)).toHaveText(String(count))
  await expect(page.getByText(`${count} need you`, { exact: true })).toBeVisible()
  expect(await textWithoutBand(page)).not.toMatch(/issue_\d+|lead-\d+|#\d+/)
})

test('the five screens open from the navigation and from G then N, F, C, I, T', async ({ page }) => {
  await page.goto('/needs-you')
  const nav = page.getByRole('navigation', { name: 'Main' })
  for (const { label, path } of SCREENS) {
    await nav.getByRole('link', { name: label }).click()
    await expect(page).toHaveURL(new RegExp(`${path}$`))
  }
  await page.locator('main').click()
  for (const { path, key } of [...SCREENS].reverse()) {
    await page.keyboard.press('g')
    await page.keyboard.press(key.toLowerCase())
    await expect(page).toHaveURL(new RegExp(`${path}$`))
  }
})

test('the palette opens on Mod+K, filters, navigates on Enter, closes on Escape and gives focus back', async ({
  page,
}) => {
  await page.goto('/needs-you')
  const trigger = page.getByRole('button', { name: 'Open command palette' })
  await trigger.focus()
  const dialog = page.getByRole('dialog')

  await page.keyboard.press('ControlOrMeta+K')
  await expect(dialog).toBeVisible()
  const input = dialog.getByRole('combobox')
  await expect(input).toBeFocused()
  await input.fill('go to improve')
  await expect(dialog.getByRole('option', { name: /Go to Improve/ })).toHaveAttribute('aria-selected', 'true')
  await page.keyboard.press('Enter')
  await expect(dialog).toBeHidden()
  await expect(page).toHaveURL(/\/improve$/)

  await trigger.focus()
  await page.keyboard.press('ControlOrMeta+K')
  await expect(dialog).toBeVisible()
  await expect(input).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(dialog).toBeHidden()
  await expect(trigger).toBeFocused()

  await page.keyboard.press('ControlOrMeta+K')
  await dialog.getByRole('combobox').fill('theme: light')
  await page.keyboard.press('Enter')
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')
  await page.keyboard.press('ControlOrMeta+K')
  await dialog.getByRole('combobox').fill('theme: dark')
  await page.keyboard.press('Enter')
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
})

test('a new thing that waits on the owner moves the badge without a reload, and the chip says Live', async ({
  page,
  apiUrl,
}) => {
  await page.goto('/needs-you')
  const before = await needsCount(apiUrl)
  await expect(badge(page)).toHaveText(String(before))
  await expect(chip(page)).toHaveText(/Live/)
  await page.evaluate('window.__kept = true')

  await holdSignal(apiUrl, 'Live update')
  await expect(badge(page)).toHaveText(String(before + 1))
  await expect(chip(page)).toHaveText(/Live/)
  expect(await page.evaluate('window.__kept')).toBe(true)
})

test.describe('without the event stream', () => {
  test.use({ serviceWorkers: 'block' })
  test.setTimeout(60_000)

  test('the chip says Polling and the count still follows within the polling interval', async ({ page, apiUrl }) => {
    await page.route('**/v1/stream*', (route) => route.abort())
    await page.goto('/needs-you')
    const before = await needsCount(apiUrl)
    await expect(chip(page)).toHaveText(/Polling/)
    await expect(badge(page)).toHaveText(String(before))

    await holdSignal(apiUrl, 'Polled update')
    await expect(badge(page)).toHaveText(String(before + 1), { timeout: 25_000 })
    await expect(chip(page)).toHaveText(/Polling/)
  })
})

test('offline after one load: the shell comes from the service worker and the chip shows the snapshot age', async ({
  page,
  context,
}) => {
  await page.goto('/needs-you')
  await expect(chip(page)).toHaveText(/Live/)
  await page.evaluate('navigator.serviceWorker.ready.then(() => true)')
  // the snapshot is written to storage a moment after the data arrives
  await expect.poll(() => page.evaluate("localStorage.getItem('console-snapshot')?.includes('counts')")).toBe(true)
  // the worker controls the page from its next load on
  await page.reload()
  await expect.poll(() => page.evaluate('navigator.serviceWorker.controller !== null')).toBe(true)

  await context.setOffline(true)
  await page.reload()
  await expect(page.getByRole('navigation', { name: 'Main' })).toBeVisible()
  await expect(chip(page)).toHaveText(/Offline - snapshot from .+/)
})

test('the listener serves without any header and refuses a write', async ({ playwright, consoleUrl }) => {
  const anonymous = await playwright.request.newContext({ baseURL: consoleUrl, extraHTTPHeaders: {} })
  for (const path of ['/', '/v1/needs', '/manifest.webmanifest']) {
    expect((await anonymous.get(path)).status(), path).toBe(200)
  }
  expect((await anonymous.post('/v1/issues', { data: {} })).status()).toBe(405)
  await anonymous.dispose()
})

test('the app is installable: a manifest with its icons and an active service worker', async ({ page, request }) => {
  const response = await request.get('/manifest.webmanifest')
  expect(response.status()).toBe(200)
  const manifest = (await response.json()) as {
    name: string
    start_url: string
    display: string
    icons: { src: string; sizes: string }[]
  }
  expect(manifest).toMatchObject({ name: 'Software Factory', start_url: '/', display: 'standalone' })
  expect(manifest.icons.map((icon) => icon.sizes)).toEqual(expect.arrayContaining(['192x192', '512x512']))
  for (const icon of manifest.icons) {
    const png = await request.get(icon.src)
    expect(png.status(), icon.src).toBe(200)
    expect(png.headers()['content-type'], icon.src).toContain('image/png')
  }

  await page.goto('/')
  await expect
    .poll(() => page.evaluate('navigator.serviceWorker.ready.then((r) => r.active?.state ?? null)'))
    .toBe('activated')
  await page.reload()
  await expect.poll(() => page.evaluate('navigator.serviceWorker.controller?.state ?? null')).toBe('activated')
})

test.describe('layout', () => {
  test.describe('phone', () => {
    test.use({ viewport: { width: 390, height: 844 } })

    test('the tab bar is at the bottom and the side rail is gone', async ({ page }) => {
      await page.goto('/needs-you')
      const nav = page.getByRole('navigation', { name: 'Main' })
      await expect(nav).toHaveCount(1)
      await expect(nav).toBeVisible()
      const box = await nav.boundingBox()
      expect(box?.y ?? 0).toBeGreaterThan(844 / 2)
      expect(box?.width).toBeCloseTo(390, 0)
    })
  })

  test.describe('desktop', () => {
    test.use({ viewport: { width: 1280, height: 800 } })

    test('the side rail is at the left and the tab bar is gone', async ({ page }) => {
      await page.goto('/needs-you')
      await expect(page.getByRole('navigation', { name: 'Main' })).toHaveCount(1)
      const box = await page.locator('aside').boundingBox()
      expect(box?.x).toBe(0)
      expect(box?.width).toBeLessThan(400)
    })
  })
})

test('the strip shows the counts, each account weekly and the host, and opens the detail', async ({ page, apiUrl }) => {
  const flow = await api<{ states: Record<'working' | 'waiting' | 'queued', { count: number }> }>(apiUrl, '/v1/flow')
  const { accounts } = await api<{ accounts: { account: string }[] }>(apiUrl, '/v1/accounts')
  expect(accounts.length).toBeGreaterThan(0)
  await page.goto('/needs-you')
  const counts = page.getByRole('navigation', { name: 'Issues in flight' })
  await expect(counts).toContainText(`${flow.states.working.count} working`)
  await expect(counts).toContainText(`${flow.states.waiting.count} waiting`)
  await expect(counts).toContainText(`${flow.states.queued.count} queued`)
  for (const { account } of accounts)
    await expect(page.getByRole('button', { name: new RegExp(`^${account}, `) })).toContainText(/\d+/)
  const host = page.getByRole('button', { name: 'Host: load, memory and swap' })
  for (const label of ['Load', 'Memory', 'Swap']) await expect(host).toContainText(label)
  await host.click()
  await expect(page.getByRole('dialog')).toContainText('Host, last 24 hours')
  await page.keyboard.press('Escape')
  await page.getByRole('button', { name: new RegExp(`^${accounts[0]?.account}, `) }).click()
  await expect(page.getByRole('dialog')).toContainText('This week')
})
