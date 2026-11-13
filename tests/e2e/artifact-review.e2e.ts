import { join } from 'node:path'
import type { Page, Route } from '@playwright/test'
import { expect, test } from './fixtures.ts'
import { api } from './seed.ts'
import { EXTERNAL_URL, REVIEW_QUOTE, type SeededArtifacts } from './seed-artifacts.ts'

/**
 * Reviewing an artifact (Issue 966), at 1800x1200 against the seeded server: a comment shows at once and survives a slow or
 * failed write, a click on a highlight opens its comment, links work (inside the frame too), the table of contents follows
 * the reader, and every verdict says what it does. The Spec `review` is long, with one link of each kind; `links` is an
 * HTML Report with the same.
 */
test.describe.configure({ mode: 'serial' })

const seeded = (): SeededArtifacts => JSON.parse(process.env.E2E_ARTIFACTS ?? '{}') as SeededArtifacts
const OUT = join(import.meta.dir, 'out', 'screenshots')

const comments = (page: Page) => page.getByRole('complementary', { name: 'Comments' })
const card = (page: Page, text: string) => comments(page).getByRole('listitem').filter({ hasText: text })
const contents = (page: Page) => page.getByRole('navigation', { name: 'Contents' })

/** Selects the first text node that contains `text`, in the page. */
const SELECT = (text: string) => `(() => {
  const walker = document.createTreeWalker(document.querySelector('.artifact-prose'), NodeFilter.SHOW_TEXT)
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const at = node.data.indexOf(${JSON.stringify(text)})
    if (at === -1) continue
    const range = document.createRange()
    range.setStart(node, at)
    range.setEnd(node, at + ${JSON.stringify(text)}.length)
    node.parentElement.scrollIntoView({ block: 'center' })
    const selection = getSelection()
    selection.removeAllRanges()
    selection.addRange(range)
    return true
  }
  return false
})()`

/** The scroll container of the document in the page: the nearest ancestor of the prose that scrolls on its own. */
const SCROLLER = `(() => {
  for (let el = document.querySelector('.artifact-prose').parentElement; el; el = el.parentElement) {
    const overflow = getComputedStyle(el).overflowY
    if ((overflow === 'auto' || overflow === 'scroll') && el.scrollHeight > el.clientHeight) return el
  }
  return document.scrollingElement
})()`

const annotations = (apiUrl: string, id: string, passages: Array<[quote: string, comment: string, path: string]>) =>
  passages.reduce(
    (done, [quote, comment, path]) =>
      done.then(() => api(apiUrl, `/v1/artifacts/${id}/annotations`, { revision: 1, quote, path, comment })),
    Promise.resolve<unknown>(undefined),
  )

const ANNOTATIONS = '**/v1/artifacts/*/annotations'

test('a comment shows at once while the write takes 3 s, and is kept when the write fails', async ({
  page,
  apiUrl,
}) => {
  const { review } = seeded()
  await page.goto(`/artifacts/${review}`)
  await expect(page.locator('main header').getByRole('heading', { level: 1, name: 'Weather rollout' })).toBeVisible()

  // the write is held for 3 s: the comment must not wait for it
  let sent = 0
  await page.route(ANNOTATIONS, async (route: Route) => {
    if (route.request().method() !== 'POST') return route.continue()
    sent += 1
    await new Promise((resolve) => setTimeout(resolve, 3000))
    return route.continue()
  })
  await page.evaluate(SELECT(REVIEW_QUOTE))
  const composer = page.getByRole('form', { name: 'Comment on the selection' })
  await composer.getByRole('textbox', { name: 'Comment' }).fill('Ten minutes is long for a storm.')
  // timed inside the page, so the test's own round trips do not count against the 100 ms
  const ms = (await page.evaluate(`(async () => {
    const button = [...document.querySelectorAll('button')].find((b) => b.textContent === 'Add comment')
    const start = performance.now()
    button.click()
    await new Promise((resolve) => {
      const look = () =>
        document.querySelector('aside[aria-label="Comments"] li[data-annotation^="pending:"]')
          ? resolve()
          : requestAnimationFrame(look)
      look()
    })
    return performance.now() - start
  })()`)) as number
  expect(ms).toBeLessThan(100)
  const mine = card(page, 'Ten minutes is long for a storm.')
  await expect(mine).toContainText('Sending')
  // painted in the document too, and the box is gone
  await expect
    .poll(() => page.evaluate("[...(CSS.highlights.get('annotation') ?? [])].map((range) => range.toString())"))
    .toContain(REVIEW_QUOTE)
  await expect(composer).toBeHidden()
  await expect(mine).not.toContainText('Sending', { timeout: 8000 })
  expect(sent).toBe(1)
  await expect
    .poll(async () =>
      (await api<{ annotations: { comment: string }[] }>(apiUrl, `/v1/artifacts/${review}`)).annotations.map(
        (a) => a.comment,
      ),
    )
    .toContain('Ten minutes is long for a storm.')
  await page.unroute(ANNOTATIONS)

  // a write that fails keeps the words, says so, and goes through on retry
  let attempts = 0
  await page.route(ANNOTATIONS, (route) => {
    if (route.request().method() !== 'POST') return route.continue()
    attempts += 1
    return attempts === 1 ? route.abort('failed') : route.continue()
  })
  const general = page.getByRole('textbox', { name: 'General comment' })
  await general.fill('Who owns the cache?')
  await page.getByRole('button', { name: 'Add general comment' }).click()
  await expect(general).toHaveValue('')
  const lost = card(page, 'Who owns the cache?')
  await expect(lost).toBeVisible()
  await expect(lost.getByRole('alert')).toContainText('Could not send')
  await expect(lost.getByRole('button', { name: 'Retry' })).toBeVisible()
  await lost.getByRole('button', { name: 'Retry' }).click()
  await expect(lost.getByRole('alert')).toHaveCount(0)
  await expect
    .poll(async () =>
      (await api<{ annotations: { comment: string }[] }>(apiUrl, `/v1/artifacts/${review}`)).annotations.map(
        (a) => a.comment,
      ),
    )
    .toContain('Who owns the cache?')
  expect(attempts).toBe(2)
  await page.unroute(ANNOTATIONS)
})

test('edit and delete show at once too, and a failed delete comes back with a retry', async ({ page, apiUrl }) => {
  const { review } = seeded()
  await annotations(apiUrl, review, [
    ['Paragraph 1 on the options', 'An edit to make.', 'Weather rollout > Options'],
    ['Paragraph 1 on the proof', 'A comment to delete.', 'Weather rollout > Proof'],
  ])
  await page.goto(`/artifacts/${review}`)
  await expect(card(page, 'An edit to make.')).toBeVisible()

  const slow = '**/v1/artifacts/*/annotations/*'
  await page.route(slow, async (route) => {
    if (route.request().method() === 'PATCH') await new Promise((resolve) => setTimeout(resolve, 3000))
    return route.continue()
  })
  const edited = card(page, 'An edit to make.')
  await edited.getByRole('button', { name: 'Edit comment' }).click()
  const form = comments(page).getByRole('form', { name: 'Edit comment' })
  await form.getByRole('textbox', { name: 'Comment' }).fill('Edited, and shown before the server knows.')
  await form.getByRole('button', { name: 'Save' }).click()
  const now = card(page, 'Edited, and shown before the server knows.')
  await expect(now).toContainText('Sending', { timeout: 100 })
  await expect(now).not.toContainText('Sending', { timeout: 8000 })
  await page.unroute(slow)

  // the delete fails once: the card leaves at once and comes back with its reason
  let tries = 0
  await page.route(slow, (route) => {
    if (route.request().method() !== 'DELETE') return route.continue()
    tries += 1
    return tries === 1 ? route.abort('failed') : route.continue()
  })
  const doomed = card(page, 'A comment to delete.')
  await doomed.getByRole('button', { name: 'Delete comment' }).click()
  await doomed.getByRole('button', { name: 'Delete', exact: true }).click()
  await expect(doomed.getByRole('alert')).toContainText('Could not delete')
  await doomed.getByRole('button', { name: 'Retry' }).click()
  await expect(doomed).toHaveCount(0)
  expect(tries).toBe(2)
  await page.unroute(slow)
})

test('a click on a highlight opens its comment in edit mode and brings it into view', async ({ page, apiUrl }) => {
  const { review } = seeded()
  // enough comments that the last one is below the fold of the comments column
  const quotes = [
    'Paragraph 2 on the context',
    'Paragraph 3 on the context',
    'Paragraph 4 on the context',
    'Paragraph 2 on the options',
    'Paragraph 3 on the options',
    'Paragraph 4 on the options',
    'Paragraph 2 on the risks',
    'Paragraph 3 on the risks',
    'Paragraph 2 on the proof',
    'Paragraph 3 on the proof',
    'Paragraph 2 on the rollout',
    'Paragraph 3 on the rollout',
    'Paragraph 4 on the open questions',
  ]
  await annotations(
    apiUrl,
    review,
    quotes.map((quote, i): [string, string, string] => [
      quote,
      `Seeded comment ${i + 1}.`,
      'Weather rollout > Options',
    ]),
  )
  await page.goto(`/artifacts/${review}`)
  const last = card(page, 'Seeded comment 13.')
  await expect(last).toBeVisible()
  await expect(last).not.toBeInViewport()

  // bring the passage under the pointer and click it
  await page.evaluate(`(() => {
    const [range] = [...CSS.highlights.get('annotation')].filter((r) => r.toString() === ${JSON.stringify(quotes.at(-1))})
    range.startContainer.parentElement.scrollIntoView({ block: 'center' })
  })()`)
  const point = await page.evaluate(`(() => {
    const [range] = [...CSS.highlights.get('annotation')].filter((r) => r.toString() === ${JSON.stringify(quotes.at(-1))})
    const r = range.getBoundingClientRect()
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
  })()`)
  const { x, y } = point as { x: number; y: number }
  await expect.poll(() => page.evaluate(`document.querySelector('.artifact-prose').style.cursor`)).toBe('')
  await page.mouse.move(x, y)
  await expect.poll(() => page.evaluate(`document.querySelector('.artifact-prose').style.cursor`)).toBe('pointer')
  await page.mouse.click(x, y)

  const form = comments(page).getByRole('form', { name: 'Edit comment' })
  await expect(form).toBeVisible()
  await expect(form.getByRole('textbox', { name: 'Comment' })).toHaveValue('Seeded comment 13.')
  await expect(form.getByRole('textbox', { name: 'Comment' })).toBeFocused()
  await expect(form).toBeInViewport()
  // the passage is painted as the one in focus, and the document did not jump away from it
  await expect
    .poll(() => page.evaluate("[...(CSS.highlights.get('annotation-active') ?? [])].map((range) => range.toString())"))
    .toEqual([quotes.at(-1)])
  await page.keyboard.press('Escape')
  await expect(form).toBeHidden()

  // and the other way: a click on a card brings its passage to the middle of the document
  await card(page, 'Seeded comment 1.').getByRole('button').first().click()
  await expect
    .poll(() =>
      page.evaluate(`(() => {
        const [range] = [...CSS.highlights.get('annotation-active')]
        const r = range.getBoundingClientRect()
        return r.top > 0 && r.bottom < innerHeight
      })()`),
    )
    .toBe(true)
})

test('a card does not repeat the document name, and says what each earlier comment became', async ({
  page,
  apiUrl,
}) => {
  const { review } = seeded()
  await annotations(apiUrl, review, [['Paragraph 2 on the rollout', 'Where is the path?', 'Weather rollout > Rollout']])
  await page.goto(`/artifacts/${review}`)
  const withPath = card(page, 'Where is the path?')
  await expect(withPath).toContainText('Rollout')
  await expect(withPath).not.toContainText('Weather rollout')
  for (const text of await comments(page).getByRole('listitem').allInnerTexts())
    expect(text).not.toContain('Weather rollout')
})

test('every verdict says what it does to the lead, and where verdicts go', async ({ page }) => {
  const { review } = seeded()
  await page.goto(`/artifacts/${review}`)
  await page.getByRole('button', { name: 'Give your verdict' }).click()
  const group = page.getByRole('group', { name: 'Verdict' })
  for (const [name, line] of [
    ['Looks good', 'The lead builds as written.'],
    ['With notes', 'The lead builds and applies your comments.'],
    ['Changes', 'The lead revises and resubmits before building.'],
    ['No longer applies', 'The lead drops this artifact and goes on.'],
  ] as const) {
    await expect(group.getByRole('button', { name })).toBeVisible()
    await expect(group.getByRole('button', { name })).toHaveAccessibleDescription(line)
    await expect(group.getByText(line)).toBeVisible()
  }
  await expect(page.getByText("also feed the weekly retro's taste pass")).toBeVisible()
  await expect(page.getByRole('button', { name: 'What Taste pass means' })).toBeVisible()
})

test('links in Markdown: an anchor scrolls the document, a web link opens a tab, a Console link opens its page', async ({
  page,
  context,
}) => {
  const { review, spec } = seeded()
  await context.route(EXTERNAL_URL, (route) =>
    route.fulfill({ contentType: 'text/html', body: '<title>WeatherOrb V2</title>' }),
  )
  await page.goto(`/artifacts/${review}`)
  const prose = page.locator('.artifact-prose')

  const risks = prose.locator('h2#risks')
  await expect(risks).toBeAttached()
  await expect(risks).not.toBeInViewport()
  await prose.getByRole('link', { name: 'the risks' }).click()
  await expect(risks).toBeInViewport()
  await expect
    .poll(() => page.evaluate(`document.querySelector('#risks').getBoundingClientRect().top < 300`))
    .toBe(true)
  expect(new URL(page.url()).hash).toBe('')
  await page.evaluate(`${SCROLLER}.scrollTo(0, 0)`)

  const [tab] = await Promise.all([
    context.waitForEvent('page'),
    prose.getByRole('link', { name: 'WeatherOrb V2' }).click(),
  ])
  await tab.waitForLoadState()
  expect(tab.url()).toBe(EXTERNAL_URL)
  expect(await tab.evaluate('window.opener')).toBeNull()
  await tab.close()

  // a link with no destination here is not a link
  await expect(prose.getByRole('link', { name: 'vault note' })).toHaveCount(0)
  await expect(prose.locator('span[title^="No page for"]', { hasText: 'vault note' })).toBeVisible()

  await prose.getByRole('link', { name: 'storage spec' }).click()
  await expect(page).toHaveURL(new RegExp(`/artifacts/${spec}$`))
  await expect(page.getByRole('heading', { level: 1, name: 'The storage spec' })).toBeVisible()
})

test('links in an HTML artifact work through the page: the frame has no network', async ({ page, context }) => {
  const { links } = seeded()
  await context.route(EXTERNAL_URL, (route) =>
    route.fulfill({ contentType: 'text/html', body: '<title>WeatherOrb V2</title>' }),
  )
  await page.goto(`/artifacts/${links}`)
  const frame = page.frameLocator('iframe[title="Artifact"]')
  await expect(frame.getByRole('heading', { level: 1, name: 'Link report' })).toBeVisible()
  const origin = page.url()
  const inner = page.frames().find((f) => f.url().endsWith('/frame.html'))
  if (!inner) throw new Error('no frame')
  await expect.poll(() => inner.evaluate('scrollY')).toBe(0)

  const [tab] = await Promise.all([context.waitForEvent('page'), frame.locator('#external').click()])
  await tab.waitForLoadState()
  expect(tab.url()).toBe(EXTERNAL_URL)
  expect(await tab.evaluate('window.opener')).toBeNull()
  await tab.close()
  expect(page.url()).toBe(origin)

  await frame.locator('#anchor').click()
  await expect.poll(() => inner.evaluate('scrollY')).toBeGreaterThan(600)
  expect(page.url()).toBe(origin)

  await frame.locator('#page').click()
  await expect(page).toHaveURL(/\/issues\/1$/)
})

test('the contents list the headings, mark the section in view while scrolling, and jump', async ({ page }) => {
  const { review } = seeded()
  await page.goto(`/artifacts/${review}`)
  const nav = contents(page)
  await expect(nav).toBeVisible()
  const names = ['Weather rollout', 'Context', 'Options', 'Risks', 'Proof', 'Rollout', 'Open questions']
  for (const name of names) await expect(nav.getByRole('button', { name, exact: true })).toBeVisible()
  const current = nav.locator('[aria-current="location"]')
  await expect(current).toHaveText('Weather rollout')

  // a third of the right column: the comments keep the other two thirds
  const [t, c] = [await nav.boundingBox(), await comments(page).boundingBox()]
  if (!t || !c) throw new Error('no boxes')
  expect(Math.abs(c.width - 2 * t.width)).toBeLessThanOrEqual(2)
  expect(Math.abs(t.x + t.width - c.x)).toBeLessThanOrEqual(1)

  // scrolling the document moves the mark
  await page.evaluate(
    `(() => { const top = ${SCROLLER}.getBoundingClientRect().top; ${SCROLLER}.scrollTop += document.querySelector('#proof').getBoundingClientRect().top - top - 8 })()`,
  )
  await expect(current).toHaveText('Proof')
  await page.evaluate(`${SCROLLER}.scrollTo(0, 0)`)
  await expect(current).toHaveText('Weather rollout')

  // a click on an entry scrolls to its heading, and the mark follows
  await nav.getByRole('button', { name: 'Open questions', exact: true }).click()
  await expect(page.locator('h2#open-questions')).toBeInViewport()
  await expect(current).toHaveText('Open questions')

  await page.screenshot({ path: join(OUT, 'review-after-xl.png'), animations: 'disabled' })
})

test('the contents of an HTML artifact follow the frame, and jump in it', async ({ page }) => {
  const { links } = seeded()
  await page.goto(`/artifacts/${links}`)
  const nav = contents(page)
  await expect(nav.getByRole('button', { name: 'Later', exact: true })).toBeVisible()
  const current = nav.locator('[aria-current="location"]')
  await expect(current).toHaveText('Link report')
  await nav.getByRole('button', { name: 'Later', exact: true }).click()
  await expect(current).toHaveText('Later')
  const inner = page.frames().find((f) => f.url().endsWith('/frame.html'))
  if (!inner) throw new Error('no frame')
  await expect.poll(() => inner.evaluate('scrollY')).toBeGreaterThan(600)
  await inner.evaluate('scrollTo(0, 0)')
  await expect(current).toHaveText('Link report')
})

test('below 1800 px the comments keep the column and the contents fold into a bar under the header', async ({
  page,
}) => {
  const { review } = seeded()
  await page.setViewportSize({ width: 1400, height: 900 })
  await page.goto(`/artifacts/${review}`)
  const bar = page.getByRole('button', { name: /^Contents/ })
  await expect(bar).toBeVisible()
  await expect(bar).toHaveAttribute('aria-expanded', 'false')
  await expect(comments(page)).toBeVisible()
  const box = await comments(page).boundingBox()
  expect(box?.width).toBeGreaterThanOrEqual(380)
  expect(box?.width).toBeLessThanOrEqual(388)
  await bar.click()
  await contents(page).getByRole('button', { name: 'Proof', exact: true }).click()
  await expect(page.locator('h2#proof')).toBeInViewport()
})
