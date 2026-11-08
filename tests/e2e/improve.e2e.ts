import { formatKpi, perIssueWords, windowWords } from '../../apps/console/src/lib/improve.ts'
import type { Page } from '@playwright/test'
import { expect, test } from './fixtures.ts'
import { api } from './seed.ts'

interface Kpi {
  key: string
  label: string
  value: number | null
  unit: 'per_issue' | 'share' | 'ms' | 'usd' | 'points'
  measured: boolean
}
interface KpiModel {
  days: number
  window: { from: string; to: string }
  kpis: Kpi[]
}
interface FrictionModel {
  counts: { key: string; label: string; count: number; perIssue: number | null }[]
}

const HEADLINE = ['first_verification_passes', 'avoidable_touches', 'asks', 'queue_wait_p90', 'refusals']

/** Each headline card shows what `formatKpi` makes of the API's value. */
async function expectHeadline(page: Page, kpis: KpiModel) {
  const cards = page.getByRole('list', { name: 'Headline' })
  for (const key of HEADLINE) {
    const kpi = kpis.kpis.find((k) => k.key === key)
    if (!kpi) throw new Error(`${key} is not in the API answer`)
    const card = cards.getByRole('listitem').filter({ hasText: kpi.label })
    await expect(card.getByText(formatKpi(kpi), { exact: true }).first()).toBeVisible()
  }
}

const read = (apiUrl: string, days: number) =>
  Promise.all([api<KpiModel>(apiUrl, `/v1/kpis?days=${days}`), api<FrictionModel>(apiUrl, `/v1/friction?days=${days}`)])

test('the headline numbers, the table and each friction count are what the API says', async ({ page, apiUrl }) => {
  const [kpis, friction] = await read(apiUrl, 7)
  await page.goto('/improve')
  await expect(page.getByRole('heading', { name: 'Improve' })).toBeVisible()
  await expect(page.getByText(`Last 7 days, ${windowWords(kpis.window)}`, { exact: true })).toBeVisible()

  await expectHeadline(page, kpis)

  const table = page.getByRole('table')
  expect(kpis.kpis).toHaveLength(11)
  for (const kpi of kpis.kpis) {
    const row = table.getByRole('row').filter({ has: page.getByRole('rowheader', { name: kpi.label }) })
    await expect(row).toHaveCount(1)
    await expect(row.getByRole('cell').first()).toHaveText(formatKpi(kpi))
  }

  for (const count of friction.counts) {
    const row = page.getByRole('listitem').filter({ hasText: count.label })
    await expect(row.getByLabel('Count')).toHaveText(String(count.count))
    await expect(row.getByLabel('Per Issue closed')).toHaveText(perIssueWords(count.perIssue))
  }
})

test('the window switch sets the URL, the note and the numbers', async ({ page, apiUrl }) => {
  const [kpis] = await read(apiUrl, 30)
  await page.goto('/improve')
  await expect(page.getByRole('link', { name: '7 days' })).toHaveAttribute('aria-current', 'page')
  await page.getByRole('link', { name: '30 days' }).click()
  await expect(page).toHaveURL(/\/improve\?days=30$/)
  await expect(page.getByRole('link', { name: '30 days' })).toHaveAttribute('aria-current', 'page')
  await expect(page.getByText(`Last 30 days, ${windowWords(kpis.window)}`, { exact: true })).toBeVisible()
  await expectHeadline(page, kpis)
  await page.goto('/improve?days=12')
  await expect(page.getByText(/^Last 7 days/)).toBeVisible()
})

test('usage reads Not measured where the API says so, and no id leaks onto the page', async ({ page, apiUrl }) => {
  const [kpis] = await read(apiUrl, 7)
  await page.goto('/improve')
  const usage = page.getByRole('region', { name: 'Usage' })
  for (const key of ['cost', 'window_points']) {
    const kpi = kpis.kpis.find((k) => k.key === key)
    if (!kpi) throw new Error(`${key} is not in the API answer`)
    await expect(
      usage.getByRole('listitem').filter({ hasText: kpi.label }).getByText(formatKpi(kpi), { exact: true }),
    ).toBeVisible()
    if (!kpi.measured) expect(formatKpi(kpi)).toBe('Not measured')
  }
  await expect(usage.getByText('Not measured: the usage schema is not joined here').first()).toBeVisible()
  expect(await page.locator('body').innerText()).not.toMatch(/issue_\d+|lead-\d+|#\d+/)
})

test('held finding classes read what the API says: a line when none is held, else each class with its counts', async ({
  page,
  apiUrl,
}) => {
  const model = await api<{
    classes: { loop: string; class: string; status: string; decided: number; noise: number }[]
  }>(apiUrl, '/v1/finding-classes')
  await page.goto('/improve')
  const quiet = model.classes.filter((c) => c.status !== 'open')
  if (quiet.length === 0) {
    await expect(page.getByText('No finding class is held.', { exact: true })).toBeVisible()
    return
  }
  const list = page.getByRole('list', { name: 'Held finding classes' })
  for (const c of quiet) {
    const row = list.getByRole('listitem').filter({ hasText: `${c.loop} · ${c.class}` })
    await expect(row).toContainText(`${c.noise} of ${c.decided} dropped or cancelled`)
  }
})
