import type { Frame, Page } from '@playwright/test'
import { expect, test } from './fixtures.ts'
import { api } from './seed.ts'

/**
 * A comment hangs on the occurrence the owner selected, not on the first place its text occurs: the same sentence stands
 * under three headings, the second and the third are commented, and after a reload each is painted, scrolled to and opened
 * at its own place, in a Markdown page and in an HTML artifact's frame.
 */
test.describe.configure({ mode: 'serial' })

const SENTENCE = 'The cache is warmed before the first request arrives.'
const HEADINGS = ['First', 'Second', 'Third']
const filler = (heading: string) =>
  Array.from(
    { length: 24 },
    (_, i) => `Line ${i} of the ${heading.toLowerCase()} section, only here to make the page scroll.`,
  )

const MARKDOWN = ['# Warm-up notes', ...HEADINGS.flatMap((h) => [`## ${h}`, SENTENCE, ...filler(h)])].join('\n\n')
const HTML = `<!doctype html><html><head><title>Warm-up notes</title></head><body><h1>Warm-up notes</h1>${HEADINGS.map(
  (h) =>
    `<h2>${h}</h2><p>${SENTENCE}</p>${filler(h)
      .map((line) => `<p>${line}</p>`)
      .join('')}`,
).join('')}</body></html>`

/** Selects the n-th (0-based) text node that holds the sentence, under `root`, in a page or a frame. */
const SELECT_NTH = (root: string, n: number) => `(() => {
  const walker = document.createTreeWalker(${root}, NodeFilter.SHOW_TEXT)
  let seen = 0
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const at = node.data.indexOf(${JSON.stringify(SENTENCE)})
    if (at === -1) continue
    if (seen++ !== ${n}) continue
    const range = document.createRange()
    range.setStart(node, at)
    range.setEnd(node, at + ${JSON.stringify(SENTENCE)}.length)
    node.parentElement.scrollIntoView({ block: 'center' })
    const selection = getSelection()
    selection.removeAllRanges()
    selection.addRange(range)
    return true
  }
  return false
})()`

/** The headings the ranges of a highlight sit under. */
const UNDER = (name: string) => `[...(CSS.highlights.get(${JSON.stringify(name)}) ?? [])].map((range) => {
  for (let e = range.startContainer.parentElement.closest('p'); e; e = e.previousElementSibling) if (e.tagName === 'H2') return e.textContent
  return null
})`

/** The viewport rect of the first range of a highlight, in the page or frame it is painted in. */
const RECT_OF = (name: string) => `(() => {
  const range = [...(CSS.highlights.get(${JSON.stringify(name)}) ?? [])][0]
  const r = range.getBoundingClientRect()
  return { top: r.top, bottom: r.bottom, left: r.left, width: r.width, height: r.height, viewport: innerHeight }
})()`

/** Where the second painted passage of a highlight is: a point on it, and its edges, in the viewport of its page or frame. */
const SPOT = (name: string) => `(() => {
  const r = [...CSS.highlights.get(${JSON.stringify(name)})][1].getBoundingClientRect()
  return { x: r.left + 12, y: r.top + r.height / 2, top: r.top, bottom: r.bottom, viewport: innerHeight }
})()`

interface Spot {
  x: number
  y: number
  top: number
  bottom: number
  viewport: number
}

/** The spot once a smooth scroll has stopped with it in view: a click made while it moves lands beside the passage. */
async function stillInView(measure: () => Promise<Spot>): Promise<Spot> {
  let last = await measure()
  await expect
    .poll(async () => {
      const now = await measure()
      const still = now.top === last.top
      last = now
      return still && now.top >= 0 && now.bottom <= now.viewport
    })
    .toBe(true)
  return last
}

const region = (page: Page, name: string) => page.getByRole('region', { name, exact: true })
const card = (page: Page, text: string) => region(page, 'On the text').getByRole('listitem').filter({ hasText: text })

interface Detail {
  annotations: {
    quote: string
    occurrence: number | null
    prefix: string | null
    suffix: string | null
    comment: string
  }[]
}

async function file(
  apiUrl: string,
  title: string,
  content: string,
  contentFormat: 'markdown' | 'html',
): Promise<string> {
  const made = await api<{ artifact: { id: string } }>(apiUrl, '/v1/artifacts', {
    repo: 'ember',
    title,
    content,
    contentFormat,
  })
  return made.artifact.id
}

async function comment(page: Page, where: Page | Frame, root: string, n: number, text: string) {
  const composer = page.getByRole('form', { name: 'Comment on the selection' })
  // a frame's annotator loads after its text is written: a selection made before it listens is made again
  await expect(async () => {
    expect(await where.evaluate(SELECT_NTH(root, n))).toBe(true)
    await expect(composer).toBeVisible({ timeout: 1500 })
  }).toPass({ timeout: 20_000 })
  await composer.getByRole('textbox', { name: 'Comment' }).fill(text)
  await composer.getByRole('button', { name: 'Add comment' }).click()
  await expect(composer).toBeHidden()
}

test('Markdown: a comment on the second and on the third occurrence stays on each after a reload', async ({
  page,
  apiUrl,
}) => {
  const id = await file(apiUrl, 'Warm-up notes, Markdown', MARKDOWN, 'markdown')
  await page.goto(`/artifacts/${id}`)
  await expect(page.getByRole('heading', { level: 1, name: 'Warm-up notes, Markdown' })).toBeVisible()

  await comment(page, page, "document.querySelector('.artifact-prose')", 1, 'About the second one.')
  await expect(card(page, 'About the second one.')).toBeVisible()
  await comment(page, page, "document.querySelector('.artifact-prose')", 2, 'About the third one.')
  await expect(card(page, 'About the third one.')).toBeVisible()

  // the API holds which occurrence each is, and the text around it
  await expect
    .poll(async () => (await api<Detail>(apiUrl, `/v1/artifacts/${id}`)).annotations.map((a) => a.occurrence).sort())
    .toEqual([1, 2])
  const stored = (await api<Detail>(apiUrl, `/v1/artifacts/${id}`)).annotations
  for (const a of stored) expect(a.prefix?.length).toBeGreaterThan(0)

  await page.reload()
  await expect(card(page, 'About the third one.')).toBeVisible()
  await expect.poll(() => page.evaluate(UNDER('annotation'))).toEqual(['Second', 'Third'])

  // a click on a card scrolls its own passage into view and paints it as the one in focus
  await card(page, 'About the third one.').getByRole('button').first().click()
  await expect.poll(() => page.evaluate(UNDER('annotation-active'))).toEqual(['Third'])
  await expect
    .poll(async () => {
      const r = await page.evaluate<{ top: number; bottom: number; viewport: number }>(RECT_OF('annotation-active'))
      return r.top >= 0 && r.bottom <= r.viewport
    })
    .toBe(true)
  await card(page, 'About the second one.').getByRole('button').first().click()
  await expect.poll(() => page.evaluate(UNDER('annotation-active'))).toEqual(['Second'])

  // a click on the third passage opens the third comment, not the first one with the same words
  await page.evaluate(
    `[...CSS.highlights.get('annotation')][1].startContainer.parentElement.scrollIntoView({ block: 'center' })`,
  )
  const at = await stillInView(() => page.evaluate<Spot>(SPOT('annotation')))
  await page.mouse.click(at.x, at.y)
  const form = page.getByRole('complementary', { name: 'Comments' }).getByRole('form', { name: 'Edit comment' })
  await expect(form.getByRole('textbox', { name: 'Comment' })).toHaveValue('About the third one.')
})

test('HTML: a comment on the second and on the third occurrence stays on each after a reload', async ({
  page,
  apiUrl,
}) => {
  const id = await file(apiUrl, 'Warm-up notes, HTML', HTML, 'html')
  // the frame is a navigation of its own: once the service worker controls the page, it must not answer it with the app shell
  await page.goto('/needs-you')
  await page.evaluate('navigator.serviceWorker.ready.then(() => true)')
  await page.reload()
  await expect.poll(() => page.evaluate('navigator.serviceWorker.controller !== null')).toBe(true)

  const frameOf = async (): Promise<Frame> => {
    const frame = await (await page.locator('iframe[title="Artifact"]').elementHandle())?.contentFrame()
    if (!frame) throw new Error('no frame')
    return frame
  }
  await page.goto(`/artifacts/${id}`)
  let frame = await frameOf()
  await comment(page, frame, 'document.body', 1, 'About the second one.')
  await expect(card(page, 'About the second one.')).toBeVisible()
  await comment(page, frame, 'document.body', 2, 'About the third one.')
  await expect(card(page, 'About the third one.')).toBeVisible()
  await expect
    .poll(async () => (await api<Detail>(apiUrl, `/v1/artifacts/${id}`)).annotations.map((a) => a.occurrence).sort())
    .toEqual([1, 2])

  await page.reload()
  await expect(card(page, 'About the third one.')).toBeVisible()
  frame = await frameOf()
  await expect.poll(() => frame.evaluate(UNDER('factory'))).toEqual(['Second', 'Third'])

  await card(page, 'About the third one.').getByRole('button').first().click()
  await expect.poll(() => frame.evaluate(UNDER('factory-active'))).toEqual(['Third'])
  await expect
    .poll(async () => {
      const r = await frame.evaluate<{ top: number; bottom: number; viewport: number }>(RECT_OF('factory-active'))
      return r.top >= 0 && r.bottom <= r.viewport
    })
    .toBe(true)
  await card(page, 'About the second one.').getByRole('button').first().click()
  await expect.poll(() => frame.evaluate(UNDER('factory-active'))).toEqual(['Second'])

  // a click on the third passage in the frame opens the third comment
  await frame.evaluate(
    "[...CSS.highlights.get('factory')][1].startContainer.parentElement.scrollIntoView({ block: 'center' })",
  )
  const at = await stillInView(() => frame.evaluate<Spot>(SPOT('factory')))
  const box = await page.locator('iframe[title="Artifact"]').boundingBox()
  if (!box) throw new Error('no frame box')
  await page.mouse.click(box.x + at.x, box.y + at.y)
  const form = page.getByRole('complementary', { name: 'Comments' }).getByRole('form', { name: 'Edit comment' })
  await expect(form.getByRole('textbox', { name: 'Comment' })).toHaveValue('About the third one.')
})
