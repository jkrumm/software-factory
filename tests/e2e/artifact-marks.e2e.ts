import type { Frame, Page } from '@playwright/test'
import { expect, test } from './fixtures.ts'
import { api } from './seed.ts'

/**
 * A new comment marks its passage in the artifact, in a Markdown page and in an HTML artifact's frame: at once, after the
 * server has it and the page has read it back, after a reload, and a click on the mark opens the comment. The passages are
 * the shapes a Spec has besides a plain paragraph (a table row, a list item with code, a link and emphasis, a name with an
 * accent): the server decides which comments are anchored from the source, so a shape its text model does not know would
 * list the comment under Unanchored and take its mark away at the read-back.
 */
test.describe.configure({ mode: 'serial' })

interface Passage {
  /** the element that is selected, as a CSS selector of the page's own tags, and the text it holds */
  tag: string
  key: string
  comment: string
}

const MARKDOWN = `# Queue notes

## Order

The queue drains oldest first, and a retry goes to the back of it.

## Options

| Option | Cost | Note |
|-|-|-|
| Fair queue | low cost | one lane for all |
| Priority lane | high cost | two lanes, a starved one |

## Steps

- First step **matters** most and holds \`retry\` apart
- Second step reads [the wait rule](https://example.com/wait) before it runs
${Array.from({ length: 24 }, (_, i) => `\nLine ${i} of the notes, only here to make the page scroll.`).join('\n')}
`

const HTML = `<!doctype html><html><head><title>Queue notes</title></head><body><main><h1>Queue notes</h1>
<h2>Order</h2>
<p>The queue drains oldest first, and a retry goes to the back of it.</p>
<h2>Options</h2>
<table><thead><tr><th>Option</th><th>Cost</th><th>Note</th></tr></thead><tbody>
<tr><td>Fair queue</td><td>low cost</td><td>one lane for all</td></tr>
<tr><td>Priority lane</td><td>high cost</td><td>two lanes, a starved one</td></tr>
</tbody></table>
<h2>Steps</h2>
<ul><li>First step <strong>matters</strong> most and holds <code>retry</code> apart</li>
<li>Second step reads <a href="https://example.com/wait">the wait rule</a> before it runs</li></ul>
<p>The caf&eacute; owner says na&iuml;ve &check; is fine.</p>
${Array.from({ length: 24 }, (_, i) => `<p>Line ${i} of the notes, only here to make the page scroll.</p>`).join('\n')}
</main></body></html>`

const COMMON: Passage[] = [
  { tag: 'p', key: 'The queue drains oldest first', comment: 'Is a retry fair to the rest?' },
  { tag: 'tr', key: 'Priority lane', comment: 'Why two lanes?' },
  { tag: 'li', key: 'First step', comment: 'What does retry hold apart?' },
  { tag: 'li', key: 'Second step', comment: 'Where is the wait rule?' },
]
const MARKDOWN_PASSAGES = COMMON
const HTML_PASSAGES: Passage[] = [...COMMON, { tag: 'p', key: 'The café owner', comment: 'Who is the owner?' }]

/** A line that makes a fixture new on every run: filing the same content again is a replay onto the same artifact. */
const unique = () => `Run ${Date.now()}-${Math.random().toString(36).slice(2, 8)}.`

/** Selects the contents of the first `tag` that holds `key`, under `root`, as a drag over it would. */
const SELECT = (root: string, { tag, key }: Passage) => `(() => {
  const el = [...${root}.querySelectorAll(${JSON.stringify(tag)})].find((e) => e.textContent.includes(${JSON.stringify(key)}))
  if (!el) return false
  const range = document.createRange()
  range.selectNodeContents(el)
  el.scrollIntoView({ block: 'center' })
  const selection = getSelection()
  selection.removeAllRanges()
  selection.addRange(range)
  return true
})()`

/** The painted passages of a highlight, their whitespace folded. */
const PAINTED = (name: string) =>
  `[...(CSS.highlights.get(${JSON.stringify(name)}) ?? [])].map((range) => range.toString().replace(/\\s+/g, ' ').trim())`

/** A point on the painted passage that holds `key`, and its edges, in the viewport of its page or frame. */
const SPOT = (name: string, key: string) => `(() => {
  const range = [...CSS.highlights.get(${JSON.stringify(name)})].find((r) => r.toString().includes(${JSON.stringify(key)}))
  range.startContainer.parentElement.scrollIntoView({ block: 'center' })
  const r = range.getBoundingClientRect()
  const line = range.getClientRects()[0] ?? r
  return { x: line.left + Math.min(12, line.width / 2), y: line.top + line.height / 2 }
})()`

const comments = (page: Page) => page.getByRole('complementary', { name: 'Comments' })
const card = (page: Page, text: string) => comments(page).getByRole('listitem').filter({ hasText: text })
const editForm = (page: Page) => comments(page).getByRole('form', { name: 'Edit comment' })

async function file(apiUrl: string, title: string, content: string, contentFormat: 'markdown' | 'html') {
  const made = await api<{ artifact: { id: string } }>(apiUrl, '/v1/artifacts', {
    repo: 'ember',
    title,
    content,
    contentFormat,
  })
  return made.artifact.id
}

/** Makes the comment through the box, with the write held for a second so the pending state is seen too. */
async function comment(page: Page, where: Page | Frame, root: string, passage: Passage) {
  const composer = page.getByRole('form', { name: 'Comment on the selection' })
  // a frame's annotator loads after its text is written: a selection made before it listens is made again
  await expect(async () => {
    expect(await where.evaluate(SELECT(root, passage))).toBe(true)
    await expect(composer).toBeVisible({ timeout: 1500 })
  }).toPass({ timeout: 20_000 })
  await composer.getByRole('textbox', { name: 'Comment' }).fill(passage.comment)
  await composer.getByRole('button', { name: 'Add comment' }).click()
  await expect(composer).toBeHidden()
}

/** Every passage commented so far is marked: one mark each, the one of `key` among them. */
async function expectMarked(where: Page | Frame, name: string, passages: readonly Passage[]) {
  await expect
    .poll(async () => {
      const painted = await where.evaluate<string[]>(PAINTED(name))
      const missing = passages.filter((p) => !painted.some((text) => text.includes(p.key))).map((p) => p.key)
      return { marks: painted.length, missing, painted: missing.length > 0 ? painted : [] }
    })
    .toEqual({ marks: passages.length, missing: [], painted: [] })
}

/** The comments, one after the other: each is marked at once, and still after the server has it and the page has read it back. */
async function commentOnEach(
  page: Page,
  where: Page | Frame,
  root: string,
  name: string,
  passages: readonly Passage[],
) {
  await page.route('**/v1/artifacts/*/annotations', async (route) => {
    if (route.request().method() !== 'POST') return route.continue()
    await new Promise((resolve) => setTimeout(resolve, 1000))
    return route.continue()
  })
  for (const [i, passage] of passages.entries()) {
    await comment(page, where, root, passage)
    const done = passages.slice(0, i + 1)
    await expectMarked(where, name, done)
    await expect(card(page, passage.comment)).toBeVisible()
    await expect(card(page, passage.comment)).not.toContainText('Sending', { timeout: 8000 })
    await expect(comments(page).locator('li[data-annotation^="pending:"]')).toHaveCount(0)
    // the artifact has been read again, and the server's comment is on the text: its mark holds
    await expectMarked(where, name, done)
  }
  await page.unroute('**/v1/artifacts/*/annotations')
}

test('Markdown: a new comment marks its passage at once, after the read-back and after a reload, and the mark opens it', async ({
  page,
  apiUrl,
}) => {
  const id = await file(apiUrl, 'Queue notes, Markdown', `${MARKDOWN}\n\n${unique()}`, 'markdown')
  await page.goto(`/artifacts/${id}`)
  await expect(page.getByRole('heading', { level: 1, name: 'Queue notes, Markdown' })).toBeVisible()

  const root = "document.querySelector('.artifact-prose')"
  await commentOnEach(page, page, root, 'annotation', MARKDOWN_PASSAGES)

  await page.reload()
  await expect(card(page, MARKDOWN_PASSAGES.at(0)?.comment ?? '')).toBeVisible()
  await expectMarked(page, 'annotation', MARKDOWN_PASSAGES)

  for (const passage of MARKDOWN_PASSAGES) {
    const at = await page.evaluate<{ x: number; y: number }>(SPOT('annotation', passage.key))
    // the smooth scroll of a card is not in play here: the passage is brought to the middle at once
    await page.waitForTimeout(500)
    const spot = await page.evaluate<{ x: number; y: number }>(SPOT('annotation', passage.key))
    await page.mouse.click(spot.x || at.x, spot.y || at.y)
    await expect(editForm(page).getByRole('textbox', { name: 'Comment' })).toHaveValue(passage.comment)
    // the passage clicked is the one painted as active
    await expect
      .poll(async () => (await page.evaluate<string[]>(PAINTED('annotation-active'))).join('|'))
      .toContain(passage.key)
    await page.keyboard.press('Escape')
    await expect(editForm(page)).toBeHidden()
  }
})

test('HTML: a new comment marks its passage at once, after the read-back and after a reload, and the mark opens it', async ({
  page,
  apiUrl,
}) => {
  const id = await file(apiUrl, 'Queue notes, HTML', HTML.replace('</main>', `<p>${unique()}</p></main>`), 'html')
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
  await commentOnEach(page, frame, 'document.body', 'factory', HTML_PASSAGES)

  await page.reload()
  await expect(card(page, HTML_PASSAGES.at(0)?.comment ?? '')).toBeVisible()
  frame = await frameOf()
  await expectMarked(frame, 'factory', HTML_PASSAGES)

  const iframe = page.locator('iframe[title="Artifact"]')
  for (const passage of HTML_PASSAGES) {
    await frame.evaluate(SPOT('factory', passage.key))
    await page.waitForTimeout(800)
    const [spot, box] = await Promise.all([
      frame.evaluate<{ x: number; y: number }>(SPOT('factory', passage.key)),
      iframe.boundingBox(),
    ])
    if (!box) throw new Error('no frame box')
    const at = { x: box.x + spot.x, y: box.y + spot.y }
    // the frame reads the point on each mouse move, so a move made before it was ready is made again
    await expect(async () => {
      await page.mouse.move(at.x - 3, at.y)
      await page.mouse.move(at.x, at.y)
      expect(await frame.evaluate('document.documentElement.style.cursor')).toBe('pointer')
    }).toPass({ timeout: 20_000 })
    await page.mouse.click(at.x, at.y)
    await expect(editForm(page).getByRole('textbox', { name: 'Comment' })).toHaveValue(passage.comment)
    await expect
      .poll(async () => (await frame.evaluate<string[]>(PAINTED('factory-active'))).join('|'))
      .toContain(passage.key)
    await page.keyboard.press('Escape')
    await expect(editForm(page)).toBeHidden()
  }
})
