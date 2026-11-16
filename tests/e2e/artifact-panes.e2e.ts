import { join } from 'node:path'
import type { Frame, Page } from '@playwright/test'
import { expect, test } from './fixtures.ts'
import type { SeededArtifacts } from './seed-artifacts.ts'

/**
 * The artifact page's panes (Issue 1716): the document, Contents and Comments are three panes with drag handles whose sizes
 * a browser remembers, each folds to a rail; the reading size is a control, 18 px by default, in Markdown and in an HTML
 * artifact's frame; Contents entries never break inside a word; a table sits in the text column and the document is centred.
 */
const seeded = (): SeededArtifacts => JSON.parse(process.env.E2E_ARTIFACTS ?? '{}') as SeededArtifacts
const OUT = join(import.meta.dir, 'out', 'screenshots')

const comments = (page: Page) => page.getByRole('complementary', { name: 'Comments' })
const contents = (page: Page) => page.getByRole('navigation', { name: 'Contents' })
const handle = (page: Page, name: 'Resize Contents' | 'Resize Comments') => page.getByRole('separator', { name })
const widthOf = async (target: ReturnType<Page['locator']>) => (await target.boundingBox())?.width ?? 0

const frameOf = (page: Page): Frame => {
  const inner = page.frames().find((f) => f.url().endsWith('/frame.html'))
  if (!inner) throw new Error('no frame')
  return inner
}

/** The artifact's frame once it is attached and has taken the reading stylesheet. */
async function readyFrame(page: Page): Promise<Frame> {
  await expect.poll(() => page.frames().some((f) => f.url().endsWith('/frame.html'))).toBe(true)
  await expect
    .poll(() =>
      frameOf(page).evaluate(
        "[...document.querySelectorAll('style')].some((s) => s.textContent.includes('--factory-size'))",
      ),
    )
    .toBe(true)
  return frameOf(page)
}

/** Drags a separator by `by` px along x, in steps. */
async function drag(page: Page, name: 'Resize Contents' | 'Resize Comments', by: number) {
  const box = await handle(page, name).boundingBox()
  if (!box) throw new Error(`no ${name} handle`)
  const x = box.x + box.width / 2
  const y = box.y + box.height / 2
  await page.mouse.move(x, y)
  await page.mouse.down()
  await page.mouse.move(x + by / 2, y, { steps: 6 })
  await page.mouse.move(x + by, y, { steps: 6 })
  await page.mouse.up()
}

/** Whether any Contents entry has a word wider than the entry itself, which would have to break inside the word. */
const BROKEN_WORDS = `(() => {
  const nav = document.querySelector('nav[aria-label="Contents"]')
  const bad = []
  for (const entry of nav.querySelectorAll('button > span')) {
    if (entry.scrollWidth > entry.clientWidth + 1) bad.push(entry.textContent)
    const lines = new Set()
    const range = document.createRange()
    range.selectNodeContents(entry)
    for (const rect of range.getClientRects()) lines.add(Math.round(rect.top))
    if (lines.size > 2) bad.push('over two lines: ' + entry.textContent)
  }
  return bad
})()`

for (const viewport of [
  { width: 1800, height: 1200 },
  { width: 1440, height: 900 },
]) {
  test(`${viewport.width}x${viewport.height}: three panes, Contents whole words, the document centred at 18 px`, async ({
    page,
  }) => {
    const { review } = seeded()
    await page.setViewportSize(viewport)
    await page.goto(`/artifacts/${review}`)
    await expect(contents(page).getByRole('button', { name: 'Proof', exact: true })).toBeVisible()
    await expect(comments(page)).toBeVisible()
    expect(await page.evaluate(BROKEN_WORDS)).toEqual([])

    // the contents pane is wide enough for a 12-character word, the comments pane for a comment line
    expect(await widthOf(contents(page))).toBeGreaterThanOrEqual(176)
    expect(await widthOf(comments(page))).toBeGreaterThanOrEqual(288)

    const prose = await page.locator('.artifact-prose').boundingBox()
    const pane = await page.locator('[data-panel][id="document"], #document').first().boundingBox()
    if (!prose || !pane) throw new Error('no boxes')
    expect(Math.abs(prose.x + prose.width / 2 - (pane.x + pane.width / 2))).toBeLessThanOrEqual(2)
    await expect(page.locator('.artifact-prose')).toHaveCSS('font-size', '18px')
    await page.screenshot({ path: join(OUT, `artifact-panes-markdown-${viewport.width}.png`) })
  })

  test(`${viewport.width}x${viewport.height}: an HTML artifact's table sits in the text column, centred, at 18 px`, async ({
    page,
  }) => {
    const { links } = seeded()
    await page.setViewportSize(viewport)
    await page.goto(`/artifacts/${links}`)
    await expect(contents(page).getByRole('button', { name: 'Later', exact: true })).toBeVisible()
    expect(await page.evaluate(BROKEN_WORDS)).toEqual([])
    const inner = await readyFrame(page)
    await expect.poll(() => inner.evaluate('getComputedStyle(document.body).fontSize')).toBe('18px')
    const text = await inner.locator('#claim').boundingBox()
    const table = await inner.locator('.factory-table').boundingBox()
    const pane = await page.locator('iframe[title="Artifact"]').boundingBox()
    if (!text || !table || !pane) throw new Error('no boxes')
    // the table is as wide as the text column and starts where it starts
    expect(Math.abs(table.x - text.x)).toBeLessThanOrEqual(2)
    expect(Math.abs(table.width - text.width)).toBeLessThanOrEqual(2)
    // both are centred in the frame
    expect(Math.abs(text.x + text.width / 2 - (pane.x + pane.width / 2))).toBeLessThanOrEqual(24)
    await page.screenshot({ path: join(OUT, `artifact-panes-html-${viewport.width}.png`) })
  })
}

test('dragging a handle resizes the panes, and a reload keeps the sizes', async ({ page }) => {
  const { review } = seeded()
  await page.goto(`/artifacts/${review}`)
  await expect(comments(page)).toBeVisible()
  // a handle moves the two panes beside it: the Comments handle trades room with Contents, the Contents handle with the document
  const comments0 = await widthOf(comments(page))
  await drag(page, 'Resize Comments', -120)
  await expect.poll(() => widthOf(comments(page))).toBeGreaterThan(comments0 + 100)
  const comments1 = await widthOf(comments(page))
  const contents0 = await widthOf(contents(page))
  expect(contents0).toBeLessThan(comments1)
  await drag(page, 'Resize Contents', -40)
  await expect.poll(() => widthOf(contents(page))).toBeGreaterThan(contents0 + 30)
  const contents1 = await widthOf(contents(page))

  await page.reload()
  await expect(comments(page)).toBeVisible()
  expect(Math.abs((await widthOf(comments(page))) - comments1)).toBeLessThanOrEqual(4)
  expect(Math.abs((await widthOf(contents(page))) - contents1)).toBeLessThanOrEqual(4)

  // below its minimum a pane folds to its rail: Comments is never a sliver
  await drag(page, 'Resize Comments', 600)
  await expect(page.getByRole('button', { name: 'Show Comments' })).toBeVisible()
  expect(await widthOf(page.getByRole('button', { name: 'Show Comments' }))).toBeLessThanOrEqual(44)
})

test('a pane folds to a rail and opens again, and stays folded after a reload', async ({ page }) => {
  const { review } = seeded()
  await page.goto(`/artifacts/${review}`)
  await expect(comments(page)).toBeVisible()
  await page.getByRole('button', { name: 'Fold Comments away' }).click()
  const rail = page.getByRole('button', { name: 'Show Comments' })
  await expect(rail).toBeVisible()
  expect(await widthOf(rail)).toBeLessThanOrEqual(44)
  await page.getByRole('button', { name: 'Fold Contents away' }).click()
  await expect(page.getByRole('button', { name: 'Show Contents' })).toBeVisible()
  // the document takes the room
  const prose = await page.locator('.artifact-prose').boundingBox()
  expect(prose?.width ?? 0).toBeGreaterThan(700)

  await page.reload()
  await expect(page.getByRole('button', { name: 'Show Comments' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Show Contents' })).toBeVisible()
  await page.getByRole('button', { name: 'Show Comments' }).click()
  await expect(page.getByRole('button', { name: 'Fold Comments away' })).toBeVisible()
  expect(await widthOf(comments(page))).toBeGreaterThanOrEqual(288)
})

test('the size control changes the reading size in Markdown and in an HTML artifact, and a reload keeps it', async ({
  page,
}) => {
  const { review, links } = seeded()
  const group = page.getByRole('group', { name: 'Reading size' })
  const prose = page.locator('.artifact-prose')
  await page.goto(`/artifacts/${review}`)
  await expect(prose).toBeVisible()
  await expect(prose).toHaveCSS('font-size', '18px')
  await group.getByRole('button', { name: 'Larger text' }).click()
  await expect(prose).toHaveCSS('font-size', '20px')
  await group.getByRole('button', { name: 'Smaller text' }).click()
  await expect(prose).toHaveCSS('font-size', '16px')
  await group.getByRole('button', { name: 'Larger text' }).click()

  // the same choice reaches an HTML artifact, on first paint and live
  await page.goto(`/artifacts/${links}`)
  await readyFrame(page)
  await expect.poll(() => frameOf(page).evaluate('getComputedStyle(document.body).fontSize')).toBe('20px')
  await page.getByRole('group', { name: 'Reading size' }).getByRole('button', { name: 'Default text size' }).click()
  await expect.poll(() => frameOf(page).evaluate('getComputedStyle(document.body).fontSize')).toBe('18px')
  await page.getByRole('group', { name: 'Reading size' }).getByRole('button', { name: 'Smaller text' }).click()
  await expect.poll(() => frameOf(page).evaluate('getComputedStyle(document.body).fontSize')).toBe('16px')

  await page.reload()
  await readyFrame(page)
  await expect.poll(() => frameOf(page).evaluate('getComputedStyle(document.body).fontSize')).toBe('16px')
  await expect(
    page.getByRole('group', { name: 'Reading size' }).getByRole('button', { name: 'Smaller text' }),
  ).toHaveAttribute('aria-pressed', 'true')
})
