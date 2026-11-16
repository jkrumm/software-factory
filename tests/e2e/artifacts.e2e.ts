import type { Page } from '@playwright/test'
import { expect, test } from './fixtures.ts'
import type { SeededArtifacts } from './seed-artifacts.ts'

const seeded = (): SeededArtifacts => JSON.parse(process.env.E2E_ARTIFACTS ?? '{}') as SeededArtifacts

/** The rest of the page is folded by project: open every fold. */
async function openFolds(page: Page): Promise<void> {
  await page.getByRole('group', { name: 'Artifacts by project' }).waitFor()
  const folds = page.locator('main button[aria-expanded="false"]')
  while ((await folds.count()) > 0) await folds.first().click()
}

test('Artifacts lists every Report and Spec newest first, filters by kind and opens one', async ({ page }) => {
  const { spec } = seeded()
  await page.goto('/needs-you')
  await page
    .getByRole('navigation', { name: 'Main' })
    .getByRole('link', { name: /^Artifacts/ })
    .click()
  await expect(page).toHaveURL(/\/artifacts$/)
  await expect(page.getByRole('heading', { name: 'Artifacts', level: 1 })).toBeVisible()

  await openFolds(page)
  const list = page.locator('main ul')
  await expect(list.getByRole('link', { name: /The launch report/ })).toBeVisible()
  await expect(list.getByRole('link', { name: /The storage spec/ })).toBeVisible()
  // each row names its Issue
  await expect(list.getByRole('link', { name: /The launch report/ })).toContainText(/Issue \d+/)

  await page
    .getByRole('group', { name: 'Kinds' })
    .getByRole('link', { name: /^Report/ })
    .click()
  await expect(page).toHaveURL(/kind=report/)
  await expect(list.getByRole('link', { name: /The storage spec/ })).toHaveCount(0)
  await expect(list.getByRole('link', { name: /The launch report/ })).toBeVisible()

  await page.goto(`/artifacts?kind=spec`)
  await list.getByRole('link', { name: /The storage spec/ }).click()
  await expect(page).toHaveURL(/peek=/)
  // a plain click opens the artifact in the peek over the list
  expect(new URL(page.url()).searchParams.get('peek')).toBe(`artifacts/${spec}`)
  await expect(page.getByRole('dialog').and(page.locator('[data-peek-panel]'))).toBeVisible()
})

test('Artifacts opens on the pinned collection, the rest folded by project, and a collection opens to its pages', async ({
  page,
}) => {
  const { pinned, unpinned } = seeded().collections
  await page.goto('/artifacts')
  const cards = page.locator('[data-collection]').filter({ has: page.getByRole('heading') })
  await expect(cards).toHaveCount(1)
  const card = cards.first()
  await expect(card.getByRole('heading', { name: pinned.title })).toBeVisible()
  await expect(card).toContainText('2')
  await expect(card).toContainText('pages')
  await expect(card).toContainText('open comments')
  await expect(card).toContainText('ember')
  // the unpinned one and every loose artifact are folded away by project
  await expect(page.getByRole('link', { name: new RegExp(unpinned.title) })).toHaveCount(0)
  await expect(page.locator('main button[aria-expanded="false"]').first()).toBeVisible()

  await card.getByRole('link', { name: pinned.title }).click()
  await expect(page).toHaveURL(new RegExp(`/artifacts/collections/${pinned.id}`))
  await expect(page.getByRole('heading', { name: pinned.title, level: 1 })).toBeVisible()
  const pages = page.getByRole('list', { name: 'Pages' })
  await expect(pages.getByRole('link')).toHaveCount(2)
  await expect(pages.getByRole('link').first()).toContainText('Overview')
  await expect(pages.getByRole('link', { name: /Orb rewrite: forecast/ })).toBeVisible()
})

test('a collection is unpinned and pinned from the page, and each stays after a reload', async ({ page }) => {
  const { pinned, unpinned } = seeded().collections
  await page.goto('/artifacts')
  const cards = page.locator('[data-collection]').filter({ has: page.getByRole('heading') })
  await expect(cards).toHaveCount(1)

  await page.getByRole('button', { name: `Unpin ${pinned.title}` }).click()
  await expect(cards).toHaveCount(0)
  await page.reload()
  await expect(cards).toHaveCount(0)
  // unpinned, it is a row under its project
  await openFolds(page)
  await expect(page.getByRole('link', { name: new RegExp(`^Collection\\s*${pinned.title}`) })).toBeVisible()

  await page.getByRole('button', { name: `Pin ${unpinned.title}` }).click()
  await expect(cards).toHaveCount(1)
  await expect(cards.first().getByRole('heading', { name: unpinned.title })).toBeVisible()

  // put it back as it was
  await page.getByRole('button', { name: `Unpin ${unpinned.title}` }).click()
  await expect(cards).toHaveCount(0)
  await page.getByRole('button', { name: `Pin ${pinned.title}` }).click()
  await expect(cards).toHaveCount(1)
  await page.reload()
  await expect(cards).toHaveCount(1)
  await expect(cards.first().getByRole('heading', { name: pinned.title })).toBeVisible()
})

test('the default view lists no title twice and leaves out the Spec of a closed Issue; Show all brings both back', async ({
  page,
}) => {
  const { closedSpec, copy } = seeded().collections
  await page.goto('/artifacts')
  await openFolds(page)
  const titles = await page.locator('main ul a[href^="/artifacts/"]').locator('span.font-medium').allTextContents()
  expect(new Set(titles).size).toBe(titles.length)
  const list = page.locator('main ul')
  await expect(list.getByRole('link', { name: new RegExp(closedSpec.title) })).toHaveCount(0)
  await expect(list.getByRole('link', { name: new RegExp(copy.title) })).toHaveCount(1)

  const toggle = page.getByRole('switch', { name: 'Show all' })
  await expect(toggle).toHaveAttribute('aria-checked', 'false')
  await toggle.click()
  await expect(page).toHaveURL(/all=true/)
  await expect(page.getByRole('switch', { name: 'Show all' })).toHaveAttribute('aria-checked', 'true')
  await openFolds(page)
  await expect(list.getByRole('link', { name: new RegExp(closedSpec.title) })).toContainText('Issue closed')
  await expect(list.getByRole('link', { name: new RegExp(copy.title) })).toHaveCount(2)
  await expect(
    list.getByRole('link', { name: new RegExp(copy.title) }).filter({ hasText: 'Replaced by a newer copy' }),
  ).toHaveCount(1)

  await page.getByRole('switch', { name: 'Show all' }).click()
  await expect(page).not.toHaveURL(/all=/)
  await openFolds(page)
  await expect(list.getByRole('link', { name: new RegExp(closedSpec.title) })).toHaveCount(0)
})
