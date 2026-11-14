import {
  CAPACITY_HINT,
  comparisonWords,
  constantRows,
  distanceWords,
  drawsHistory,
  fixCard,
  fixClassRows,
  fixWeeksOldestFirst,
  fixWeekTotals,
  formatKpi,
  FRICTION_GROUP_HINT,
  FRICTION_GROUP_LABEL,
  historyLabels,
  hoursWords,
  kpiChange,
  KPI_HINT,
  kpiFooter,
  mibWords,
  msWords,
  perDayWords,
  perIssueWords,
  shortDate,
  STATUS_WORD,
  summaryKpis,
  targetStatus,
  targetWords,
  targetTally,
  windowWords,
} from '../../apps/console/src/lib/improve.ts'
import type { CapacityLoopModel, Kpi, KpiModel } from '@software-factory/contract'
import type { Locator, Page } from '@playwright/test'
import { expect, test } from './fixtures.ts'
import { expectHint } from './hints.ts'
import { api } from './seed.ts'

interface FrictionModel {
  counts: { key: string; label: string; count: number; perIssue: number | null }[]
}
type FixModel = Parameters<typeof fixClassRows>[0] & { measured: boolean }

/** The cards in the Console's own order, band by band; the fix-commit card follows. */
const CARD_ORDER = [
  'first_verification_passes',
  'avoidable_touches',
  'asks',
  'worth_asking',
  'specs_not_needed',
  'specs_per_100',
  'owner_decisions_per_100',
  'verdict_changes_share',
  'first_watch_dwell_p50',
  'regression_cause',
  'queue_wait_p90',
  'queue_wait_p50',
  'cycle_p50',
  'refusals',
  'queue_time',
  'idle_capacity',
  'working_share',
  'dropped_after_lead',
  'amend_rate',
  'nudges_acted',
  'forced_note_delay_p50',
  'errands_turned_away',
  'window_points',
  'cost',
]
const BAND_HEADINGS = [
  'Against target',
  'Quality',
  'Pace and gates',
  'Where time goes',
  'The loops',
  'Spend',
  'Fix commits',
  'Friction',
  'Held finding classes',
]
const FIX_TITLE = 'Fix commits per week'

const cardOf = (page: Page, title: string): Locator =>
  page.getByRole('article').filter({ has: page.getByRole('heading', { name: title, exact: true }) })

const cardKpis = (model: KpiModel): Kpi[] =>
  CARD_ORDER.map((key) => {
    const kpi = model.kpis.find((k) => k.key === key)
    if (!kpi) throw new Error(`${key} is not in the API answer`)
    return kpi
  })

/** Each KPI card shows what the lib makes of the API's figure, history and target: figure, change, distance, footer. */
async function expectCards(page: Page, model: KpiModel) {
  expect(model.kpis).toHaveLength(25)
  expect(model.windows).toHaveLength(6)
  for (const kpi of cardKpis(model)) {
    const card = cardOf(page, kpi.label)
    await expect(card, kpi.key).toHaveCount(1)
    await expect(card.getByText(formatKpi(kpi), { exact: true }).first()).toBeVisible()
    await expect(card.getByText(comparisonWords(model.days), { exact: true })).toBeVisible()
    const [target, counted] = kpiFooter(kpi)
    await expect(card.locator('dd').nth(0)).toHaveText(target.value)
    await expect(card.locator('dd').nth(1)).toHaveText(counted.value)

    const chart = card.getByRole('group', { name: new RegExp(`^${kpi.label}:`) })
    if (!kpi.measured) {
      expect(formatKpi(kpi)).toBe('Not measured')
      await expect(card.locator('[data-tone]')).toHaveCount(0)
      await expect(chart).toHaveCount(0)
      continue
    }
    const distance = distanceWords(kpi)
    // no target to judge: the footer's Target pair says so, and the card says it nowhere else
    if (distance === null) await expect(card.getByText(target.value, { exact: true })).toHaveCount(1)
    else await expect(card.getByText(distance, { exact: true }).first()).toBeVisible()
    const change = kpiChange(kpi)
    await expect(card.locator('[data-tone]')).toHaveText(change.text)
    await expect(card.locator('[data-tone]')).toHaveAttribute('data-tone', change.tone)
    if (drawsHistory(kpi)) await expect(chart.locator('tbody tr')).toHaveCount(6)
    else await expect(chart).toHaveCount(0)
  }
}

test('the summary strip tiles every KPI with a target: its status word, the target in words, and a click scrolls to its card', async ({
  page,
  apiUrl,
}) => {
  const [kpis] = await read(apiUrl, 7)
  const tiled = summaryKpis(kpis.kpis)
  expect(tiled.length).toBeGreaterThanOrEqual(3)
  await page.goto('/improve')
  const strip = page.locator('[data-shot="improve-summary"]')
  const { met, judged } = targetTally(tiled)
  if (judged > 0) await expect(strip.getByText(`${met} of ${judged} targets met`, { exact: true })).toBeVisible()
  else await expect(strip.getByText(/targets met$/)).toHaveCount(0)
  await expect(strip.getByRole('link')).toHaveCount(tiled.length)
  for (const kpi of tiled) {
    const tile = strip.getByRole('link').filter({ hasText: kpi.label })
    await expect(tile).toContainText(STATUS_WORD[targetStatus(kpi)])
    await expect(tile).toContainText(formatKpi(kpi))
    await expect(tile).toContainText(targetWords(kpi))
  }
  const last = tiled.at(-1)
  if (!last) throw new Error('no tile')
  await strip.getByRole('link').filter({ hasText: last.label }).click()
  await expect(cardOf(page, last.label)).toBeInViewport()
})

const read = (apiUrl: string, days: number) =>
  Promise.all([api<KpiModel>(apiUrl, `/v1/kpis?days=${days}`), api<FrictionModel>(apiUrl, `/v1/friction?days=${days}`)])

test('one card per KPI in the order the Console shows, each the figures the API says, then the fix-commit card', async ({
  page,
  apiUrl,
}) => {
  const [kpis, friction] = await read(apiUrl, 7)
  await page.goto('/improve')
  await expect(page.getByRole('heading', { name: 'Improve', level: 1 })).toBeVisible()
  await expect(page.getByText(`Last 7 days, ${windowWords(kpis.window)}`, { exact: true })).toBeVisible()

  const grid = page.getByRole('group', { name: 'Key figures' })
  await expect(grid.locator('article h3')).toHaveText([...cardKpis(kpis).map((k) => k.label), FIX_TITLE])
  await expect(grid.getByRole('heading', { level: 2 })).toHaveText(BAND_HEADINGS)
  await expectCards(page, kpis)

  for (const count of friction.counts) {
    const row = page.getByRole('listitem').filter({ hasText: count.label })
    await expect(row.getByLabel('Count')).toHaveText(String(count.count))
    await expect(row.getByLabel('Per Issue closed')).toHaveText(perIssueWords(count.perIssue))
  }
})

test('the KPIs with a history draw it: a tooltip per point names its window and what was counted', async ({
  page,
  apiUrl,
}) => {
  const [kpis] = await read(apiUrl, 7)
  const withHistory = cardKpis(kpis).filter(
    (k) => drawsHistory(k) && k.history.filter((p) => p.value !== null).length > 1,
  )
  expect(withHistory.length, 'the seed gives some KPI a real history').toBeGreaterThanOrEqual(3)
  await page.goto('/improve')
  for (const kpi of withHistory.slice(0, 3)) {
    const chart = cardOf(page, kpi.label).getByRole('group', { name: new RegExp(`^${kpi.label}:`) })
    await chart.focus()
    const last = kpi.history.map((p) => p.value !== null).lastIndexOf(true)
    await expect(chart.getByRole('status')).toContainText(historyLabels(kpi, kpis.windows)[last] ?? '')
  }
})

test('the definition of what is counted is one keyboard press away on every card', async ({ page, apiUrl }) => {
  const [kpis] = await read(apiUrl, 7)
  await page.goto('/improve')
  for (const kpi of [kpis.kpis[0], kpis.kpis.find((k) => k.key === 'cost')]) {
    if (!kpi) throw new Error('a KPI is missing')
    const button = cardOf(page, kpi.label).getByRole('button', { name: `${kpi.label}: what is counted` })
    await button.focus()
    await page.keyboard.press('Enter')
    await expect(page.getByText(kpi.definition, { exact: true })).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(page.getByText(kpi.definition, { exact: true })).toHaveCount(0)
  }
})

test('every KPI card title, the watches, and the friction words carry an InfoHint with the generated text', async ({
  page,
  apiUrl,
}) => {
  const [kpis] = await read(apiUrl, 7)
  await page.goto('/improve')
  for (const kpi of cardKpis(kpis)) await expectHint(cardOf(page, kpi.label), KPI_HINT[kpi.key])
  await expectHint(cardOf(page, FIX_TITLE), KPI_HINT.fix_commits)
  const first = kpis.kpis.find((k) => k.key === 'first_verification_passes')
  if (!first?.measured) throw new Error('the first verification passes are not measured')
  await expectHint(cardOf(page, first.label), 'watch')

  const { counts } = await api<{ counts: { group: string }[] }>(apiUrl, '/v1/friction?days=7')
  const groups = Object.keys(FRICTION_GROUP_HINT).filter((group) => counts.some((c) => c.group === group))
  for (const group of groups) {
    const word = FRICTION_GROUP_HINT[group as keyof typeof FRICTION_GROUP_HINT]
    const label = FRICTION_GROUP_LABEL[group as keyof typeof FRICTION_GROUP_LABEL]
    await expectHint(page.locator('h3', { hasText: label }), word)
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
  await expectCards(page, kpis)
  await page.goto('/improve?days=12')
  await expect(page.getByText(/^Last 7 days, /)).toBeVisible()
})

test('a KPI the API does not measure says Not measured and why, and no id leaks onto the page', async ({
  page,
  apiUrl,
}) => {
  const [kpis] = await read(apiUrl, 7)
  await page.goto('/improve')
  for (const key of ['cost', 'window_points']) {
    const kpi = kpis.kpis.find((k) => k.key === key)
    if (!kpi) throw new Error(`${key} is not in the API answer`)
    const card = cardOf(page, kpi.label)
    await expect(card.getByText(formatKpi(kpi), { exact: true }).first()).toBeVisible()
    if (kpi.measured) continue
    await expect(card.getByText('The usage schema is not joined here', { exact: true })).toBeVisible()
  }
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

test('the fix-commit card reads the API: the newest week, the change, the legend and the busiest class', async ({
  page,
  apiUrl,
}) => {
  const model = await api<FixModel>(apiUrl, '/v1/fix-commits')
  expect(model.measured).toBe(true)
  const card = fixCard(model)
  await page.goto('/improve')
  const article = cardOf(page, FIX_TITLE)
  await expect(article.getByText(String(card.latest), { exact: true }).first()).toBeVisible()
  await expect(article.locator('[data-tone]')).toHaveText(card.change.text)
  await expect(article.locator('[data-tone]')).toHaveAttribute('data-tone', card.tone)
  await expect(article.locator('dd').nth(0)).toHaveText(String(card.total))
  await expect(article.locator('dd').nth(1)).toHaveText(
    card.busiest ? `${card.busiest.key} (${card.busiest.total})` : 'None',
  )

  const legend = article.getByRole('list', { name: /legend/ })
  const present = card.classes.filter((c) => c.total > 0)
  await expect(legend.getByRole('listitem')).toHaveCount(present.length)
  for (const c of present)
    await expect(legend.getByRole('listitem').filter({ hasText: c.key })).toContainText(String(c.total))

  const chart = article.getByRole('group', { name: /^Fix commits per week by class/ })
  await expect(chart.locator('tbody tr')).toHaveCount(card.weeks.length)
  await chart.focus()
  const newest = card.weeks.at(-1)
  await expect(chart.getByRole('status')).toContainText(`Week to ${newest?.label}`)
})

test('fix commits by class read what the API says, the weeks oldest first, with a total row', async ({
  page,
  apiUrl,
}) => {
  const model = await api<FixModel>(apiUrl, '/v1/fix-commits')
  expect(model.measured).toBe(true)
  await page.goto('/improve')
  const region = page.getByRole('region', { name: 'Fix commits by class' })
  await expect(region.getByRole('heading', { name: /^Fix commits by class/, level: 3 })).toBeVisible()
  const table = region.getByRole('table')
  const head = table.getByRole('columnheader')
  await expect(head).toHaveText(['Class', ...fixWeeksOldestFirst(model).map((week) => shortDate(week.to))])
  for (const row of fixClassRows(model)) {
    const line = table.getByRole('row').filter({ has: page.getByRole('rowheader', { name: row.key, exact: true }) })
    await expect(line.getByRole('cell')).toHaveText(row.counts.map(String))
  }
  const total = table.getByRole('row').filter({ has: page.getByRole('rowheader', { name: 'Total' }) })
  await expect(total.getByRole('cell')).toHaveText(fixWeekTotals(model).map(String))
})

test('the capacity section reads what the API computed: cards, steps, lead costs, the reaper and the settings', async ({
  page,
  apiUrl,
}) => {
  const model = await api<CapacityLoopModel>(apiUrl, '/v1/capacity-loop?days=7')
  // the seed's figures, so a read that drifted from the rows fails here and not only against itself
  expect(model.minutesOverCeiling.total).toBe(2)
  expect(model.idleSeatHours.total).toBeCloseTo(2, 9)
  expect(model.slotWait.n).toBe(6)
  expect(model.slotWait.p50Ms).toBeCloseTo(2000, 6)
  expect(model.slotWait.p90Ms).toBeCloseTo(55_000, 6)
  expect(model.reaped.total).toBe(3)
  expect(model.topSteps.map((s) => s.name)).toEqual([
    'software-factory check',
    'software-factory e2e',
    'software-factory test',
  ])
  expect(model.leadCosts.map((l) => [l.repo, l.attempts, l.peakMibP80])).toEqual([
    ['argo', 3, 2200],
    ['zeta', 2, 900],
  ])

  await page.goto('/improve')
  const section = page.getByRole('region', { name: 'Capacity' })
  await expect(section).toBeVisible()
  const cards = section.getByRole('group', { name: 'Capacity figures' })
  await expect(cards.getByRole('heading')).toHaveText([
    'Issues closed',
    'Idle seat-hours with work queued',
    'Minutes over the load ceiling',
    'Test slot wait',
  ])
  await expect(cardOf(page, 'Issues closed').getByText(perDayWords(model.throughput.total, model.days))).toBeVisible()
  await expect(
    cardOf(page, 'Idle seat-hours with work queued').getByText(hoursWords(2), { exact: true }).first(),
  ).toBeVisible()
  await expect(cardOf(page, 'Minutes over the load ceiling').getByText('2', { exact: true }).first()).toBeVisible()
  const wait = cardOf(page, 'Test slot wait')
  await expect(wait.getByText(msWords(2000), { exact: true }).first()).toBeVisible()
  await expect(wait.getByText(`Median; 90th percentile ${msWords(55_000)}`, { exact: true })).toBeVisible()
  await expectHint(cardOf(page, 'Idle seat-hours with work queued'), CAPACITY_HINT.idle)
  await expectHint(cardOf(page, 'Test slot wait'), CAPACITY_HINT.wait)

  const steps = section.getByRole('table', { name: /Test-slot steps/ })
  const check = steps
    .getByRole('row')
    .filter({ has: page.getByRole('rowheader', { name: 'software-factory check', exact: true }) })
  const top = model.topSteps[0]
  if (!top) throw new Error('no step in the API answer')
  await expect(check.getByRole('cell')).toHaveText([
    String(top.runs),
    mibWords(top.maxPeakMib),
    mibWords(top.p80PeakMib),
    msWords(top.medianDurationMs),
    msWords(top.medianWaitMs),
  ])
  const costs = section.getByRole('table', { name: /Memory a lead takes/ })
  const argo = costs.getByRole('row').filter({ has: page.getByRole('rowheader', { name: 'argo', exact: true }) })
  // argo's footprints are 60 % of its RSS; zeta has none recorded yet
  await expect(argo.getByRole('cell')).toHaveText(['3', mibWords(2200), mibWords(1800), mibWords(1320), '60 %'])
  const zeta = costs.getByRole('row').filter({ has: page.getByRole('rowheader', { name: 'zeta', exact: true }) })
  await expect(zeta.getByRole('cell')).toHaveText(['2', mibWords(900), mibWords(900), 'none yet', 'none yet'])

  await expect(section.getByText(/^3 processes of closed attempts ended by the/)).toBeVisible()
  await expectHint(section, CAPACITY_HINT.reaped)
  const settings = section.getByLabel('Settings in force')
  const rows = constantRows(model.constants)
  await expect(settings.locator('dt')).toHaveText(rows.map((r) => r.label))
  await expect(settings.locator('dd')).toHaveText(rows.map((r) => r.value))
})
