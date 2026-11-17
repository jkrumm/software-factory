import type { Page } from '@playwright/test'
import { expect, test } from './fixtures.ts'
import type { SeededHistory } from './seed-history.ts'

/**
 * The Shell is `h-dvh` and only its `main` scrolls. Anything that makes the document itself taller than the viewport gives
 * a second scroll container (the whole page moves under the header and the tab bar): the proof is
 * `document.scrollingElement.scrollHeight === window.innerHeight` on every route.
 */
const VIEWPORTS = [
  { name: 'desktop 1800x1200', width: 1800, height: 1200 },
  { name: 'phone 390x844', width: 390, height: 844 },
] as const

const documentOverflow = (page: Page) =>
  page.evaluate<{ scrollHeight: number; innerHeight: number; scrollWidth: number; innerWidth: number }>(`({
    scrollHeight: document.scrollingElement?.scrollHeight ?? -1,
    innerHeight: window.innerHeight,
    scrollWidth: document.scrollingElement?.scrollWidth ?? -1,
    innerWidth: window.innerWidth,
  })`)

const routes = (): string[] => {
  const { rich } = JSON.parse(process.env.E2E_HISTORY ?? '{}') as SeededHistory
  const { spec } = JSON.parse(process.env.E2E_ARTIFACTS ?? '{}') as { spec: string }
  return [
    '/needs-you',
    '/',
    '/artifacts',
    '/chain',
    '/improve',
    '/improve?days=90',
    '/throughput',
    '/throughput?hours=168',
    '/kit',
    `/issues/${rich.replace('issue_', '')}`,
    `/artifacts/${spec}`,
  ]
}

for (const viewport of VIEWPORTS) {
  test.describe(viewport.name, () => {
    test.use({ viewport: { width: viewport.width, height: viewport.height } })

    test('the document is as tall as the viewport on every route, so only main scrolls', async ({ page }) => {
      for (const path of routes()) {
        await page.goto(path)
        await expect(page.getByRole('status').filter({ hasText: 'Live' })).toBeVisible()
        await page.waitForLoadState('networkidle')
        const { scrollHeight, innerHeight, scrollWidth, innerWidth } = await documentOverflow(page)
        expect({ path, scrollHeight, scrollWidth }).toEqual({
          path,
          scrollHeight: innerHeight,
          scrollWidth: innerWidth,
        })
      }
    })
  })
}
