import { join } from 'node:path'
import type { Page } from '@playwright/test'
import { expect, test } from './fixtures.ts'
import { scaleModel, SCALE_PROJECT } from './seed-scale-chain.ts'

/**
 * The Chain against a seeded chain of 400 nodes in one project (tests/e2e/seed-scale-chain.ts), answered for
 * `GET /v1/chain`: the default view is the open Issues, the rows that may file now and a few group nodes; a group opens in
 * place; the project filter and the schedule keep working; the graph answers in under 100 ms.
 */
const MAX_NODES = 40
const graph = (page: Page) => page.getByRole('region', { name: 'Dependency chain' })
const cards = (page: Page) => graph(page).getByTestId('chain-node')
const groups = (page: Page) => graph(page).getByTestId('chain-group')

test.beforeEach(async ({ page }) => {
  const model = scaleModel()
  await page.route('**/v1/chain', (route) => route.fulfill({ json: model }))
})

test('400 nodes open as about 40 cards plus a few groups', async ({ page }) => {
  await page.goto('/chain')
  await expect(groups(page).first()).toBeVisible()
  const nodes = await cards(page).count()
  const folded = await groups(page).count()
  expect(nodes).toBeGreaterThanOrEqual(8)
  expect(nodes).toBeLessThanOrEqual(MAX_NODES)
  expect(folded).toBeGreaterThanOrEqual(2)
  expect(folded).toBeLessThanOrEqual(8)
  await expect(page.getByText(/of 400 nodes are folded into \d+ groups/)).toBeVisible()
  // a group says how many it holds and where they stand
  const first = groups(page).filter({ hasText: 'Wait for open Issues to close' })
  await expect(first).toHaveCount(1)
  await expect(first).toContainText('44 plan rows')
  await expect(first).toContainText('Not filed yet')
  await expect(first).toContainText(/Earliest [A-Z][a-z]{2} \d{1,2} [A-Z][a-z]{2}, \d{2}:\d{2}/)
  await expect(first.getByRole('button')).toHaveAttribute('aria-expanded', 'false')
  // nothing in the card is cut off: the title, the date and the Open cue all sit inside it
  const outer = await first.boundingBox()
  for (const part of [
    first.getByRole('heading'),
    first.getByText('Earliest'),
    first.getByText('Open', { exact: true }),
  ]) {
    const box = await part.boundingBox()
    if (!outer || !box) throw new Error('no box in the group card')
    expect(box.y).toBeGreaterThanOrEqual(outer.y)
    expect(box.y + box.height).toBeLessThanOrEqual(outer.y + outer.height + 0.5)
  }
  expect(await page.locator('body').innerText()).not.toMatch(/issue_\d+|row:|group:/)
})

test('a group opens in place into its rows and Fold all closes it again', async ({ page }) => {
  await page.goto('/chain')
  await expect(cards(page).first()).toBeVisible()
  const before = await cards(page).count()
  const folded = await groups(page).count()
  const target = groups(page).filter({ hasText: 'Wait for open Issues to close' })
  await expect(target).toBeVisible()
  await target.getByRole('button').click()
  await expect(groups(page)).toHaveCount(folded - 1)
  await expect.poll(() => cards(page).count()).toBeGreaterThan(before)
  await expect(page.getByText('1 group is open')).toBeVisible()
  await page.getByRole('button', { name: 'Fold all' }).click()
  await expect(groups(page)).toHaveCount(folded)
  await expect(cards(page)).toHaveCount(before)
})

test('opening a group answers in under 100 ms', async ({ page }) => {
  await page.goto('/chain')
  await expect(groups(page).first()).toBeVisible()
  // time from the click to the frame that paints the opened rows
  const ms = await page.evaluate<number>(`(async () => {
    const group = [...document.querySelectorAll('[data-testid="chain-group"]')].find((g) => g.textContent.includes('Wait for open Issues'))
    const before = document.querySelectorAll('[data-testid="chain-node"]').length
    const t0 = performance.now()
    group.querySelector('button').click()
    for (;;) {
      await new Promise((resolve) => requestAnimationFrame(resolve))
      if (document.querySelectorAll('[data-testid="chain-node"]').length > before) return performance.now() - t0
      if (performance.now() - t0 > 5000) return -1
    }
  })()`)
  console.log(`opening a group of 44 rows: ${ms.toFixed(0)} ms`)
  test.info().annotations.push({ type: 'open-group', description: `${ms.toFixed(0)} ms` })
  expect(ms).toBeGreaterThan(0)
  expect(ms).toBeLessThan(100)
})

test('panning and zooming the default view stay under 100 ms a frame', async ({ page }) => {
  await page.goto('/chain')
  await expect(groups(page).first()).toBeVisible()
  const region = await graph(page).boundingBox()
  if (!region) throw new Error('no box for the graph')
  const worst = await page.evaluate<number>(`(async () => {
    let worst = 0
    let last = performance.now()
    const stop = performance.now() + 600
    while (performance.now() < stop) {
      await new Promise((resolve) => requestAnimationFrame(resolve))
      const now = performance.now()
      worst = Math.max(worst, now - last)
      last = now
    }
    return worst
  })()`)
  const box = { x: region.x + region.width / 2, y: region.y + region.height / 2 }
  await page.mouse.move(box.x, box.y)
  const frames = page.evaluate<number>(`(async () => {
    let worst = 0
    let last = performance.now()
    const stop = performance.now() + 800
    while (performance.now() < stop) {
      await new Promise((resolve) => requestAnimationFrame(resolve))
      const now = performance.now()
      worst = Math.max(worst, now - last)
      last = now
    }
    return worst
  })()`)
  for (let i = 0; i < 10; i++) {
    await page.mouse.wheel(0, -120)
    await page.mouse.down()
    await page.mouse.move(box.x + 10 * i, box.y + 6 * i)
    await page.mouse.up()
  }
  const busy = await frames
  console.log(`worst frame while idle ${worst.toFixed(0)} ms, while panning and zooming ${busy.toFixed(0)} ms`)
  expect(busy).toBeLessThan(100)
})

test('the project filter and the schedule keep working', async ({ page }) => {
  await page.goto(`/chain?project=${SCALE_PROJECT}`)
  await expect(groups(page).first()).toBeVisible()
  await expect(page.getByRole('group', { name: 'Projects' }).getByRole('link', { name: /^basalt-ui/ })).toHaveAttribute(
    'aria-pressed',
    'true',
  )
  const dated = page.getByRole('region', { name: 'Schedule' }).getByTestId('schedule-item')
  await expect(dated.first()).toBeVisible()
  // one dated row in each step: the schedule lists them from the whole chain, not from what is drawn
  await expect(dated).toHaveCount(8)
})

test('1280x800 and a phone do not break', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 })
  await page.goto('/chain')
  await expect(groups(page).first()).toBeVisible()
  await page.setViewportSize({ width: 390, height: 844 })
  await expect(cards(page).first()).toBeAttached()
  expect(
    await page.evaluate<number>('document.documentElement.scrollWidth - document.documentElement.clientWidth'),
  ).toBeLessThanOrEqual(0)
})

const OUT = join(import.meta.dir, 'out', 'screenshots')
const VARIANTS = [
  { name: 'desktop-xl-dark', viewport: { width: 1800, height: 1200 }, colorScheme: 'dark' },
  { name: 'desktop-xl-light', viewport: { width: 1800, height: 1200 }, colorScheme: 'light' },
  { name: 'desktop-dark', viewport: { width: 1280, height: 800 }, colorScheme: 'dark' },
  { name: 'phone-dark', viewport: { width: 390, height: 844 }, colorScheme: 'dark' },
] as const

// the Issue's evidence: the collapsed default and a group opened, in each variant
for (const variant of VARIANTS) {
  test.describe(`screenshots ${variant.name}`, () => {
    test.use({ viewport: variant.viewport, colorScheme: variant.colorScheme })

    test('the collapsed chain and an opened group', async ({ page }) => {
      const shot = (name: string) =>
        page.screenshot({ path: join(OUT, `${variant.name}-chain-scale-${name}.png`), animations: 'disabled' })
      await page.goto('/chain')
      await expect(cards(page).first()).toBeVisible()
      await page.waitForLoadState('networkidle')
      await shot('collapsed')
      // a group card up close: zoom in on the closed Issues' group, the first one in view
      const card = groups(page).filter({ hasText: 'closed Issues' })
      const at = await card.boundingBox()
      if (at && variant.viewport.width > 600) {
        await page.mouse.move(at.x + at.width / 2, at.y + at.height / 2)
        await page.mouse.wheel(0, -400)
        await page.waitForTimeout(300)
        await page.mouse.move(2, 2)
        await card.screenshot({ path: join(OUT, `${variant.name}-chain-scale-group-card.png`), animations: 'disabled' })
        await page.getByRole('button', { name: /fit view/i }).click()
        // the plan rows' group (dashed): pan along the chain until it is in view, then shoot it hovered
        const steps = groups(page).filter({ hasText: 'Wait for open Issues to close' })
        const region = await graph(page).boundingBox()
        if (region) {
          for (let drag = 0; drag < 6; drag++) {
            const box = await steps.boundingBox()
            if (box && box.x > region.x && box.x + box.width < region.x + region.width * 0.6) break
            const y = region.y + 60
            await page.mouse.move(region.x + region.width - 100, y)
            await page.mouse.down()
            await page.mouse.move(region.x + 160, y, { steps: 6 })
            await page.mouse.up()
          }
          await steps.hover()
          await page.mouse.wheel(0, -400)
          await page.waitForTimeout(300)
          // the zoom keeps the card under the cursor: shoot the canvas around it
          const at = await steps.boundingBox()
          if (at) {
            const x = Math.max(region.x, at.x - 24)
            const y = Math.max(region.y, at.y - 24)
            const width = Math.min(at.width + 48, region.x + region.width - x)
            const height = Math.min(at.height + 48, region.y + region.height - y)
            if (width > 0 && height > 0)
              await page.screenshot({
                path: join(OUT, `${variant.name}-chain-scale-group-card-rows.png`),
                animations: 'disabled',
                clip: { x, y, width, height },
              })
          }
          await page.mouse.move(2, 2)
          await page.getByRole('button', { name: /fit view/i }).click()
        }
      }
      // on a phone the graph starts at the top left and the group may be off screen: open it by its button
      await groups(page).filter({ hasText: 'Wait for open Issues to close' }).getByRole('button').dispatchEvent('click')
      await expect(page.getByRole('button', { name: 'Fold all' })).toBeVisible()
      await page.waitForTimeout(300)
      await shot('opened')
    })
  })
}
