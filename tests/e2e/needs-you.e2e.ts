import { join } from 'node:path'
import type { Page } from '@playwright/test'
import { readState, statePathOf } from '../scenarios/fakes/hc-state.ts'
import { sessionOf } from '../scenarios/flow.ts'
import { expect, test } from './fixtures.ts'
import { api, holdSignal } from './seed.ts'

/**
 * The Needs you screen against the real server whose leads are real sessions of the fake `hc` (seed.ts): what the owner
 * answers in the Console is read back from the API, and what the lead hears from the fake terminal it was typed into.
 * The seed holds two of each kind, one to read and one to settle, and the files run in this order (`needs-you`,
 * `screenshots`, `shell`), so what is settled here leaves enough for the others (the shell tests want more than one need).
 */
interface Need {
  kind: 'decision' | 'review' | 'errand' | 'held_signal'
  id: string
  title: string
  repo: string | null
}

const needs = async (apiUrl: string): Promise<Need[]> => (await api<{ items: Need[] }>(apiUrl, '/v1/needs')).items

async function needNamed(apiUrl: string, title: string): Promise<Need> {
  const found = (await needs(apiUrl)).find((need) => need.title.includes(title))
  if (!found) throw new Error(`nothing waits on the owner called "${title}"`)
  return found
}

const card = (page: Page, title: string) => page.locator('article').filter({ hasText: title })

async function open(page: Page, title: string) {
  await page.goto('/needs-you')
  await card(page, title).getByRole('button').first().click()
  await expect(card(page, title).getByRole('button').first()).toHaveAttribute('aria-expanded', 'true')
}

test('a card header and the other pressable controls show a pointer, and the card reacts to hover', async ({
  page,
}) => {
  await page.goto('/needs-you')
  const header = card(page, 'Which logging library').getByRole('button').first()
  await expect(header).toHaveCSS('cursor', 'pointer')
  const surface = card(page, 'Which logging library')
  const before = await surface.evaluate(
    (node) => node.ownerDocument.defaultView?.getComputedStyle(node).backgroundColor,
  )
  await header.hover()
  await expect(surface).not.toHaveCSS('background-color', before)
  await expect(page.getByRole('button', { name: 'Open command palette' })).toHaveCSS('cursor', 'pointer')
})

test('the list groups what waits and the open cards show everything the owner decides on, with no id on screen', async ({
  page,
  apiUrl,
}) => {
  const all = await needs(apiUrl)
  await page.goto('/needs-you')
  for (const heading of ['Decisions', 'Reviews', 'Errands', 'Held signals']) {
    await expect(page.getByRole('heading', { level: 2, name: new RegExp(`^${heading}`) })).toBeVisible()
  }
  await expect(card(page, 'Which logging library').getByText('Waiting 2 hours')).toBeVisible()
  const everything = async () => {
    const text = await page.locator('body').innerText()
    expect(text).not.toMatch(/issue_\d+|lead-\d+|#\d+/)
    expect(text).not.toMatch(/\b(decision|errand|artifact|signal|issue)_[a-z0-9]+/)
    for (const need of all) expect(text).not.toContain(need.id)
  }
  await everything()

  await open(page, 'Which logging library')
  const decision = card(page, 'Which logging library')
  await expect(decision.getByText('Recommended', { exact: true })).toBeVisible()
  await expect(decision.getByText('pino', { exact: true }).first()).toBeVisible()
  await expect(decision.getByText('one dependency, fast to swap later')).toBeVisible()
  await expect(decision.getByText('heavier, with more moving parts')).toBeVisible()
  await expect(decision.getByText('Not reversible', { exact: true })).toBeVisible()
  await expect(decision.getByText('The lead logs to the console until someone answers.')).toBeVisible()
  await expect(decision.getByText(/In \d+ hours?, if nobody answers:/)).toBeVisible()
  await everything()

  await open(page, 'The queue spec')
  const review = card(page, 'The queue spec')
  await expect(review.getByText('Spec', { exact: true })).toBeVisible()
  await expect(review.getByText('We keep the queue in Postgres.')).toBeVisible()
  await everything()

  await open(page, 'Rotate the argo deploy key')
  await expect(card(page, 'Rotate the argo deploy key').getByText(/Settings > Keys > Rotate/)).toBeVisible()
  await everything()

  const held = all.find((need) => need.kind === 'held_signal')
  if (!held) throw new Error('no held signal is seeded')
  await open(page, held.title)
  await expect(
    card(page, held.title)
      .getByText(held.repo ?? 'App feedback')
      .first(),
  ).toBeVisible()
  await everything()
})

test('an answer from the Console reaches the lead as its next turn', async ({ page, apiUrl }) => {
  const need = await needNamed(apiUrl, 'How long should argo keep audit rows')
  const before = await api<{ issueId: string; status: string }>(apiUrl, `/v1/decisions/${need.id}`)
  expect(before.status).toBe('open')

  await open(page, 'How long should argo keep audit rows')
  await card(page, 'How long should argo keep audit rows')
    .getByRole('button', { name: 'Take the recommendation' })
    .click()
  await expect(page.getByRole('status').filter({ hasText: 'Sent to the lead' })).toBeVisible()
  await expect(card(page, 'How long should argo keep audit rows')).toHaveCount(0)

  const after = await api<{ status: string; answer: string; settledBy: string }>(apiUrl, `/v1/decisions/${need.id}`)
  expect(after).toMatchObject({ status: 'answered', answer: '90 days', settledBy: 'owner' })
  expect(await api<{ state: string }>(apiUrl, `/v1/issues/${before.issueId}`)).toMatchObject({ state: 'working' })

  // the leads' loop delivers the note: the answer is typed into the lead's own terminal, once
  await api(apiUrl, '/v1/loops/leads/run', {})
  await api(apiUrl, '/v1/loops/leads/run', {})
  const state = readState(statePathOf(join(requireBin(), 'calls.jsonl')))
  const lead = Object.values(state.terminals).find(
    (terminal) => terminal.labels['factory.key'] === sessionOf(before.issueId),
  )
  const heard = (lead?.sent ?? []).filter((text) => text.includes('90 days'))
  expect(heard).toHaveLength(1)
})

function requireBin(): string {
  const bin = process.env.E2E_WORLD_BIN
  if (!bin) throw new Error('E2E_WORLD_BIN is not set: the global setup starts the world')
  return bin
}

test('a deep link opens the item expanded and focused; the ntfy link lands on the same; a settled one says so', async ({
  page,
  apiUrl,
}) => {
  const errand = await needNamed(apiUrl, 'Rotate the argo deploy key')
  const expanded = () => card(page, 'Rotate the argo deploy key').getByRole('button').first()

  await page.goto(`/needs-you?item=${errand.id}`)
  await expect(expanded()).toHaveAttribute('aria-expanded', 'true')
  await expect(expanded()).toBeFocused()
  await expect(card(page, 'Rotate the argo deploy key').getByText(/Settings > Keys > Rotate/)).toBeVisible()

  await page.goto(`/checkpoints/${errand.id}`)
  await expect(page).toHaveURL(new RegExp(`/needs-you\\?item=${errand.id}$`))
  await expect(expanded()).toHaveAttribute('aria-expanded', 'true')

  await page.goto('/needs-you?item=errand_gone')
  await expect(page.getByText('That one is already settled.')).toBeVisible()
  await page.getByRole('link', { name: 'Back to the list' }).click()
  await expect(page).toHaveURL(/\/needs-you$/)
  await expect(page.getByText('That one is already settled.')).toHaveCount(0)
})

test('a held signal dismissed with a reason leaves Needs you and stays on record', async ({ page, apiUrl }) => {
  // its own signal, so the held ones the other tests settle are left alone
  await holdSignal(apiUrl, 'The footer link is dead', 'dismissal')
  const held = await needNamed(apiUrl, 'The footer link is dead')
  await open(page, held.title)
  const signal = card(page, held.title)
  await expect(signal.getByRole('button', { name: 'Dismiss' })).toBeDisabled()
  await signal.getByLabel('Reason').fill('Not a real complaint')
  await signal.getByRole('button', { name: 'Dismiss' }).click()
  await expect(page.getByRole('status').filter({ hasText: 'Dismissed' })).toBeVisible()
  expect((await needs(apiUrl)).map((need) => need.id)).not.toContain(held.id)
  const { signals } = await api<{
    signals: { id: string; dismissedReason: string | null; dismissedBy: string | null }[]
  }>(apiUrl, '/v1/signals?state=dismissed')
  expect(signals.find((s) => s.id === held.id)).toMatchObject({
    dismissedReason: 'Not a real complaint',
    dismissedBy: 'owner',
  })
})

test('a held signal with a markdown fence shows no fence', async ({ page, apiUrl }) => {
  await api(apiUrl, '/signals', {
    from: 'feedback:fencedapp',
    title: 'The export crashes',
    text: 'It said:\n```ts\nthrow new Error("boom")\n```\nafter I clicked.',
  })
  const held = await needNamed(apiUrl, 'The export crashes')
  await open(page, held.title)
  const signal = card(page, held.title)
  await expect(signal.getByText('throw new Error("boom")')).toBeVisible()
  expect(await signal.innerText()).not.toContain('```')
  await signal.getByLabel('Reason').fill('Test signal')
  await signal.getByRole('button', { name: 'Dismiss' }).click()
  await expect(page.getByRole('status').filter({ hasText: 'Dismissed' })).toBeVisible()
})

test('an Errand done, a held signal promoted and a verdict each move the API state', async ({ page, apiUrl }) => {
  // Errand
  const errand = await needNamed(apiUrl, 'Plug in the test phone')
  await open(page, 'Plug in the test phone')
  await card(page, 'Plug in the test phone').getByLabel('Note').fill('Done, it passed')
  await card(page, 'Plug in the test phone').getByRole('button', { name: 'Done' }).click()
  await expect(page.getByRole('status').filter({ hasText: 'Sent to the lead' })).toBeVisible()
  const { errands } = await api<{ errands: { id: string; doneAt: string | null; doneNote: string | null }[] }>(
    apiUrl,
    '/v1/errands',
  )
  expect(errands.find((e) => e.id === errand.id)).toMatchObject({ doneNote: 'Done, it passed' })
  expect(errands.find((e) => e.id === errand.id)?.doneAt).not.toBeNull()

  // Held signal (app feedback names no repo: the owner does)
  const held = (await needs(apiUrl)).find((need) => need.kind === 'held_signal')
  if (!held) throw new Error('no held signal is left')
  await open(page, held.title)
  const signal = card(page, held.title)
  if (held.repo === null) {
    await expect(signal.getByRole('button', { name: 'Promote' })).toBeDisabled()
    await signal.getByLabel('Repository').fill('argo')
  }
  await signal.getByRole('button', { name: 'Promote' }).click()
  await expect(page.getByRole('status').filter({ hasText: 'Promoted' })).toBeVisible()
  const { signals } = await api<{ signals: { id: string; state: string }[] }>(apiUrl, '/v1/signals?state=promoted')
  expect(signals.map((s) => s.id)).toContain(held.id)

  // Verdict
  const review = await needNamed(apiUrl, 'The cache spec')
  await open(page, 'The cache spec')
  const spec = card(page, 'The cache spec')
  await expect(spec.getByText('We cache reads for ten seconds.')).toBeVisible()
  await expect(spec.getByRole('link', { name: 'Open the full page' })).toBeVisible()
  expect(await spec.innerText()).not.toContain('<!doctype')
  await expect(spec.getByRole('button', { name: 'With notes' })).toBeDisabled()
  await expect(spec.getByRole('button', { name: 'Changes' })).toBeDisabled()
  await spec.getByLabel('Note for the verdict').fill('Fine as it is')
  await expect(spec.getByRole('button', { name: 'With notes' })).toBeEnabled()
  await spec.getByRole('button', { name: 'Looks good' }).click()
  await expect(page.getByRole('status').filter({ hasText: 'Sent to the lead' })).toBeVisible()
  const detail = await api<{ verdicts: { verdict: string; note: string | null }[] }>(
    apiUrl,
    `/v1/artifacts/${review.id}`,
  )
  expect(detail.verdicts).toMatchObject([{ verdict: 'looks_good', note: 'Fine as it is' }])
})

test('a comment on a review is kept and shown, and the review stays on the list', async ({ page, apiUrl }) => {
  const review = await needNamed(apiUrl, 'The queue spec')
  await open(page, 'The queue spec')
  const spec = card(page, 'The queue spec')
  const add = spec.getByRole('button', { name: 'Add comment' })
  await expect(add).toBeDisabled()
  await spec.getByLabel('Passage').fill('One advisory lock guards the pass')
  await spec.getByLabel('Comment', { exact: true }).fill('Name the lock.')
  await add.click()
  await expect(spec.getByText('Comment saved')).toBeVisible()
  await expect(spec.getByText('Name the lock.')).toBeVisible()
  const detail = await api<{ annotations: { comment: string; author: string }[] }>(apiUrl, `/v1/artifacts/${review.id}`)
  expect(detail.annotations).toMatchObject([{ comment: 'Name the lock.', author: 'owner' }])
  await expect(card(page, 'The queue spec')).toHaveCount(1)
})

test('an answer someone else gave first says so and the card leaves', async ({ page, apiUrl }) => {
  const decision = await needNamed(apiUrl, 'Which cache store')
  await open(page, 'Which cache store')
  // answered elsewhere just before the Console's own answer arrives (the CLI, the lead's other channel)
  await page.route(`**/v1/decisions/${decision.id}/answer`, async (route) => {
    await api(apiUrl, `/v1/decisions/${decision.id}/answer`, { answer: 'redis' })
    await route.continue()
  })
  await card(page, 'Which cache store').getByRole('button', { name: 'Take the recommendation' }).click()
  await expect(page.getByRole('status').filter({ hasText: 'Already settled elsewhere' })).toBeVisible()
  await expect(card(page, 'Which cache store')).toHaveCount(0)
  expect(await api<{ answer: string }>(apiUrl, `/v1/decisions/${decision.id}`)).toMatchObject({ answer: 'redis' })
})

test.describe('nothing waits', () => {
  test.use({ serviceWorkers: 'block' })

  // `page.route` stands in for an empty server: the shared world holds the other tests' items, and this is the screen's
  // reading of a valid empty NeedsModel.
  test('the empty state shows', async ({ page }) => {
    await page.route('**/v1/needs', (route) =>
      route.fulfill({
        json: {
          at: new Date().toISOString(),
          items: [],
          counts: { decision: 0, review: 0, errand: 0, held_signal: 0 },
        },
      }),
    )
    await page.goto('/needs-you')
    await expect(page.getByText('Nothing waits on you')).toBeVisible()
    await expect(page.locator('article')).toHaveCount(0)
  })
})

test('a write the allow-list refuses stays refused through the listener, and a cross-site answer too', async ({
  playwright,
  consoleUrl,
}) => {
  const owner = await playwright.request.newContext({ baseURL: consoleUrl })
  for (const path of ['/v1/issues', '/v1/issues/issue_1/cancel', '/v1/issues/issue_1/ask']) {
    expect((await owner.post(path, { data: {} })).status(), path).toBe(405)
  }
  const cross = await owner.post('/v1/decisions/decision_x/answer', {
    data: { answer: 'x' },
    headers: { 'Sec-Fetch-Site': 'cross-site' },
  })
  expect(cross.status()).toBe(403)
  await owner.dispose()
})
