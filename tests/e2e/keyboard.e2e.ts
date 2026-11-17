import type { Page } from '@playwright/test'
import { SCREENS as NAV } from '../../apps/console/src/lib/screens.ts'
import { SHORTCUT_GROUPS } from '../../apps/console/src/lib/shortcuts.ts'
import { expect, test } from './fixtures.ts'
import { api, needsCount } from './seed.ts'

/**
 * The Console by keyboard (Issue 1805): the Overview at home, the navigation in the owner's order, the purpose of each
 * screen, the help overlay and every key it lists. The expectations are read from `nav.ts` and `shortcuts.ts`, the same
 * lists the Console builds its navigation, its bindings and the overlay from, so a key added there without a test here
 * fails the last test of this file.
 */

const main = (page: Page) => page.getByRole('navigation', { name: 'Main' })
const overlay = (page: Page) => page.getByTestId('shortcuts')
const palette = (page: Page) => page.getByRole('dialog').filter({ has: page.getByRole('combobox') })
const peekPanel = (page: Page) => page.getByRole('dialog').and(page.locator('[data-peek-panel]'))
const keynav = (page: Page) => page.locator('main [data-keynav]')
const windowButton = (page: Page, name: string) =>
  page.getByTestId('flow-trend').getByRole('group', { name: 'Window' }).getByRole('button', { name, exact: true })

const LISTED = SHORTCUT_GROUPS.flatMap((group) =>
  group.items.map((item) => (typeof item.keys === 'string' ? item.keys : item.keys.join(' '))),
)

/** The seeded facts the palette searches for: a project, and an Issue that is in the list. */
async function world(apiUrl: string) {
  const { issues } = await api<{ issues: { id: number; title: string }[] }>(apiUrl, '/v1/issues?state=all&limit=500')
  const flow = await api<{ perProject: { repo: string }[] }>(apiUrl, '/v1/flow')
  const issue = issues[0]
  const project = flow.perProject[0]?.repo
  if (!issue || !project) throw new Error('the seed has no Issue or no project to search for')
  return { issue, project }
}

/** Presses a key as the overlay names it (`G O`, `Mod+K`, `?`), and records it as exercised. */
function keys(page: Page, exercised: Set<string>) {
  return async (shortcut: string) => {
    exercised.add(shortcut)
    for (const step of shortcut.split(' ')) {
      await page.keyboard.press(step === 'Mod+K' ? 'ControlOrMeta+K' : step.length === 1 ? step.toLowerCase() : step)
    }
  }
}

test('the root is the Overview: the band shows its four panels from live data, the needs match the API', async ({
  page,
  apiUrl,
}) => {
  const count = await needsCount(apiUrl)
  await page.goto('/')
  await expect(page).toHaveURL(/\/$/)
  const band = page.getByTestId('overview-band')
  await expect(band).toBeVisible()
  for (const panel of ['overview-needs', 'overview-production', 'overview-shipped', 'overview-host']) {
    await expect(band.getByTestId(panel)).toBeVisible()
  }
  await expect(band.getByTestId('overview-needs').locator('p').first()).toHaveText(new RegExp(`^${count}`))
  await expect(page.getByTestId('flow-trend')).toBeVisible()
  // the band is above the trend chart, which is above the list
  const top = async (id: string) => (await page.getByTestId(id).boundingBox())?.y ?? -1
  expect(await top('overview-band')).toBeLessThan(await top('flow-trend'))
  // the old address keeps its search
  await page.goto('/flow?state=paused')
  await expect(page).toHaveURL(/\/\?state=paused$/)
})

test('the navigation is in the order of nav.ts, in its two groups, and the open count sits on the Overview', async ({
  page,
}) => {
  await page.goto('/')
  const groups = main(page).getByRole('group')
  await expect(groups).toHaveCount(2)
  const hrefs = (group: number) =>
    groups
      .nth(group)
      .getByRole('link')
      .evaluateAll((els) => els.map((el) => el.getAttribute('href')))
  expect(await hrefs(0)).toEqual(NAV.filter((item) => item.group === 'work').map((item) => item.to))
  expect(await hrefs(1)).toEqual(NAV.filter((item) => item.group === 'insight').map((item) => item.to))
  await expect(groups.nth(0)).toHaveAccessibleName('Daily')
  await expect(groups.nth(1)).toHaveAccessibleName('How the factory runs')
  for (const item of NAV) {
    await expect(main(page).getByRole('link', { name: new RegExp(`^${item.label}`) })).toHaveAttribute('href', item.to)
  }
})

test('every screen shows its purpose under the title', async ({ page }) => {
  for (const item of NAV) {
    await page.goto(item.to)
    await expect(page.getByTestId('page-purpose')).toHaveText(item.purpose)
  }
})

test('? opens the overlay and it lists exactly the keys of shortcuts.ts', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByTestId('overview-band')).toBeVisible()
  await page.keyboard.press('?')
  await expect(page.getByRole('dialog', { name: 'Keyboard shortcuts' })).toBeVisible()
  const listed = await overlay(page)
    .locator('li[data-shortcut]')
    .evaluateAll((els) => els.map((el) => el.getAttribute('data-shortcut')))
  expect(listed).toEqual(LISTED)
  expect(new Set(listed).size).toBe(listed.length)
  for (const key of ['G O', 'Mod+K', '?', '/', 'Escape', 'J', 'K', 'Enter', '[', ']']) expect(listed).toContain(key)
})

test('every key the overlay lists does what it says', async ({ page, apiUrl }) => {
  const exercised = new Set<string>()
  const press = keys(page, exercised)

  // G then a letter: each screen of the navigation
  await page.goto('/needs-you')
  await expect(page.getByTestId('page-purpose')).toBeVisible()
  for (const item of [...NAV].reverse()) {
    await press(`G ${item.key}`)
    await expect(page).toHaveURL(item.to === '/' ? /\/$/ : new RegExp(`${item.to}$`))
    await expect(main(page).getByRole('link', { name: new RegExp(`^${item.label}`) })).toHaveAttribute(
      'data-status',
      'active',
    )
  }

  // Mod+K opens the palette, ? opens and closes the overlay, Escape closes the palette
  await page.goto('/')
  await expect(page.getByTestId('overview-band')).toBeVisible()
  await press('Mod+K')
  await expect(palette(page)).toBeVisible()
  await press('Escape')
  await expect(palette(page)).toBeHidden()
  await press('?')
  await expect(overlay(page)).toBeVisible()
  await press('?')
  await expect(overlay(page)).toBeHidden()

  // / focuses the page's filter in the sidebar; on a screen with none it opens the palette
  await press('/')
  await expect(page.locator('[data-page-section]').locator(':focus')).toHaveCount(1)
  await page.goto('/projects')
  await expect(page.getByTestId('page-purpose')).toBeVisible()
  await press('/')
  await expect(palette(page)).toBeVisible()
  await press('Escape')
  await expect(palette(page)).toBeHidden()

  // [ and ] step the trend window on the Overview and the days of /improve
  await page.goto('/')
  await expect(page.getByTestId('flow-trend')).toBeVisible()
  await expect(windowButton(page, '7 d')).toHaveAttribute('aria-pressed', 'true')
  await press('[')
  await expect(windowButton(page, '24 h')).toHaveAttribute('aria-pressed', 'true')
  await press(']')
  await press(']')
  await expect(windowButton(page, '30 d')).toHaveAttribute('aria-pressed', 'true')
  await page.goto('/improve?days=30')
  await expect(page.getByTestId('page-purpose')).toBeVisible()
  await press(']')
  await expect(page).toHaveURL(/days=90$/)
  await press('[')
  await press('[')
  await expect(page).toHaveURL(/days=7$/)

  // J and K step through the rows marked data-keynav
  await page.goto('/')
  await expect(page.getByTestId('overview-band')).toBeVisible()
  expect(await keynav(page).count()).toBeGreaterThanOrEqual(2)
  await press('J')
  await expect(keynav(page).nth(0)).toBeFocused()
  await press('J')
  await expect(keynav(page).nth(1)).toBeFocused()
  await press('K')
  await expect(keynav(page).nth(0)).toBeFocused()

  // Enter opens the focused Issue in the peek; Escape closes it; the full page, then Escape goes back
  const { project } = await world(apiUrl)
  await page.goto('/?state=running')
  const rows = page.getByTestId('flow-list').getByTestId('flow-row')
  await expect(rows.first()).toBeVisible()
  const rowLink = rows.first().locator('[data-keynav]')
  for (
    let i = 0, n = await keynav(page).count();
    i < n && (await rowLink.evaluate((el) => el !== el.ownerDocument.activeElement));
    i++
  ) {
    await press('J')
  }
  await expect(rowLink).toBeFocused()
  await press('Enter')
  await expect(peekPanel(page)).toBeVisible()
  await press('Escape')
  await expect(peekPanel(page)).toBeHidden()
  await rowLink.click()
  await peekPanel(page).getByRole('link', { name: 'Open full page' }).click()
  await expect(page).toHaveURL(/\/issues\/\d+$/)
  await press('Escape')
  await expect(page).not.toHaveURL(/\/issues\//)
  expect(project).toBeTruthy()

  // every key the overlay lists was pressed above
  expect([...exercised].sort()).toEqual([...new Set(LISTED)].sort())
})

test.describe('the palette finds', () => {
  const open = async (page: Page, query: string) => {
    await page.goto('/')
    await expect(page.getByTestId('overview-band')).toBeVisible()
    await page.keyboard.press('ControlOrMeta+K')
    await expect(palette(page)).toBeVisible()
    await palette(page).getByRole('combobox').fill(query)
  }

  test('a project by its name, and Enter opens its page', async ({ page, apiUrl }) => {
    const { project } = await world(apiUrl)
    await open(page, project)
    await expect(palette(page).getByRole('option').filter({ hasText: 'Project' }).first()).toBeVisible()
    await page.keyboard.press('Enter')
    await expect(page).toHaveURL(new RegExp(`/projects/${project}$`))
  })

  test('an Issue by #number, and Enter opens its page', async ({ page, apiUrl }) => {
    const { issue } = await world(apiUrl)
    await open(page, `#${issue.id}`)
    await expect(palette(page).getByRole('option').first()).toContainText(`#${issue.id}`)
    await page.keyboard.press('Enter')
    await expect(page).toHaveURL(new RegExp(`/issues/${issue.id}$`))
  })

  test('a number of no loaded Issue as "Open Issue #n"', async ({ page }) => {
    await open(page, '987654')
    await expect(palette(page).getByRole('option').first()).toContainText('Open Issue #987654')
  })
})
