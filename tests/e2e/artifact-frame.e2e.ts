import type { Frame, Page } from '@playwright/test'
import { expect, test } from './fixtures.ts'
import type { SeededArtifacts } from './seed-artifacts.ts'

const seeded = (): SeededArtifacts => JSON.parse(process.env.E2E_ARTIFACTS ?? '{}') as SeededArtifacts

const DARK_PAGE = 'rgb(39, 39, 42)'

/** The artifact's own document: the frame is sandboxed, so it is read through Playwright's frame, never through the page. */
async function artifactFrame(page: Page): Promise<Frame> {
  const frame = await (await page.locator('iframe[title="Artifact"]').elementHandle())?.contentFrame()
  if (!frame) throw new Error('no frame')
  return frame
}

async function setTheme(page: Page, theme: 'light' | 'dark') {
  await page.keyboard.press('ControlOrMeta+K')
  await page.getByRole('dialog').getByRole('combobox').fill(`theme: ${theme}`)
  await page.keyboard.press('Enter')
  await expect(page.locator('html')).toHaveAttribute('data-theme', theme)
}

// The e2e project has no DOM types: what runs in the frame is a string.
const css = (frame: Frame, selector: string, property: string) =>
  frame.evaluate<string>(`getComputedStyle(document.querySelector(${JSON.stringify(selector)})).${property}`)
const left = (frame: Frame, selector: string) =>
  frame.evaluate<number>(`document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect().left`)
const width = (frame: Frame, selector: string) =>
  frame.evaluate<number>(`document.querySelector(${JSON.stringify(selector)})?.getBoundingClientRect().width ?? -1`)
const theme = (frame: Frame) => frame.evaluate<string>('document.documentElement.dataset.theme')

// A wide window: at 1800 the three panes leave the document about 840 px, which the text column nearly fills, so there is no room for a
// wider track there (the lightbox is what shows a picture large at that size).
test.describe('an HTML artifact in a wide frame', () => {
  test.use({ viewport: { width: 2800, height: 1200 }, colorScheme: 'light' })

  test('follows the Console theme, not the system one, and re-themes without a reload', async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem('console-theme', 'dark'))
    await page.goto(`/artifacts/${seeded().frameMedia}`)
    const frame = await artifactFrame(page)
    // the system is light and the artifact names no scheme: the Console's dark theme still reaches it
    await expect.poll(() => css(frame, 'body', 'backgroundColor')).toBe(DARK_PAGE)
    expect(await theme(frame)).toBe('dark')
    // its own light grey callout is swapped for a dark surface, its dark text lifted
    expect(await css(frame, '#note', 'backgroundColor')).not.toBe('rgb(246, 248, 250)')
    expect(await css(frame, '#first-p', 'color')).toBe('rgb(229, 229, 233)')

    await setTheme(page, 'light')
    await expect.poll(() => theme(frame)).toBe('light')
    expect(await css(frame, 'body', 'backgroundColor')).not.toBe(DARK_PAGE)
    expect(await css(frame, '#note', 'backgroundColor')).toBe('rgb(246, 248, 250)')
    await setTheme(page, 'dark')
    await expect.poll(() => css(frame, 'body', 'backgroundColor')).toBe(DARK_PAGE)
  })

  test('a heading and the paragraph below it share one left edge, wherever they sit', async ({ page }) => {
    await page.goto(`/artifacts/${seeded().frameMedia}`)
    const frame = await artifactFrame(page)
    await expect.poll(() => width(frame, '#first-p')).toBeGreaterThan(300)
    const edge = await left(frame, '#first-p')
    expect(await left(frame, '#first')).toBe(edge)
    expect(await left(frame, '#second')).toBe(edge)
    expect(await left(frame, '#second-p')).toBe(edge)
    // the h1 sits in a header, outside the wrapper that holds the rest
    expect(await left(frame, 'h1')).toBe(edge)
  })

  test('a screenshot and an SVG figure use the pane; an icon stays inline; data-measure keeps one in the column', async ({
    page,
  }) => {
    await page.goto(`/artifacts/${seeded().frameMedia}`)
    const frame = await artifactFrame(page)
    await expect.poll(() => width(frame, '#shot')).toBeGreaterThan(900)
    const column = await width(frame, '#first-p')
    const pane = await frame.evaluate<number>('document.documentElement.clientWidth')
    expect(await width(frame, '#shot')).toBeLessThanOrEqual(1600)
    expect(await width(frame, '#shot')).toBeLessThanOrEqual(pane)
    expect(await width(frame, '#figure')).toBeGreaterThan(column)
    // centred on the pane
    const shotLeft = await left(frame, '#shot')
    expect(Math.abs(shotLeft + (await width(frame, '#shot')) / 2 - pane / 2)).toBeLessThan(2)
    expect(await width(frame, '#icon')).toBe(24)
    expect(await width(frame, '#kept')).toBeLessThanOrEqual(column + 1)
    expect(await left(frame, '#kept')).toBe(await left(frame, '#first-p'))
  })

  test('a click opens the lightbox: arrows step through the pictures, Esc closes it and focus returns', async ({
    page,
  }) => {
    await page.goto(`/artifacts/${seeded().frameMedia}`)
    const frame = await artifactFrame(page)
    await expect.poll(() => width(frame, '#shot')).toBeGreaterThan(900)
    const box = frame.locator('#shot')
    await box.scrollIntoViewIfNeeded()
    await box.click()
    const dialog = frame.locator('dialog.factory-lightbox')
    await expect(dialog).toBeVisible()
    // the screenshot, the figure and the kept picture; the icon is not one
    await expect(dialog.locator('.factory-lightbox-count')).toHaveText('1 / 3')
    await page.keyboard.press('ArrowRight')
    await expect(dialog.locator('.factory-lightbox-count')).toHaveText('2 / 3')
    await expect(dialog.locator('.factory-lightbox-caption')).toHaveText('The diagram caption')
    await dialog.getByRole('button', { name: 'Next picture' }).click()
    await expect(dialog.locator('.factory-lightbox-count')).toHaveText('3 / 3')
    await expect(dialog.getByRole('button', { name: 'Next picture' })).toBeDisabled()
    await page.keyboard.press('ArrowLeft')
    await expect(dialog.locator('.factory-lightbox-count')).toHaveText('2 / 3')
    await page.keyboard.press('Escape')
    await expect(dialog).toBeHidden()
    await expect.poll(() => frame.evaluate<string>('document.activeElement?.id')).toBe('figure')
    // a click beside the picture closes it too
    await frame.locator('#shot').click()
    await expect(dialog).toBeVisible()
    await dialog.locator('.factory-lightbox-stage').click({ position: { x: 10, y: 300 } })
    await expect(dialog).toBeHidden()
  })

  test('selecting text never opens the lightbox', async ({ page }) => {
    await page.goto(`/artifacts/${seeded().frameMedia}`)
    const frame = await artifactFrame(page)
    await expect.poll(() => width(frame, '#shot')).toBeGreaterThan(900)
    await frame.locator('#first-p').click({ clickCount: 3 })
    await expect(frame.locator('dialog.factory-lightbox')).toHaveCount(0)
  })
})
