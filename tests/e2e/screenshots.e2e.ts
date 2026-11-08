import { join } from 'node:path'
import { expect, test } from './fixtures.ts'
import { api } from './seed.ts'

const OUT = join(import.meta.dir, 'out', 'screenshots')

const SCREENS = [
  { name: 'needs-you', path: '/needs-you' },
  { name: 'flow', path: '/flow' },
  { name: 'chain', path: '/chain' },
  { name: 'improve', path: '/improve' },
] as const

const VARIANTS = [
  { name: 'desktop-dark', viewport: { width: 1280, height: 800 }, colorScheme: 'dark' },
  { name: 'desktop-light', viewport: { width: 1280, height: 800 }, colorScheme: 'light' },
  { name: 'phone-dark', viewport: { width: 390, height: 844 }, colorScheme: 'dark' },
] as const

for (const variant of VARIANTS) {
  test.describe(variant.name, () => {
    test.use({ viewport: variant.viewport, colorScheme: variant.colorScheme })

    test('the four screens and the open palette', async ({ page, apiUrl }) => {
      const shot = (name: string) =>
        page.screenshot({ path: join(OUT, `${variant.name}-${name}.png`), fullPage: true, animations: 'disabled' })
      for (const { name, path } of SCREENS) {
        await page.goto(path)
        await expect(page.getByRole('status').filter({ hasText: 'Live' })).toBeVisible()
        await page.waitForLoadState('networkidle')
        await shot(name)
      }
      // Needs you with one item open (the deep link of a page)
      const { items } = await api<{ items: { id: string; kind: string }[] }>(apiUrl, '/v1/needs')
      const decision = items.find((item) => item.kind === 'decision')
      if (!decision) throw new Error('no Decision waits')
      await page.goto(`/needs-you?item=${decision.id}`)
      await expect(page.locator('article[data-open="true"]')).toBeVisible()
      await page.waitForLoadState('networkidle')
      await shot('needs-you-open')
      await page.keyboard.press('ControlOrMeta+K')
      await expect(page.getByRole('dialog')).toBeVisible()
      await shot('palette')
    })
  })
}
