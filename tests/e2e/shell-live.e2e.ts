import { expect, test } from './fixtures.ts'
import { badge, chip } from './shell-support.ts'
import { holdSignal, needsCount } from './seed.ts'

// the first test restarts the server, which comes back on another port
test.describe.configure({ mode: 'serial' })
// page.route does not see requests a service worker answers
test.use({ serviceWorkers: 'block' })

test('after the server restarts, a new checkpoint appears without a reload and the chip is Live again', async ({
  page,
  request,
}) => {
  test.setTimeout(90_000)
  const control = process.env.E2E_CONTROL_URL
  await page.goto('/needs-you')
  await expect(chip(page)).toHaveText(/Live/)
  await page.evaluate('window.__kept = true')

  const restarting = request.post(`${control}/restart`)
  await expect(chip(page)).not.toHaveText(/Live/)
  const apiUrl = await (await restarting).text()

  const before = await needsCount(apiUrl)
  await expect(badge(page)).toHaveText(String(before), { timeout: 30_000 })
  await holdSignal(apiUrl, 'After the restart')
  await expect(badge(page)).toHaveText(String(before + 1), { timeout: 30_000 })
  await expect(chip(page)).toHaveText(/Live/, { timeout: 30_000 })
  expect(await page.evaluate('window.__kept')).toBe(true)
})

test('after the stream drops, the count follows by polling and the chip is Live again with the stream', async ({
  page,
  apiUrl,
}) => {
  test.setTimeout(90_000)
  // keeps every EventSource the page opens, so the test can make the app see an error on it
  await page.addInitScript(`
    const Native = window.EventSource
    window.__streams = []
    window.EventSource = class extends Native {
      constructor(url, init) {
        super(url, init)
        window.__streams.push(this)
      }
    }
  `)
  await page.goto('/needs-you')
  await expect(chip(page)).toHaveText(/Live/)
  await page.evaluate('window.__kept = true')
  const before = await needsCount(apiUrl)
  await expect(badge(page)).toHaveText(String(before))

  await page.route('**/v1/stream*', (route) => route.abort())
  await page.evaluate("window.__streams.forEach((source) => source.dispatchEvent(new Event('error')))")
  await expect(chip(page)).toHaveText(/Polling/, { timeout: 30_000 })
  await holdSignal(apiUrl, 'While the stream is down')
  await expect(badge(page)).toHaveText(String(before + 1), { timeout: 30_000 })

  await page.unroute('**/v1/stream*')
  await expect(chip(page)).toHaveText(/Live/, { timeout: 40_000 })
  expect(await page.evaluate('window.__kept')).toBe(true)
})

test.describe('a persisted snapshot', () => {
  test('never hides what the API says now', async ({ page, apiUrl }) => {
    await page.goto('/needs-you')
    await expect(chip(page)).toHaveText(/Live/)
    await expect.poll(() => page.evaluate("localStorage.getItem('console-snapshot')?.includes('counts')")).toBe(true)

    await page.evaluate(() => {
      const stored = JSON.parse(localStorage.getItem('console-snapshot') ?? '{}')
      for (const query of stored.clientState.queries) {
        if (query.queryKey[0] !== 'needs') continue
        query.state.dataUpdatedAt = Date.now()
        query.state.data.items = []
        for (const kind of Object.keys(query.state.data.counts)) query.state.data.counts[kind] = 0
      }
      stored.timestamp = Date.now()
      localStorage.setItem('console-snapshot', JSON.stringify(stored))
    })
    await page.reload()

    const truth = await needsCount(apiUrl)
    expect(truth).toBeGreaterThan(0)
    await expect(badge(page)).toHaveText(String(truth))
    await expect(page.getByText('Nothing waits on you')).toHaveCount(0)
  })
})
