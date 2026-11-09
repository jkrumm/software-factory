import type { Page } from '@playwright/test'
import { expect, test } from './fixtures.ts'
import { api } from './seed.ts'

/**
 * At 390×844 the Shell's `main` scrolls inside itself, so `document.scrollWidth` says nothing: a card wider than the
 * column is clipped by `main` instead. Each card's own bounding box is the proof, and `main` must not scroll sideways.
 */
const WIDTH = 390

test.use({ viewport: { width: WIDTH, height: 844 } })

/** Every card (an `article`) that reaches past the viewport's right edge, and `main` if it scrolls sideways; empty when all fit. */
const overhang = (page: Page): Promise<string[]> =>
  page.evaluate<string[]>(`(() => {
    const out = []
    // a card inside a scroller meant to scroll sideways (the Flow totals carousel) is not clipped, it is swiped
    const swipes = (el) => {
      for (let up = el.parentElement; up && up.tagName !== 'MAIN'; up = up.parentElement)
        if (/auto|scroll/.test(getComputedStyle(up).overflowX)) return true
      return false
    }
    for (const card of document.querySelectorAll('article')) {
      if (swipes(card)) continue
      const box = card.getBoundingClientRect()
      if (box.width > 0 && box.right > ${WIDTH} + 0.5)
        out.push((card.querySelector('h3')?.textContent ?? '?') + ' ends at ' + Math.round(box.right))
    }
    const main = document.querySelector('main')
    if (main && main.scrollWidth > main.clientWidth) out.push('main scrolls sideways by ' + (main.scrollWidth - main.clientWidth))
    return out
  })()`)

for (const path of ['/improve', '/improve?days=30', '/improve?days=90', '/needs-you', '/flow']) {
  test(`no card reaches past the right edge of the phone on ${path}`, async ({ page }) => {
    await page.goto(path)
    await expect(page.getByRole('status').filter({ hasText: 'Live' })).toBeVisible()
    await page.waitForLoadState('networkidle')
    expect(await overhang(page)).toEqual([])
  })
}

test('an open Needs you card of every kind stays inside the phone, even with a word that cannot break', async ({
  page,
  apiUrl,
}) => {
  const word = `https://example.com/${'a-very-long-path-segment-'.repeat(8)}`
  await api(apiUrl, '/signals', {
    from: 'feedback:phoneapp',
    title: `Broken link ${word}`,
    text: `It said ${word} and nothing else.`,
  })
  const { items } = await api<{ items: { id: string; title: string }[] }>(apiUrl, '/v1/needs')
  expect(items.length).toBeGreaterThan(0)
  for (const item of items) {
    await page.goto(`/needs-you?item=${item.id}`)
    await expect(page.locator('article[data-open="true"]')).toBeVisible()
    await page.waitForLoadState('networkidle')
    expect(await overhang(page), item.id).toEqual([])
  }
  // leave the Needs-you counts as the other files expect them
  const long = items.find((item) => item.title.startsWith('Broken link'))
  if (long) await api(apiUrl, `/signals/${encodeURIComponent(long.id)}/dismiss`, { reason: 'Test signal' })
})
