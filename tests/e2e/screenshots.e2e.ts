import { join } from 'node:path'
import { expect, test } from './fixtures.ts'
import { api } from './seed.ts'

const OUT = join(import.meta.dir, 'out', 'screenshots')

const SCREENS = [
  { name: 'needs-you', path: '/needs-you' },
  { name: 'flow', path: '/flow' },
  { name: 'flow-working', path: '/flow?state=working' },
  { name: 'flow-project', path: '/flow?project=argo' },
  { name: 'chain', path: '/chain' },
  { name: 'improve', path: '/improve' },
  { name: 'improve-30', path: '/improve?days=30' },
  { name: 'kit', path: '/kit' },
] as const

/** The artifact page: a Markdown Spec, an HTML Report, and a Report compared with its first revision. */
function artifactScreens() {
  const ids = JSON.parse(process.env.E2E_ARTIFACTS ?? '{}') as { spec: string; report: string; revised: string }
  return [
    { name: 'artifact', path: `/artifacts/${ids.spec}` },
    { name: 'artifact-html', path: `/artifacts/${ids.report}` },
    { name: 'artifact-compare', path: `/artifacts/${ids.revised}?revision=2&compare=1` },
  ]
}

/** The Issue page: the seeded Issue with a rich history, and the one that is working. */
function issueScreens() {
  const ids = JSON.parse(process.env.E2E_HISTORY ?? '{}') as { rich: string; working: string }
  return [
    { name: 'issue', path: `/issues/${ids.rich.replace('issue_', '')}` },
    { name: 'issue-working', path: `/issues/${ids.working.replace('issue_', '')}` },
  ]
}

const VARIANTS = [
  { name: 'desktop-xl-dark', viewport: { width: 1800, height: 1200 }, colorScheme: 'dark' },
  { name: 'desktop-xl-light', viewport: { width: 1800, height: 1200 }, colorScheme: 'light' },
  { name: 'desktop-dark', viewport: { width: 1280, height: 800 }, colorScheme: 'dark' },
  { name: 'desktop-light', viewport: { width: 1280, height: 800 }, colorScheme: 'light' },
  { name: 'phone-dark', viewport: { width: 390, height: 844 }, colorScheme: 'dark' },
  { name: 'phone-light', viewport: { width: 390, height: 844 }, colorScheme: 'light' },
] as const

for (const variant of VARIANTS) {
  test.describe(variant.name, () => {
    test.use({ viewport: variant.viewport, colorScheme: variant.colorScheme })

    test('the screens, the artifact page and the open palette', async ({ page, apiUrl }) => {
      const shot = (name: string) =>
        page.screenshot({ path: join(OUT, `${variant.name}-${name}.png`), fullPage: true, animations: 'disabled' })
      for (const { name, path } of [...SCREENS, ...artifactScreens(), ...issueScreens()]) {
        await page.goto(path)
        await expect(page.getByRole('status').filter({ hasText: 'Live' })).toBeVisible()
        await page.waitForLoadState('networkidle')
        await shot(name)
        if (name === 'kit') {
          // The Shell scrolls inside itself, so a full-page shot stops at the viewport: shoot the whole kit on a tall one.
          const { width, height } = page.viewportSize() ?? variant.viewport
          await page.setViewportSize({ width, height: width < 600 ? 7000 : 3600 })
          await page.waitForLoadState('networkidle')
          await shot('kit-tall')
          await page.setViewportSize({ width, height })
        }
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

    test('the header strip closed, each popover open, and the palette with a query', async ({ page, apiUrl }) => {
      const shot = (name: string) =>
        page.screenshot({ path: join(OUT, `${variant.name}-${name}.png`), animations: 'disabled' })
      const { accounts } = await api<{ accounts: { account: string }[] }>(apiUrl, '/v1/accounts')
      const { issues } = await api<{ issues: { id: number; title: string }[] }>(apiUrl, '/v1/issues?state=all&limit=50')
      const word = issues[0]?.title.split(/\s+/).find((w) => w.length > 3) ?? 'a'
      await page.goto('/flow')
      await expect(page.getByRole('status').filter({ hasText: 'Live' })).toBeVisible()
      await page.waitForLoadState('networkidle')
      await shot('strip')

      const popups: [string, RegExp | string][] = [
        ['strip-account', new RegExp(`^${accounts[0]?.account}, `)],
        ['strip-host', 'Host: load, memory and swap'],
        ['strip-live', /^Connection:/],
      ]
      for (const [name, label] of popups) {
        await page.getByRole('button', { name: label }).click()
        await expect(page.getByRole('dialog')).toBeVisible()
        if (name === 'strip-host') {
          await expect(page.getByRole('group', { name: /^Load,/ })).toBeVisible()
          await page.getByRole('group', { name: /^Load,/ }).hover()
        }
        await shot(name)
        await page.keyboard.press('Escape')
        await expect(page.getByRole('dialog')).toBeHidden()
      }

      await page.keyboard.press('ControlOrMeta+K')
      await expect(page.getByRole('dialog')).toBeVisible()
      await page.getByRole('combobox').fill(word)
      await expect(page.getByRole('option').first()).toBeVisible()
      await shot('palette-query')
    })
  })
}

/** The README's demo: the Issue page tall enough to show the whole history, signal to passed watch. */
test.describe('demo', () => {
  test.use({ viewport: { width: 1280, height: 2150 }, colorScheme: 'dark' })

  test('the Issue with a rich history, whole', async ({ page }) => {
    const ids = JSON.parse(process.env.E2E_HISTORY ?? '{}') as { rich: string }
    await page.goto(`/issues/${ids.rich.replace('issue_', '')}`)
    await expect(page.getByRole('status').filter({ hasText: 'Live' })).toBeVisible()
    await page.waitForLoadState('networkidle')
    await page.screenshot({ path: join(OUT, 'demo-issue.png'), animations: 'disabled' })
  })
})

/** Flow with the sidebar open, and collapsed at the primary viewport. */
for (const variant of VARIANTS) {
  test(`sidebar ${variant.name}`, async ({ browser }) => {
    const context = await browser.newContext({ viewport: variant.viewport, colorScheme: variant.colorScheme })
    const page = await context.newPage()
    const shot = (name: string) =>
      page.screenshot({ path: join(OUT, `${variant.name}-${name}.png`), animations: 'disabled' })
    await page.goto('/flow')
    await page.waitForLoadState('networkidle')
    await shot('sidebar-flow')
    if (variant.name.startsWith('desktop-xl')) {
      await page.getByRole('button', { name: 'Collapse sidebar' }).click()
      await shot('sidebar-flow-collapsed')
    }
    await context.close()
  })
}
