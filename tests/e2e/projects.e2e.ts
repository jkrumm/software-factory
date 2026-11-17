import type { Page } from '@playwright/test'
import { expect, test } from './fixtures.ts'
import { api } from './seed.ts'
import { BROKEN_LINKS, PROJECT, RED_PROJECT } from './seed-projects.ts'

/**
 * The project screens against the seeded server: the list, and `argo`'s page: the first screen that answers four questions,
 * and one tab each for the work, the plan, what shipped, the hygiene and the setup, each figure read back from the API the
 * page itself reads.
 */
interface Index {
  at: string
  seats: number | null
  groups: string[]
  projects: {
    name: string
    work: boolean
    group: string
    counts: { done7d: number; work: Work }
    shipped: { hours: number[]; lastAt: string | null }
    production: { incidents: number; incidentAt: string | null; regressionAt: string | null }
    plan: { done: number; total: number }
    hygiene: { clean: number; run: number; lastPassAt: string | null }
    digest: { headline: string } | null
  }[]
}
type Work = Record<'running' | 'paused' | 'ready' | 'held' | 'checking', number>
interface Flow {
  states: Record<string, { issues: { id: string; repo: string }[] }>
}
interface Hygiene {
  probes: { name: string; status: string }[]
  findings: { key: string; status: string }[]
  passes: unknown[]
}
interface Plan {
  rows: { key: string; state: string }[]
}
interface Setup {
  fields: { path: string; description: string; value: string }[]
  yaml: string
}
interface Page_ {
  counts: { done7d: number; work: Work }
  production: { monitors: { monitor: string }[] }
  shipped: { hours: number[]; items: { id: string }[] }
}

const OPEN = ['settling', 'queued', 'working', 'waiting', 'watching'] as const
const TABS = ['Work', 'Plan', 'Shipped', 'Hygiene', 'Setup'] as const

const settle = async (page: Page) => {
  await expect(page.getByRole('status').filter({ hasText: 'Live' })).toBeVisible()
  await page.waitForLoadState('networkidle')
}

const sections = (page: Page) => page.getByRole('navigation', { name: 'Project sections' })

type IndexRow = Index['projects'][number]
const shippedOf = (row: IndexRow) => row.shipped.hours.reduce((a, b) => a + b, 0)
const isRed = (row: IndexRow) => row.production.incidents > 0 || row.production.regressionAt !== null
const table = (page: Page) => page.getByRole('table', { name: 'Projects' })
const rows = (page: Page) => table(page).locator('tbody tr[data-project]')
const order = (page: Page) => rows(page).evaluateAll((els) => els.map((el) => el.getAttribute('data-project')))

test.beforeEach(async ({ page }) => {
  // every test starts from the defaults: the table's choices live in this browser's storage
  await page.addInitScript(() => {
    if (!sessionStorage.getItem('projects-e2e')) {
      localStorage.removeItem('factory.projects.table.v1')
      sessionStorage.setItem('projects-e2e', '1')
    }
  })
})

test('the sidebar and the g p key reach the table: every project in one view at 1800x1200, grouped', async ({
  page,
  apiUrl,
}) => {
  const index = await api<Index>(apiUrl, '/v1/projects')
  await page.goto('/needs-you')
  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Projects' }).click()
  await expect(page).toHaveURL(/\/projects$/)
  await expect(rows(page)).toHaveCount(index.projects.length)
  // all of them on screen, nothing scrolled: the last row ends inside the viewport
  const viewport = page.viewportSize()
  const last = await rows(page).last().boundingBox()
  expect(viewport && last && last.y + last.height <= viewport.height).toBe(true)
  expect(await page.evaluate("document.querySelector('main')?.scrollTop ?? 0")).toBe(0)
  // groups in the owner's order, each with the projects the groups file files under it
  const groups = index.groups.filter((group) => index.projects.some((p) => p.group === group))
  await expect(table(page).locator('tbody th[scope="colgroup"]')).toHaveCount(groups.length)
  for (const group of groups) {
    const members = index.projects.filter((p) => p.group === group).length
    await expect(table(page).getByRole('rowgroup', { name: group }).locator('tr[data-project]')).toHaveCount(members)
  }
  await page.goto('/')
  await page.locator('main').click()
  await page.keyboard.press('g')
  await page.keyboard.press('p')
  await expect(page).toHaveURL(/\/projects$/)
})

test('32 projects in six groups, the size of the live estate, still fit 1800x1200 without scrolling', async ({
  page,
  apiUrl,
}) => {
  const index = await api<Index>(apiUrl, '/v1/projects')
  const groups = ['Infra', 'Tooling', 'Personal', 'Apps', 'Work', 'Other']
  const projects = Array.from({ length: 32 }, (_, i) => {
    const source = index.projects[i % index.projects.length]
    if (!source) throw new Error('no project to copy')
    return { ...source, name: `${source.name}-${i}`, group: groups[i % groups.length] }
  })
  await page.route('**/v1/projects', (route) => route.fulfill({ json: { ...index, groups, projects } }))
  await page.goto('/projects')
  await expect(rows(page)).toHaveCount(32)
  const last = await rows(page).last().boundingBox()
  const viewport = page.viewportSize()
  expect(viewport && last && last.y + last.height <= viewport.height).toBe(true)
})

test("a row shows the API's figures: the state bar, the shipped count, the lamp, the plan and the hygiene", async ({
  page,
  apiUrl,
}) => {
  const index = await api<Index>(apiUrl, '/v1/projects')
  const argo = index.projects.find((p) => p.name === PROJECT)
  if (!argo) throw new Error('argo is not a project')
  await page.goto('/projects')
  const row = rows(page).and(page.locator(`[data-project="${PROJECT}"]`))
  const { running, paused, ready, held, checking } = argo.counts.work
  await expect(row.getByRole('img', { name: `Open Issues of ${PROJECT}` })).toHaveAccessibleName(
    `Open Issues of ${PROJECT}: ${running} running, ${paused} paused, ${ready} ready, ${held} held, ${checking} checking`,
  )
  const cells = row.locator('td')
  const heads = await table(page)
    .locator('thead th')
    .evaluateAll((els) => els.map((el) => el.textContent?.trim()))
  const cellOf = (head: string) => cells.nth(heads.findIndex((h) => h?.startsWith(head)))
  await expect(cellOf('Now')).toContainText(String(running + paused + ready + held + checking))
  await expect(cellOf('Shipped 7 d')).toContainText(String(shippedOf(argo)))
  expect(shippedOf(argo)).toBe(argo.counts.done7d)
  if (argo.plan.total > 0) await expect(cellOf('Plan')).toContainText(`${argo.plan.done}/${argo.plan.total}`)
  if (argo.hygiene.run > 0) await expect(cellOf('Hygiene')).toContainText(`${argo.hygiene.clean}/${argo.hygiene.run}`)
  const red = index.projects.find((p) => p.name === RED_PROJECT)
  expect(red && isRed(red)).toBe(true)
  await expect(
    rows(page)
      .and(page.locator(`[data-project="${RED_PROJECT}"]`))
      .locator('[data-lamp="incident"]'),
  ).toBeVisible()
  // the hover previews the digest, a click opens the page
  if (argo.digest) {
    await row.hover()
    await expect(page.getByRole('dialog').filter({ hasText: argo.digest.headline })).toBeVisible()
  }
  await cellOf('Now').click()
  await expect(page).toHaveURL(new RegExp(`/projects/${PROJECT}$`))
})

test('sorting by shipped orders the rows by the 7-day count, the most first', async ({ page, apiUrl }) => {
  const index = await api<Index>(apiUrl, '/v1/projects')
  const shipped = new Map(index.projects.map((p) => [p.name, shippedOf(p)]))
  await page.goto('/projects')
  await page.getByRole('group', { name: 'Group' }).getByRole('button', { name: 'Flat' }).click()
  await table(page).getByRole('button', { name: 'Shipped 7 d' }).click()
  await expect(table(page).locator('th[aria-sort="descending"]')).toContainText('Shipped 7 d')
  const counts = (await order(page)).map((name) => shipped.get(name ?? '') ?? -1)
  expect(counts).toHaveLength(index.projects.length)
  expect(counts).toEqual([...counts].sort((a, b) => b - a))
  await table(page).getByRole('button', { name: 'Shipped 7 d' }).click()
  await expect(table(page).locator('th[aria-sort="ascending"]')).toContainText('Shipped 7 d')
  const ascending = (await order(page)).map((name) => shipped.get(name ?? '') ?? -1)
  expect(ascending).toEqual([...ascending].sort((a, b) => a - b))
})

test('the Red filter keeps the projects with an open incident or a regression in 7 days, and search narrows by name', async ({
  page,
  apiUrl,
}) => {
  const index = await api<Index>(apiUrl, '/v1/projects')
  const red = index.projects.filter(isRed).map((p) => p.name)
  expect(red).toContain(RED_PROJECT)
  await page.goto('/projects')
  await page.getByRole('group', { name: 'Show' }).getByRole('button', { name: 'Red' }).click()
  await expect(rows(page)).toHaveCount(red.length)
  expect((await order(page)).sort()).toEqual([...red].sort())
  await page.getByRole('group', { name: 'Show' }).getByRole('button', { name: 'All' }).click()
  await page.getByRole('searchbox', { name: 'Search projects' }).fill(PROJECT)
  const matching = index.projects.filter((p) => p.name.includes(PROJECT)).length
  await expect(rows(page)).toHaveCount(matching)
})

test('the column choice, the sort and the density survive a reload', async ({ page }) => {
  await page.goto('/projects')
  await expect(table(page).getByRole('columnheader', { name: /Plan/ })).toBeVisible()
  await page.getByRole('button', { name: 'Columns' }).click()
  await page.getByRole('checkbox', { name: 'Plan' }).uncheck()
  await page.keyboard.press('Escape')
  await table(page).getByRole('button', { name: 'Last ship' }).click()
  await page.getByRole('group', { name: 'Density' }).getByRole('button', { name: 'Comfortable' }).click()
  await expect(table(page).getByRole('columnheader', { name: /Plan/ })).toHaveCount(0)
  await page.reload()
  await expect(rows(page).first()).toBeVisible()
  await expect(table(page).getByRole('columnheader', { name: /Plan/ })).toHaveCount(0)
  await expect(table(page).locator('th[aria-sort="descending"]')).toContainText('Last ship')
  await expect(
    page.getByRole('group', { name: 'Density' }).getByRole('button', { name: 'Comfortable' }),
  ).toHaveAttribute('aria-pressed', 'true')
})

test('the page reads its data in one request', async ({ page }) => {
  const reads: string[] = []
  page.on('request', (request) => {
    const path = new URL(request.url()).pathname
    if (path.startsWith('/v1/projects')) reads.push(path)
  })
  await page.goto('/projects')
  await expect(rows(page).first()).toBeVisible()
  await page.waitForLoadState('networkidle')
  expect(reads).toEqual(['/v1/projects'])
})

test('the keyboard moves between rows and Enter opens the project', async ({ page }) => {
  await page.goto('/projects')
  const first = rows(page).first()
  await first.focus()
  await page.keyboard.press('ArrowDown')
  const second = (await order(page))[1]
  await expect(rows(page).nth(1)).toBeFocused()
  await page.keyboard.press('Enter')
  await expect(page).toHaveURL(new RegExp(`/projects/${second}$`))
})

test.describe('on a phone', () => {
  test.use({ viewport: { width: 390, height: 844 } })
  test('every project is a card with its state bar and opens its page', async ({ page, apiUrl }) => {
    const index = await api<Index>(apiUrl, '/v1/projects')
    await page.goto('/projects')
    const cards = page.getByRole('article')
    await expect(cards).toHaveCount(index.projects.length)
    const argo = cards.filter({ has: page.getByRole('heading', { name: PROJECT, exact: true }) })
    await expect(argo.getByRole('img', { name: new RegExp(`^Open Issues of ${PROJECT}`) })).toBeVisible()
    await argo.getByRole('link', { name: PROJECT, exact: true }).click()
    await expect(page).toHaveURL(new RegExp(`/projects/${PROJECT}$`))
  })
})

test('the first screen answers health, now, next and shipped in 1800 by 1200 without scrolling, each list capped at five', async ({
  page,
  apiUrl,
}) => {
  const model = await api<Page_>(apiUrl, `/v1/projects/${PROJECT}`)
  await page.setViewportSize({ width: 1800, height: 1200 })
  await page.goto(`/projects/${PROJECT}`)
  await expect(page.getByRole('heading', { level: 1, name: PROJECT })).toBeVisible()
  await settle(page)
  // is it healthy: three answers, each a link to the tab with the detail
  const health = page.getByRole('list', { name: 'Health' })
  await expect(health.getByRole('listitem')).toHaveCount(3)
  await expect(health.getByRole('link', { name: /Production/ })).toHaveAttribute('href', `/projects/${PROJECT}/shipped`)
  await expect(health.getByRole('link', { name: /Checks/ })).toHaveAttribute('href', `/projects/${PROJECT}/hygiene`)
  await expect(health.getByRole('link', { name: /Project files/ })).toHaveAttribute(
    'href',
    `/projects/${PROJECT}/setup`,
  )
  // what moves now, what is next, what shipped
  await expect(page.getByRole('heading', { level: 2, name: 'Moving now' })).toBeVisible()
  await expect(page.getByRole('heading', { level: 2, name: 'Next' })).toBeVisible()
  await expect(page.getByRole('heading', { level: 2, name: 'Shipped' })).toBeVisible()
  for (const list of ['Running', 'Paused', 'Ready', 'Held', 'Next plan rows', 'Newest shipped']) {
    const items = page.getByRole('list', { name: list }).getByRole('listitem')
    expect(await items.count()).toBeLessThanOrEqual(5)
  }
  await expect(page.getByRole('list', { name: 'Newest shipped' }).getByRole('listitem')).toHaveCount(
    Math.min(5, model.shipped.items.length),
  )
  // the hourly bars carry the page's own hours
  expect(model.shipped.hours).toHaveLength(168)
  // nothing needs a scroll: the last thing of the first screen ends inside the viewport and the content does not overflow
  const overflow = await page.locator('main').evaluate((el) => {
    const box = el as { scrollHeight: number; clientHeight: number }
    return box.scrollHeight - box.clientHeight
  })
  expect(overflow).toBeLessThanOrEqual(0)
  // nothing is told twice: a heading of the first screen appears once
  for (const name of ['Moving now', 'Next', 'Shipped']) {
    await expect(page.getByRole('heading', { name, exact: true })).toHaveCount(1)
  }
})

test("the tabs are addresses, the Work tab lists Flow's open Issues of the project and the badge is the page's count", async ({
  page,
  apiUrl,
}) => {
  const flow = await api<Flow>(apiUrl, '/v1/flow')
  const open = OPEN.flatMap((state) => flow.states[state]?.issues ?? []).filter((issue) => issue.repo === PROJECT)
  const model = await api<Page_>(apiUrl, `/v1/projects/${PROJECT}`)
  const { running, paused, ready, held, checking } = model.counts.work
  expect(running + paused + ready + held + checking).toBeGreaterThan(0)
  await page.goto(`/projects/${PROJECT}`)
  await settle(page)
  const nav = sections(page)
  await expect(nav.getByRole('link', { name: 'Overview' })).toHaveAttribute('aria-current', 'page')
  await expect(nav.getByRole('link', { name: /^Work/ })).toContainText(
    String(running + paused + ready + held + checking),
  )
  await expect(nav.getByRole('link', { name: /^Shipped/ })).toContainText(String(model.counts.done7d))
  for (const tab of TABS) {
    await nav.getByRole('link', { name: new RegExp(`^${tab}`) }).click()
    await expect(page).toHaveURL(new RegExp(`/projects/${PROJECT}/${tab.toLowerCase()}$`))
    await expect(nav.getByRole('link', { name: new RegExp(`^${tab}`) })).toHaveAttribute('aria-current', 'page')
  }
  await page.goto(`/projects/${PROJECT}/work`)
  await settle(page)
  await expect(page.getByRole('table', { name: 'Open Issues' }).getByRole('row')).toHaveCount(open.length + 1)
  // a sortable column: pressing it sets aria-sort
  await page.getByRole('button', { name: 'Title' }).click()
  await expect(page.getByRole('columnheader', { name: 'Title' })).toHaveAttribute('aria-sort', 'ascending')
  // the other screens, filtered to the project
  const others = page.getByRole('navigation', { name: 'This project in other screens' })
  await expect(others.getByRole('link', { name: 'Overview' })).toHaveAttribute('href', `/?project=${PROJECT}`)
  await expect(others.getByRole('link', { name: 'Chain' })).toHaveAttribute('href', `/chain?project=${PROJECT}`)
  await expect(others.getByRole('link', { name: 'Artifacts' })).toHaveAttribute('href', `/artifacts?project=${PROJECT}`)
})

test('each tab reads only its own data, loaded when the tab opens', async ({ page }) => {
  const reads: string[] = []
  page.on('request', (request) => {
    const path = new URL(request.url()).pathname
    if (path.startsWith(`/v1/projects/${PROJECT}/`)) reads.push(path.slice(`/v1/projects/${PROJECT}/`.length))
  })
  await page.goto(`/projects/${PROJECT}/setup`)
  await expect(page.getByRole('table', { name: 'project.yaml keys' })).toBeVisible()
  expect(reads).toContain('setup')
  expect(reads).not.toContain('plan')
  expect(reads).not.toContain('hygiene')
  reads.length = 0
  await sections(page).getByRole('link', { name: 'Hygiene' }).click()
  await expect(page.getByRole('table', { name: 'Probes' })).toBeVisible()
  expect(reads).toContain('hygiene')
  expect(reads).not.toContain('setup')
  expect(reads).not.toContain('plan')
  reads.length = 0
  await sections(page).getByRole('link', { name: 'Plan' }).click()
  await expect(page).toHaveURL(new RegExp(`/projects/${PROJECT}/plan$`))
  await page.waitForLoadState('networkidle')
  expect(reads).toContain('plan')
  expect(reads).not.toContain('hygiene')
  expect(reads).not.toContain('setup')
})

test('the plan tab shows every row with its state', async ({ page, apiUrl }) => {
  const plan = await api<Plan>(apiUrl, `/v1/projects/${PROJECT}/plan`)
  await page.goto(`/projects/${PROJECT}/plan`)
  await settle(page)
  const region = page.getByRole('region', { name: 'Plan' })
  if (plan.rows.length === 0) {
    await expect(region).toContainText('This project has no plan rows')
    return
  }
  await expect(region.getByRole('table', { name: 'Plan rows' }).getByRole('row')).toHaveCount(plan.rows.length + 1)
})

test('the shipped tab names production and the last 7 days by day', async ({ page, apiUrl }) => {
  const model = await api<Page_>(apiUrl, `/v1/projects/${PROJECT}`)
  await page.goto(`/projects/${PROJECT}/shipped`)
  await settle(page)
  await expect(page.getByRole('region', { name: 'Production' })).toBeVisible()
  const history = page.getByRole('region', { name: 'Shipped, last 7 days' })
  await expect(history).toBeVisible()
  await expect(history.getByRole('listitem')).toHaveCount(model.shipped.items.length)
})

test("the setup tab is the project.yaml as a described form with the schema's meaning of each key, and the raw file behind a toggle", async ({
  page,
  apiUrl,
}) => {
  const setup = await api<Setup>(apiUrl, `/v1/projects/${PROJECT}/setup`)
  const leads = setup.fields.find((f) => f.path === 'leads')
  if (!leads?.description) throw new Error('the setup form has no description for leads')
  const model = await api<Page_>(apiUrl, `/v1/projects/${PROJECT}`)
  expect(model.production.monitors.map((m) => m.monitor)).toEqual(['argo web'])
  await page.goto(`/projects/${PROJECT}/setup`)
  const form = page.getByRole('table', { name: 'project.yaml keys' })
  await expect(form.getByRole('row')).toHaveCount(setup.fields.length)
  await expect(form.getByRole('row').filter({ hasText: leads.description })).toContainText(leads.value)
  await expect(form.getByRole('row').filter({ hasText: 'hygiene' }).first()).toBeVisible()
  // the raw file behind the toggle
  await page.getByRole('button', { name: 'Raw file' }).click()
  await expect(page.getByLabel('project.yaml, defaults filled in')).toContainText('apiVersion: factory/v2')
  await expect(form).toHaveCount(0)
  await page.getByRole('button', { name: 'Form' }).click()
  await expect(form).toBeVisible()
  // the monitors that file alerts in the project
  const monitors = page.getByRole('region', { name: 'Monitors' })
  await expect(monitors.getByRole('table', { name: 'Monitors' }).getByRole('row').nth(1)).toContainText('argo web')
})

test("hygiene shows each probe's last run and how each finding ended, as the hygiene tables hold them", async ({
  page,
  apiUrl,
}) => {
  const hygiene = await api<Hygiene>(apiUrl, `/v1/projects/${PROJECT}/hygiene`)
  await page.goto(`/projects/${PROJECT}/hygiene`)
  const region = page.getByRole('region', { name: 'Hygiene' })
  const probes = region.getByRole('table', { name: 'Probes' })
  await expect(probes.getByRole('row')).toHaveCount(hygiene.probes.length + 1)
  const row = (name: string) => probes.getByRole('row').filter({ has: page.getByText(name, { exact: true }) })
  await expect(row('links')).toContainText('Found')
  await expect(row('deps')).toContainText('Clean')
  await expect(row('browser')).toContainText('argo has no UI')
  await expect(row('bundle')).toContainText("the project's own")
  await expect(row('bundle')).toContainText('Found')
  const findings = region.getByRole('table', { name: 'Findings' })
  await expect(findings.getByRole('row')).toHaveCount(hygiene.findings.length + 1)
  await expect(findings.getByRole('row').filter({ hasText: BROKEN_LINKS })).toContainText('Filed')
  await expect(findings.getByRole('row').filter({ hasText: 'project probe bundle' })).toContainText('Left out')
  await expect(findings.getByRole('row').filter({ hasText: 'run rule is broken' })).toContainText('Refused')
  await expect(findings.getByRole('row').filter({ hasText: 'removed command' })).toContainText('Filed')
  // the older pass sits under a fold
  await region.getByRole('button', { name: /Earlier passes/ }).click()
  await expect(region.getByRole('table', { name: 'Passes' }).getByRole('row')).toHaveCount(hygiene.passes.length)
})

test('the project switcher moves to another project on the tab that is open, and the sidebar has no project list', async ({
  page,
  apiUrl,
}) => {
  const index = await api<Index>(apiUrl, '/v1/projects')
  const other = index.projects.find((p) => p.name !== PROJECT && !p.work)
  if (!other) throw new Error('the seed has no second project')
  await page.goto(`/projects/${PROJECT}/hygiene`)
  await settle(page)
  // the sidebar's own section for the page is gone: no project of the list is a link in it
  await expect(page.getByRole('complementary').getByRole('link', { name: other.name, exact: true })).toHaveCount(0)
  await page.getByRole('button', { name: 'Switch project' }).click()
  const list = page.getByRole('dialog', { name: 'Projects' })
  await expect(list.getByRole('link')).toHaveCount(index.projects.filter((p) => !p.work || p.name === PROJECT).length)
  await list.getByRole('link', { name: other.name }).click()
  await expect(page).toHaveURL(new RegExp(`/projects/${other.name}/hygiene$`))
  await expect(page.getByRole('heading', { level: 1, name: other.name })).toBeVisible()
})

test('a project the factory never read says so', async ({ page }) => {
  await page.goto('/projects/nowhere')
  await expect(page.getByText('No project of that name')).toBeVisible()
  await expect(page.getByRole('link', { name: 'All projects' })).toBeVisible()
})

test('a chain node and the palette open the project page too', async ({ page }) => {
  await page.goto('/chain')
  const chip = page.getByRole('link', { name: PROJECT, exact: true }).first()
  if (await chip.count()) {
    await expect(chip).toHaveAttribute('href', new RegExp(`/projects/${PROJECT}$`))
  }
  await page.goto('/needs-you')
  await settle(page)
  await page.keyboard.press('ControlOrMeta+K')
  const dialog = page.getByRole('dialog')
  await expect(dialog).toBeVisible()
  await dialog.getByRole('combobox').fill(PROJECT)
  await dialog.getByRole('option').filter({ hasText: 'Project' }).filter({ hasText: PROJECT }).first().click()
  await expect(page).toHaveURL(new RegExp(`/projects/${PROJECT}$`))
})
