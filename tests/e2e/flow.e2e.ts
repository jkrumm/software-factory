import type { Page } from '@playwright/test'
import { expect, test } from './fixtures.ts'
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
  title: string
  repo: string
  origin: string
  waitReason?: string | null
}
interface Flow {
  states: Record<State, { count: number; issues: Item[] }>
  closedRecently: Item[]
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

test('a card shows title, project, origin word, a reason and an age, and no id', async ({ page, apiUrl }) => {
  const flow = await flowOf(apiUrl)
  await page.goto('/flow')
  const waiting = flow.states.waiting.issues.find((i) => i.waitReason)
  if (!waiting) throw new Error('the seed has no waiting Issue')
  const card = region(page, 'waiting').getByRole('listitem').filter({ hasText: waiting.title })
  await expect(card).toBeVisible()
  await expect(card).toContainText(waiting.repo)
  await expect(card).toContainText(ORIGIN_WORD[waiting.origin] ?? waiting.origin)
  await expect(card).toContainText(waiting.waitReason ?? '')
  await expect(card).toContainText(/just now|\d+ (min|h|d) ago/)
  expect(await page.locator('body').innerText()).not.toMatch(/issue_\d+|lead-\d+|#\d+/)
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
  await page.getByLabel('Project').selectOption('chat')
  await expect(page).toHaveURL(/[?&]project=chat/)
  await expectCounts(
    page,
    countsOf(flow, (i) => i.repo === 'chat'),
  )
  await page.getByLabel('Project').selectOption('')
  await expect(page).not.toHaveURL(/project=/)
  await expectCounts(page, countsOf(flow))

  await page.getByLabel('Origin').selectOption('feedback')
  await expect(page).toHaveURL(/[?&]origin=feedback/)
  await expectCounts(
    page,
    countsOf(flow, (i) => i.origin === 'feedback'),
  )
  await expect(region(page, 'settling').getByRole('listitem').first()).toContainText('Feedback')

  await page.getByLabel('Project').selectOption('argo')
  await expect(page).toHaveURL(/project=argo/)
  await expectCounts(
    page,
    countsOf(flow, (i) => i.origin === 'feedback' && i.repo === 'argo'),
  )
  await page.getByLabel('Origin').selectOption('')
  await page.getByLabel('Project').selectOption('')
  await expect(page).not.toHaveURL(/origin=|project=/)
  await expectCounts(page, countsOf(flow))

  // a linked view applies, and a value the data does not have gives empty columns
  await page.goto('/flow?project=nowhere')
  await expectCounts(page, { settling: 0, queued: 0, working: 0, waiting: 0, watching: 0, closed: 0 })
  await expect(page.getByText('Nothing here')).toHaveCount(6)
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
