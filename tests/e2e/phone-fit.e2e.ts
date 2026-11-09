import type { Page } from '@playwright/test'
import { expect, test } from './fixtures.ts'
import type { SeededHistory } from './seed-history.ts'
import { api } from './seed.ts'

/**
 * At 390×844 the Shell's `main` scrolls inside itself, so `document.scrollWidth` says nothing, and a box wider than the
 * column is clipped by `main` or by an `overflow-hidden` ancestor instead of widening the page. The proof is geometry:
 * no element of `main` has a right edge past the viewport, whatever clips it, unless it sits inside a scroller meant to
 * scroll sideways (and that scroller itself ends inside the viewport).
 *
 * The seed is short, and short content fits by luck: the live Console clipped Improve by 45 px and a Review card by 16 px
 * while this file passed. So the tests also run against content as long as the live data (see `liveShaped`).
 */
const WIDTH = 390

test.use({ viewport: { width: WIDTH, height: 844 } })

/** Every element of `main` that reaches past the viewport's right edge, and `main` if it scrolls sideways; empty when all fit. */
const overhang = (page: Page): Promise<string[]> =>
  page.evaluate<string[]>(`(() => {
    const out = []
    const main = document.querySelector('main')
    if (!main) return ['no main']
    const describe = (el) => {
      const own = el.querySelector('h3')?.textContent ?? el.textContent ?? ''
      return el.tagName.toLowerCase() + (el.getAttribute('aria-label') ? '[' + el.getAttribute('aria-label') + ']' : '') +
        ' "' + own.trim().slice(0, 40) + '"'
    }
    // a descendant of a scroller meant to scroll sideways (the Flow totals carousel, a wide table) is swiped, not clipped
    const swipes = (el) => {
      for (let up = el.parentElement; up && up !== main; up = up.parentElement)
        if (/auto|scroll/.test(getComputedStyle(up).overflowX)) return true
      return false
    }
    // the visually hidden text (sr-only: a 1 px absolute box that clips what is inside, a chart's table) is not on screen
    const hidden = (el) => {
      for (let up = el; up && up !== main; up = up.parentElement) {
        const box = up.getBoundingClientRect()
        if (getComputedStyle(up).position === 'absolute' && box.width <= 1 && box.height <= 1) return true
      }
      return false
    }
    for (const el of main.querySelectorAll('*')) {
      if (el instanceof SVGElement && !(el instanceof SVGSVGElement)) continue
      const box = el.getBoundingClientRect()
      // nothing laid out (display: none) has no width to clip
      if (box.width === 0 || box.height === 0) continue
      if (hidden(el) || swipes(el)) continue
      if (box.right > ${WIDTH} + 0.5) out.push(describe(el) + ' ends at ' + Math.round(box.right))
    }
    if (main.scrollWidth > main.clientWidth) out.push('main scrolls sideways by ' + (main.scrollWidth - main.clientWidth))
    return out.slice(0, 12)
  })()`)

const settle = async (page: Page) => {
  await expect(page.getByRole('status').filter({ hasText: 'Live' })).toBeVisible()
  await page.waitForLoadState('networkidle')
}

/** What the live Console had on 2026-11-09: a Review as long as a sentence on an Issue with a long title, 489 Issues counted, 4-digit figures, refusals named by their whole sentence. */
const LONG_TITLE = 'What Basalt takes from the Console, and what the Console takes back from Basalt in return'
const LONG_ISSUE = 'Console: phone clipping still live on Improve and Needs you and every other screen of the phone'
const REFUSAL =
  'A ship was refused: ship refused: factory/414-1 holds work that is not on origin/master: merge it before the next ship'

const liveShaped = async (page: Page) => {
  const rewrite = (url: string | RegExp, change: (body: Record<string, unknown>) => void) =>
    page.route(url, async (route) => {
      const response = await route.fetch()
      const body = (await response.json()) as Record<string, unknown>
      change(body)
      await route.fulfill({ response, json: body })
    })
  await rewrite('**/v1/friction?*', (body) => {
    body.issues = 489
    body.closed = 480
    body.since = '2026-11-07T16:35:26.398Z'
    const counts = (body.counts ?? []) as Record<string, unknown>[]
    body.counts = [
      ...counts.map((row) => ({ ...row, count: 1234 })),
      { key: 'refusal:long', group: 'refusal', label: REFUSAL, count: 1234, perIssue: 0.0038910505836575876 },
    ]
  })
  await rewrite('**/v1/kpis?*', (body) => {
    for (const kpi of (body.kpis ?? []) as Record<string, unknown>[]) {
      kpi.n = 4891
      kpi.count = 1124
    }
  })
  await rewrite('**/v1/needs', (body) => {
    const items = (body.items ?? []) as Record<string, unknown>[]
    for (const item of items) {
      item.title = LONG_TITLE
      item.summary = LONG_TITLE
      item.issue = 'issue_1'
      item.repo = 'software-factory'
    }
  })
  await rewrite(/\/v1\/issues\/\d+(\?.*)?$/, (body) => {
    body.title = LONG_ISSUE
    body.filedTitle = LONG_ISSUE
  })
  await rewrite('**/v1/issues?*', (body) => {
    const issues = (body.issues ?? []) as Record<string, unknown>[]
    for (const card of issues) if (card.ref === 'issue_1') card.title = LONG_ISSUE
  })
}

for (const path of ['/improve', '/improve?days=30', '/improve?days=90', '/needs-you', '/flow']) {
  test(`nothing reaches past the right edge of the phone on ${path}`, async ({ page }) => {
    await page.goto(path)
    await settle(page)
    expect(await overhang(page)).toEqual([])
  })

  test(`nothing reaches past the right edge of the phone on ${path} with content as long as the live data`, async ({
    page,
  }) => {
    await liveShaped(page)
    await page.goto(path)
    await settle(page)
    expect(await overhang(page)).toEqual([])
  })
}

test('every tab of an Issue page stays inside the phone, with a long title', async ({ page }) => {
  const { rich } = JSON.parse(process.env.E2E_HISTORY ?? '{}') as SeededHistory
  await liveShaped(page)
  for (const tab of ['overview', 'activity', 'evidence', 'checkpoints']) {
    await page.goto(`/issues/${rich.replace('issue_', '')}?tab=${tab}`)
    await settle(page)
    expect(await overhang(page), tab).toEqual([])
  }
})

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
