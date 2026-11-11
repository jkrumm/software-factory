import type { Page } from '@playwright/test'
import { expect, test } from './fixtures.ts'
import { COLUMN_EMPTY } from '../../apps/console/src/lib/column-empty.ts'
import { api } from './seed.ts'

/**
 * The Flow board against the seeded server. The files run in order (`artifact`, `flow`, `needs-you`, ...): the live and
 * virtualised tests add Issues, and the others read the counts from the API at the moment they run.
 */
const STATES = ['settling', 'queued', 'working', 'waiting', 'watching'] as const
type State = (typeof STATES)[number]
const LABEL: Record<State | 'closed', string> = {
  settling: 'Settling',
  queued: 'Queued',
  working: 'Working',
  waiting: 'Waiting',
  watching: 'Watching',
  closed: 'Closed recently',
}
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
}
interface Flow {
  states: Record<State, { count: number; issues: Item[] }>
  closedRecently: Item[]
  trend: { states: Record<State, number[]>; shipped: number[]; shippedBefore: number }
}

const flowOf = (apiUrl: string) => api<Flow>(apiUrl, '/v1/flow')
const region = (page: Page, key: keyof typeof LABEL) => page.getByRole('region', { name: new RegExp(`^${LABEL[key]}`) })
const heading = (page: Page, key: keyof typeof LABEL) => region(page, key).getByRole('heading', { level: 2 })

function countsOf(flow: Flow, keep: (item: Item) => boolean = () => true): Record<keyof typeof LABEL, number> {
  return {
    ...(Object.fromEntries(STATES.map((s) => [s, flow.states[s].issues.filter(keep).length])) as Record<State, number>),
    closed: flow.closedRecently.filter(keep).length,
  }
}

async function expectCounts(page: Page, counts: Record<keyof typeof LABEL, number>) {
  for (const key of Object.keys(LABEL) as (keyof typeof LABEL)[])
    await expect(heading(page, key)).toHaveText(`${LABEL[key]} ${counts[key]}`)
}

/** A toggle of the sidebar's Flow section: `Projects` or `Origin`, by the start of its label (`All` clears). */
const pick = (page: Page, group: 'Projects' | 'Origin', label: string) =>
  page
    .getByRole('group', { name: group })
    .getByRole('link', { name: new RegExp(`^${label}( \\d+ (working|waiting).*)?$`) })
    .click()

/** A word from a number, letters only: intake's fingerprint drops digits, and titles that overlap are amended into one Issue. */
const wordOf = (n: number): string =>
  n.toString(26).replace(/[0-9a-p]/g, (c) => String.fromCharCode(97 + parseInt(c, 26)))

test('every column is present with a heading and its count equals the API', async ({ page, apiUrl }) => {
  const flow = await flowOf(apiUrl)
  await page.goto('/flow')
  for (const key of Object.keys(LABEL) as (keyof typeof LABEL)[]) await expect(heading(page, key)).toBeVisible()
  await expectCounts(page, countsOf(flow))
  const open = Object.values(countsOf(flow)).reduce((a, b) => a + b, 0) - flow.closedRecently.length
  await expect(page.getByText(`${open} open, ${flow.closedRecently.length} closed in the last day`)).toBeVisible()
})

test('a card shows title, project, origin word, a reason, an age and its number', async ({ page, apiUrl }) => {
  const flow = await flowOf(apiUrl)
  await page.goto('/flow')
  const waiting = flow.states.waiting.issues.find((i) => i.waitReason)
  if (!waiting) throw new Error('the seed has no waiting Issue')
  const card = region(page, 'waiting').getByRole('listitem').filter({ hasText: waiting.title })
  await expect(card).toBeVisible()
  await expect(card).toContainText(waiting.repo)
  // the default origin (You) is noise and is not shown
  const origin = ORIGIN_WORD[waiting.origin] ?? waiting.origin
  if (origin !== 'You') await expect(card).toContainText(origin)
  await expect(card).toContainText(waiting.waitReason ?? '')
  await expect(card).toContainText(/just now|\d+ (min|h|d) ago/)
  await expect(card).toContainText(`#${waiting.id.replace('issue_', '')}`)
  expect(await page.locator('body').innerText()).not.toMatch(/issue_\d+|lead-\d+/)
})

test('a card shows its kind as an icon', async ({ page, apiUrl }) => {
  const flow = await flowOf(apiUrl)
  await page.goto('/flow')
  const working = flow.states.working.issues[0]
  if (!working) throw new Error('the seed has no working Issue')
  const card = region(page, 'working').getByRole('listitem').filter({ hasText: working.title })
  await expect(
    card.getByRole('img', { name: working.kind.charAt(0).toUpperCase() + working.kind.slice(1) }),
  ).toBeVisible()
  // the column names the state, so a working card has no Lozenge of it
  await expect(card).not.toContainText('Working')
})

test('a card opens its Issue page', async ({ page, apiUrl }) => {
  const flow = await flowOf(apiUrl)
  const working = flow.states.working.issues[0]
  if (!working) throw new Error('the seed has no working Issue')
  await page.goto('/flow')
  const card = region(page, 'working').getByRole('listitem').filter({ hasText: working.title })
  await expect(card.getByRole('link', { name: working.title })).toHaveAttribute('href', /\/issues\/\d+$/)
  // the link is the card itself: no ⋯ is needed to open it
  await expect(card.getByRole('button')).toHaveCount(0)
  await card.click()
  await expect(page).toHaveURL(new RegExp(`/issues/${working.id.replace('issue_', '')}$`))
  await expect(page.getByRole('heading', { level: 1, name: working.title })).toBeVisible()
})

test('the stat row shows the API figures and a card opens its column', async ({ page, apiUrl }) => {
  const flow = await flowOf(apiUrl)
  await page.goto('/flow')
  const row = page.getByRole('group', { name: 'Totals' })
  const cards = row.locator('article')
  await expect(cards).toHaveCount(4)
  const shipped = flow.trend.shipped.reduce((a, b) => a + b, 0)
  const expected: [string, number][] = [
    ['Working', flow.states.working.count],
    ['Waiting', flow.states.waiting.count],
    ['Queued', flow.states.queued.count],
    ['Shipped this week', shipped],
  ]
  for (const [i, [title, value]] of expected.entries()) {
    await expect(cards.nth(i).getByRole('heading', { name: title })).toBeVisible()
    await expect(cards.nth(i).getByText(String(value), { exact: true }).first()).toBeVisible()
  }
  await row.getByRole('link', { name: 'Working' }).click()
  await expect(page).toHaveURL(/\/flow\?state=working$/)
  await expect(page.getByRole('region')).toHaveCount(1)
  await expect(heading(page, 'working')).toHaveText(`Working ${flow.states.working.count}`)
  await page.goto('/flow')
  await row.getByRole('link', { name: 'Shipped this week' }).click()
  await expect(page).toHaveURL(/\/flow\?state=closed$/)
})

test('the header strip count opens the same view as the stat card', async ({ page, apiUrl }) => {
  const flow = await flowOf(apiUrl)
  await page.goto('/flow')
  await page
    .getByRole('navigation', { name: 'Issues in flight' })
    .getByRole('link', { name: /working$/ })
    .click()
  await expect(page).toHaveURL(/\/flow\?state=working$/)
  await expect(page.getByRole('region')).toHaveCount(1)
  await expect(heading(page, 'working')).toHaveText(`Working ${flow.states.working.count}`)
})

test('every column header has its InfoHint, and no select shows on a wide screen', async ({ page }) => {
  await page.goto('/flow')
  for (const key of Object.keys(LABEL) as (keyof typeof LABEL)[]) {
    const word = key === 'closed' ? 'Outcome' : LABEL[key]
    await expect(region(page, key).getByRole('button', { name: `What ${word} means` })).toBeVisible()
    // the hint is a sibling of the h2: the heading text stays the label and count
    await expect(heading(page, key)).toHaveText(new RegExp(`^${LABEL[key]} \\d+$`))
  }
  await expect(page.locator('select:visible')).toHaveCount(0)
})

test('a project toggle in the sidebar narrows the board', async ({ page, apiUrl }) => {
  const flow = await flowOf(apiUrl)
  await page.goto('/flow')
  await pick(page, 'Projects', 'argo')
  await expect(page).toHaveURL(/[?&]project=argo/)
  await expectCounts(
    page,
    countsOf(flow, (i) => i.repo === 'argo'),
  )
  await expect(page.locator('select:visible')).toHaveCount(0)
})

test("a card's project chip is a link that filters the board to that project", async ({ page, apiUrl }) => {
  const flow = await flowOf(apiUrl)
  const item = flow.states.working.issues[0] ?? STATES.flatMap((s) => flow.states[s].issues)[0]
  if (!item) throw new Error('the board is empty')
  await page.goto('/flow')
  const chip = page
    .getByRole('article')
    .filter({ has: page.getByRole('heading', { name: item.title, exact: true }) })
    .first()
    .getByRole('link', { name: item.repo, exact: true })
  await expect(chip).toHaveAttribute('href', new RegExp(`/flow\\?project=${item.repo}$`))
  await chip.click()
  await expect(page).toHaveURL(new RegExp(`[?&]project=${item.repo}`))
  await expectCounts(
    page,
    countsOf(flow, (i) => i.repo === item.repo),
  )
})

test('the filters narrow every column, write the URL, and clearing restores the counts', async ({ page, apiUrl }) => {
  // an Issue of another origin: a held feedback signal the owner promotes
  const title = `Flow feedback ${Date.now()}`
  await api(apiUrl, '/signals', { from: 'feedback:argo', title, text: 'it is broken' })
  const { items } = await api<{ items: { kind: string; id: string; title: string }[] }>(apiUrl, '/v1/needs')
  const held = items.find((i) => i.kind === 'held_signal' && i.title.includes(title))
  if (!held) throw new Error('the feedback signal is not held')
  await api(apiUrl, `/signals/${held.id}/promote`, { repo: 'argo' })
  const flow = await flowOf(apiUrl)
  expect(Object.values(flow.states).flatMap((c) => c.issues)).toEqual(
    expect.arrayContaining([expect.objectContaining({ origin: 'feedback' })]),
  )

  await page.goto('/flow')
  await expectCounts(page, countsOf(flow))
  await pick(page, 'Projects', 'chat')
  await expect(page).toHaveURL(/[?&]project=chat/)
  await expectCounts(
    page,
    countsOf(flow, (i) => i.repo === 'chat'),
  )
  await pick(page, 'Projects', 'All')
  await expect(page).not.toHaveURL(/project=/)
  await expectCounts(page, countsOf(flow))

  await pick(page, 'Origin', 'Feedback')
  await expect(page).toHaveURL(/[?&]origin=feedback/)
  await expectCounts(
    page,
    countsOf(flow, (i) => i.origin === 'feedback'),
  )
  await expect(region(page, 'settling').getByRole('listitem').first()).toContainText('Feedback')

  await pick(page, 'Projects', 'argo')
  await expect(page).toHaveURL(/project=argo/)
  await expectCounts(
    page,
    countsOf(flow, (i) => i.origin === 'feedback' && i.repo === 'argo'),
  )
  await pick(page, 'Origin', 'All')
  await pick(page, 'Projects', 'All')
  await expect(page).not.toHaveURL(/origin=|project=/)
  await expectCounts(page, countsOf(flow))

  // a linked view applies, and a value the data does not have gives empty columns
  await page.goto('/flow?project=nowhere')
  await expectCounts(page, { settling: 0, queued: 0, working: 0, waiting: 0, watching: 0, closed: 0 })
  // an empty column says what is missing and what puts a card there, never a bare "Nothing here"
  await expect(page.getByText('Nothing here')).toHaveCount(0)
  for (const key of [...STATES, 'closed'] as const) {
    const empty = COLUMN_EMPTY[key]
    await expect(region(page, key).getByText(empty.title, { exact: true })).toBeVisible()
    await expect(region(page, key).getByText(empty.cause, { exact: true })).toBeVisible()
  }
})

test('the board sizes its columns by what they hold: an empty one is narrower than one with cards', async ({
  page,
  apiUrl,
}) => {
  const flow = await flowOf(apiUrl)
  const empty = STATES.find((state) => flow.states[state].count === 0)
  const full = STATES.find((state) => flow.states[state].count > 0)
  if (!empty || !full) throw new Error('the seed leaves one column empty and one with cards')
  await page.goto('/flow')
  await expect(heading(page, full)).toBeVisible()
  const width = async (state: State) => (await region(page, state).boundingBox())?.width ?? 0
  expect(await width(empty)).toBeLessThan(await width(full))
  // nothing is squeezed below what a card can read
  expect(await width(full)).toBeGreaterThanOrEqual(240)
})

test('a new Issue appears in its column without a reload', async ({ page, apiUrl }) => {
  await page.goto('/flow')
  const before = (await flowOf(apiUrl)).states.settling.count
  await expect(heading(page, 'settling')).toHaveText(`Settling ${before}`)
  await page.evaluate('window.__kept = true')

  const title = `Live board card ${Date.now()}`
  await api(apiUrl, '/signals', { from: 'owner:hermes', repo: 'argo', title })
  await expect(region(page, 'settling').getByRole('listitem').filter({ hasText: title })).toBeVisible()
  await expect(heading(page, 'settling')).toHaveText(`Settling ${before + 1}`)
  expect(await page.evaluate('window.__kept')).toBe(true)
})

test('only the visible cards are in the DOM, and scrolling reveals the rest', async ({ page, apiUrl }) => {
  for (let i = 0; i < 40; i++)
    await api(apiUrl, '/signals', {
      from: 'owner:hermes',
      repo: 'argo',
      title: `Crowded ${wordOf(1000 + i)} ${wordOf(5000 + i)} ${wordOf(9000 + i)}`,
    })
  const flow = await flowOf(apiUrl)
  const [state, column] =
    STATES.map((s) => [s, flow.states[s]] as const).sort((a, b) => b[1].count - a[1].count)[0] ?? []
  if (!state || !column || column.count < 30) throw new Error('no column holds enough cards')

  await page.goto('/flow')
  await expect(heading(page, state)).toHaveText(`${LABEL[state]} ${column.count}`)
  const cards = region(page, state).getByRole('listitem')
  await expect(cards.first()).toBeVisible()
  expect(await cards.count()).toBeLessThan(column.count)
  expect(await cards.count()).toBeGreaterThan(0)

  const last = column.issues.at(-1)?.title ?? ''
  await expect(cards.filter({ hasText: last })).toHaveCount(0)
  await region(page, state)
    .getByTestId('flow-scroll')
    .evaluate((node) => node.scrollTo(0, node.scrollHeight))
  await expect(cards.filter({ hasText: last })).toBeVisible()
  await expect(heading(page, state)).toHaveText(`${LABEL[state]} ${column.count}`)
})

test.describe('phone', () => {
  test.use({ viewport: { width: 390, height: 844 } })

  test('tabs pick one state at a time and the page does not scroll sideways', async ({ page, apiUrl }) => {
    const flow = await flowOf(apiUrl)
    await page.goto('/flow')
    const tabs = page.getByRole('tablist', { name: 'State' })
    await expect(tabs).toBeVisible()
    await expect(page.getByRole('region')).toHaveCount(0)
    const working = page.getByRole('tab', { name: /^Working/ })
    await expect(working).toHaveAttribute('aria-selected', 'true')
    const panel = page.getByRole('tabpanel')
    const workingTitle = flow.states.working.issues[0]?.title ?? ''
    await expect(panel.getByRole('listitem').filter({ hasText: workingTitle })).toBeVisible()

    const waiting = page.getByRole('tab', { name: new RegExp(`^Waiting ${flow.states.waiting.count}$`) })
    await waiting.click()
    await expect(waiting).toHaveAttribute('aria-selected', 'true')
    await expect(
      panel.getByRole('listitem').filter({ hasText: flow.states.waiting.issues[0]?.title ?? '' }),
    ).toBeVisible()
    await expect(panel.getByRole('listitem').filter({ hasText: workingTitle })).toHaveCount(0)

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
 * alone says nothing), and the board is the one thing that scrolls sideways, inside its own container.
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
      await page.goto('/flow')
      await expect(heading(page, 'working').or(page.getByRole('tab', { name: /^Working/ }))).toBeVisible()
      await page.waitForLoadState('networkidle')
      const measured = await reach(page)
      expect(measured.scrollWidth).toBe(measured.innerWidth)
      expect(measured.mainScroll).toBe(measured.mainClient)
    })
  })
}

test('on a wide screen the board scrolls sideways inside its own container when its columns do not fit', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 800 })
  await page.goto('/flow')
  const board = page.getByTestId('flow-board')
  await expect(board).toBeVisible()
  const scroll = await board.evaluate((node) => node.scrollWidth)
  const client = await board.evaluate((node) => node.clientWidth)
  expect(scroll).toBeGreaterThan(client)
  const measured = await reach(page)
  expect(measured.mainScroll).toBe(measured.mainClient)
})

test('the sidebar counts each project by what runs and what waits, and a project with nothing open shows no figure', async ({
  page,
  apiUrl,
}) => {
  const flow = await flowOf(apiUrl)
  await page.goto('/flow')
  const projects = page.getByRole('group', { name: 'Projects' })
  const repos = new Set([...STATES.flatMap((s) => flow.states[s].issues), ...flow.closedRecently].map((i) => i.repo))
  for (const repo of repos) {
    const inRepo = (s: State) => flow.states[s].issues.filter((i) => i.repo === repo).length
    const running = inRepo('working') + inRepo('watching')
    const pending = inRepo('settling') + inRepo('queued') + inRepo('waiting')
    const row = projects.getByRole('link', { name: new RegExp(`^${repo}( \\d+ (working|waiting).*)?$`) })
    const words = [running ? `${running} working` : null, pending ? `${pending} waiting` : null].filter(Boolean)
    if (words.length > 0) await expect(row.getByLabel(words.join(', '))).toBeVisible()
    else await expect(row.getByLabel(/\d+ (working|waiting)/)).toHaveCount(0)
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
      await page.goto('/flow')
      await page.waitForLoadState('networkidle')
      const measured = await reach(page)
      expect(measured.scrollWidth).toBe(measured.innerWidth)
      expect(measured.mainScroll).toBe(measured.mainClient)
    })
  }
})
