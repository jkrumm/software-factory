import type { Page } from '@playwright/test'
import { expect, test } from './fixtures.ts'
import { api } from './seed.ts'

const strip = (page: Page) => page.locator('[aria-label="Status"]')
const flowLinks = (page: Page) => page.getByRole('navigation', { name: 'Issues in flight' })
const hostTrigger = (page: Page) => page.getByRole('button', { name: 'Host: load, memory and swap' })
const liveTrigger = (page: Page) => page.getByRole('button', { name: /^Connection:/ })

interface World {
  accounts: string[]
  issue: { number: number; title: string }
  word: string
  project: string
  artifact: { id: string; title: string }
}

/** Facts to search for, read from the API. */
async function world(apiUrl: string): Promise<World> {
  const { accounts } = await api<{ accounts: { account: string }[] }>(apiUrl, '/v1/accounts')
  const { issues } = await api<{ issues: { id: number; title: string }[] }>(apiUrl, '/v1/issues?state=all&limit=500')
  const { artifacts } = await api<{ artifacts: { id: string; title: string }[] }>(apiUrl, '/v1/artifacts?limit=200')
  const flow = await api<{ perProject: { repo: string }[] }>(apiUrl, '/v1/flow')
  const issue = issues.find((candidate) => /[A-Za-z]{5,}/.test(candidate.title))
  const artifact = artifacts[0]
  const project = flow.perProject[0]?.repo
  if (!issue || !artifact || !project) throw new Error('the world has no Issue, artifact or project to search for')
  const word = [...issue.title.matchAll(/[A-Za-z]{5,}/g)].map((m) => m[0]).sort((a, b) => b.length - a.length)[0] ?? ''
  return {
    accounts: accounts.map((a) => a.account),
    issue: { number: issue.id, title: issue.title },
    word,
    project,
    artifact,
  }
}

test.describe('the counts', () => {
  for (const state of ['working', 'waiting', 'queued'] as const) {
    test(`${state} links to Flow filtered to it`, async ({ page, apiUrl }) => {
      const flow = await api<{ states: Record<typeof state, { count: number }> }>(apiUrl, '/v1/flow')
      await page.goto('/needs-you')
      const link = flowLinks(page).getByRole('link', { name: new RegExp(`${state}$`) })
      await expect(link).toContainText(String(flow.states[state].count))
      await link.click()
      await expect(page).toHaveURL(new RegExp(`/flow\\?state=${state}$`))
    })
  }
})

test.describe('the meters and their popovers', () => {
  test('an account meter opens the formatted rows and Escape closes it', async ({ page, apiUrl }) => {
    const { accounts } = await world(apiUrl)
    await page.goto('/needs-you')
    for (const account of accounts) {
      const trigger = page.getByRole('button', { name: new RegExp(`^${account}, `) })
      await expect(trigger).toBeVisible()
      await trigger.click()
      const popup = page.getByRole('dialog')
      await expect(popup).toBeVisible()
      await expect(popup.getByText(account, { exact: true })).toBeVisible()
      for (const row of ['This week', '5-hour window', 'Reading'])
        await expect(popup.getByText(row, { exact: true })).toBeVisible()
      await expect(popup.getByText(/Fresh|Stale/)).toBeVisible()
      await expect(popup.getByRole('meter').first()).toBeVisible()
      await page.keyboard.press('Escape')
      await expect(popup).toBeHidden()
    }
  })

  test('an account meter opens from the keyboard', async ({ page, apiUrl }) => {
    const { accounts } = await world(apiUrl)
    await page.goto('/needs-you')
    const trigger = page.getByRole('button', { name: new RegExp(`^${accounts[0]}, `) })
    await trigger.focus()
    await page.keyboard.press('Enter')
    await expect(page.getByRole('dialog')).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(page.getByRole('dialog')).toBeHidden()
  })

  test('the host popover shows three charts with a tooltip and two process tables of eight rows', async ({ page }) => {
    await page.goto('/needs-you')
    await expect(hostTrigger(page)).toBeVisible()
    for (const label of ['Load', 'Memory', 'Swap']) await expect(hostTrigger(page)).toContainText(label)
    await hostTrigger(page).click()
    const popup = page.getByRole('dialog')
    await expect(popup.getByRole('heading', { name: 'Host, last 24 hours' })).toBeVisible()

    for (const title of ['Load', 'Memory and swap', 'Swapped out']) {
      await expect(popup.getByRole('heading', { name: title })).toBeVisible()
    }
    const charts = popup.getByRole('group', { name: /^(Load|Memory and swap|Swapped out),/ })
    await expect(charts).toHaveCount(3)
    for (let i = 0; i < 3; i++) {
      const chart = charts.nth(i)
      await expect(chart).toBeVisible()
      await chart.hover()
      const tip = popup.getByRole('status')
      await expect(tip).toBeVisible()
      await expect(tip).toContainText(/\d\d:\d\d/)
    }
    await expect(popup.getByText('-24 h')).toHaveCount(3)
    await expect(popup.getByText('now', { exact: true })).toHaveCount(3)

    for (const title of ['Top by CPU', 'Top by memory']) {
      const table = popup.locator('section', { has: page.getByRole('heading', { name: title }) })
      await expect(table.locator('tbody tr')).toHaveCount(8)
    }
    await page.keyboard.press('Escape')
    await expect(popup).toBeHidden()
  })

  test('the host popover says there is no history when the server has none', async ({ page }) => {
    await page.route('**/v1/host', (route) => route.fulfill({ status: 404, body: '{}' }))
    await page.goto('/needs-you')
    await hostTrigger(page).click()
    await expect(page.getByRole('dialog').getByText('No history yet')).toBeVisible()
  })

  test('the Live popover shows the stream, the last event, the version and the uptime', async ({ page, apiUrl }) => {
    const host = await api<{ version: string }>(apiUrl, '/v1/host')
    await page.goto('/needs-you')
    await expect(page.getByRole('status').filter({ hasText: 'Live' })).toBeVisible()
    await liveTrigger(page).click()
    const popup = page.getByRole('dialog')
    await expect(popup.getByText('Connected to the event stream')).toBeVisible()
    await expect(popup.getByText('Last event')).toBeVisible()
    await expect(popup.getByText(/just now|\d+ min ago/)).toBeVisible()
    await expect(popup.getByText(host.version, { exact: true })).toBeVisible()
    await expect(popup.getByText(/^up (\d+ d \d+ h|\d+ h \d+ min|\d+ min|under a minute)$/)).toBeVisible()
  })
})

test.describe('the palette', () => {
  const dialog = (page: Page) => page.getByRole('dialog')
  const open = async (page: Page, query?: string) => {
    await expect(page.getByRole('status').filter({ hasText: 'Live' })).toBeVisible()
    await page.keyboard.press('ControlOrMeta+K')
    await expect(dialog(page)).toBeVisible()
    if (query !== undefined) await dialog(page).getByRole('combobox').fill(query)
  }

  test('finds an Issue by number, first, and opens its page', async ({ page, apiUrl }) => {
    const { issue } = await world(apiUrl)
    await page.goto('/needs-you')
    for (const query of [String(issue.number), `#${issue.number}`]) {
      await open(page, query)
      const first = dialog(page).getByRole('option').first()
      await expect(first).toContainText(`#${issue.number}`)
      await expect(first).toContainText('Issue')
      await expect(first).toHaveAttribute('aria-selected', 'true')
      await expect(first.locator('mark')).toHaveText(String(issue.number))
      await page.keyboard.press('Escape')
      await expect(dialog(page)).toBeHidden()
    }
    await open(page, `#${issue.number}`)
    await page.keyboard.press('Enter')
    await expect(page).toHaveURL(new RegExp(`/issues/${issue.number}$`))
  })

  test('finds an Issue by a word of its title, highlights it and opens its page', async ({ page, apiUrl }) => {
    const { issue, word } = await world(apiUrl)
    await page.goto('/needs-you')
    await open(page, word.toUpperCase())
    const row = dialog(page)
      .getByRole('option')
      .filter({ hasText: `#${issue.number}` })
    await expect(row).toBeVisible()
    await expect(row.locator('mark').first()).toHaveText(new RegExp(`^${word}$`, 'i'))
    await row.click()
    await expect(page).toHaveURL(new RegExp(`/issues/${issue.number}$`))
  })

  test('finds a project and goes to Flow filtered to it', async ({ page, apiUrl }) => {
    const { project } = await world(apiUrl)
    await page.goto('/needs-you')
    await open(page, project)
    const row = dialog(page).getByRole('option').filter({ hasText: 'Project' }).filter({ hasText: project })
    await row.first().click()
    await expect(page).toHaveURL(new RegExp(`/flow\\?project=${project}$`))
  })

  test('finds an artifact and opens it', async ({ page, apiUrl }) => {
    const { artifact } = await world(apiUrl)
    await page.goto('/needs-you')
    await open(page, artifact.title)
    const row = dialog(page).getByRole('option').filter({ hasText: 'Artifact' }).filter({ hasText: artifact.id })
    await row.first().click()
    await expect(page).toHaveURL(new RegExp(`/artifacts/${artifact.id}$`))
  })

  test('shows the keys of the commands, the footer and the recent Issues on an empty query', async ({ page }) => {
    await page.goto('/needs-you')
    await open(page)
    const flow = dialog(page).getByRole('option', { name: /Go to Flow/ })
    await expect(flow.locator('kbd')).toHaveText(['G', 'F'])
    await expect(flow).toContainText('Command')
    await expect(dialog(page).getByText('Recently active')).toBeVisible()
    await expect(dialog(page).getByRole('option').filter({ hasText: 'Issue' }).first()).toBeVisible()
    for (const hint of ['move', 'open', 'close']) await expect(dialog(page).getByText(hint)).toBeVisible()
  })

  test('keeps its size while the results change', async ({ page, apiUrl }) => {
    const { word } = await world(apiUrl)
    await page.goto('/needs-you')
    await open(page)
    const box = () => dialog(page).evaluate((el) => (el as { offsetHeight: number }).offsetHeight)
    const empty = await box()
    await dialog(page).getByRole('combobox').fill(word)
    expect(await box()).toBe(empty)
    await dialog(page).getByRole('combobox').fill('zzzzqqq')
    await expect(dialog(page).getByText('Nothing matches.')).toBeVisible()
    expect(await box()).toBe(empty)
  })
})

test.describe('the strip at 1280 and on a phone', () => {
  test.describe('1280x800', () => {
    test.use({ viewport: { width: 1280, height: 800 } })

    test('is one line with every item visible', async ({ page }) => {
      await page.goto('/needs-you')
      await expect(page.getByRole('status').filter({ hasText: 'Live' })).toBeVisible()
      await expect(hostTrigger(page)).toBeVisible()
      const box = await strip(page).boundingBox()
      expect(box?.height ?? 99).toBeLessThan(40)
      const right = (box?.x ?? 0) + (box?.width ?? 0)
      const items = [
        ...(await flowLinks(page).getByRole('link').all()),
        ...(await page.getByRole('button', { name: /of this week used|no reading/ }).all()),
        hostTrigger(page),
        liveTrigger(page),
      ]
      expect(items.length).toBeGreaterThanOrEqual(6)
      for (const item of items) {
        await expect(item).toBeVisible()
        const itemBox = await item.boundingBox()
        expect((itemBox?.x ?? 0) + (itemBox?.width ?? 0)).toBeLessThanOrEqual(right + 1)
        expect(itemBox?.height ?? 99).toBeLessThan(40)
      }
      expect(await page.evaluate('document.documentElement.scrollWidth <= window.innerWidth')).toBe(true)
    })
  })

  test.describe('390x844', () => {
    test.use({ viewport: { width: 390, height: 844 } })

    test('wraps to more than one line without scrolling the page sideways', async ({ page }) => {
      await page.goto('/needs-you')
      await expect(page.getByRole('status').filter({ hasText: 'Live' })).toBeVisible()
      const box = await strip(page).boundingBox()
      expect(box?.height ?? 0).toBeGreaterThan(40)
      expect(await page.evaluate('document.documentElement.scrollWidth <= window.innerWidth')).toBe(true)
    })

    test('a popover stays inside the viewport', async ({ page }) => {
      await page.goto('/needs-you')
      await hostTrigger(page).click()
      const popup = page.getByRole('dialog')
      await expect(popup.getByRole('heading', { name: 'Host, last 24 hours' })).toBeVisible()
      const box = await popup.boundingBox()
      expect(box?.x ?? -1).toBeGreaterThanOrEqual(0)
      expect((box?.x ?? 0) + (box?.width ?? 999)).toBeLessThanOrEqual(390)
    })
  })
})
