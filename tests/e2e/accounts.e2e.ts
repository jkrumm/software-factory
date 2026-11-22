import { join } from 'node:path'
import type { Page } from '@playwright/test'
import type { AccountRow, AccountsView } from '@software-factory/contract'
import { hostEnv } from '../scenarios/host.ts'
import { expect, test } from './fixtures.ts'
import { api } from './seed.ts'

const OUT = join(import.meta.dir, 'out', 'screenshots')
const ROOT = join(import.meta.dir, '..', '..')
const HOUR = 3_600_000

/** `claude-account <args>` against the world's own files, the way the owner's terminal reads them. */
async function claudeAccount(args: string[]): Promise<unknown> {
  const proc = Bun.spawn(['bun', join(ROOT, 'packages', 'accounts', 'bin', 'claude-account.ts'), ...args, '--json'], {
    env: { ...process.env, ...hostEnv(process.env.E2E_WORLD_BIN ?? '') },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [out, err, code] = await Promise.all([proc.stdout.text(), proc.stderr.text(), proc.exited])
  if (code !== 0) throw new Error(`claude-account ${args.join(' ')} exited ${code}: ${err}`)
  return JSON.parse(out)
}

/** N accounts made from the real one: every shape the page has to read (open, drain, reserve, paused, stale, an Ultra without a 5 h window). */
function seeded(base: AccountRow, count: number, now = Date.now()): AccountsView['accounts'] {
  const iso = (hours: number) => new Date(now + hours * HOUR).toISOString()
  const shapes: Partial<AccountRow>[] = [
    {},
    {
      mode: {
        ...base.mode,
        kind: 'drain',
        source: 'override',
        until: 'reset',
        until_at: iso(60),
        why: 'fill first',
        for: null,
      },
    },
    { mode: { ...base.mode, kind: 'reserve', for: 'fable', source: 'registry', until: null, until_at: null } },
    {
      mode: {
        ...base.mode,
        kind: 'paused',
        source: 'override',
        until: iso(4),
        until_at: iso(4),
        why: 'rest',
        for: null,
      },
    },
    { fresh: false },
    { plan: 'ultra' },
    {},
    { forecast: null },
  ]
  return Array.from({ length: count }, (_, i) => {
    const shape = shapes[i % shapes.length] ?? {}
    const weekly = 20 + ((i * 17) % 70)
    const id = i === 0 ? base.id : `acct-${i + 1}`
    return {
      ...base,
      ...shape,
      id,
      account: id,
      weeklyUsed: weekly,
      weeklyResetsAt: iso(30 + i * 9),
      limits: [
        ...(shape.plan === 'ultra'
          ? []
          : [{ kind: 'session', percent: 10 + i * 8, resets_at: iso(2), age_s: 30, source: 'statusline' }]),
        { kind: 'weekly_all', percent: weekly, resets_at: iso(30 + i * 9), age_s: 30, source: 'statusline' },
      ],
      forecast:
        'forecast' in shape
          ? null
          : i % 2 === 0
            ? {
                method: 'burn-rate-24h-v1',
                weekly_at_reset: 100,
                full_at: iso(20 + i),
                waste_percent: 0,
                waste_units: 0,
                burn_per_hour: 1.2,
                basis_hours: 24,
              }
            : {
                method: 'burn-rate-24h-v1',
                weekly_at_reset: weekly + 18,
                full_at: null,
                waste_percent: 100 - weekly - 18,
                waste_units: 0.4,
                burn_per_hour: 0.4,
                basis_hours: 24,
              },
      resets: Array.from({ length: 8 }, (_, k) => ({
        at: iso(-(8 - k) * 168 + 30 + i * 9),
        weekly: 60 + ((k * 13 + i * 7) % 41),
        scoped: null,
        modes: [],
        rule: 'v1.10',
        closed_hours: 0,
        manual: k === 2 && i === 1,
      })),
      seats: { cap: 3, taken: i % 3, free: 3 - (i % 3) },
      leads: Array.from({ length: i % 3 }, (_, k) => `issue_${100 + i * 3 + k}`),
      rank: i + 1,
      rankReason: 'home',
      lanes: Object.fromEntries(
        Object.entries(base.lanes).map(([lane, state]) => [
          lane,
          shape.mode?.kind === 'paused'
            ? {
                open: false,
                position: null,
                reason: null,
                closed: 'paused',
                why: 'paused by its mode: sampled and checked, takes no work',
                opens_at: null,
              }
            : {
                ...state,
                open: true,
                position: i + 1,
                reason: i === 1 ? 'drain' : 'home',
                closed: null,
                why: null,
                opens_at: null,
              },
        ]),
      ),
      closed: shape.mode?.kind === 'paused' ? { closed: 'paused', why: 'paused by its mode', opens_at: null } : null,
    }
  })
}

/** The health rows of the owner's state on 2026-11-22: the first account's login here ends in 6.9 d (warn), its MacBook peer has had no quota sample for 7 h; every other login is fine. */
function seededHealth(view: AccountsView, ids: string[], now = Date.now()): NonNullable<AccountsView['health']> {
  const peer = 'macbook'
  const ends = (days: number) => new Date(now + days * 86_400_000).toISOString()
  const rows = ids.flatMap((id, i): NonNullable<AccountsView['health']>['rows'] => {
    const here = { machine: view.machine, id, check: 'login' as const, via: undefined }
    const there = { machine: peer, id, check: 'login' as const }
    const warn = i === 0
    return [
      warn
        ? {
            ...here,
            state: 'warn',
            detail: 'login ends in 6.9 d',
            fix: `claude-relogin ${id} --machine ${view.machine}`,
            ends_at: ends(6.9),
            days_left: 6.9,
          }
        : { ...here, state: 'ok', detail: '22 d left', fix: null, ends_at: ends(22), days_left: 22 },
      { ...there, state: 'ok', detail: '9 d left', fix: null, ends_at: ends(9), days_left: 9, via: 'core' },
      ...(warn
        ? [
            {
              machine: peer,
              id,
              check: 'quota' as const,
              state: 'warn' as const,
              detail: 'no quota sample for 7 h (token rejected?)',
              fix: null,
              via: 'core' as const,
            },
          ]
        : []),
    ]
  })
  return { at: new Date(now - 12 * 60_000).toISOString(), rows }
}

async function mockAccounts(page: Page, apiUrl: string, count: number) {
  const view = await api<AccountsView>(apiUrl, '/v1/accounts')
  const base = view.accounts.find((a) => a.enabled)
  if (!base) throw new Error('the world has no account in service')
  const accounts = [...seeded(base, count), ...view.accounts.filter((a) => !a.enabled)]
  const health = seededHealth(
    view,
    accounts.filter((a) => a.enabled).map((a) => a.id),
  )
  await page.route('**/v1/accounts', (route) => route.fulfill({ json: { ...view, accounts, health } }))
  return accounts.filter((a) => a.enabled)
}

for (const count of [1, 3, 8]) {
  test.describe(`${count} account${count === 1 ? '' : 's'}`, () => {
    for (const scheme of ['dark', 'light'] as const) {
      test(`reads well at 1800x1200, ${scheme}`, async ({ page, apiUrl }) => {
        await page.emulateMedia({ colorScheme: scheme })
        const accounts = await mockAccounts(page, apiUrl, count)
        await page.goto('/accounts')
        await expect(page.getByRole('heading', { level: 1, name: 'Accounts' })).toBeVisible()
        await expect(page.getByTestId('page-purpose')).toHaveText(
          'Will each subscription be full at its reset, and if not, why?',
        )
        for (const account of accounts) {
          const panel = page.getByRole('article', { name: `Account ${account.id}` })
          await expect(panel).toBeVisible()
          await expect(panel.getByTestId('forecast')).toHaveText(/(Full |Ends at |No forecast|At its weekly limit)/)
          await expect(panel.getByRole('group', { name: `Steer ${account.id}` })).toBeVisible()
        }
        await expect(page.getByRole('list', { name: 'Order in the bulk lane' }).getByRole('listitem')).toHaveCount(
          accounts.length,
        )
        // nothing reaches past the viewport, whatever the count
        const past = await page.evaluate(
          `[...document.querySelectorAll('main *')].filter((el) => !el.closest('.sr-only') && el.getBoundingClientRect().right > window.innerWidth + 1).slice(0, 5).map((el) => el.tagName + '.' + String(el.className).slice(0, 60))`,
        )
        expect(past).toEqual([])
        await page.waitForLoadState('networkidle')
        await page.screenshot({
          path: join(OUT, `accounts-${count}-${scheme}.png`),
          fullPage: true,
          animations: 'disabled',
        })
      })
    }
  })
}

test.describe('logins', () => {
  test('each machine shows its line with the date and days left; a warn marks the strip chip; the card header lists no Issue', async ({
    page,
    apiUrl,
  }) => {
    await page.emulateMedia({ colorScheme: 'dark' })
    const accounts = await mockAccounts(page, apiUrl, 3)
    const first = accounts[0]
    if (!first) throw new Error('no account in service')
    await page.goto('/accounts')
    const panel = page.getByRole('article', { name: `Account ${first.id}` })
    const logins = panel.getByRole('region', { name: 'Logins' })
    await expect(logins.getByRole('listitem')).toHaveCount(3)
    await expect(logins.getByRole('listitem').filter({ hasText: 'Login' }).first()).toContainText(
      /Ends .* · 6\.9 d left/,
    )
    await expect(logins.getByText('No quota sample for 7 h (token rejected?)')).toBeVisible()
    await expect(logins.getByText(/Valid until .* · 9 d left/)).toBeVisible()
    // an account whose logins are all fine shows its lines and no mark on the strip
    const second = accounts[1]
    if (!second) throw new Error('no second account')
    const other = page.getByRole('article', { name: `Account ${second.id}` }).getByRole('region', { name: 'Logins' })
    await expect(other.getByRole('listitem')).toHaveCount(2)
    await expect(page.getByTestId('strip-login')).toHaveCount(1)
    // the second account has a lead running: its header says how many seats are taken and names no Issue
    const header = page.getByRole('article', { name: `Account ${second.id}` }).locator('header')
    await expect(header).toContainText('1 of 3 leads allowed')
    await expect(header).not.toContainText('Issue')
    await page.waitForLoadState('networkidle')
    await page.screenshot({ path: join(OUT, 'accounts-logins-dark.png'), fullPage: true, animations: 'disabled' })
  })
})

test.describe('narrower viewports', () => {
  for (const { name, viewport } of [
    { name: '1280x800', viewport: { width: 1280, height: 800 } },
    { name: '390x844', viewport: { width: 390, height: 844 } },
  ]) {
    test(`3 accounts stay inside ${name}`, async ({ page, apiUrl }) => {
      await page.emulateMedia({ colorScheme: 'dark' })
      await page.setViewportSize(viewport)
      await mockAccounts(page, apiUrl, 3)
      await page.goto('/accounts')
      await expect(page.getByRole('heading', { level: 1, name: 'Accounts' })).toBeVisible()
      await expect(page.getByRole('article')).toHaveCount(3)
      const past = await page.evaluate(
        `[...document.querySelectorAll('main *')].filter((el) => !el.closest('.sr-only') && el.getBoundingClientRect().right > window.innerWidth + 1).slice(0, 5).map((el) => el.tagName + '.' + String(el.className).slice(0, 60))`,
      )
      expect(past).toEqual([])
      await page.waitForLoadState('networkidle')
      await page.screenshot({ path: join(OUT, `accounts-3-${name}-dark.png`), animations: 'disabled' })
    })
  }
})

test.describe('steering', () => {
  test('a mode set on the page shows in claude-account mode and in the next rank, and its clear removes it', async ({
    page,
    apiUrl,
  }) => {
    const view = await api<AccountsView>(apiUrl, '/v1/accounts')
    const id = view.accounts.find((a) => a.enabled)?.id
    if (!id) throw new Error('the world has no account in service')
    const modeOf = async () =>
      (
        (await claudeAccount(['mode'])) as {
          accounts: { id: string; kind: string; source: string; why: string | null }[]
        }
      ).accounts.find((a) => a.id === id)
    const reasonOf = async () =>
      (
        (await claudeAccount(['rank', '--lane', 'bulk'])) as { order: { account: string; reason: string }[] }
      ).order.find((o) => o.account === id)?.reason
    try {
      expect((await modeOf())?.kind).toBe('normal')
      expect(await reasonOf()).not.toBe('drain')

      await page.goto('/accounts')
      const panel = page.getByRole('article', { name: `Account ${id}` })
      await panel.getByRole('button', { name: `Fill first ${id}` }).click()
      await expect(panel.getByText('Fill first', { exact: true }).first()).toBeVisible()
      await expect(panel.getByText(/until the reset, .* · Set by hand/)).toBeVisible()

      await expect.poll(async () => (await modeOf())?.kind).toBe('drain')
      expect(await modeOf()).toMatchObject({ source: 'override', why: 'set in the Console' })
      expect(await reasonOf()).toBe('drain')
      // the strip beside the numbers
      await expect(page.getByTestId('strip-mode').first()).toHaveText('Fill first')

      await panel.getByRole('button', { name: `Back to normal ${id}` }).click()
      await expect(panel.getByRole('button', { name: `Back to normal ${id}` })).toBeHidden()
      await expect.poll(async () => (await modeOf())?.kind).toBe('normal')
      expect(await reasonOf()).not.toBe('drain')
      await expect(page.getByTestId('strip-mode')).toHaveCount(0)
    } finally {
      await api(apiUrl, `/v1/accounts/${id}/mode`, undefined, 'DELETE').catch(() => undefined)
    }
  })

  test('a refusal shows the API words on the panel', async ({ page, apiUrl }) => {
    const view = await api<AccountsView>(apiUrl, '/v1/accounts')
    const id = view.accounts.find((a) => a.enabled)?.id
    if (!id) throw new Error('the world has no account in service')
    await page.goto('/accounts')
    const panel = page.getByRole('article', { name: `Account ${id}` })
    await panel.getByLabel(`Model to hold ${id} for`).fill('')
    await panel.getByRole('button', { name: `Hold for a model ${id}` }).click()
    await expect(panel.getByRole('alert')).toHaveText('Name the model to hold the account for.')
  })
})
