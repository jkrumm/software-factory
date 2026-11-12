import { expect, test } from './fixtures.ts'
import { api } from './seed.ts'

/**
 * The project digest strip on Flow against the seeded server: `argo` and `harbor` carry a seeded digest (seed-digests.ts) that
 * cites the Issues the seed filed there. Counts come from the API, never from the digest's words.
 */
interface Digests {
  projects: {
    project: string
    headline: string
    counts: { done7d: number; working: number; queued: number; waiting: number }
  }[]
}

const cited = (): Record<string, string[]> => JSON.parse(process.env.E2E_DIGESTS ?? '{}') as Record<string, string[]>
const numberOf = (id: string): string => id.replace('issue_', '')

test('Flow opens with one card per digested project: headline, counts from the API, collapsed', async ({
  page,
  apiUrl,
}) => {
  const model = await api<Digests>(apiUrl, '/v1/projects/digests')
  expect(model.projects.map((p) => p.project).sort()).toEqual(['argo', 'harbor'])
  await page.goto('/flow')
  const strip = page.getByTestId('digest-strip')
  await expect(strip).toBeVisible()
  await expect(strip.getByTestId('project-digest')).toHaveCount(model.projects.length)
  for (const project of model.projects) {
    const card = strip.locator(`[data-project="${project.project}"]`)
    await expect(card).toContainText(project.headline)
    await expect(card).toContainText(/\d+ min ago|\d+ h ago/)
    for (const [key, value] of Object.entries(project.counts))
      await expect(card.locator(`[data-count="${key}"]`)).toHaveText(String(value))
    // collapsed by default: the bullets are there but hidden
    await expect(card.getByRole('group', { name: 'Shipped' })).toBeHidden()
    await expect(card.getByRole('button', { name: /Show shipped, next and risks/ })).toHaveAttribute(
      'aria-expanded',
      'false',
    )
  }
})

test('one click opens the bullets, and the Issue ids in them are links to the Issues', async ({ page }) => {
  const ids = cited().argo ?? []
  const first = ids[0]
  if (!first) throw new Error('the seed cited no Issue in argo')
  await page.goto('/flow')
  const card = page.getByTestId('digest-strip').locator('[data-project="argo"]')
  await card.getByRole('button', { name: /Show shipped, next and risks/ }).click()
  for (const name of ['Shipped', 'Next', 'Risks']) await expect(card.getByRole('group', { name })).toBeVisible()
  await expect(card.getByRole('group', { name: 'Shipped' })).toContainText('retention policy')
  const link = card.getByRole('group', { name: 'Shipped' }).getByRole('link', { name: `#${numberOf(first)}` })
  await expect(link).toHaveAttribute('href', new RegExp(`/issues/${numberOf(first)}$`))
  // a plain click on an Issue link opens the peek over Flow
  await link.click()
  await expect(page).toHaveURL(new RegExp(`peek=issues(%2F|/)${numberOf(first)}`))
  await card.getByRole('button', { name: /Hide details/ }).click()
  await expect(card.getByRole('group', { name: 'Shipped' })).toBeHidden()
})

test('the project filter shows that project alone, opened', async ({ page }) => {
  await page.goto('/flow?project=argo')
  const strip = page.getByTestId('digest-strip')
  await expect(strip.getByTestId('project-digest')).toHaveCount(1)
  await expect(strip.locator('[data-project="argo"]').getByRole('group', { name: 'Risks' })).toBeVisible()
  await page.goto('/flow?project=orion')
  await expect(page.getByTestId('digest-strip')).toHaveCount(0)
})

test('a project name on a card filters the board to it', async ({ page }) => {
  await page.goto('/flow')
  await page
    .getByTestId('digest-strip')
    .locator('[data-project="harbor"]')
    .getByRole('link', { name: 'harbor' })
    .click()
  await expect(page).toHaveURL(/project=harbor/)
})

test('with more than one project the strip is one row, and "Show all" lays every card out', async ({ page }) => {
  await page.goto('/flow')
  const strip = page.getByTestId('digest-strip')
  await expect(strip).toContainText('2 projects')
  const toggle = strip.getByRole('button', { name: 'Show all 2' })
  await expect(toggle).toHaveAttribute('aria-expanded', 'false')
  await expect(strip.getByRole('list')).toHaveCSS('display', 'flex')
  await toggle.click()
  await expect(strip.getByRole('button', { name: 'Show one row' })).toHaveAttribute('aria-expanded', 'true')
  await expect(strip.getByRole('list')).toHaveCSS('display', 'grid')
})
