import { join } from 'node:path'
import type { Page } from '@playwright/test'
import { expect, test } from './fixtures.ts'
import { readState, statePathOf } from '../scenarios/fakes/hc-state.ts'
import { sessionOf } from '../scenarios/flow.ts'
import { api } from './seed.ts'
import { DROPPED, KEPT, SPEC_QUOTE, TARGET, type SeededArtifacts } from './seed-artifacts.ts'

const seeded = (): SeededArtifacts => JSON.parse(process.env.E2E_ARTIFACTS ?? '{}') as SeededArtifacts

interface Detail {
  artifact: { title: string; issueId: string; revisions: { n: number }[] }
  annotations: {
    id: string
    quote: string
    path: string | null
    comment: string
    revision: number
    editedAt: string | null
  }[]
  unanchored: { quote: string; path: string | null; comment: string }[]
  verdicts: { revision: number; verdict: string; note: string | null }[]
}
const detail = (apiUrl: string, id: string, revision?: number) =>
  api<Detail>(apiUrl, `/v1/artifacts/${id}${revision ? `?revision=${revision}` : ''}`)

/** Selects the text of the first text node that contains `text`, in a page or a frame. */
const SELECT = (text: string) => `(() => {
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const at = node.data.indexOf(${JSON.stringify(text)})
    if (at === -1) continue
    const range = document.createRange()
    range.setStart(node, at)
    range.setEnd(node, at + ${JSON.stringify(text)}.length)
    const selection = getSelection()
    selection.removeAllRanges()
    selection.addRange(range)
    return true
  }
  return false
})()`

/** The first selection's rect in the viewport of a page or a frame. */
const RECT = `(() => { const r = getSelection().getRangeAt(0).getBoundingClientRect(); return { top: r.top, bottom: r.bottom } })()`

const region = (page: Page, name: string) => page.getByRole('region', { name, exact: true })

test('a Markdown Spec: mark text, comment, see it listed and highlighted, then a verdict the API records', async ({
  page,
  apiUrl,
}) => {
  const { spec } = seeded()
  await page.goto(`/artifacts/${spec}`)
  await expect(page.getByRole('heading', { level: 1, name: 'The storage spec' })).toBeVisible()
  const header = page.locator('main header')
  await expect(header).toContainText('Spec')
  await expect(header).toContainText('Markdown')
  await expect(header).toContainText('Waiting for your verdict')
  expect(await page.locator('body').innerText()).not.toMatch(/artifact_|issue_\d+|lead-\d+|#\d+/)

  // Escape cancels the box, and the same passage can be chosen again
  await page.evaluate(SELECT(SPEC_QUOTE))
  const composer = page.getByRole('form', { name: 'Comment on the selection' })
  await expect(composer).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(composer).toBeHidden()
  await expect.poll(() => page.evaluate('getSelection().isCollapsed')).toBe(true)

  // The box opens in the comments column, level with the passage, and the passage stays painted while it is open.
  await page.evaluate(SELECT(SPEC_QUOTE))
  const passage = (await page.evaluate(RECT)) as { top: number; bottom: number }
  await expect(composer).toBeVisible()
  await expect(composer).toContainText(SPEC_QUOTE)
  const column = await region(page, 'Revision 1').boundingBox()
  const box = await composer.boundingBox()
  if (!column || !box) throw new Error('no boxes')
  expect(box.x).toBeGreaterThanOrEqual(column.x + column.width - 1)
  expect(box.x).toBeGreaterThan(1000)
  expect(box.y).toBeGreaterThanOrEqual(passage.top - 24)
  expect(box.y).toBeLessThanOrEqual(passage.bottom)
  await expect(composer.getByRole('textbox', { name: 'Comment' })).toBeFocused()
  await expect
    .poll(() => page.evaluate("[...(CSS.highlights.get('annotation-pending') ?? [])].map((range) => range.toString())"))
    .toEqual([SPEC_QUOTE])
  await composer.getByRole('textbox', { name: 'Comment' }).fill('Say why not Redis.')
  await composer.getByRole('button', { name: 'Add comment' }).click()

  const listed = region(page, 'On the text')
  await expect(listed).toContainText('Say why not Redis.')
  await expect(listed).toContainText('Queue storage > Options > Cost')
  await expect(composer).toBeHidden()
  await expect
    .poll(() => page.evaluate("[...(CSS.highlights.get('annotation') ?? [])].map((range) => range.toString())"))
    .toEqual([SPEC_QUOTE])
  await expect.poll(() => page.evaluate("CSS.highlights.has('annotation-pending')")).toBe(false)
  await listed.getByRole('button').first().click()

  // a second comment, to be deleted
  const second = 'The cost is one more table.'
  await page.evaluate(SELECT(second))
  await expect(composer).toContainText(second)
  await composer.getByRole('textbox', { name: 'Comment' }).fill('Is one table really the cost?')
  await composer.getByRole('button', { name: 'Add comment' }).click()
  await expect(listed).toContainText('Is one table really the cost?')

  // Edit: only the owner's own comments, in place; Escape keeps the old words; Save shows "edited"
  const item = (text: string) => listed.getByRole('listitem').filter({ hasText: text })
  const mine = item('Say why not Redis.')
  await expect(mine.getByText(/edited/)).toHaveCount(0)
  await mine.getByRole('button', { name: 'Edit comment' }).click()
  const edit = listed.getByRole('form', { name: 'Edit comment' })
  await expect(edit.getByRole('textbox', { name: 'Comment' })).toHaveValue('Say why not Redis.')
  await edit.getByRole('textbox', { name: 'Comment' }).fill('half typed')
  await page.keyboard.press('Escape')
  await expect(edit).toBeHidden()
  await expect(mine).toContainText('Say why not Redis.')
  await mine.getByRole('button', { name: 'Edit comment' }).click()
  // a half-typed edit survives clicking another comment
  await edit.getByRole('textbox', { name: 'Comment' }).fill('Say why not Redis, with the cost.')
  await item('Is one table really the cost?').getByRole('button').first().click()
  await expect(edit.getByRole('textbox', { name: 'Comment' })).toHaveValue('Say why not Redis, with the cost.')
  await edit.getByRole('button', { name: 'Save' }).click()
  await expect(listed).toContainText('Say why not Redis, with the cost.')
  await expect(listed).toContainText('edited')
  await expect(listed).not.toContainText('half typed')
  const edited = await detail(apiUrl, spec)
  expect(edited.annotations.find((a) => a.quote === SPEC_QUOTE)).toMatchObject({
    comment: 'Say why not Redis, with the cost.',
    editedAt: expect.any(String),
  })
  expect(edited.annotations.find((a) => a.quote === second)?.editedAt).toBeNull()

  // Delete: two steps; "Keep" changes nothing
  const doomed = item('Is one table really the cost?')
  await doomed.getByRole('button', { name: 'Delete comment' }).click()
  await expect(doomed).toContainText('Delete comment?')
  await doomed.getByRole('button', { name: 'Keep' }).click()
  await expect(doomed).not.toContainText('Delete comment?')
  await doomed.getByRole('button', { name: 'Delete comment' }).click()
  await doomed.getByRole('button', { name: 'Delete', exact: true }).click()
  await expect(listed).not.toContainText('Is one table really the cost?')
  await expect
    .poll(() => page.evaluate("[...(CSS.highlights.get('annotation') ?? [])].map((range) => range.toString())"))
    .toEqual([SPEC_QUOTE])
  expect((await detail(apiUrl, spec)).annotations.map((a) => a.quote)).toEqual([SPEC_QUOTE])

  await page.getByRole('textbox', { name: 'General comment' }).fill('Overall: good direction.')
  await page.getByRole('button', { name: 'Add general comment' }).click()
  await expect(region(page, 'General')).toContainText('Overall: good direction.')

  const verdict = region(page, 'Verdict')
  await verdict.getByRole('button', { name: 'With notes' }).click()
  await verdict.getByRole('textbox', { name: 'Verdict note' }).fill('Good, but name the lock.')
  await verdict.getByRole('button', { name: 'Send verdict' }).click()
  await expect(verdict).toContainText('With notes')
  await expect(verdict).toContainText('Good, but name the lock.')
  await expect(page.locator('main header')).toContainText('With notes')

  // The API holds both, and the Issue moved on: the verdict ends its wait on the Spec.
  const shown = await detail(apiUrl, spec)
  expect(await api(apiUrl, `/v1/issues/${shown.artifact.issueId}`)).toMatchObject({ state: 'working' })
  const all = [...shown.annotations, ...shown.unanchored]
  expect(all).toHaveLength(2)
  expect(all).toContainEqual(
    expect.objectContaining({
      quote: SPEC_QUOTE,
      path: 'Queue storage > Options > Cost',
      comment: 'Say why not Redis, with the cost.',
    }),
  )
  expect(all).toContainEqual(
    expect.objectContaining({ quote: shown.artifact.title, path: 'global', comment: 'Overall: good direction.' }),
  )
  expect(shown.verdicts).toEqual([
    expect.objectContaining({ revision: 1, verdict: 'with_notes', note: 'Good, but name the lock.' }),
  ])

  // The lead hears it: the leads' loop types the owner's verdict into the lead's own terminal, once.
  await api(apiUrl, '/v1/loops/leads/run', {})
  await api(apiUrl, '/v1/loops/leads/run', {})
  const bin = process.env.E2E_WORLD_BIN
  if (!bin) throw new Error('E2E_WORLD_BIN is not set: the global setup starts the world')
  const state = readState(statePathOf(join(bin, 'calls.jsonl')))
  const lead = Object.values(state.terminals).find(
    (terminal) => terminal.labels['factory.key'] === sessionOf(shown.artifact.issueId),
  )
  const heard = (lead?.sent ?? []).filter((text) => text.includes('Good, but name the lock.'))
  expect(heard).toHaveLength(1)
  expect(heard[0]).toContain('With notes')
  // What the lead reads with `factory artifact show` is the detail: the edited words, never the deleted comment.
  const read = await detail(apiUrl, spec)
  const words = [...read.annotations, ...read.unanchored].map((a) => a.comment)
  expect(words).toContain('Say why not Redis, with the cost.')
  expect(words).not.toContain('Say why not Redis.')
  expect(words).not.toContain('Is one table really the cost?')
})

/** A throwaway server on a free port that counts every request it gets. */
function leakTarget() {
  const hits: string[] = []
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch: (request) => {
      hits.push(`${request.method} ${new URL(request.url).pathname}`)
      return new Response('leak', { headers: { 'access-control-allow-origin': '*' } })
    },
  })
  return { hits, url: `http://127.0.0.1:${server.port}`, stop: () => server.stop(true) }
}

test('the frame document has its own sandboxing policy and the page keeps its own', async ({ request }) => {
  const frame = (await request.get('/frame.html')).headers()['content-security-policy'] ?? ''
  expect(frame).toContain('sandbox allow-scripts')
  expect(frame).toContain("connect-src 'none'")
  expect(frame).not.toContain("default-src 'self'")
  const page = (await request.get('/')).headers()['content-security-policy'] ?? ''
  expect(page).toContain("script-src 'self';")
  expect(page).toContain("frame-src 'self'")
  expect(page).toContain("frame-ancestors 'none'")
  expect(page).not.toContain('sandbox')
})

test.describe('an HTML artifact', () => {
  // page.route does not see a service worker's requests, so the worker is blocked for this one
  test.describe('without the service worker', () => {
    test.use({ serviceWorkers: 'block' })

    test('cannot reach the network or its parent', async ({ page, apiUrl }) => {
      const { report } = seeded()
      const target = leakTarget()
      try {
        // The probe script is seeded with a placeholder; the page gets it with this test's server in its place.
        await page.route(`**/v1/artifacts/${report}*`, async (route) => {
          const response = await route.fetch()
          const body = (await response.json()) as { content: string }
          // also a static meta refresh to the target, one second in: the frame must not follow it
          const refresh = `<meta http-equiv="refresh" content="1;url=${target.url}/refresh">`
          const content = refresh + body.content.replaceAll(TARGET, target.url)
          await route.fulfill({ response, json: { ...body, content } })
        })
        await page.goto(`/artifacts/${report}`)
        const probe = page.frameLocator('iframe[title="Artifact"]').locator('#probe')
        await expect(probe).toContainText('"parent"')
        const result = JSON.parse((await probe.textContent()) ?? '{}') as Record<string, string>
        expect(result.parent).toBe('SecurityError')
        expect(result.open).toBe('null')
        expect(result.fetch).not.toBe('sent')
        expect(result.xhr).not.toBe('sent')
        expect(result.websocket).not.toBe('sent')
        // the probe then navigates the frame away; give every attempt time to arrive
        await page.waitForTimeout(1500)
        expect(target.hits).toEqual([])
        expect(await detail(apiUrl, report)).toMatchObject({ annotations: [], unanchored: [], verdicts: [] })
      } finally {
        await target.stop()
      }
    })
  })

  test('a selection in the frame reaches the Console and can be commented', async ({ page, apiUrl }) => {
    const { report } = seeded()
    // the frame is a navigation of its own: once the service worker controls the page, it must not answer it with the app shell
    await page.goto('/needs-you')
    await page.evaluate('navigator.serviceWorker.ready.then(() => true)')
    await page.reload()
    await expect.poll(() => page.evaluate('navigator.serviceWorker.controller !== null')).toBe(true)
    await page.goto(`/artifacts/${report}`)
    const frame = await (await page.locator('iframe[title="Artifact"]').elementHandle())?.contentFrame()
    if (!frame) throw new Error('no frame')
    const claim = 'The probe ships on Friday and nobody pays for it.'
    await expect.poll(() => frame.evaluate(SELECT(claim))).toBe(true)
    const inFrame = (await frame.evaluate(RECT)) as { top: number; bottom: number }
    const composer = page.getByRole('form', { name: 'Comment on the selection' })
    await expect(composer).toContainText(claim)
    // beside the passage: right of the frame, level with the passage (the frame's rect plus the frame's own position)
    const frameBox = await page.locator('iframe[title="Artifact"]').boundingBox()
    const box = await composer.boundingBox()
    if (!frameBox || !box) throw new Error('no boxes')
    expect(box.x).toBeGreaterThanOrEqual(frameBox.x + frameBox.width - 1)
    expect(box.y).toBeGreaterThanOrEqual(frameBox.y + inFrame.top - 24)
    expect(box.y).toBeLessThanOrEqual(frameBox.y + inFrame.bottom)
    // the frame fills the page's height and width: no box, no border
    expect(frameBox.height).toBeGreaterThan(900)
    expect(frameBox.width).toBeGreaterThan(1100)
    // cancelled, the same passage can be chosen again
    await composer.getByRole('button', { name: 'Cancel' }).click()
    await expect(composer).toBeHidden()
    await expect.poll(() => frame.evaluate('getSelection().isCollapsed')).toBe(true)
    await expect.poll(() => frame.evaluate(SELECT(claim))).toBe(true)
    await expect(composer).toBeVisible()
    await expect(composer).toContainText(claim)
    await composer.getByRole('textbox', { name: 'Comment' }).fill('Who pays on Saturday?')
    await composer.getByRole('button', { name: 'Add comment' }).click()
    await expect(region(page, 'On the text')).toContainText('Who pays on Saturday?')
    await expect.poll(() => frame.evaluate("CSS.highlights.get('factory')?.size ?? 0")).toBe(1)

    const shown = await detail(apiUrl, report)
    expect(shown.annotations).toEqual([
      expect.objectContaining({ quote: claim, path: 'Launch report > Result', comment: 'Who pays on Saturday?' }),
    ])

    // A passage with inline code, an underscore name, an entity and punctuation anchors as the browser shows it.
    const markup = 'Run make, then check snake_case_name \u00b7 see \u00b7 the notes.'
    await expect(composer).toBeHidden()
    await expect.poll(() => frame.evaluate('getSelection().isCollapsed')).toBe(true)
    await frame.evaluate(
      "(() => { const r = document.createRange(); r.selectNodeContents(document.getElementById('markup')); const s = getSelection(); s.removeAllRanges(); s.addRange(r) })()",
    )
    await expect(composer).toContainText(markup)
    await composer.getByRole('textbox', { name: 'Comment' }).fill('Which target?')
    await composer.getByRole('button', { name: 'Add comment' }).click()
    await expect(region(page, 'On the text')).toContainText('Which target?')
    await expect(region(page, 'Unanchored')).toHaveCount(0)
    await expect.poll(() => frame.evaluate("CSS.highlights.get('factory')?.size ?? 0")).toBe(2)
    const both = await detail(apiUrl, report)
    expect(both.unanchored).toEqual([])
    expect(both.annotations.map((a) => a.quote)).toContain(markup)
  })

  test('is not written to by a message of its own', async ({ page, apiUrl }) => {
    const { report } = seeded()
    const before = await detail(apiUrl, report)
    await page.goto(`/artifacts/${report}`)
    await expect(page.getByRole('heading', { level: 1, name: 'The launch report' })).toBeVisible()
    // from the page itself, not the frame: not the frame's window, so it is ignored
    await page.evaluate("window.postMessage({ type: 'factory.select', quote: 'forged', path: '' }, '*')")
    await page.waitForTimeout(300)
    await expect(page.getByRole('form', { name: 'Comment on the selection' })).toHaveCount(0)
    expect(await detail(apiUrl, report)).toEqual(before)
  })
})

test('a new revision keeps one anchored comment and moves the other to Unanchored; compare shows both', async ({
  page,
  apiUrl,
}) => {
  const { revised } = seeded()
  const shown = await detail(apiUrl, revised, 2)
  expect(shown.annotations.map((a) => a.quote)).toEqual([KEPT])
  expect(shown.unanchored.map((a) => a.quote)).toEqual([DROPPED])

  await page.goto(`/artifacts/${revised}?revision=2`)
  await expect(region(page, 'On the text')).toContainText('Name the lock.')
  await expect(region(page, 'Unanchored')).toContainText('Why a minute?')
  await expect(region(page, 'Unanchored')).not.toContainText('Name the lock.')
  await expect
    .poll(() => page.evaluate("[...(CSS.highlights.get('annotation') ?? [])].map((range) => range.toString())"))
    .toEqual([KEPT])
  await expect(region(page, 'Revision 2')).toBeVisible()
  await expect(region(page, 'Revision 2')).not.toContainText(DROPPED)

  await page.goto(`/artifacts/${revised}?revision=1`)
  await expect(region(page, 'On the text')).toContainText('Why a minute?')
  await expect(region(page, 'Revision 1')).toContainText(DROPPED)

  await page.goto(`/artifacts/${revised}?revision=2&compare=1`)
  const left = region(page, 'Revision 2')
  const right = region(page, 'Revision 1')
  await expect(left).toBeVisible()
  await expect(right).toBeVisible()
  await expect(right).toContainText(DROPPED)
  await expect(left).not.toContainText(DROPPED)
  await expect(left).toContainText('A failed row is retried at once.')
  await page.getByLabel('Compare with').selectOption('')
  await expect(page).not.toHaveURL(/compare=/)
})

const scrolls = async (page: Page) =>
  (await page.evaluate(
    '({ scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth })',
  )) as { scroll: number; client: number }

test.describe('on a phone', () => {
  test.use({ viewport: { width: 390, height: 844 } })

  test('the document and its comments stack, nothing scrolls sideways, the comment box docks at the bottom', async ({
    page,
  }) => {
    const { shotSpec, shotReport, revised } = seeded()
    for (const path of [
      `/artifacts/${shotSpec}`,
      `/artifacts/${shotReport}`,
      `/artifacts/${revised}?revision=2&compare=1`,
    ]) {
      await page.goto(path)
      await expect(page.locator('main header').getByRole('heading', { level: 1 })).toBeVisible()
      await page.waitForLoadState('networkidle')
      const widths = await scrolls(page)
      expect(widths.scroll, `${path} scrolls sideways`).toBeLessThanOrEqual(widths.client)
    }
    await page.goto(`/artifacts/${shotSpec}`)
    await expect(page.locator('main header').getByRole('heading', { level: 1 })).toBeVisible()
    await page.evaluate(SELECT(SPEC_QUOTE))
    const composer = page.getByRole('form', { name: 'Comment on the selection' })
    await expect(composer).toBeVisible()
    const box = await composer.boundingBox()
    if (!box) throw new Error('no box')
    expect(box.y + box.height).toBeGreaterThan(600)
    expect(box.x + box.width).toBeLessThanOrEqual(390)
    await page.keyboard.press('Escape')
    await expect(composer).toBeHidden()
  })
})
