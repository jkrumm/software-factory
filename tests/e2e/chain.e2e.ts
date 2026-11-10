import type { Page } from '@playwright/test'
import { expect, test } from './fixtures.ts'
import { api } from './seed.ts'

/**
 * The Chain screen against the seeded chain (tests/e2e/seed-chain.ts): gate (pearl) blocks middle (orion) blocks last
 * (pearl), middle followed a cancelled blocker (a satisfied edge), and plan rows not yet filed: two chained on a far date and
 * the burn-in shape (report 1, report 2 after it, report 3 forty days out). `GET /v1/chain` is the truth.
 */
interface Chain {
  nodes: {
    id: string
    kind: 'issue' | 'row'
    repo: string | null
    title: string
    state: string
    notBefore: string | null
  }[]
  edges: { from: string; to: string; closed: boolean }[]
}

const NO_IDS = /issue_\d+|row:|lead-\d+|#\d+/

const chainOf = (apiUrl: string) => api<Chain>(apiUrl, '/v1/chain')
const graph = (page: Page) => page.getByRole('region', { name: 'Dependency chain' })
// by the card's own heading: another card's reason can name this title ("Waits for ...")
const node = (page: Page, title: string) =>
  graph(page)
    .getByTestId('chain-node')
    .filter({ has: page.getByRole('heading', { name: title, exact: true }) })
const schedule = (page: Page) => page.getByRole('region', { name: 'Schedule' })
const DATE = /^[A-Z][a-z]{2} \d{1,2} [A-Z][a-z]{2}( \d{4})?, \d{2}:\d{2}$/
const linked = (chain: Chain) => new Set(chain.edges.flatMap((edge) => [edge.from, edge.to]))

test('one node per linked API node, with its title, project and state as a word', async ({ page, apiUrl }) => {
  const chain = await chainOf(apiUrl)
  await page.goto('/chain')
  await expect(graph(page)).toBeVisible()
  const drawn = chain.nodes.filter((n) => linked(chain).has(n.id))
  expect(drawn.length).toBeGreaterThanOrEqual(6)
  await expect(graph(page).getByTestId('chain-node')).toHaveCount(drawn.length)
  for (const n of drawn) {
    const card = node(page, n.title)
    await expect(card).toHaveCount(1)
    await expect(card).toContainText(n.repo ?? '')
    await expect(card).toHaveAttribute('data-kind', n.kind)
    if (n.kind === 'row') await expect(card).toContainText('Not filed yet')
  }
  await expect(node(page, 'Choose the export format')).toContainText('Settling')
  await expect(node(page, 'Add a retry to the export job')).toContainText('Queued')
})

test('one edge per API edge; a blocked edge reads differently from a satisfied one', async ({ page, apiUrl }) => {
  const chain = await chainOf(apiUrl)
  await page.goto('/chain')
  const edges = graph(page).locator('.react-flow__edge')
  await expect(edges).toHaveCount(chain.edges.length)
  const blocked = chain.edges.filter((e) => !e.closed).length
  expect(blocked).toBeGreaterThanOrEqual(1)
  expect(chain.edges.length - blocked).toBeGreaterThanOrEqual(1)
  await expect(graph(page).locator('.chain-edge-blocked')).toHaveCount(blocked)
  await expect(graph(page).locator('.chain-edge-done')).toHaveCount(chain.edges.length - blocked)

  const gate = graph(page).locator(
    '.chain-edge-blocked[aria-label="Choose the export format blocks Add a retry to the export job"]',
  )
  await expect(gate).toHaveCount(1)
  await expect(gate).toContainText('blocks')
  const done = graph(page).locator('.chain-edge-done[aria-label^="Move the export job to the new queue is done"]')
  await expect(done).toHaveCount(1)
  await expect(done).toContainText('done')
  const dash = (selector: string): Promise<string> =>
    page.evaluate<string>(
      `getComputedStyle(document.querySelector('${selector} .react-flow__edge-path')).strokeDasharray`,
    )
  const strokes = { blocked: await dash('.chain-edge-blocked'), done: await dash('.chain-edge-done') }
  expect(strokes.blocked).toBe('none')
  expect(strokes.done).not.toBe('none')
})

test('the layout runs left to right: a blocker sits left of what waits for it', async ({ page, apiUrl }) => {
  const chain = await chainOf(apiUrl)
  await page.goto('/chain')
  await expect(graph(page).locator('.react-flow__edge')).toHaveCount(chain.edges.length)
  const titleOf = (id: string) => chain.nodes.find((n) => n.id === id)?.title ?? ''
  for (const edge of chain.edges) {
    const blocker = await node(page, titleOf(edge.to)).boundingBox()
    const waiting = await node(page, titleOf(edge.from)).boundingBox()
    if (!blocker || !waiting) throw new Error(`no box for ${edge.from} or ${edge.to}`)
    expect(blocker.x).toBeLessThan(waiting.x)
  }
})

test('the project filter is in the URL and narrows the nodes to the project and what it is joined to', async ({
  page,
  apiUrl,
}) => {
  const chain = await chainOf(apiUrl)
  await page.goto('/chain')
  await expect(graph(page).getByTestId('chain-node').first()).toBeVisible()
  const all = await graph(page).getByTestId('chain-node').count()
  await page
    .getByRole('group', { name: 'Projects' })
    .getByRole('link', { name: /^quartz/ })
    .click()
  await expect(page).toHaveURL(/\/chain\?project=quartz$/)
  const quartz = new Set(chain.nodes.flatMap((n) => (n.repo === 'quartz' ? [n.id] : [])))
  const keep = new Set(chain.edges.flatMap((e) => (quartz.has(e.from) || quartz.has(e.to) ? [e.from, e.to] : [])))
  expect(keep.size).toBeGreaterThanOrEqual(2)
  expect(keep.size).toBeLessThan(all)
  await expect(graph(page).getByTestId('chain-node')).toHaveCount(keep.size)
  await expect(node(page, 'Draft the export schema')).toHaveCount(1)
  await expect(node(page, 'Choose the export format')).toHaveCount(0)

  await page.goto('/chain?project=pearl')
  await expect(page.getByRole('group', { name: 'Projects' }).getByRole('link', { name: /^pearl/ })).toHaveAttribute(
    'aria-pressed',
    'true',
  )
  await expect(node(page, 'Choose the export format')).toHaveCount(1)
  // the cross-project neighbour stays
  await expect(node(page, 'Add a retry to the export job')).toHaveCount(1)
  await expect(node(page, 'Draft the export schema')).toHaveCount(0)
})

test('an Issue node links to its page; a plan row does not link', async ({ page }) => {
  await page.goto('/chain')
  await expect(node(page, 'Draft the export schema').getByRole('link')).toHaveCount(0)
  await node(page, 'Choose the export format').getByRole('link').click()
  await expect(page).toHaveURL(/\/issues\/\d+$/)
  await expect(page.getByRole('heading', { name: 'Choose the export format' })).toBeVisible()
})

test('no id is on the page', async ({ page }) => {
  await page.goto('/chain')
  await expect(graph(page).getByTestId('chain-node').first()).toBeVisible()
  expect(await page.locator('body').innerText()).not.toMatch(NO_IDS)
  const labels = await page.locator('[aria-label]').evaluateAll((els) => els.map((el) => el.getAttribute('aria-label')))
  for (const label of labels) expect(label).not.toMatch(NO_IDS)
})

test('the graph fills the content area', async ({ page }) => {
  await page.goto('/chain')
  await expect(graph(page).getByTestId('chain-node').first()).toBeVisible()
  const main = await page.locator('main').boundingBox()
  const region = await graph(page).boundingBox()
  if (!main || !region) throw new Error('no box for main or the graph')
  expect(region.width).toBeGreaterThanOrEqual(main.width * 0.9)
  expect(region.height).toBeGreaterThanOrEqual(600)
  expect(page.viewportSize()).toEqual({ width: 1800, height: 1200 })
  await expect(schedule(page)).toBeInViewport()
})

test('the graph fits again when the window changes size', async ({ page }) => {
  await page.goto('/chain')
  const first = graph(page).getByTestId('chain-node').first()
  await expect(first).toBeVisible()
  const before = await first.boundingBox()
  await page.setViewportSize({ width: 1280, height: 800 })
  await expect.poll(async () => (await first.boundingBox())?.width ?? 0).not.toBe(before?.width)
  const region = await graph(page).boundingBox()
  const box = await first.boundingBox()
  if (!region || !box) throw new Error('no box')
  expect(box.x + box.width).toBeLessThanOrEqual(region.x + region.width)
})

test('every Issue card is a link to its Issue; a plan row is not', async ({ page, apiUrl }) => {
  const chain = await chainOf(apiUrl)
  await page.goto('/chain')
  await expect(graph(page).getByTestId('chain-node').first()).toBeVisible()
  const issues = chain.nodes.filter((n) => n.kind === 'issue' && linked(chain).has(n.id))
  expect(issues.length).toBeGreaterThanOrEqual(3)
  for (const n of issues) {
    const link = node(page, n.title).getByRole('link')
    await expect(link).toHaveCount(1)
    await expect(link).toHaveAttribute('href', `/issues/${n.id.replace('issue_', '')}`)
  }
  await expect(graph(page).locator('[data-kind="row"] a')).toHaveCount(0)
})

test('the schedule lists the dated plan rows in date order; a far date is in Later', async ({ page, apiUrl }) => {
  const chain = await chainOf(apiUrl)
  const dated = chain.nodes
    .filter((n) => n.notBefore !== null)
    .sort((a, b) => Date.parse(a.notBefore ?? '') - Date.parse(b.notBefore ?? ''))
  expect(dated.map((n) => n.title)).toEqual([
    'Burn-in report, week 1',
    'Burn-in report, week 2',
    'Burn-in report, week 6',
    'Draft the export schema',
  ])
  await page.goto('/chain')
  const items = schedule(page).getByTestId('schedule-item')
  await expect(items).toHaveCount(dated.length)
  for (const [i, n] of dated.entries()) {
    const item = items.nth(i)
    await expect(item).toContainText(n.title)
    await expect(item).toContainText(n.repo ?? '')
    await expect(item.locator('time')).toHaveText(DATE)
    await expect(item.locator('time')).toHaveAttribute(
      'title',
      `${(n.notBefore ?? '').slice(0, 16).replace('T', ' ')} UTC`,
    )
  }
  await expect(items.nth(0)).toContainText(/in [12] days?/)
  await expect(items.nth(1)).toContainText(/in [89] days/)
  const later = schedule(page)
    .locator('div', { has: page.locator('h3', { hasText: 'Later' }) })
    .last()
  await expect(later.getByTestId('schedule-item')).toHaveCount(1)
  await expect(later).toContainText('Draft the export schema')
  await expect(later).toContainText('2099')
  await expect(schedule(page).getByText('Now', { exact: true })).toBeVisible()
  // the text equivalent
  await expect(schedule(page).getByRole('table')).toContainText('Burn-in report, week 6')
})

test('the schedule follows the project filter', async ({ page }) => {
  await page.goto('/chain?project=pearl')
  await expect(page.getByRole('region', { name: 'Dependency chain' })).toBeVisible()
  await expect(schedule(page)).toHaveCount(0)
  await page.goto('/chain?project=quartz')
  await expect(schedule(page).getByTestId('schedule-item')).toHaveCount(4)
})

test('an Issue that waits on an open blocker says for whom', async ({ page }) => {
  await page.goto('/chain')
  await expect(node(page, 'Add a retry to the export job')).toContainText('Waits for Choose the export format')
  await expect(node(page, 'Show the retry count on the board')).toContainText('Waits for Add a retry to the export job')
  await expect(node(page, 'Publish the export schema')).toContainText('Waits for Draft the export schema')
})

test('a scheduled row with an edge shows its date in the graph too', async ({ page }) => {
  await page.goto('/chain')
  const card = node(page, 'Burn-in report, week 2')
  await expect(card).toHaveCount(1)
  await expect(card).toContainText('Not filed yet')
  await expect(card).toContainText(/Not before [A-Z][a-z]{2} \d{1,2} [A-Z][a-z]{2}( \d{4})?, \d{2}:\d{2}/)
  await expect(card.getByTitle(/ UTC$/)).toHaveCount(1)
  // week 6 has no edge: it is on the schedule only
  await expect(node(page, 'Burn-in report, week 6')).toHaveCount(0)
})

test('on a phone the page does not scroll sideways and the graph fits', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('/chain')
  await expect(graph(page).getByTestId('chain-node').first()).toBeVisible()
  const overflow = await page.evaluate<number>(
    'document.documentElement.scrollWidth - document.documentElement.clientWidth',
  )
  expect(overflow).toBeLessThanOrEqual(0)
  await expect(graph(page).getByRole('button', { name: /fit view/i })).toBeVisible()
  await expect(schedule(page).getByTestId('schedule-item').first()).toBeAttached()
  expect(await page.locator('main').evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(0)
})

test('a project without a dependency says so', async ({ page }) => {
  await page.goto('/chain?project=atlas')
  await expect(page.getByText('No dependencies', { exact: true })).toBeVisible()
})

test('an edge is one line with its label on it, and the line runs on to the arrowhead', async ({ page }) => {
  await page.goto('/chain')
  await expect(graph(page).getByTestId('chain-node').first()).toBeVisible()
  const edges = graph(page).locator('.react-flow__edge')
  const count = await edges.count()
  expect(count).toBeGreaterThanOrEqual(5)
  for (let i = 0; i < count; i++) {
    const edge = edges.nth(i)
    const line = await edge.locator('.react-flow__edge-path').boundingBox()
    const label = await edge.locator('.react-flow__edge-textbg').boundingBox()
    if (!line || !label) throw new Error(`edge ${i} has no line or no label`)
    // the label sits inside the line's span, with line left before it and line (and the arrowhead) after it
    expect(label.x - line.x).toBeGreaterThanOrEqual(24)
    expect(line.x + line.width - (label.x + label.width)).toBeGreaterThanOrEqual(16)
    // and on its last straight run: the label's centre is on the line's lower or upper end, not floating beside it
    const centre = label.y + label.height / 2
    const atEnd = Math.min(Math.abs(centre - line.y), Math.abs(centre - (line.y + line.height)))
    // (the label's box sits a few px off its text, and by how much follows the font the runner has: the bound is that the
    // line's end lies within the label's box, half its height)
    expect(atEnd).toBeLessThanOrEqual(label.height / 2)
  }
})

test('a small graph is enlarged to fill the canvas, not left floating in it', async ({ page }) => {
  await page.goto('/chain?project=quartz')
  const first = graph(page).getByTestId('chain-node').first()
  await expect(first).toBeVisible()
  const box = await first.boundingBox()
  const region = await graph(page).boundingBox()
  if (!box || !region) throw new Error('no box')
  // a card is 320 px at zoom 1: the old ceiling was 1.1
  await expect.poll(async () => (await first.boundingBox())?.width ?? 0).toBeGreaterThanOrEqual(320 * 1.25)
  expect(box.x).toBeGreaterThanOrEqual(region.x)
})

test('the schedule axis labels do not touch each other or Now', async ({ page }) => {
  await page.goto('/chain')
  const axis = schedule(page).locator('div[aria-hidden="true"] > div.font-mono')
  await expect(axis.first()).toBeVisible()
  const boxes = (
    await Promise.all(
      (await axis.all()).map(async (label) => ({ text: await label.innerText(), box: await label.boundingBox() })),
    )
  ).filter((label) => label.box !== null && label.text !== '')
  expect(boxes.some((label) => label.text === 'Now')).toBe(true)
  const sorted = boxes.toSorted((a, b) => (a.box?.x ?? 0) - (b.box?.x ?? 0))
  for (const [i, label] of sorted.entries()) {
    const next = sorted[i + 1]
    if (!next?.box || !label.box) continue
    expect(next.box.x - (label.box.x + label.box.width), `${label.text} and ${next.text}`).toBeGreaterThanOrEqual(4)
  }
})

test('Needs you to Chain: the graph chunk is fetched before the click, and the first paint is quick', async ({
  page,
}) => {
  const RUNS = 7
  const times: number[] = []
  for (let run = 0; run < RUNS; run++) {
    const loaded: string[] = []
    const chainData = page.waitForResponse((response) => response.url().includes('/v1/chain'))
    await page.goto('/needs-you')
    await expect(page.getByRole('status').filter({ hasText: 'Live' })).toBeVisible()
    // the idle preload has run: the chain's data came without anybody asking for the screen
    await chainData
    await page.waitForLoadState('networkidle')
    page.on('request', (request) => {
      if (request.url().endsWith('.js')) loaded.push(request.url())
    })
    const ms = await page.evaluate<number>(`(async () => {
      const link = [...document.querySelectorAll('nav[aria-label="Main"] a')].find((a) => a.textContent.includes('Chain'))
      const t0 = performance.now()
      link.click()
      for (;;) {
        await new Promise((resolve) => requestAnimationFrame(resolve))
        const card = document.querySelector('[data-testid="chain-node"]')
        const wrapper = card && card.closest('.react-flow__node')
        if (wrapper && getComputedStyle(wrapper).visibility === 'visible') return performance.now() - t0
        if (performance.now() - t0 > 5000) return -1
      }
    })()`)
    expect(ms).toBeGreaterThan(0)
    expect(loaded, 'no script is fetched by the click').toEqual([])
    times.push(ms)
    page.removeAllListeners('request')
  }
  const median = times.toSorted((a, b) => a - b)[Math.floor(RUNS / 2)] ?? 0
  test.info().annotations.push({
    type: 'needs-you-to-chain',
    description: `median ${median.toFixed(0)} ms over ${RUNS} runs: ${times.map((t) => t.toFixed(0)).join(', ')}`,
  })
  console.log(
    `Needs you -> Chain: median ${median.toFixed(0)} ms over ${RUNS} runs (${times.map((t) => t.toFixed(0)).join(', ')})`,
  )
})
