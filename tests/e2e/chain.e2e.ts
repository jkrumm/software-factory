import type { Page } from '@playwright/test'
import { expect, test } from './fixtures.ts'
import { api } from './seed.ts'

/**
 * The Chain screen against the seeded chain (tests/e2e/seed-chain.ts): gate (pearl) blocks middle (orion) blocks last
 * (pearl), middle followed a cancelled blocker (a satisfied edge), and two plan rows not yet filed. `GET /v1/chain` is the truth.
 */
interface Chain {
  nodes: { id: string; kind: 'issue' | 'row'; repo: string | null; title: string; state: string }[]
  edges: { from: string; to: string; closed: boolean }[]
}

const NO_IDS = /issue_\d+|row:|lead-\d+|#\d+/

const chainOf = (apiUrl: string) => api<Chain>(apiUrl, '/v1/chain')
const graph = (page: Page) => page.getByRole('region', { name: 'Dependency chain' })
const node = (page: Page, title: string) => graph(page).getByTestId('chain-node').filter({ hasText: title })
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

test('on a phone the page does not scroll sideways and the graph fits', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('/chain')
  await expect(graph(page).getByTestId('chain-node').first()).toBeVisible()
  const overflow = await page.evaluate<number>(
    'document.documentElement.scrollWidth - document.documentElement.clientWidth',
  )
  expect(overflow).toBeLessThanOrEqual(0)
  await expect(graph(page).getByRole('button', { name: /fit view/i })).toBeVisible()
})

test('a project without a dependency says so', async ({ page }) => {
  await page.goto('/chain?project=atlas')
  await expect(page.getByText('No dependencies', { exact: true })).toBeVisible()
})
