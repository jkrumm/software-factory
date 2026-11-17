import type { Page } from '@playwright/test'
import { workOf } from '@software-factory/contract'
import { pausedReason } from '../../apps/console/src/lib/paused-reason.ts'
import { expect, test } from './fixtures.ts'
import { expectHint } from './hints.ts'
import { api } from './seed.ts'

/**
 * The Flow page against the seeded server: the numbers, the trend chart and the list of Issues a filter opens. The files
 * run in order (`artifact`, `flow`, `needs-you`, ...): the live test adds Issues, and the others read the counts from the
 * API at the moment they run.
 */
const STATES = ['settling', 'queued', 'working', 'waiting', 'watching'] as const
type State = (typeof STATES)[number]
const WORDS = ['running', 'paused', 'ready', 'held', 'checking'] as const
type Word = (typeof WORDS)[number]
const ORIGIN_WORD: Record<string, string> = {
  you: 'You',
  application: 'Application',
  infrastructure: 'Infrastructure',
  github: 'GitHub',
  feedback: 'Feedback',
  factory: 'Factory',
}

interface Item {
  id: string
  title: string
  repo: string
  origin: string
  kind: string
  waitReason?: string | null
  queue?: { kind: string } | null
}
interface Flow {
  states: Record<State, { count: number; issues: Item[] }>
  work: Record<Word, number>
  closedRecently: Item[]
  trend: { states: Record<State, number[]>; shipped: number[]; shippedBefore: number }
}

const flowOf = (apiUrl: string) => api<Flow>(apiUrl, '/v1/flow')
const open = (flow: Flow, keep: (item: Item) => boolean = () => true): Item[] =>
  STATES.flatMap((state) => flow.states[state].issues).filter(keep)

/** The Issues under one word, as the strip and the stat cards count them (`workOf`), in the order the server sent them. */
const issuesOf = (flow: Flow, word: Word): Item[] =>
  STATES.flatMap((state) =>
    flow.states[state].issues.filter(
      (item) =>
        workOf({ state, waitReason: item.waitReason ?? null, queueKind: item.queue?.kind ?? null })?.word === word,
    ),
  )

/** The Flow page's list of Issues: collapsed until a filter is set, then one row per Issue. */
const list = (page: Page) => page.getByTestId('flow-list')
const rows = (page: Page) => list(page).getByTestId('flow-row')
const row = (page: Page, title: string) => rows(page).filter({ hasText: title })

/** A toggle of the sidebar's Flow section: `Projects` or `Origin`, by the start of its label (`All` clears). */
const pick = (page: Page, group: 'Projects' | 'Origin', label: string) =>
  page
    .getByRole('group', { name: group })
    .getByRole('link', { name: new RegExp(`^${label}( \\d+ (running|paused|ready|held|checking).*)?$`) })
    .click()

test('Flow is the numbers and their charts: no state columns, and the list is collapsed until a filter is set', async ({
  page,
  apiUrl,
}) => {
  const flow = await flowOf(apiUrl)
  await page.goto('/flow')
  await expect(page.getByRole('group', { name: 'Totals' })).toBeVisible()
  await expect(page.getByTestId('flow-trend')).toBeVisible()
  await expect(page.getByTestId('flow-columns')).toHaveCount(0)
  await expect(page.getByRole('tablist')).toHaveCount(0)
  await expect(page.getByRole('region', { name: /^(Running|Paused|Ready|Held|Checking|Closed recently)/ })).toHaveCount(
    0,
  )
  await expect(list(page)).toHaveAttribute('data-collapsed', 'true')
  await expect(rows(page)).toHaveCount(0)
  const openCount = open(flow).length
  await expect(page.getByText(`${openCount} open, ${flow.closedRecently.length} closed in the last day`)).toBeVisible()
})

test('a row shows the number, kind, title, project, origin, state, a reason and an age', async ({ page, apiUrl }) => {
  const flow = await flowOf(apiUrl)
  const waiting = issuesOf(flow, 'paused').find((i) => i.waitReason)
  if (!waiting) throw new Error('the seed has no paused Issue')
  await page.goto('/flow?state=paused')
  const card = row(page, waiting.title)
  await expect(card).toBeVisible()
  await expect(card).toContainText(waiting.repo)
  await expect(card).toContainText(ORIGIN_WORD[waiting.origin] ?? waiting.origin)
  await expect(card).toContainText('Paused')
  await expect(card).toContainText(pausedReason(waiting.waitReason ?? null) ?? '')
  await expect(card).toContainText(/just now|\d+ (min|h|d) ago/)
  await expect(card).toContainText(`#${waiting.id.replace('issue_', '')}`)
  await expect(
    card.getByRole('img', { name: waiting.kind.charAt(0).toUpperCase() + waiting.kind.slice(1) }),
  ).toBeVisible()
  expect(await page.locator('body').innerText()).not.toMatch(/issue_\d+|lead-\d+/)
})

test('a row is a link to its Issue page (a plain click opens the peek, peek.e2e.ts)', async ({ page, apiUrl }) => {
  const flow = await flowOf(apiUrl)
  const working = issuesOf(flow, 'running')[0]
  if (!working) throw new Error('the seed has no running Issue')
  await page.goto('/flow?state=running')
  await expect(row(page, working.title).getByRole('link', { name: working.title })).toHaveAttribute(
    'href',
    /\/issues\/\d+$/,
  )
  await page.goto(`/issues/${working.id.replace('issue_', '')}`)
  await expect(page.getByRole('heading', { level: 1, name: working.title })).toBeVisible()
})

test('the stat row shows the API figures and a card opens the list of the Issues it counts', async ({
  page,
  apiUrl,
}) => {
  const flow = await flowOf(apiUrl)
  await page.goto('/flow')
  const totals = page.getByRole('group', { name: 'Totals' })
  const cards = totals.locator('article')
  await expect(cards).toHaveCount(4)
  const shipped = flow.trend.shipped.reduce((a, b) => a + b, 0)
  const expected: [string, number][] = [
    ['Running', flow.work.running],
    ['Paused', flow.work.paused],
    ['Not started', flow.work.ready + flow.work.held],
    ['Shipped this week', shipped],
  ]
  for (const [i, [title, value]] of expected.entries()) {
    await expect(cards.nth(i).getByRole('heading', { name: title })).toBeVisible()
    await expect(cards.nth(i).getByText(String(value), { exact: true }).first()).toBeVisible()
  }
  await totals.getByRole('link', { name: 'Running' }).click()
  await expect(page).toHaveURL(/\/flow\?state=running$/)
  await expect(list(page).getByRole('heading', { level: 2 })).toHaveText(`Running ${flow.work.running}`)
  await expect(rows(page)).toHaveCount(flow.work.running)
  await page.goto('/flow')
  await totals.getByRole('link', { name: 'Shipped this week' }).click()
  await expect(page).toHaveURL(/\/flow\?state=closed$/)
  await expect(rows(page)).toHaveCount(flow.closedRecently.length)
})

test('the strip, the stat cards and the sidebar count the same Issues, each card carries its hint', async ({
  page,
  apiUrl,
}) => {
  const flow = await flowOf(apiUrl)
  await page.goto('/flow')
  const strip = page.getByRole('navigation', { name: 'Issues in flight' })
  const cards = page.getByRole('group', { name: 'Totals' }).locator('article')
  for (const key of WORDS)
    await expect(strip.getByRole('link', { name: new RegExp(`^${flow.work[key]} ${key}`) })).toBeVisible()
  for (const [i, word] of (['running', 'paused', 'not started'] as const).entries())
    await expectHint(cards.nth(i), word)
})

for (const count of WORDS) {
  test(`the header strip's ${count} count opens a list of exactly those Issues`, async ({ page, apiUrl }) => {
    const flow = await flowOf(apiUrl)
    await page.goto('/flow')
    await page
      .getByRole('navigation', { name: 'Issues in flight' })
      .getByRole('link', { name: new RegExp(`${count}$`) })
      .click()
    await expect(page).toHaveURL(new RegExp(`/flow\\?state=${count}$`))
    const issues = issuesOf(flow, count)
    await expect(list(page)).not.toHaveAttribute('data-collapsed', 'true')
    await expect(rows(page)).toHaveCount(issues.length)
    for (const issue of issues) await expect(row(page, issue.title)).toBeVisible()
  })
}

test('the list sorts by a pressed column, and pressing it again reverses it', async ({ page }) => {
  await page.goto('/flow?state=running')
  const number = page.getByRole('columnheader', { name: 'Issue' })
  const numbers = async () =>
    (await rows(page).evaluateAll((nodes) => nodes.map((node) => node.textContent ?? ''))).map((text) =>
      Number(/#(\d+)/.exec(text)?.[1]),
    )
  // opens on what has been in its state longest, so no column says it sorts the rows
  await expect(number).toHaveAttribute('aria-sort', 'none')
  await number.getByRole('button').click()
  await expect(number).toHaveAttribute('aria-sort', 'descending')
  const down = await numbers()
  expect(down.length).toBeGreaterThan(1)
  expect(down).toEqual([...down].sort((a, b) => b - a))
  await number.getByRole('button').click()
  await expect(number).toHaveAttribute('aria-sort', 'ascending')
  expect(await numbers()).toEqual([...down].reverse())
})

test("the list links to the Chain, for the project when the rows are one project's", async ({ page, apiUrl }) => {
  await page.goto('/flow?state=running')
  await expect(list(page).getByRole('link', { name: 'See how these depend' })).toHaveAttribute('href', '/chain')
  const flow = await flowOf(apiUrl)
  const repo = open(flow)[0]?.repo
  if (!repo) throw new Error('the seed has no open Issue')
  await page.goto(`/flow?project=${repo}`)
  await expect(list(page).getByRole('link', { name: 'See how these depend' })).toHaveAttribute(
    'href',
    `/chain?project=${repo}`,
  )
  await list(page).getByRole('link', { name: 'See how these depend' }).click()
  await expect(page).toHaveURL(new RegExp(`/chain\\?project=${repo}$`))
})

test('a project toggle in the sidebar lists that project, and no select shows on a wide screen', async ({
  page,
  apiUrl,
}) => {
  const flow = await flowOf(apiUrl)
  await page.goto('/flow')
  await pick(page, 'Projects', 'argo')
  await expect(page).toHaveURL(/[?&]project=argo/)
  await expect(rows(page)).toHaveCount(
    open(flow, (i) => i.repo === 'argo').length + flow.closedRecently.filter((i) => i.repo === 'argo').length,
  )
  await expect(page.locator('select:visible')).toHaveCount(0)
})

test("a row's project is a link that opens the project's page", async ({ page, apiUrl }) => {
  const flow = await flowOf(apiUrl)
  const item = issuesOf(flow, 'running')[0] ?? open(flow)[0]
  if (!item) throw new Error('the seed is empty')
  await page.goto(`/flow?project=${item.repo}`)
  const chip = row(page, item.title).getByRole('link', { name: item.repo, exact: true })
  await expect(chip).toHaveAttribute('href', new RegExp(`/projects/${item.repo}$`))
  await chip.click()
  await expect(page).toHaveURL(new RegExp(`/projects/${item.repo}$`))
  await expect(page.getByRole('heading', { level: 1, name: item.repo })).toBeVisible()
})

test('the filters narrow the list, write the URL, and clearing collapses it again', async ({ page, apiUrl }) => {
  // an Issue of another origin: a held feedback signal the owner promotes
  const title = `Flow feedback ${Date.now()}`
  await api(apiUrl, '/signals', { from: 'feedback:argo', title, text: 'it is broken' })
  const { items } = await api<{ items: { kind: string; id: string; title: string }[] }>(apiUrl, '/v1/needs')
  const held = items.find((i) => i.kind === 'held_signal' && i.title.includes(title))
  if (!held) throw new Error('the feedback signal is not held')
  await api(apiUrl, `/signals/${held.id}/promote`, { repo: 'argo' })
  const flow = await flowOf(apiUrl)
  expect(open(flow)).toEqual(expect.arrayContaining([expect.objectContaining({ origin: 'feedback' })]))
  const closed = (keep: (item: Item) => boolean) => flow.closedRecently.filter(keep).length

  await page.goto('/flow')
  await expect(list(page)).toHaveAttribute('data-collapsed', 'true')
  await pick(page, 'Projects', 'chat')
  await expect(page).toHaveURL(/[?&]project=chat/)
  await expect(rows(page)).toHaveCount(open(flow, (i) => i.repo === 'chat').length + closed((i) => i.repo === 'chat'))
  await pick(page, 'Projects', 'All')
  await expect(page).not.toHaveURL(/project=/)
  await expect(list(page)).toHaveAttribute('data-collapsed', 'true')

  await pick(page, 'Origin', 'Feedback')
  await expect(page).toHaveURL(/[?&]origin=feedback/)
  await expect(rows(page)).toHaveCount(
    open(flow, (i) => i.origin === 'feedback').length + closed((i) => i.origin === 'feedback'),
  )
  await expect(row(page, title)).toContainText('Feedback')

  await pick(page, 'Projects', 'argo')
  await expect(page).toHaveURL(/project=argo/)
  const both = (i: Item) => i.origin === 'feedback' && i.repo === 'argo'
  await expect(rows(page)).toHaveCount(open(flow, both).length + closed(both))
  await pick(page, 'Origin', 'All')
  await pick(page, 'Projects', 'All')
  await expect(page).not.toHaveURL(/origin=|project=/)
  await expect(list(page)).toHaveAttribute('data-collapsed', 'true')

  // a linked view applies, and a value the data does not have gives an empty list that says so
  await page.goto('/flow?project=nowhere')
  await expect(rows(page)).toHaveCount(0)
  await expect(list(page)).toContainText('No Issue matches this filter.')
})

test('a state in the URL names the list, an unknown one is dropped, and "Show all states" clears it', async ({
  page,
}) => {
  await page.goto('/flow?state=paused&project=argo')
  await expect(list(page).getByRole('heading', { level: 2 })).toHaveText(/^Paused \d+$/)
  // the stored names of an old link read as the word that replaced them
  await page.goto('/flow?state=waiting')
  await expect(list(page).getByRole('heading', { level: 2 })).toHaveText(/^Paused \d+$/)
  await page.goto('/flow?state=nonsense')
  await expect(list(page)).toHaveAttribute('data-collapsed', 'true')
  await page.goto('/flow?state=running')
  await list(page).getByRole('link', { name: 'Show all states' }).click()
  await expect(page).not.toHaveURL(/state=/)
  await expect(list(page).getByRole('heading', { level: 2 })).toHaveText('Issues')
})

test('a new Issue appears in its list without a reload', async ({ page, apiUrl }) => {
  await page.goto('/flow?state=held')
  const before = (await flowOf(apiUrl)).work.held
  await expect(rows(page)).toHaveCount(before)
  await page.evaluate('window.__kept = true')

  const title = `Live list row ${Date.now()}`
  await api(apiUrl, '/signals', { from: 'owner:hermes', repo: 'argo', title })
  await expect(row(page, title)).toBeVisible()
  await expect(list(page).getByRole('heading', { level: 2 })).toHaveText(`Held ${before + 1}`)
  expect(await page.evaluate('window.__kept')).toBe(true)
})

test.describe('phone', () => {
  test.use({ viewport: { width: 390, height: 844 } })

  test('the list is a table that scrolls inside itself and the page does not scroll sideways', async ({
    page,
    apiUrl,
  }) => {
    const flow = await flowOf(apiUrl)
    await page.goto('/flow?state=running')
    await expect(page.getByRole('tablist')).toHaveCount(0)
    await expect(rows(page)).toHaveCount(flow.work.running)
    const overflow = await page.evaluate<number>(
      'document.documentElement.scrollWidth - document.documentElement.clientWidth',
    )
    expect(overflow).toBeLessThanOrEqual(0)
  })
})

interface Reach {
  scrollWidth: number
  innerWidth: number
  mainScroll: number
  mainClient: number
}

/** How far the page reaches: the document, and the Shell's `main` (the real scroller on this layout). */
const reach = (page: Page): Promise<Reach> =>
  page.evaluate<Reach>(`(() => {
    const main = document.querySelector('main')
    return {
      scrollWidth: document.documentElement.scrollWidth,
      innerWidth: window.innerWidth,
      mainScroll: main ? main.scrollWidth : -1,
      mainClient: main ? main.clientWidth : -2,
    }
  })()`)

/**
 * The page never scrolls sideways: not the document, not the Shell's `main` (the real scroller, so `document.scrollWidth`
 * alone says nothing); a table too wide for the screen scrolls inside its own container.
 */
for (const viewport of [
  { width: 1280, height: 800 },
  { width: 390, height: 844 },
]) {
  test.describe(`${viewport.width}x${viewport.height}`, () => {
    test.use({ viewport })

    test('document.scrollWidth equals the viewport width on Flow, and main does not scroll sideways', async ({
      page,
    }) => {
      await page.goto('/flow?state=running')
      await expect(rows(page).first()).toBeVisible()
      await page.waitForLoadState('networkidle')
      const measured = await reach(page)
      expect(measured.scrollWidth).toBe(measured.innerWidth)
      expect(measured.mainScroll).toBe(measured.mainClient)
    })
  })
}

test('the sidebar counts each project by the five words, and a project with nothing open shows no figure', async ({
  page,
  apiUrl,
}) => {
  const flow = await flowOf(apiUrl)
  await page.goto('/flow')
  const projects = page.getByRole('group', { name: 'Projects' })
  const repos = new Set([...open(flow), ...flow.closedRecently].map((i) => i.repo))
  for (const repo of repos) {
    const row = projects.getByRole('link', {
      name: new RegExp(`^${repo}( \\d+ (running|paused|ready|held|checking).*)?$`),
    })
    const words = WORDS.flatMap((word) => {
      const n = issuesOf(flow, word).filter((i) => i.repo === repo).length
      return n ? [`${n} ${word}`] : []
    })
    if (words.length > 0) await expect(row.getByLabel(words.join(', '))).toBeVisible()
    else await expect(row.getByLabel(/\d+ (running|paused|ready|held|checking)/)).toHaveCount(0)
  }
})

test.describe('content as long as the live data', () => {
  const LONG = `Console: phone clipping still live on Improve and every other screen, ${'unbreakable_'.repeat(8)}`
  for (const viewport of [
    { width: 1024, height: 768 },
    { width: 1280, height: 800 },
    { width: 390, height: 844 },
  ]) {
    test(`Flow does not scroll sideways at ${viewport.width}x${viewport.height} with long titles and wait reasons`, async ({
      page,
    }) => {
      await page.setViewportSize(viewport)
      await page.route('**/v1/flow', async (route) => {
        const response = await route.fetch()
        const body = (await response.json()) as Flow
        for (const state of STATES)
          for (const item of body.states[state].issues) {
            item.title = LONG
            if (item.waitReason) item.waitReason = LONG
          }
        for (const item of body.closedRecently) item.title = LONG
        await route.fulfill({ response, json: body })
      })
      await page.goto('/flow?state=ready')
      await expect(rows(page).first()).toBeVisible()
      await page.waitForLoadState('networkidle')
      const measured = await reach(page)
      expect(measured.scrollWidth).toBe(measured.innerWidth)
      expect(measured.mainScroll).toBe(measured.mainClient)
    })
  }
})

interface Trend {
  window: string
  bucket: string
  buckets: { at: string; running: { peak: number; avg: number } }[]
}

test('the trend chart opens on 7 days by the hour, and its control offers 24 h, 7 d and 30 d only', async ({
  page,
  apiUrl,
}) => {
  await page.goto('/flow')
  const chart = page.getByTestId('flow-trend')
  await expect(chart.getByRole('heading', { name: 'Issues over time' })).toBeVisible()
  await expectHint(chart, 'running')
  const ranges = chart.getByRole('group', { name: 'Window' })
  await expect(ranges.getByRole('button')).toHaveText(['24 h', '7 d', '30 d'])
  await expect(ranges.getByRole('button', { name: '7 d' })).toHaveAttribute('aria-pressed', 'true')
  // the read's own default is the same window by the same bucket
  const byDefault = await api<Trend>(apiUrl, '/v1/flow/trend')
  expect(byDefault).toMatchObject({ window: '7d', bucket: 'hour' })
  expect(byDefault.buckets).toHaveLength(168)
  for (const [label, window, bucket, length] of [
    ['24 h', '24h', 'hour', 24],
    ['7 d', '7d', 'hour', 168],
    ['30 d', '30d', 'day', 30],
  ] as const) {
    await ranges.getByRole('button', { name: label, exact: true }).click()
    await expect(ranges.getByRole('button', { name: label, exact: true })).toHaveAttribute('aria-pressed', 'true')
    const trend = await api<Trend>(apiUrl, `/v1/flow/trend?window=${window}&bucket=${bucket}`)
    expect(trend.buckets).toHaveLength(length)
    const peak = Math.max(0, ...trend.buckets.map((b) => b.running.peak))
    await expect(chart.getByText(`peak running in the window`)).toBeVisible()
    await expect(chart.getByTestId('trend-peak')).toHaveText(String(peak))
  }
  await chart.getByRole('group', { name: 'Count' }).getByRole('button', { name: 'Not started' }).click()
  await expect(chart.getByText('peak not started in the window')).toBeVisible()
})

test('7 days by the day is no range of the read', async ({ apiUrl }) => {
  await expect(api(apiUrl, '/v1/flow/trend?window=7d&bucket=day')).rejects.toThrow(/4\d\d/)
})
