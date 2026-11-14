import type { ThroughputModel } from '@software-factory/contract'
import type { Page } from '@playwright/test'
import {
  CLASS_LABEL,
  classRows,
  kpiLabel,
  kpiValue,
  levelWords,
  mibWords,
  percentWords,
  secondsWords,
  splitRows,
  STATUS,
  windowName,
} from '../../apps/console/src/lib/throughput.ts'
import { expect, test } from './fixtures.ts'
import { api } from './seed.ts'

const read = (apiUrl: string, hours: number) => api<ThroughputModel>(apiUrl, `/v1/throughput?hours=${hours}`)

const HEADINGS = [
  'Memory by class',
  'Pressure, swap and load',
  'Where it goes',
  "Where a lead's time goes",
  'Project scorecard',
  'Improvements',
]

const note = (hours: number) => `Where the host's memory and the leads' hours went over ${windowName(hours)}`
const table = (page: Page, name: string) => page.getByRole('table', { name })

test('the bands are on the page in order, each with its heading, and no skeleton is left', async ({ page }) => {
  await page.goto('/throughput')
  await expect(page.getByRole('heading', { name: 'Throughput', level: 1 })).toBeVisible()
  const headings = page.getByRole('main').getByRole('heading', { level: 2 })
  await expect(headings).toHaveText(HEADINGS)
  await expect(page.locator('[aria-busy="true"]')).toHaveCount(0)
  await expect(page.getByText(/issue_\d+|lead-\d+/)).toHaveCount(0)
})

test('memory by class lists the seven classes with the API figures and shares that add up', async ({
  page,
  apiUrl,
}) => {
  const model = await read(apiUrl, 24)
  await page.goto('/throughput')
  const rows = table(page, 'Footprint by process class').locator('tbody tr')
  await expect(rows).toHaveCount(7)
  for (const row of classRows(model)) {
    const line = table(page, 'Footprint by process class').locator(`tr[data-class="${row.class}"]`)
    await expect(line.getByRole('rowheader')).toHaveText(CLASS_LABEL[row.class] ?? row.class)
    const cells = line.getByRole('cell')
    await expect(cells.nth(0)).toContainText(percentWords(row.share))
    await expect(cells.nth(1)).toHaveText(mibWords(row.footprintMib))
    await expect(cells.nth(2)).toHaveText(mibWords(row.peakMib))
  }
  expect(model.host.byClass.reduce((sum, c) => sum + c.share, 0)).toBeCloseTo(1, 2)
  // no class budget exists, so no meter takes a warn or bad tone from one
  await expect(table(page, 'Footprint by process class').locator('[data-tone]:not([data-tone="neutral"])')).toHaveCount(
    0,
  )
})

test('the pressure card is the API: warning plus critical minutes, and each chart has its numbers', async ({
  page,
  apiUrl,
}) => {
  const model = await read(apiUrl, 24)
  const { warning, critical, normal } = model.host.signals.pressureMinutes
  expect(warning).toBeGreaterThan(0)
  expect(critical).toBeGreaterThan(0)
  await page.goto('/throughput')
  const card = page.locator('#throughput-pressure')
  await expect(card.getByText(`${warning + critical} min`, { exact: true }).first()).toBeVisible()
  await expect(card).toContainText(`of ${normal + warning + critical} min read`)
  await expect(card.locator('dd').nth(0)).toHaveText(`${warning} min`)
  await expect(card.locator('dd').nth(1)).toHaveText(`${critical} min`)
  for (const name of ['Memory pressure', 'Swap in use, share of RAM', 'Load average']) {
    await expect(page.getByRole('group', { name: new RegExp(`^${name}`) }).first()).toBeVisible()
  }
  expect(model.host.timeline.bucketMinutes).toBe(5)
  expect(model.host.timeline.points.some((p) => p.pressureLevel === 4)).toBe(true)
  expect(levelWords(4)).toBe('Critical')
})

test('tenants, projects and processes read the API, and a project opens Flow filtered to it', async ({
  page,
  apiUrl,
}) => {
  const model = await read(apiUrl, 24)
  await page.goto('/throughput')
  const tenants = table(page, 'Memory by tenant')
  await expect(tenants.locator('tbody tr')).toHaveCount(model.host.byTenant.length)
  await expect(tenants.locator('tbody tr').first().getByRole('rowheader')).toHaveText(
    model.host.byTenant[0]?.tenant ?? '',
  )
  const processes = table(page, 'Notable processes')
  await expect(processes.locator('tbody tr')).toHaveCount(model.host.topProcesses.length)
  await expect(processes.getByRole('rowheader').filter({ hasText: 'grew' }).first()).toBeVisible()
  await table(page, 'Memory by project').getByRole('link', { name: 'argo' }).click()
  await expect(page).toHaveURL(/\/flow\?project=argo$/)
})

test('the scorecard has a row per project the API names, with its slot minutes per closed Issue', async ({
  page,
  apiUrl,
}) => {
  const model = await read(apiUrl, 168)
  await page.goto('/throughput?hours=168')
  const rows = table(page, 'One row per project').locator('tbody tr')
  await expect(rows).toHaveCount(model.project.length)
  expect(model.project.map((p) => p.repo)).toContain('argo')
  for (const project of model.project) {
    const row = rows.filter({ has: page.getByRole('link', { name: project.repo, exact: true }) })
    await expect(row).toHaveCount(1)
    const per = project.slot.minutesPerClosedIssue
    await expect(row.getByRole('cell').nth(1)).toHaveText(per === null ? '–' : per.toFixed(1))
  }
})

test('the lead time band is the API: the split of each part, or the empty line when no lead closed an Issue', async ({
  page,
  apiUrl,
}) => {
  const model = await read(apiUrl, 24)
  await page.goto('/throughput')
  const band = page.getByRole('region', { name: "Where a lead's time goes" })
  if (model.lead.closed === 0) {
    await expect(band.getByText('No Issue with a lead closed in this window.')).toBeVisible()
    return
  }
  for (const part of splitRows(model.lead.split)) {
    const line = band.getByRole('listitem').filter({ hasText: part.label })
    await expect(line).toContainText(secondsWords(part.seconds))
  }
  await expect(band.getByRole('img')).toHaveAttribute('aria-label', /^Lead time: /)
})

test('the improvements read the API newest first, each with its before, target, after, status and Issue', async ({
  page,
  apiUrl,
}) => {
  const model = await read(apiUrl, 24)
  expect(model.improvements.map((f) => f.status)).toEqual(
    expect.arrayContaining(['open', 'moved', 'flat', 'worse', 'shipped']),
  )
  await page.goto('/throughput')
  const rows = table(page, 'Improvement findings').locator('tbody tr')
  await expect(rows).toHaveCount(model.improvements.length)
  for (const [i, finding] of model.improvements.entries()) {
    const row = rows.nth(i)
    await expect(row).toHaveAttribute('data-status', finding.status)
    await expect(row.getByRole('rowheader')).toHaveText(finding.project)
    await expect(row.getByRole('cell').nth(0)).toContainText(kpiLabel(finding.kpi))
    const figures = row.getByRole('cell').nth(1)
    await expect(figures).toContainText(kpiValue(finding.kpi, finding.before))
    await expect(figures).toContainText(`target ${kpiValue(finding.kpi, finding.target)}`)
    await expect(figures).toContainText(finding.after === null ? 'not read' : kpiValue(finding.kpi, finding.after))
    await expect(row.getByRole('cell').nth(2)).toHaveText(STATUS[finding.status]?.label ?? finding.status)
  }
})

test('the window switch sets the URL, the note and the numbers; another value is the default', async ({
  page,
  apiUrl,
}) => {
  const week = await read(apiUrl, 168)
  await page.goto('/throughput')
  await expect(page.getByText(note(24), { exact: true })).toBeVisible()
  await expect(page.getByRole('link', { name: '24 hours' }).first()).toHaveAttribute('aria-current', 'page')
  await page.getByRole('link', { name: '7 days' }).first().click()
  await expect(page).toHaveURL(/\/throughput\?hours=168$/)
  await expect(page.getByText(note(168), { exact: true })).toBeVisible()
  await expect(table(page, 'One row per project').locator('tbody tr')).toHaveCount(week.project.length)
  await page.goto('/throughput?hours=5')
  await expect(page.getByText(note(24), { exact: true })).toBeVisible()
})

test('the window is in the sidebar and the page has no switch of its own at desktop width', async ({ page }) => {
  await page.goto('/throughput')
  const section = page.locator('aside').getByRole('group', { name: 'Window' })
  await expect(section.getByRole('link', { name: '24 hours' })).toHaveAttribute('aria-current', 'page')
  await expect(page.getByRole('navigation', { name: 'Window' })).toBeHidden()
})
