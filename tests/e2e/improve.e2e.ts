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
  frictionRanking,
  groupKpis,
  historyLabels,
  hoursWords,
  kpiChange,
  KPI_HINT,
  kpiFooter,
  MEANING,
  mibWords,
  msWords,
  partRows,
  perDayWords,
  shortDate,
  targetTally,
  windowWords,
} from '../../apps/console/src/lib/improve.ts'
import type { CapacityLoopModel, Kpi, KpiModel } from '@software-factory/contract'
import type { Locator, Page } from '@playwright/test'
import { expect, test } from './fixtures.ts'
import { expectHint } from './hints.ts'
import { api } from './seed.ts'

interface FrictionModel {
  days: number
  counts: { key: string; label: string; count: number; perIssue: number | null; previous: number | null }[]
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
  'errands_reached_per_100',
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
const FIX_TITLE = 'Fix commits per week'

const cardOf = (page: Page, title: string): Locator =>
  page.getByRole('article').filter({ has: page.getByRole('heading', { name: title, exact: true }) })

/** Every KPI card in the order the page shows them: off target, the trends, on target, then those with no figure. */
const cardKpis = (model: KpiModel): Kpi[] => {
  const groups = groupKpis(model.kpis)
  const found = [...groups.off, ...groups.trend, ...groups.met, ...groups.unmeasured]
  expect(found.map((k) => k.key).toSorted()).toEqual([...CARD_ORDER].toSorted())
  return found
}

/** The folds hide their cards until opened: open every one. */
const openFolds = async (page: Page) => {
  await expect(page.getByRole('heading', { name: 'Off target', level: 2 })).toBeVisible()
  const closed = page
    .getByRole('group', { name: 'Key figures' })
    .locator('button[aria-controls][aria-expanded="false"]')
  while ((await closed.count()) > 0) await closed.first().click()
}

/** Each KPI card shows what the lib makes of the API's figure, history and target: figure, change, distance, footer. */
async function expectCards(page: Page, model: KpiModel) {
  expect(model.kpis).toHaveLength(26)
  expect(model.windows).toHaveLength(6)
  for (const kpi of cardKpis(model)) {
    const card = cardOf(page, kpi.label)
    await expect(card, kpi.key).toHaveCount(1)
    await expect(card.getByText(formatKpi(kpi), { exact: true }).first()).toBeVisible()
    // one plain sentence of what it means and which way is good, with no click
    await expect(card.getByText(MEANING[kpi.key], { exact: true })).toBeVisible()
    await expect(card.getByText(comparisonWords(model.days), { exact: true })).toBeVisible()
    const [target, counted] = kpiFooter(kpi)
    await expect(card.locator('dd').nth(0)).toHaveText(target.value)
    await expect(card.locator('dd').nth(1)).toHaveText(counted.value)

    const chart = card.getByRole('group', { name: new RegExp(`^${kpi.label}:`) })
    if (!kpi.measured) {
      expect(formatKpi(kpi)).toBe('Not measured')
      expect(kpi.value, `${kpi.key} has no figure, never a zero`).toBeNull()
      expect(kpi.reason).toBeTruthy()
      await expect(card.getByText(kpi.reason ?? '', { exact: true })).toBeVisible()
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

test('the page opens on what is off target; what is met and what has no figure sit in folds', async ({
  page,
  apiUrl,
}) => {
  const [kpis] = await read(apiUrl, 7)
  const groups = groupKpis(kpis.kpis)
  const { met, judged } = targetTally(kpis.kpis)
  await page.goto('/improve')
  const region = page.getByRole('group', { name: 'Key figures' })
  const off = page.locator('[data-shot="improve-target"]')
  await expect(off.getByRole('heading', { name: 'Off target', level: 2 })).toBeVisible()
  if (judged > 0) await expect(off.getByText(`${met} of ${judged} targets met, ${groups.off.length} not`)).toBeVisible()
  await expect(off.getByRole('article')).toHaveCount(groups.off.length)
  const unmeasured = region.getByRole('button', { name: /^Not measured/ })
  const onTarget = region.getByRole('button', { name: /^On target/ })
  await expect(unmeasured).toHaveCount(groups.unmeasured.length > 0 ? 1 : 0)
  await expect(onTarget).toHaveCount(groups.met.length > 0 ? 1 : 0)
  // on target is folded: its cards are not shown until opened
  if (groups.met.length > 0) {
    await expect(onTarget).toHaveAttribute('aria-expanded', 'false')
    await expect(page.locator('[data-shot="improve-met"]').getByRole('article').first()).toBeHidden()
    await onTarget.click()
    await expect(page.locator('[data-shot="improve-met"]').getByRole('article').first()).toBeVisible()
  }
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
  await openFolds(page)
  await expect(grid.locator('article h3')).toHaveText([...cardKpis(kpis).map((k) => k.label), FIX_TITLE])
  const headings = ['Off target', ...(groupKpis(kpis.kpis).trend.length > 0 ? ['No target, trends only'] : [])]
  await expect(grid.getByRole('heading', { level: 2 })).toHaveText([
    ...headings,
    'Fix commits',
    'Friction',
    'Held finding classes',
  ])
  await expectCards(page, kpis)

  // the friction view: kinds that counted, most first, the top five in words with their change, the tail folded
  const ranking = frictionRanking(friction.counts)
  const top = page.getByRole('list', { name: 'Friction, most first' })
  await expect(top.getByRole('listitem')).toHaveCount(ranking.top.length)
  for (const [i, row] of ranking.top.entries()) {
    const item = top.getByRole('listitem').nth(i)
    await expect(item).toContainText(row.label)
    await expect(item.getByLabel('Count')).toHaveText(String(row.count))
    if (ranking.compared) await expect(item.getByLabel('Change')).toHaveText(row.change)
    else await expect(item.getByLabel('Change')).toHaveCount(0)
  }
  const counts = await top.getByLabel('Count').allTextContents()
  expect(counts.map(Number)).toEqual([...counts.map(Number)].toSorted((x, y) => y - x))
  if (ranking.tail.length > 0)
    await expect(page.getByRole('list', { name: 'Friction, the rest' }).getByRole('listitem')).toHaveCount(
      ranking.tail.length,
    )
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
  await openFolds(page)
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
  await openFolds(page)
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

test('every KPI card title and the watches carry an InfoHint with the generated text', async ({ page, apiUrl }) => {
  const [kpis] = await read(apiUrl, 7)
  await page.goto('/improve')
  await openFolds(page)
  for (const kpi of cardKpis(kpis)) await expectHint(cardOf(page, kpi.label), KPI_HINT[kpi.key])
  await expectHint(cardOf(page, FIX_TITLE), KPI_HINT.fix_commits)
  const first = kpis.kpis.find((k) => k.key === 'first_verification_passes')
  if (!first) throw new Error('the first verification passes are not in the API answer')
  await expectHint(cardOf(page, first.label), 'watch')
})

test('the window switch sets the URL, the note and the numbers', async ({ page, apiUrl }) => {
  const [kpis] = await read(apiUrl, 30)
  await page.goto('/improve')
  await expect(page.getByRole('link', { name: '7 days' })).toHaveAttribute('aria-current', 'page')
  await page.getByRole('link', { name: '30 days' }).click()
  await expect(page).toHaveURL(/\/improve\?days=30$/)
  await expect(page.getByRole('link', { name: '30 days' })).toHaveAttribute('aria-current', 'page')
  await expect(page.getByText(`Last 30 days, ${windowWords(kpis.window)}`, { exact: true })).toBeVisible()
  await openFolds(page)
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
  await openFolds(page)
  for (const key of ['cost', 'window_points']) {
    const kpi = kpis.kpis.find((k) => k.key === key)
    if (!kpi) throw new Error(`${key} is not in the API answer`)
    const card = cardOf(page, kpi.label)
    await expect(card.getByText(formatKpi(kpi), { exact: true }).first()).toBeVisible()
    if (kpi.measured) continue
    await expect(card.getByText(kpi.reason ?? '', { exact: true })).toBeVisible()
  }
  // no card reads a zero for a figure that is not there
  for (const kpi of kpis.kpis.filter((k) => !k.measured))
    await expect(cardOf(page, kpi.label).locator('span.tabular-nums').first()).not.toHaveText(/^[$0.]+$/)
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
  // the KPI is wired to the same data: the newest week is the number the fix-commits read returns
  const [kpis] = await read(apiUrl, 7)
  expect(kpis.kpis.find((k) => k.key === 'fix_commits')).toMatchObject({ measured: true, value: card.latest })
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
    'Idle seat-hours with work ready',
    'Minutes over the load ceiling',
    'Test slot wait',
  ])
  await expect(cardOf(page, 'Issues closed').getByText(perDayWords(model.throughput.total, model.days))).toBeVisible()
  await expect(
    cardOf(page, 'Idle seat-hours with work ready').getByText(hoursWords(2), { exact: true }).first(),
  ).toBeVisible()
  await expect(cardOf(page, 'Minutes over the load ceiling').getByText('2', { exact: true }).first()).toBeVisible()
  const wait = cardOf(page, 'Test slot wait')
  await expect(wait.getByText(msWords(2000), { exact: true }).first()).toBeVisible()
  await expect(wait.getByText(`Median; 90th percentile ${msWords(55_000)}`, { exact: true })).toBeVisible()
  await expectHint(cardOf(page, 'Idle seat-hours with work ready'), CAPACITY_HINT.idle)
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

test('the queue wait card names what the wait is made of, largest first, from the same figures the API gives', async ({
  page,
  apiUrl,
}) => {
  const [kpis] = await read(apiUrl, 7)
  const wait = kpis.kpis.find((k) => k.key === 'queue_wait_p50')
  const rows = partRows(wait ?? { parts: [] })
  expect(rows.length, 'the seed queued an Issue behind an edge and a cap').toBeGreaterThan(1)
  await page.goto('/improve')
  await openFolds(page)
  const card = cardOf(page, wait?.label ?? '')
  const largest = rows[0]
  // an open interval grows between the API read and the page's, so the share is matched as a number
  await expect(
    card.getByText(new RegExp(`^Mostly ${largest?.label.toLowerCase()}, \\d+ % of the time Issues waited$`)),
  ).toBeVisible()
  const list = card.getByRole('list', { name: /by reason/ })
  await expect(list.getByRole('listitem')).toHaveCount(rows.length)
  await expect(list.getByRole('listitem').first()).toContainText(largest?.label ?? '')
})
