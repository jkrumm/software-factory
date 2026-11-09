import { join } from 'node:path'
import { SQL } from 'bun'
import type { Locator, Page } from '@playwright/test'
import { SinceModel } from '@software-factory/contract'
import { bearer } from '../scenarios/harness.ts'
import { expect, test } from './fixtures.ts'
import { expectHint } from './hints.ts'
import { api } from './seed.ts'
import { seedSince, type SeededSince } from './seed-since.ts'

/**
 * "Since you were here" on Needs you, on a seeded history (seed-since.ts: events before and after a visit moment, planted
 * when this file starts so no earlier spec sees them). Every figure on the band is compared with a count this file takes
 * from the event log and the tables by SQL, never from `GET /v1/since`. The file runs after the others (`shell*`), which
 * leave a Decision, a review, an Errand and held signals on the list for the deep links and the screenshots.
 */
const OUT = join(import.meta.dir, 'out', 'screenshots', 'console-needs-you')
const HALF_HOUR_MS = 30 * 60_000

let sql: SQL
let seed: SeededSince
let visit: Date

test.beforeAll(async () => {
  const url = process.env.E2E_DATABASE_URL
  if (!url) throw new Error('E2E_DATABASE_URL is not set: the global setup starts the database')
  sql = new SQL(url, { max: 2 })
  seed = await seedSince(sql)
  visit = new Date(seed.visit)
})

test.afterAll(async () => {
  await sql.close()
})

const keys = ['shipped', 'failed', 'dropped', 'judge', 'screen', 'filed', 'incidents'] as const
type Key = (typeof keys)[number]

/** What the event log and the tables hold after `since`, counted the way the band names each figure. */
async function expectedCounts(since: Date): Promise<Record<Key, number>> {
  const one = async (rows: Promise<{ n: number }[]>): Promise<number> => (await rows)[0]?.n ?? 0
  const events = (where: SQL.Query<unknown>) =>
    one(
      sql`SELECT count(DISTINCT issue_id)::int AS n FROM factory.issue_events WHERE result = 'applied' AND at > ${since} AND ${where}`,
    )
  const signals = await one(
    sql`SELECT count(*)::int AS n FROM factory.intake_signals WHERE dismissed_by = 'judge' AND dismissed_at > ${since}`,
  )
  const errands = await one(sql`SELECT count(*)::int AS n FROM factory.errands WHERE turned_away_at > ${since}`)
  return {
    shipped: await events(sql`kind = 'watch_passed'`),
    failed: await events(sql`kind = 'regressed'`),
    dropped: await events(sql`kind = 'closed' AND outcome = 'dropped'`),
    judge: await one(
      sql`SELECT count(DISTINCT issue_id)::int AS n FROM factory.decisions WHERE settled_by = 'judge' AND answered_at > ${since}`,
    ),
    screen: signals + errands,
    filed: await events(sql`kind = 'filed'`),
    incidents: await one(sql`SELECT count(*)::int AS n FROM factory.intake_incidents WHERE opened_at > ${since}`),
  }
}

/** Issues filed after `since`, by the origin their filed event carries. */
async function expectedOrigins(since: Date): Promise<Record<string, number>> {
  const rows = await sql`SELECT payload->>'origin' AS origin, count(DISTINCT issue_id)::int AS n
    FROM factory.issue_events WHERE kind = 'filed' AND result = 'applied' AND at > ${since} GROUP BY 1`
  return Object.fromEntries(rows.map((row: { origin: string; n: number }) => [row.origin, row.n]))
}

const ORIGIN_WORD: Record<string, string> = {
  you: 'you',
  application: 'application',
  infrastructure: 'infrastructure',
  github: 'GitHub',
  feedback: 'feedback',
  factory: 'factory',
}

/**
 * The owner read that registers a visit, then the marker set by SQL to a visit that began at `seed.visit` and was seen a
 * moment ago: the next owner read is inside that visit, so its band begins at the seeded moment. (The rule that a read
 * after 30 quiet minutes starts a new visit has its own test.)
 */
async function arm(apiUrl: string): Promise<void> {
  await api(apiUrl, '/v1/since')
  await sql`INSERT INTO factory.console_visit (id, seen_at, since_at) VALUES (true, now(), ${visit})
    ON CONFLICT (id) DO UPDATE SET seen_at = EXCLUDED.seen_at, since_at = EXCLUDED.since_at`
}

async function marker(): Promise<{ seen: Date; since: Date }> {
  const rows = await sql`SELECT seen_at, since_at FROM factory.console_visit`
  return { seen: rows[0].seen_at, since: rows[0].since_at }
}

const band = (page: Page) => page.getByRole('region', { name: 'Since you were here' })
const category = (page: Page, key: Key) => band(page).locator(`[data-category="${key}"]`)

/** Opens the "N more" fold of a category, when the newest three do not hold everything it listed. */
async function reveal(box: Locator): Promise<void> {
  for (const fold of await box.getByRole('button', { name: /^\d+ more/ }).all()) {
    if ((await fold.getAttribute('aria-expanded')) === 'false') await fold.click()
  }
}

const issueHref = (issue: string) => `/issues/${issue.replace('issue_', '')}`

async function openBand(page: Page, apiUrl: string): Promise<void> {
  await arm(apiUrl)
  await page.goto('/needs-you')
  await expect(band(page)).toBeVisible()
  await expect(band(page).locator('time').first()).toHaveAttribute('datetime', visit.toISOString())
}

test('every figure on the band equals the count in the event log since the visit, and nothing from before it', async ({
  page,
  apiUrl,
}) => {
  await openBand(page, apiUrl)
  const expected = await expectedCounts(visit)
  // the band shows the seeded history alone
  expect(expected).toMatchObject({ shipped: 2, failed: 1, dropped: 1, judge: 1, screen: 2, filed: 5, incidents: 1 })

  for (const key of keys) {
    await expect(category(page, key).locator('span').first(), key).toHaveText(String(expected[key]))
  }
  // the same events counted over the whole log are more: the ones before the visit are left out
  const overall = await expectedCounts(new Date(0))
  for (const key of ['shipped', 'failed', 'dropped', 'judge', 'screen', 'filed', 'incidents'] as const) {
    expect(overall[key], key).toBeGreaterThan(expected[key])
  }

  // New Issues: the by-origin words equal the filed events by origin
  const origins = await expectedOrigins(visit)
  expect(Object.values(origins).reduce((sum, n) => sum + n, 0)).toBe(expected.filed)
  expect(Object.keys(origins).length).toBeGreaterThanOrEqual(4)
  const breakdown = category(page, 'filed').locator('p').nth(1)
  for (const [origin, n] of Object.entries(origins)) {
    await expect(breakdown).toContainText(`${n} ${ORIGIN_WORD[origin] ?? origin}`)
  }

  // the items link to their Issue pages; the Issues from before the visit appear nowhere
  const links = async (key: Key) => {
    await reveal(category(page, key))
    return category(page, key).locator('a')
  }
  for (const issue of seed.after.shipped)
    await expect((await links('shipped')).and(page.locator(`[href="${issueHref(issue)}"]`))).toHaveCount(1)
  await expect((await links('failed')).and(page.locator(`[href="${issueHref(seed.after.failed)}"]`))).toHaveCount(1)
  await expect((await links('dropped')).and(page.locator(`[href="${issueHref(seed.after.dropped)}"]`))).toHaveCount(1)
  await expect((await links('judge')).and(page.locator(`[href="${issueHref(seed.after.judge)}"]`))).toHaveCount(1)
  await expect((await links('screen')).and(page.locator(`[href="${issueHref(seed.after.screen)}"]`))).toHaveCount(1)
  await expect((await links('incidents')).and(page.locator(`[href="${issueHref(seed.after.incident)}"]`))).toHaveCount(
    1,
  )
  await expect(category(page, 'screen').getByText('The status page flickers')).toBeVisible()
  await expect(category(page, 'judge').getByText('Keep the banner for one week?')).toBeVisible()
  await expect(category(page, 'shipped').getByText('Show the retention banner')).toBeVisible()
  await expect(category(page, 'shipped').getByRole('link', { name: 'Show the retention banner' })).toHaveAttribute(
    'href',
    issueHref(seed.after.shipped[0] ?? ''),
  )
  for (const key of keys) await reveal(category(page, key))
  for (const issue of seed.before)
    await expect(band(page).locator(`[href="${issueHref(issue)}"]`), issue).toHaveCount(0)
  await expect(band(page).getByText(/^Early:/)).toHaveCount(0)
  await expect(band(page).getByText('A duplicate complaint')).toHaveCount(0)
  await expect(band(page).getByText('Name the cache after the repo?')).toHaveCount(0)

  // an item opens its Issue page
  await category(page, 'dropped').getByRole('link', { name: 'Drop the legacy importer' }).click()
  await expect(page).toHaveURL(new RegExp(`${issueHref(seed.after.dropped)}$`))
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Drop the legacy importer')
})

test('a second page load inside the visit shows the same band', async ({ page, apiUrl }) => {
  await openBand(page, apiUrl)
  const first = await Promise.all(keys.map((key) => category(page, key).innerText()))
  const started = await marker()
  expect(started.since.toISOString()).toBe(visit.toISOString())

  await page.reload()
  await expect(band(page).locator('time').first()).toHaveAttribute('datetime', visit.toISOString())
  await page.goto('/flow')
  await page.goto('/needs-you')
  await expect(band(page)).toBeVisible()
  expect(await Promise.all(keys.map((key) => category(page, key).innerText()))).toEqual(first)
  const after = await marker()
  expect(after.since.toISOString()).toBe(visit.toISOString())
  expect(after.seen.getTime()).toBeGreaterThanOrEqual(started.seen.getTime())
})

test('Regressed, Dropped, Incidents, and the Judge and the screen, carry an InfoHint with the generated text', async ({
  page,
  apiUrl,
}) => {
  await openBand(page, apiUrl)
  await expectHint(category(page, 'failed'), 'regressed')
  await expectHint(category(page, 'dropped'), 'dropped')
  await expectHint(category(page, 'incidents'), 'incident')
  await expectHint(category(page, 'judge'), 'judge')
  await expectHint(category(page, 'screen'), 'screen')
  await expect(category(page, 'shipped').getByRole('button', { name: /^What / })).toHaveCount(0)
})

test('the visit rule: a read 31 minutes after the last starts a new visit; the read token and an agent move nothing', async ({
  apiUrl,
}) => {
  await arm(apiUrl)
  const get = async (caller: 'owner' | 'read' | 'agent') => {
    const response = await fetch(`${apiUrl}/v1/since`, { headers: bearer(caller) })
    expect(response.status, caller).toBe(200)
    return SinceModel.parse(await response.json())
  }

  // a read inside the armed visit keeps its start
  expect((await get('owner')).since).toBe(visit.toISOString())
  const read = await marker()
  expect(read.since.toISOString()).toBe(visit.toISOString())

  // other callers read from the stored start and write nothing
  for (const caller of ['read', 'agent'] as const) {
    expect((await get(caller)).since, caller).toBe(visit.toISOString())
    const kept = await marker()
    expect(kept.seen.toISOString(), caller).toBe(read.seen.toISOString())
    expect(kept.since.toISOString(), caller).toBe(visit.toISOString())
  }

  // a read within the half hour only moves seen_at
  expect((await get('owner')).since).toBe(visit.toISOString())
  const inside = await marker()
  expect(inside.since.toISOString()).toBe(visit.toISOString())
  expect(inside.seen.getTime()).toBeGreaterThanOrEqual(read.seen.getTime())

  // 31 minutes of quiet: the next read is a new visit that begins where the last one was seen
  const lastSeen = new Date(Date.now() - HALF_HOUR_MS - 60_000)
  await sql`UPDATE factory.console_visit SET seen_at = ${lastSeen}`
  expect((await get('owner')).since).toBe(lastSeen.toISOString())
  expect((await marker()).since.toISOString()).toBe(lastSeen.toISOString())
  await arm(apiUrl)
})

test.describe('the deep link, with the band above it', () => {
  const needsOf = async (apiUrl: string) =>
    (await api<{ items: { id: string; kind: string; title: string }[] }>(apiUrl, '/v1/needs')).items

  async function expectOpenUnderBand(page: Page, title: string): Promise<void> {
    const article = page.locator('article').filter({ hasText: title })
    await expect(article.getByRole('heading').getByRole('link')).toHaveAttribute('aria-current', 'page')
    await expect(band(page)).toBeVisible()
    const above = await band(page).boundingBox()
    const card = await article.boundingBox()
    expect(above && card && above.y < card.y).toBe(true)
  }

  test('/needs-you?item= and /checkpoints/ open the item, also under a filter that would hide it', async ({
    page,
    apiUrl,
  }) => {
    await arm(apiUrl)
    const decision = (await needsOf(apiUrl)).find((item) => item.title.includes('Which logging library'))
    if (!decision) throw new Error('the logging Decision no longer waits')

    await page.goto(`/needs-you?item=${decision.id}`)
    await expectOpenUnderBand(page, 'Which logging library')

    await page.goto(`/checkpoints/${decision.id}`)
    await expect(page).toHaveURL(new RegExp(`/needs-you\\?item=${decision.id}$`))
    await expectOpenUnderBand(page, 'Which logging library')

    // a kind and a project that both leave the Decision out: the deep link still opens it
    await page.goto(`/needs-you?item=${decision.id}&kind=errand&project=chat`)
    await expectOpenUnderBand(page, 'Which logging library')
    await page.goto(`/needs-you?item=${decision.id}&project=chat`)
    await expectOpenUnderBand(page, 'Which logging library')
    await page.goto(`/needs-you?item=${decision.id}&kind=errand`)
    await expectOpenUnderBand(page, 'Which logging library')
    // and without the item the filter hides it
    await page.goto('/needs-you?kind=errand&project=chat')
    await expect(band(page)).toBeVisible()
    await expect(page.locator('article').filter({ hasText: 'Which logging library' })).toHaveCount(0)
  })

  test('a settled id says it is settled, with the band still above', async ({ page, apiUrl }) => {
    await arm(apiUrl)
    expect((await needsOf(apiUrl)).map((item) => item.id)).not.toContain(seed.settledDecision)
    for (const path of [`/needs-you?item=${seed.settledDecision}`, `/checkpoints/${seed.settledDecision}`]) {
      await page.goto(path)
      const notice = page.getByRole('status').filter({ hasText: 'That one is already settled.' })
      await expect(notice).toBeVisible()
      await expect(band(page)).toBeVisible()
      const above = await band(page).boundingBox()
      const note = await notice.boundingBox()
      expect(above && note && above.y < note.y).toBe(true)
    }
  })
})

/**
 * Screenshots of Needs you with the band populated, committed under docs/evidence/console-needs-you (scripts/evidence-console-needs-you.sh
 * copies them from tests/e2e/out/screenshots/console-needs-you). Kept to about 14: the primary viewport shows every screen,
 * the others the ones that differ there.
 */
const SHOTS = [
  {
    variant: 'desktop-xl-dark',
    viewport: { width: 1800, height: 1200 },
    colorScheme: 'dark',
    shots: ['band', 'decision-open', 'errand-open', 'held-open', 'filtered'],
  },
  {
    variant: 'desktop-xl-light',
    viewport: { width: 1800, height: 1200 },
    colorScheme: 'light',
    shots: ['band', 'filtered', 'decision-open'],
  },
  {
    variant: 'desktop-dark',
    viewport: { width: 1280, height: 800 },
    colorScheme: 'dark',
    shots: ['band', 'filtered', 'decision-open'],
  },
  {
    variant: 'phone-dark',
    viewport: { width: 390, height: 844 },
    colorScheme: 'dark',
    shots: ['band', 'band-open', 'filtered', 'decision-open'],
  },
] as const

for (const { variant, viewport, colorScheme, shots } of SHOTS) {
  test.describe(`screenshots ${variant}`, () => {
    test.use({ viewport, colorScheme })

    test('the band, an open Decision, Errand and held signal, and a project filter', async ({ page, apiUrl }) => {
      await arm(apiUrl)
      const { items } = await api<{ items: { id: string; kind: string; title: string; repo: string | null }[] }>(
        apiUrl,
        '/v1/needs',
      )
      const pick = (kind: string, title?: string) => {
        const found = items.find((item) => item.kind === kind && (!title || item.title.includes(title)))
        if (!found) throw new Error(`no ${kind} waits`)
        return found
      }
      const targets = {
        band: '/needs-you',
        'band-open': '/needs-you',
        'decision-open': `/needs-you?item=${pick('decision', 'Which logging library').id}`,
        'errand-open': `/needs-you?item=${pick('errand', 'Rotate the argo deploy key').id}`,
        'held-open': `/needs-you?item=${pick('held_signal').id}`,
        filtered: '/needs-you?project=argo',
      }
      // the owner has been away: the page's clock reads three hours after the seeded visit (Date only; timers and the stream stay real)
      await page.clock.setFixedTime(new Date(Date.now() + 3 * 60 * 60_000))
      for (const name of shots) {
        await page.goto(targets[name])
        await expect(band(page)).toBeVisible()
        await expect(band(page).locator('time').first()).toHaveAttribute('datetime', visit.toISOString())
        await expect(band(page).locator('time').first()).toContainText('3 hours ago')
        // the phone keeps the items in a Fold
        if (name === 'band-open') await band(page).getByRole('button', { name: 'Show what changed' }).click()
        if (name.endsWith('-open') && name !== 'band-open')
          await expect(page.locator('article[data-open="true"]')).toBeVisible()
        await expect(page.getByRole('status').filter({ hasText: 'Live' })).toBeVisible()
        await page.waitForLoadState('networkidle')
        await page.screenshot({ path: join(OUT, `${variant}-${name}.png`), fullPage: true, animations: 'disabled' })
      }
    })
  })
}
