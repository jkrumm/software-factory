import { expect, test } from './fixtures.ts'
import type { SeededArtifacts } from './seed-artifacts.ts'

const seeded = (): SeededArtifacts => JSON.parse(process.env.E2E_ARTIFACTS ?? '{}') as SeededArtifacts

test('Artifacts lists every Report and Spec newest first, filters by kind and opens one', async ({ page }) => {
  const { spec } = seeded()
  await page.goto('/needs-you')
  await page
    .getByRole('navigation', { name: 'Main' })
    .getByRole('link', { name: /^Artifacts/ })
    .click()
  await expect(page).toHaveURL(/\/artifacts$/)
  await expect(page.getByRole('heading', { name: 'Artifacts', level: 1 })).toBeVisible()

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
  await expect(page).toHaveURL(new RegExp(`/artifacts/${spec}$`))
})
