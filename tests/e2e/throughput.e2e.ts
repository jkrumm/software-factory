import type { ThroughputModel } from '@software-factory/contract'
import type { Page } from '@playwright/test'
import {
  CLASS_LABEL,
  classRows,
  epochLine,
  hostFigures,
  hoursWords,
  kpiLabel,
  kpiValue,
  mibWords,
  percentWords,
  queueWords,
  secondsWords,
  splitRows,
  STATUS,
  windowName,
} from '../../apps/console/src/lib/throughput.ts'
import { expect, test } from './fixtures.ts'
import { api } from './seed.ts'

const read = (apiUrl: string, hours: number) => api<ThroughputModel>(apiUrl, `/v1/throughput?hours=${hours}`)

const QUESTIONS = [
  'Is the host the limit right now?',
  'What keeps Issues from starting?',
  'What is the largest avoidable cost?',
]

const table = (page: Page, name: string) => page.getByRole('table', { name })
const open = (page: Page, title: RegExp) => page.getByRole('button', { name: title }).click()

test('the three answers are on the first screen at 1800 wide, each its question, one sentence and one figure', async ({
  page,
  apiUrl,
}) => {
  const model = await read(apiUrl, 24)
  await page.goto('/throughput')
  await expect(page.getByRole('heading', { name: 'Throughput', level: 1 })).toBeVisible()
  await expect(page.locator('[aria-busy="true"]')).toHaveCount(0)
  const sentences = [model.answers.host.sentence, model.answers.queue.sentence, model.answers.cost.sentence]
  for (const [i, question] of QUESTIONS.entries()) {
    const card = page.locator('article').filter({ has: page.getByRole('heading', { name: question, level: 3 }) })
    await expect(card).toHaveCount(1)
    await expect(card.getByText(sentences[i] ?? '', { exact: true })).toBeVisible()
    const box = await card.boundingBox()
    expect(box).not.toBeNull()
    // the whole card sits in the first 1200 px, beside the other two
    expect((box?.y ?? 0) + (box?.height ?? 0)).toBeLessThanOrEqual(1200)
    expect(box?.width ?? 0).toBeGreaterThan(400)
  }
  // nothing else is open: every detail is closed
  for (const button of await page.getByRole('main').getByRole('button', { expanded: true }).all())
    await expect(button).toBeHidden()
  await expect(page.getByText(/issue_\d+|lead-\d+/)).toHaveCount(0)
})

test('the answers are the API: pressure now, the binding reason in hours, the tenant class against its budget', async ({
  page,
  apiUrl,
}) => {
  const { answers, host } = await read(apiUrl, 24)
  expect(answers.queue.binding).toMatchObject({ kind: 'memory', hours: 3, issues: 1 })
  expect(answers.cost.kind).toBe('tenant')
  expect(host.tenantBudget.over).toBe(true)
  await page.goto('/throughput')
  const hostCard = page.locator('#throughput-host')
  await expect(hostCard).toContainText(answers.host.limit ? 'The limit' : 'Not the limit')
  const queue = page.locator('#throughput-queue')
  await expect(queue).toContainText(hoursWords(3))
  await expect(queue).toContainText(queueWords('memory'))
  const cost = page.locator('#throughput-cost')
  await expect(cost).toContainText(`${mibWords(answers.cost.figure ?? 0)} over`)
  await expect(cost).toContainText(mibWords(host.tenantBudget.budgetMib))
})

test('the host row leads the page with CPU, memory, swap, pressure and load as numbers, each with a hint', async ({
  page,
  apiUrl,
}) => {
  const model = await read(apiUrl, 24)
  const figures = hostFigures(model)
  expect(model.host.now).not.toBeNull()
  await page.goto('/throughput')
  const row = page.getByRole('region', { name: 'The host now' })
  for (const [id, title, key] of [
    ['throughput-cpu', 'CPU busy', 'cpu'],
    ['throughput-memory', 'Memory used', 'memory'],
    ['throughput-swap', 'Swap used', 'swap'],
    ['throughput-pressure', 'Memory pressure', 'pressure'],
    ['throughput-load', 'Load', 'load'],
  ] as const) {
    const card = row.locator(`#${id}`)
    await expect(card.getByRole('heading', { name: title, level: 3 })).toBeVisible()
    await expect(card).toContainText(figures[key].value ?? '–')
    await expect(card.getByRole('button', { name: `What ${title} means` })).toBeVisible()
  }
  // amounts, not shares: GB of the RAM, GB of the swap, the load against its ceiling
  await expect(row.locator('#throughput-memory')).toContainText(/\d+(\.\d)? of 64 GB/)
  await expect(row.locator('#throughput-swap')).toContainText(/\d+(\.\d)? of 32 GB/)
  await expect(row.locator('#throughput-load')).toContainText(/of 36/)
  // the row sits above the three answers, inside the first 1200 px
  const box = await row.boundingBox()
  expect((box?.y ?? 0) + (box?.height ?? 0)).toBeLessThanOrEqual(1200)
})

test('the host detail holds the five charts and the five largest processes, and opens on request', async ({
  page,
  apiUrl,
}) => {
  const model = await read(apiUrl, 24)
  await page.goto('/throughput')
  await expect(page.getByRole('group', { name: /^Memory pressure/ })).toHaveCount(1)
  await expect(page.getByRole('heading', { name: 'CPU, memory, swap, pressure and load' })).toHaveCount(0)
  await open(page, /^The host over time: CPU, memory, swap, pressure and load/)
  for (const name of ['CPU busy', 'Memory used', 'Swap used', 'Memory pressure', 'Load average'])
    await expect(page.getByRole('group', { name: new RegExp(`^${name}`) }).first()).toBeVisible()
  const processes = table(page, 'Notable processes')
  await expect(processes.locator('tbody tr')).toHaveCount(Math.min(5, model.host.topProcesses.length))
  await expect(processes.getByRole('rowheader').filter({ hasText: 'grew' }).first()).toBeVisible()
})

test('the queue detail lists each reason with its hours, and the lead time split', async ({ page, apiUrl }) => {
  const model = await read(apiUrl, 24)
  await page.goto('/throughput')
  await open(page, /^The queue: what each reason cost/)
  const reasons = table(page, 'Hours in the queue by reason').locator('tbody tr')
  await expect(reasons).toHaveCount(model.answers.queue.byReason.length)
  for (const reason of model.answers.queue.byReason) {
    const row = page.locator(`tr[data-reason="${reason.kind}"]`)
    await expect(row.getByRole('rowheader')).toHaveText(queueWords(reason.kind))
    await expect(row.getByRole('cell').nth(0)).toHaveText(hoursWords(reason.hours))
  }
  const band = page.getByRole('region', { name: "Where a lead's time goes" })
  if (model.lead.closed === 0) {
    await expect(band.getByText('No Issue with a lead closed in this window.')).toBeVisible()
    return
  }
  for (const part of splitRows(model.lead.split))
    await expect(band.getByRole('listitem').filter({ hasText: part.label })).toContainText(secondsWords(part.seconds))
  await expect(band.getByRole('img')).toHaveAttribute('aria-label', /^Lead time: /)
})

test('the cost detail: the seven classes with the API figures, tenants and projects, and a project opens its page', async ({
  page,
  apiUrl,
}) => {
  const model = await read(apiUrl, 24)
  await page.goto('/throughput')
  await open(page, /^The cost: memory by class/)
  const classes = table(page, 'Footprint by process class')
  await expect(classes.locator('tbody tr')).toHaveCount(7)
  for (const row of classRows(model)) {
    const line = classes.locator(`tr[data-class="${row.class}"]`)
    await expect(line.getByRole('rowheader')).toHaveText(CLASS_LABEL[row.class] ?? row.class)
    const cells = line.getByRole('cell')
    await expect(cells.nth(0)).toContainText(percentWords(row.share))
    await expect(cells.nth(1)).toHaveText(mibWords(row.footprintMib))
    await expect(cells.nth(2)).toHaveText(mibWords(row.peakMib))
  }
  expect(model.host.byClass.reduce((sum, c) => sum + c.share, 0)).toBeCloseTo(1, 2)
  const tenants = table(page, 'Memory by tenant')
  await expect(tenants.locator('tbody tr')).toHaveCount(model.host.byTenant.length)
  await expect(tenants.locator('tbody tr').first().getByRole('rowheader')).toHaveText(
    model.host.byTenant[0]?.tenant ?? '',
  )
  await table(page, 'Memory by project').getByRole('link', { name: 'argo' }).click()
  await expect(page).toHaveURL(/\/projects\/argo$/)
})

test('the scorecard has a row per project the API names, with its slot minutes per closed Issue', async ({
  page,
  apiUrl,
}) => {
  const model = await read(apiUrl, 168)
  await page.goto('/throughput?hours=168')
  await open(page, /^The cost: project scorecard/)
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

test('the improvements read the API newest first; a finding from before the epoch is not measured, with its reason', async ({
  page,
  apiUrl,
}) => {
  const model = await read(apiUrl, 24)
  expect(model.improvements.map((f) => f.status)).toEqual(
    expect.arrayContaining(['open', 'moved', 'flat', 'worse', 'unmeasured']),
  )
  await page.goto('/throughput')
  await open(page, /^The cost: improvements ledger/)
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
    await expect(row.getByRole('cell').nth(2)).toContainText(STATUS[finding.status]?.label ?? finding.status)
    if (finding.reason) await expect(row.getByRole('cell').nth(2)).toContainText(finding.reason)
  }
})

test('the window switch sets the URL and the numbers; the fortnight is cut by the epoch and says where it starts', async ({
  page,
  apiUrl,
}) => {
  const day = await read(apiUrl, 24)
  const fortnight = await read(apiUrl, 336)
  expect(day.epoch?.cut).toBe(false)
  expect(fortnight.epoch?.cut).toBe(true)
  expect(fortnight.window.from).toBe(fortnight.epoch?.countingSince)
  await page.goto('/throughput')
  await expect(page.getByText(epochLine(day) ?? '', { exact: true })).toBeVisible()
  await expect(page.getByRole('link', { name: '24 hours' }).first()).toHaveAttribute('aria-current', 'page')
  await page.getByRole('link', { name: '14 days' }).first().click()
  await expect(page).toHaveURL(/\/throughput\?hours=336$/)
  await expect(page.getByText(epochLine(fortnight) ?? '', { exact: true })).toBeVisible()
  await expect(page.getByText(`the ${windowName(336)} window starts there`, { exact: false })).toBeVisible()
  await page.goto('/throughput?hours=5')
  await expect(page.getByText(epochLine(day) ?? '', { exact: true })).toBeVisible()
})

test('the window is in the sidebar and the page has no switch of its own at desktop width', async ({ page }) => {
  await page.goto('/throughput')
  const section = page.locator('aside').getByRole('group', { name: 'Window' })
  await expect(section.getByRole('link', { name: '24 hours' })).toHaveAttribute('aria-current', 'page')
  await expect(page.getByRole('navigation', { name: 'Window' })).toBeHidden()
})
