import { join } from 'node:path'
import { expect, test } from './fixtures.ts'
import { api } from './seed.ts'

/**
 * A Spec fits a page: its detail sits in details blocks, closed to their summary line, and a click opens one. An HTML Spec
 * with two blocks and a picture, in the two themes at the two sizes the owner reads at (1800x1200 and 390).
 */
const OUT = join(import.meta.dir, 'out', 'screenshots')

const picture = `data:image/svg+xml,${encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" width="960" height="360" viewBox="0 0 960 360"><rect width="960" height="360" fill="#2a4d3a"/><rect x="48" y="48" width="864" height="64" rx="12" fill="#ffffff22"/><rect x="48" y="144" width="400" height="168" rx="12" fill="#ffffff18"/><rect x="480" y="144" width="432" height="168" rx="12" fill="#ffffff10"/></svg>',
)}`

const SPEC = `<!doctype html><html><head><title>Queue storage</title><meta name="color-scheme" content="light dark"></head><body>
<h1>Queue storage</h1>
<h2>Build</h2><p>The queue stays in Postgres, with one advisory lock guarding the pass.</p>
<img src="${picture}" alt="The queue screen" width="960" height="360">
<h2>Decided</h2><ul><li>Postgres over Redis: it is already running and costs one table.</li><li>A failed row is retried by the worker that took it.</li></ul>
<details><summary>Why not Redis</summary><p>Redis is a second service to run, watch and back up, and the queue would lose its transactions with the rows it works on.</p></details>
<details><summary>What a move would cost</summary><p>A move later is one table copied and one reader swapped; the lock moves with it.</p></details>
</body></html>`

const VARIANTS = [
  { name: 'desktop-xl-light', viewport: { width: 1800, height: 1200 }, colorScheme: 'light' as const },
  { name: 'desktop-xl-dark', viewport: { width: 1800, height: 1200 }, colorScheme: 'dark' as const },
  { name: 'phone-light', viewport: { width: 390, height: 844 }, colorScheme: 'light' as const },
  { name: 'phone-dark', viewport: { width: 390, height: 844 }, colorScheme: 'dark' as const },
]

for (const variant of VARIANTS) {
  test.describe(variant.name, () => {
    test.use({ viewport: variant.viewport, colorScheme: variant.colorScheme })

    test('two details blocks stay closed to their summary line, and one opens on a click', async ({ page, apiUrl }) => {
      await page.addInitScript((scheme) => localStorage.setItem('console-theme', scheme), variant.colorScheme)
      const made = await api<{ artifact: { id: string } }>(apiUrl, '/v1/artifacts', {
        repo: 'ember',
        title: `A Spec on a page (${variant.name})`,
        content: SPEC,
        contentFormat: 'html',
      })
      await page.goto(`/artifacts/${made.artifact.id}`)
      const frame = await (await page.locator('iframe[title="Artifact"]').elementHandle())?.contentFrame()
      if (!frame) throw new Error('no frame')
      const blocks = frame.locator('details')
      await expect(blocks).toHaveCount(2)
      await expect(blocks.first()).not.toHaveJSProperty('open', true)
      await expect(frame.getByText('Redis is a second service')).toBeHidden()
      await page.screenshot({ path: join(OUT, `${variant.name}-artifact-details-closed.png`), animations: 'disabled' })
      await blocks.first().locator('summary').click()
      await expect(frame.getByText('Redis is a second service')).toBeVisible()
      await expect(blocks.nth(1)).not.toHaveJSProperty('open', true)
      await page.screenshot({ path: join(OUT, `${variant.name}-artifact-details-open.png`), animations: 'disabled' })
    })
  })
}
