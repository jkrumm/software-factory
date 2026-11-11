import { join } from 'node:path'
import { expect, test } from './fixtures.ts'
import { SPEC_QUOTE } from './seed-artifacts.ts'
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

/** The artifact page: a Report in the shared HTML template, a Report compared with its first revision. */
function artifactScreens() {
  const ids = JSON.parse(process.env.E2E_ARTIFACTS ?? '{}') as { revised: string; shotReport: string }
  return [
    { name: 'artifact-report', path: `/artifacts/${ids.shotReport}` },
    { name: 'artifact-compare', path: `/artifacts/${ids.revised}?revision=2&compare=1` },
  ]
}

/** The Issue page: each tab of the Issue with a rich history, the one that is working, and one in the middle of the chain. */
function issueScreens() {
  const ids = JSON.parse(process.env.E2E_HISTORY ?? '{}') as { rich: string; working: string }
  const chain = JSON.parse(process.env.E2E_CHAIN ?? '{}') as { middle: string }
  const path = (ref: string, tab?: string) => `/issues/${ref.replace('issue_', '')}${tab ? `?tab=${tab}` : ''}`
  return [
    { name: 'issue-overview', path: path(ids.rich) },
    { name: 'issue-activity', path: path(ids.rich, 'activity') },
    { name: 'issue-evidence', path: path(ids.rich, 'evidence') },
    { name: 'issue-checkpoints', path: path(ids.rich, 'checkpoints') },
    { name: 'issue-working', path: path(ids.working) },
    { name: 'issue-chain', path: path(chain.middle) },
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
      for (const { name, path } of [...SCREENS, ...artifactScreens()]) {
        await page.goto(path)
        await expect(page.getByRole('status').filter({ hasText: 'Live' })).toBeVisible()
        await page.waitForLoadState('networkidle')
        // the owner is on the edited comment: its card is open with edit and delete, its passage painted in focus
        if (name === 'artifact-report') {
          await page
            .getByRole('region', { name: 'On the text' })
            .getByRole('listitem')
            .nth(2)
            .getByRole('button')
            .first()
            .click()
          // the frame paints the passage in focus once the message has arrived
          const frame = await (await page.locator('iframe[title="Artifact"]').elementHandle())?.contentFrame()
          if (!frame) throw new Error('no frame')
          await expect.poll(() => frame.evaluate("CSS.highlights.has('factory-active')")).toBe(true)
        }
        await shot(name)
        if (name === 'chain') {
          // The graph fills the viewport and the schedule sits under it: a shorter window scrolls inside the Shell, so shoot a tall one too.
          const { width, height } = page.viewportSize() ?? variant.viewport
          await page.setViewportSize({ width, height: width < 600 ? 1800 : 1600 })
          await page.waitForLoadState('networkidle')
          await shot('chain-tall')
          await page.setViewportSize({ width, height })
        }
        if (name === 'improve' || name === 'improve-30') {
          // The bands run taller than the viewport (Friction and the held classes sit under the cards): shoot a tall one too.
          const { width, height } = page.viewportSize() ?? variant.viewport
          await page.setViewportSize({ width, height: width < 600 ? 4200 : 2200 })
          await page.waitForLoadState('networkidle')
          await shot(`${name}-tall`)
          await page.setViewportSize({ width, height })
        }
        if (name === 'kit') {
          // The Shell scrolls inside itself, so a full-page shot stops at the viewport: shoot the whole kit on a tall one.
          const { width, height } = page.viewportSize() ?? variant.viewport
          await page.setViewportSize({ width, height: width < 600 ? 7000 : 3600 })
          await page.waitForLoadState('networkidle')
          await shot('kit-tall')
          await page.setViewportSize({ width, height })
          // the first Issue card that opens an address, hovered, then focused by keyboard (tabbed to, so :focus-visible applies and the ring is asserted)
          const card = page
            .locator('article')
            .filter({ has: page.locator('h3 a[href^="#"]') })
            .first()
          const clip = async (file: string) => {
            await card.scrollIntoViewIfNeeded()
            const box = await card.boundingBox()
            if (!box) throw new Error('no card box')
            await page.screenshot({
              path: join(OUT, `${variant.name}-${file}.png`),
              animations: 'disabled',
              clip: {
                x: Math.max(0, box.x - 16),
                y: Math.max(0, box.y - 16),
                width: box.width + 32,
                height: box.height + 32,
              },
            })
          }
          await card.hover()
          await clip('kit-card-hover')
          await page.mouse.move(0, 0)
          const link = card.getByRole('link').first()
          await expect(card).toHaveCSS('outline-style', 'none')
          // real keyboard focus: tab from the top of the page until the card's link has it
          await page.evaluate('window.scrollTo(0, 0); document.activeElement?.blur()')
          const href = await link.getAttribute('href')
          for (
            let presses = 0;
            presses < 120 &&
            (await page.evaluate('document.activeElement && document.activeElement.getAttribute("href")')) !== href;
            presses++
          )
            await page.keyboard.press('Tab')
          await expect(link).toBeFocused()
          await expect(card).toHaveCSS('outline-style', 'solid')
          await clip('kit-card-focus')
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

    test('the artifact page: a Spec with the comment box open on a selection', async ({ page }) => {
      const { shotSpec } = JSON.parse(process.env.E2E_ARTIFACTS ?? '{}') as { shotSpec: string }
      await page.goto(`/artifacts/${shotSpec}`)
      await expect(page.getByRole('status').filter({ hasText: 'Live' })).toBeVisible()
      await page.waitForLoadState('networkidle')
      await page.screenshot({
        path: join(OUT, `${variant.name}-artifact-spec-closed.png`),
        fullPage: true,
        animations: 'disabled',
      })
      await page.evaluate(`(() => {
        const text = ${JSON.stringify(SPEC_QUOTE)}
        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
        for (let node = walker.nextNode(); node; node = walker.nextNode()) {
          const at = node.data.indexOf(text)
          if (at === -1) continue
          const range = document.createRange()
          range.setStart(node, at)
          range.setEnd(node, at + text.length)
          getSelection().removeAllRanges()
          getSelection().addRange(range)
          node.parentElement.scrollIntoView({ block: 'center' })
          return
        }
      })()`)
      const composer = page.getByRole('form', { name: 'Comment on the selection' })
      await expect(composer).toBeVisible()
      await composer.getByRole('textbox', { name: 'Comment' }).fill('Say why not Redis, and what a move would cost.')
      await page.screenshot({
        path: join(OUT, `${variant.name}-artifact-spec.png`),
        fullPage: true,
        animations: 'disabled',
      })
      // the verdict, from the header
      await page.keyboard.press('Escape')
      await page.getByRole('button', { name: 'Give your verdict' }).click()
      await expect(page.getByRole('group', { name: 'Verdict' })).toBeVisible()
      await page.screenshot({
        path: join(OUT, `${variant.name}-artifact-spec-verdict.png`),
        fullPage: true,
        animations: 'disabled',
      })
      const widths = (await page.evaluate(
        '({ scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth })',
      )) as { scroll: number; client: number }
      expect(widths.scroll).toBeLessThanOrEqual(widths.client)
    })

    test('the Issue page: every tab of the rich Issue, the working one and the chained one', async ({ page }) => {
      for (const { name, path } of issueScreens()) {
        await page.goto(path)
        await expect(page.getByRole('status').filter({ hasText: 'Live' })).toBeVisible()
        await page.waitForLoadState('networkidle')
        await page.screenshot({
          path: join(OUT, `${variant.name}-${name}.png`),
          fullPage: true,
          animations: 'disabled',
        })
      }
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
