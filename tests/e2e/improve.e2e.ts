import {
  comparisonWords,
  drawsHistory,
  FIX_HINT,
  fixCard,
  formatKpi,
  frictionRanking,
  groupKpis,
  historyLabels,
  kpiChange,
  KPI_HINT,
  kpiFooter,
  MEANING,
  partRows,
  SEAT_LABEL,
  subWords,
  targetTally,
  tripwireWords,
  REVIEWER_LABEL,
  reviewerTripwireWords,
  deliveryRows,
  windowWords,
} from '../../apps/console/src/lib/improve.ts'
import type { FixCommitsModel, Kpi, KpiModel, SeatsModel } from '@software-factory/contract'
import type { Locator, Page } from '@playwright/test'
import { expect, test } from './fixtures.ts'
import { expectHint } from './hints.ts'
import { api } from './seed.ts'

interface FrictionModel {
  days: number
  counts: { key: string; label: string; count: number; perIssue: number | null; previous: number | null }[]
}

/** The seven KPIs; the fix-commit card follows them. */
const CARD_ORDER = [
  'avoidable_touches',
  'first_verification_passes',
  'asks_not_needed',
  'errands_reached_per_100',
  'cycle_p50',
  'queue_wait_p90',
  'quota_at_reset',
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

/** The folds below the KPIs hide their rows until opened: open every one. */
const openFolds = async (page: Page) => {
  await expect(page.getByRole('heading', { name: 'KPIs', level: 2 })).toBeVisible()
  const closed = page
    .getByRole('group', { name: 'Key figures' })
    .locator('button[aria-controls][aria-expanded="false"]')
  while ((await closed.count()) > 0) await closed.first().click()
}

/** Each KPI card shows what the lib makes of the API's figure, history and target: figure, change, distance, footer. */
async function expectCards(page: Page, model: KpiModel) {
  expect(model.kpis).toHaveLength(7)
  // the history starts at the counting epoch: the seed's epoch is ten days back
  expect(model.windows.length).toBeGreaterThanOrEqual(1)
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
    const sub = subWords(kpi)
    // a target it is judged by says how far; none yet says why (the catalog's target source)
    if (sub === null) await expect(card.getByText(target.value, { exact: true })).toHaveCount(1)
    else await expect(card.getByText(sub, { exact: true }).first()).toBeVisible()
    const change = kpiChange(kpi)
    await expect(card.locator('[data-tone]')).toHaveText(change.text)
    await expect(card.locator('[data-tone]')).toHaveAttribute('data-tone', change.tone)
    if (drawsHistory(kpi)) await expect(chart.locator('tbody tr')).toHaveCount(model.windows.length)
    else await expect(chart).toHaveCount(0)
  }
}

test('the seven KPIs are one band, what is off target first, with the tally of the targets met', async ({
  page,
  apiUrl,
}) => {
  const [kpis] = await read(apiUrl, 7)
  const { met, judged } = targetTally(kpis.kpis)
  await page.goto('/improve')
  const band = page.locator('[data-shot="improve-target"]')
  await expect(band.getByRole('heading', { name: 'KPIs', level: 2 })).toBeVisible()
  await expect(
    band.getByText(judged > 0 ? `${met} of ${judged} targets met` : 'No target could be judged'),
  ).toBeVisible()
  await expect(band.getByRole('article')).toHaveCount(7)
  await expect(band.locator('article h3')).toHaveText(cardKpis(kpis).map((k) => k.label))
})

const read = (apiUrl: string, days: number) =>
  Promise.all([api<KpiModel>(apiUrl, `/v1/kpis?days=${days}`), api<FrictionModel>(apiUrl, `/v1/friction?days=${days}`)])

const readSeats = (apiUrl: string) => api<SeatsModel>(apiUrl, '/v1/seats?days=7')

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
  await expect(grid.getByRole('heading', { level: 2 })).toHaveText([
    'KPIs',
    'By seat',
    'What the light seat delivers',
    'Reviewers',
    'Fix commits',
    'Friction',
    'What the loops yielded',
    'Judges checked against what happened',
    'Muted finders',
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
  expect(withHistory.length, 'the seed gives some KPI a reading in the window the epoch cut').toBeGreaterThanOrEqual(1)
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
  for (const kpi of [kpis.kpis[0], kpis.kpis.find((k) => k.key === 'quota_at_reset')]) {
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
  await expectHint(cardOf(page, FIX_TITLE), FIX_HINT)
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
  for (const kpi of kpis.kpis.filter((k) => !k.measured)) {
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

test('what the loops yielded reads the API: a row per loop and window with its signals, Issues and passes', async ({
  page,
  apiUrl,
}) => {
  const model = await api<{
    loops: { loop: string; windows: { days: number; passes: number | null; signals: number; issues: number }[] }[]
  }>(apiUrl, '/v1/loop-yield')
  await page.goto('/improve')
  const table = page.getByRole('table', { name: 'What the loops yielded' })
  const rows = table.getByRole('row')
  await expect(rows).toHaveCount(1 + model.loops.length * 2)
  // the header row, then each loop's windows in the order the API gives them
  let at = 1
  for (const loop of model.loops)
    for (const window of loop.windows) {
      const cells = rows.nth(at++).getByRole('cell')
      await expect(cells.nth(0)).toHaveText(String(window.days))
      await expect(cells.nth(1)).toHaveText(window.passes === null ? '–' : String(window.passes))
      await expect(cells.nth(2)).toHaveText(String(window.signals))
      await expect(cells.nth(3)).toHaveText(String(window.issues))
    }
})

test('the judge ledger reads the API: a row per judge with its answers, what stood and the share that did not', async ({
  page,
  apiUrl,
}) => {
  const model = await api<{
    judges: {
      judge: string
      label: string
      answers: number
      stood: number
      didNotStand: number
      share: number | null
    }[]
  }>(apiUrl, '/v1/judgments?days=7')
  await page.goto('/improve')
  const table = page.getByRole('table', { name: "What became of each judge's answers" })
  const rows = table.locator('tr[data-judge]')
  await expect(rows).toHaveCount(model.judges.length)
  for (const [i, judge] of model.judges.entries()) {
    const row = rows.nth(i)
    await expect(row.getByRole('rowheader')).toHaveText(judge.label)
    const cells = row.getByRole('cell')
    await expect(cells.nth(0)).toHaveText(String(judge.answers))
    await expect(cells.nth(1)).toHaveText(String(judge.stood))
    await expect(cells.nth(3)).toHaveText(String(judge.didNotStand))
    await expect(cells.nth(4)).toHaveText(judge.share === null ? '–' : `${Math.round(judge.share * 100)}%`)
  }
})

test('muted finders read what the API says: a line when none is muted, else each finder with its counts', async ({
  page,
  apiUrl,
}) => {
  const model = await api<{
    finders: {
      loop: string
      finder: string
      status: string
      decided: number
      noise: number
    }[]
  }>(apiUrl, '/v1/finders')
  await page.goto('/improve')
  const quiet = model.finders.filter((c) => c.status !== 'open')
  if (quiet.length === 0) {
    await expect(page.getByText('No finder is muted.', { exact: true })).toBeVisible()
    return
  }
  const list = page.getByRole('list', { name: 'Muted finders' })
  for (const c of quiet) {
    const row = list.getByRole('listitem').filter({ hasText: `${c.loop} · ${c.finder}` })
    await expect(row).toContainText(`${c.noise} of ${c.decided} dropped or cancelled`)
  }
})

test('the fix-commit card reads the API: the newest week, the change, the legend and the busiest cause', async ({
  page,
  apiUrl,
}) => {
  const model = await api<FixCommitsModel>(apiUrl, '/v1/fix-commits')
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
  const present = card.causes.filter((c) => c.total > 0)
  await expect(legend.getByRole('listitem')).toHaveCount(present.length)
  for (const c of present)
    await expect(legend.getByRole('listitem').filter({ hasText: c.key })).toContainText(String(c.total))

  const chart = article.getByRole('group', { name: /^Fix commits per week by cause/ })
  await expect(chart.locator('tbody tr')).toHaveCount(card.weeks.length)
  await chart.focus()
  const newest = card.weeks.at(-1)
  await expect(chart.getByRole('status')).toContainText(`Week to ${newest?.label}`)
})

test('the queue wait card names what the wait is made of, largest first, from the same figures the API gives', async ({
  page,
  apiUrl,
}) => {
  const [kpis] = await read(apiUrl, 7)
  const wait = kpis.kpis.find((k) => k.key === 'queue_wait_p90')
  const rows = partRows(wait ?? { parts: [] })
  expect(rows.length, 'the seed queued an Issue behind an edge and a cap').toBeGreaterThan(1)
  await page.goto('/improve')
  await openFolds(page)
  const card = cardOf(page, wait?.label ?? '')
  const largest = rows[0]
  // an open interval grows between the API read and the page's, so the share is matched as a number
  await expect(
    card.getByText(new RegExp(`^Mostly ${largest?.label.toLowerCase()}, \\d+ % of the parts$`)),
  ).toBeVisible()
  const list = card.getByRole('list', { name: /by part/ })
  await expect(list.getByRole('listitem')).toHaveCount(rows.length)
  await expect(list.getByRole('listitem').first()).toContainText(largest?.label ?? '')
})

test('the By seat section tables the three seats and says where the tripwire stands', async ({ page, apiUrl }) => {
  const kpis = await readSeats(apiUrl)
  await page.goto('/improve')
  const section = page.locator('[data-shot="improve-seats"]')
  await expect(section.getByRole('heading', { name: 'By seat' })).toBeVisible()
  const table = section.getByRole('table')
  for (const seat of kpis.seats.rows.map((row) => SEAT_LABEL[row.seat]))
    await expect(table.getByRole('rowheader', { name: seat, exact: true })).toBeVisible()
  await expect(table.getByRole('columnheader', { name: 'Moved up' })).toBeVisible()
  await expect(section.getByText(tripwireWords(kpis.seats.tripwire))).toBeVisible()
})

test('the light seat delivery table shows the four figures, each with its definition', async ({ page, apiUrl }) => {
  const kpis = await readSeats(apiUrl)
  await page.goto('/improve')
  const section = page.locator('[data-shot="improve-light-delivery"]')
  await expect(section.getByRole('heading', { name: 'What the light seat delivers' })).toBeVisible()
  for (const row of deliveryRows(kpis.seats.delivery)) {
    await expect(section.getByRole('rowheader', { name: new RegExp(row.label) })).toBeVisible()
    await expect(section.getByText(row.definition)).toBeVisible()
  }
})

test('the reviewers table shows both seats with the five measures, and the tripwire with its inputs', async ({
  page,
  apiUrl,
}) => {
  const kpis = await readSeats(apiUrl)
  await page.goto('/improve')
  const section = page.locator('[data-shot="improve-reviewers"]')
  await expect(section.getByRole('heading', { name: 'Reviewers' })).toBeVisible()
  for (const row of kpis.reviewers.rows)
    await expect(section.getByRole('rowheader', { name: REVIEWER_LABEL[row.seat], exact: true })).toBeVisible()
  for (const name of [
    'Findings per review',
    'Applied',
    'Rounds until clean',
    'First verification pass',
    'Regressed Issues',
    'Cost per review',
    'Wall time p50',
  ])
    await expect(section.getByRole('columnheader', { name })).toBeVisible()
  for (const line of reviewerTripwireWords(kpis.reviewers)) await expect(section.getByText(line)).toBeVisible()
})
