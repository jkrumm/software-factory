import type { Page } from '@playwright/test'
import { expect, test } from './fixtures.ts'
import { api } from './seed.ts'
import { BROKEN_LINKS, PROJECT } from './seed-projects.ts'

/**
 * The project screens against the seeded server: the list, and `argo`'s page with its open Issues, plan, production, setup
 * and hygiene, each figure read back from the API the page itself reads.
 */
interface Index {
  projects: {
    name: string
    work: boolean
    counts: { done7d: number; working: number; queued: number; waiting: number }
  }[]
}
interface Flow {
  states: Record<string, { issues: { id: string; repo: string }[] }>
}
interface Hygiene {
  probes: { name: string; status: string }[]
  findings: { key: string; status: string }[]
  passes: unknown[]
}
interface Page_ {
  counts: { done7d: number; working: number; queued: number; waiting: number }
  production: { monitors: { monitor: string }[] }
  setup: { leads: number }
}

const OPEN = ['settling', 'queued', 'working', 'waiting', 'watching'] as const

const settle = async (page: Page) => {
  await expect(page.getByRole('status').filter({ hasText: 'Live' })).toBeVisible()
  await page.waitForLoadState('networkidle')
}

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
  await expect(card).toContainText(`${argo.counts.working}Working`)
  await expect(card).toContainText(`${argo.counts.done7d}Shipped`)
  await card.getByRole('link', { name: PROJECT, exact: true }).click()
  await expect(page).toHaveURL(new RegExp(`/projects/${PROJECT}$`))
})

test("the page's open Issues are Flow's for the project, and its counts are the API's", async ({ page, apiUrl }) => {
  const flow = await api<Flow>(apiUrl, '/v1/flow')
  const open = OPEN.flatMap((state) => flow.states[state]?.issues ?? []).filter((issue) => issue.repo === PROJECT)
  const model = await api<Page_>(apiUrl, `/v1/projects/${PROJECT}`)
  await page.goto(`/projects/${PROJECT}`)
  await expect(page.getByRole('heading', { level: 1, name: PROJECT })).toBeVisible()
  await settle(page)
  await expect(page.getByRole('list', { name: 'Open Issues' }).getByRole('listitem')).toHaveCount(open.length)
  expect(model.counts.working + model.counts.waiting + model.counts.queued).toBeGreaterThan(0)
  const totals = page.getByRole('group', { name: 'Totals' })
  await expect(totals.getByRole('article')).toHaveCount(3)
  await expect(totals).toContainText(
    `${model.counts.working} working, ${model.counts.waiting} waiting, ${model.counts.queued} queued`,
  )
  // the other screens, filtered to the project
  const nav = page.getByRole('navigation', { name: 'This project in other screens' })
  await expect(nav.getByRole('link', { name: 'Flow' })).toHaveAttribute('href', `/flow?project=${PROJECT}`)
  await expect(nav.getByRole('link', { name: 'Chain' })).toHaveAttribute('href', `/chain?project=${PROJECT}`)
  await expect(nav.getByRole('link', { name: 'Artifacts' })).toHaveAttribute('href', `/artifacts?project=${PROJECT}`)
})

test('production lists the monitors that file alerts in the project, and the setup reads project.yaml', async ({
  page,
  apiUrl,
}) => {
  const model = await api<Page_>(apiUrl, `/v1/projects/${PROJECT}`)
  expect(model.production.monitors.map((m) => m.monitor)).toEqual(['argo web'])
  await page.goto(`/projects/${PROJECT}`)
  const production = page.getByRole('region', { name: 'Production' })
  await expect(production.getByRole('table', { name: 'Monitors' }).getByRole('row').nth(1)).toContainText('argo web')
  const setup = page.getByRole('region', { name: 'Setup' })
  await expect(setup).toContainText('Leads at once')
  await expect(setup).toContainText(String(model.setup.leads))
})

test("hygiene shows each probe's last run and how each finding ended, as the hygiene tables hold them", async ({
  page,
  apiUrl,
}) => {
  const hygiene = await api<Hygiene>(apiUrl, `/v1/projects/${PROJECT}/hygiene`)
  await page.goto(`/projects/${PROJECT}`)
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
