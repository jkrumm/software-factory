import type { Page } from '@playwright/test'
import { expect, test } from './fixtures.ts'
import { api } from './seed.ts'
import { BROKEN_LINKS, PROJECT } from './seed-projects.ts'

/**
 * The project screens against the seeded server: the list, and `argo`'s page: the first screen that answers four questions,
 * and one tab each for the work, the plan, what shipped, the hygiene and the setup, each figure read back from the API the
 * page itself reads.
 */
interface Index {
  projects: {
    name: string
    work: boolean
    counts: { done7d: number; work: Work }
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

test('the sidebar and the g p key reach the list, one card per project', async ({ page, apiUrl }) => {
  const index = await api<Index>(apiUrl, '/v1/projects')
  await page.goto('/needs-you')
  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Projects' }).click()
  await expect(page).toHaveURL(/\/projects$/)
  await expect(page.getByRole('list', { name: 'Projects' }).getByRole('listitem')).toHaveCount(index.projects.length)
  await page.goto('/flow')
  await page.locator('main').click()
  await page.keyboard.press('g')
  await page.keyboard.press('p')
  await expect(page).toHaveURL(/\/projects$/)
})

test('a project card shows the counts of the API and opens the page', async ({ page, apiUrl }) => {
  const index = await api<Index>(apiUrl, '/v1/projects')
  const argo = index.projects.find((p) => p.name === PROJECT)
  if (!argo) throw new Error('argo is not a project')
  await page.goto('/projects')
  const card = page.getByRole('article').filter({ has: page.getByRole('heading', { name: PROJECT, exact: true }) })
  await expect(card).toContainText(`${argo.counts.work.running}Running`)
  await expect(card).toContainText(`${argo.counts.done7d}Shipped`)
  await card.getByRole('link', { name: PROJECT, exact: true }).click()
  await expect(page).toHaveURL(new RegExp(`/projects/${PROJECT}$`))
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
  const overflow = await page.evaluate(() => {
    const main = document.querySelector('main')
    return main ? main.scrollHeight - main.clientHeight : 0
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
  await expect(others.getByRole('link', { name: 'Flow' })).toHaveAttribute('href', `/flow?project=${PROJECT}`)
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
