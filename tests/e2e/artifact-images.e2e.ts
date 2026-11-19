import { join } from 'node:path'
import type { Frame, Page } from '@playwright/test'
import { expect, test } from './fixtures.ts'
import { api } from './seed.ts'

/**
 * A comment hangs on a picture: the second of three screenshots is commented inline, the third at a spot in the lightbox.
 * Both persist with their image anchor, show a badge or a pin, list in the Comments pane with a thumbnail, and find their
 * picture again after a reload and after a revision that reorders the pictures.
 */
test.describe.configure({ mode: 'serial' })
test.use({ viewport: { width: 1800, height: 1200 }, colorScheme: 'dark' })

const OUT = join(import.meta.dir, 'out', 'screenshots')

const SHOTS = [
  { id: 'home', alt: 'Home screen', fill: '#1d3557' },
  { id: 'queue', alt: 'Queue screen', fill: '#2a4d3a' },
  { id: 'settings', alt: 'Settings screen', fill: '#4a2c4a' },
] as const

const shot = ({ alt, fill }: (typeof SHOTS)[number]) =>
  `data:image/svg+xml,${encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="960" height="540" viewBox="0 0 960 540"><rect width="960" height="540" fill="${fill}"/><rect x="48" y="48" width="864" height="72" rx="12" fill="#ffffff22"/><text x="72" y="96" fill="#f4f4f5" font-size="32" font-family="sans-serif">${alt}</text><rect x="48" y="156" width="400" height="320" rx="12" fill="#ffffff18"/><rect x="480" y="156" width="432" height="320" rx="12" fill="#ffffff10"/></svg>`,
  )}`

const page_ = (order: readonly (typeof SHOTS)[number][], tag: string) =>
  `<!doctype html><html><head><title>Screens</title></head><body><h1>Screens</h1>${order
    .map(
      (s) =>
        `<h2>${s.alt}</h2><p>What ${s.alt.toLowerCase()} shows.</p><img id="${s.id}" src="${shot(s)}" alt="${s.alt}" width="960" height="540">`,
    )
    .join('')}<p>${tag}</p></body></html>`

const unique = () => `Run ${Date.now()}-${Math.random().toString(36).slice(2, 8)}.`

interface Detail {
  annotations: {
    quote: string
    image: { occurrence: number; srcHash: string; label: string; x: number | null; y: number | null } | null
    comment: string
  }[]
}

async function artifactFrame(page: Page): Promise<Frame> {
  const frame = await (await page.locator('iframe[title="Artifact"]').elementHandle())?.contentFrame()
  if (!frame) throw new Error('no frame')
  return frame
}

const card = (page: Page, text: string) =>
  page.getByRole('region', { name: 'On the text', exact: true }).getByRole('listitem').filter({ hasText: text })

/** The text of the badge on a picture ('' for none): markers are drawn for the pictures in view, so it is brought into view first. */
const badgeOn = (frame: Frame, id: string) =>
  frame.evaluate<string>(`new Promise((resolve) => {
    const img = document.getElementById(${JSON.stringify(id)})
    img.scrollIntoView({ block: 'center' })
    setTimeout(() => {
      const r = img.getBoundingClientRect()
      const badge = [...document.querySelectorAll('#factory-image-layer button:not(.add)')].find((b) => {
        const x = b.getBoundingClientRect()
        return x.left >= r.left && x.right <= r.right && x.top >= r.top && x.bottom <= r.bottom
      })
      resolve(badge ? badge.textContent : '')
    }, 300)
  })`)

test('a comment on a picture, inline and at a spot in the lightbox, finds its picture again', async ({
  page,
  apiUrl,
}) => {
  await page.addInitScript(() => localStorage.setItem('console-theme', 'dark'))
  const made = await api<{ artifact: { id: string } }>(apiUrl, '/v1/artifacts', {
    repo: 'ember',
    title: 'Three screenshots',
    content: page_(SHOTS, unique()),
    contentFormat: 'html',
  })
  const id = made.artifact.id
  // the frame is a navigation of its own: once the service worker controls the page, it must not answer it with the app shell
  await page.goto('/needs-you')
  await page.evaluate('navigator.serviceWorker.ready.then(() => true)')
  await page.reload()
  await expect.poll(() => page.evaluate('navigator.serviceWorker.controller !== null')).toBe(true)
  await page.goto(`/artifacts/${id}`)
  const frame = await artifactFrame(page)
  const composer = page.getByRole('form', { name: 'Comment on the picture' })
  await expect
    .poll(() => frame.evaluate<number>("document.getElementById('queue')?.naturalWidth ?? 0"))
    .toBeGreaterThan(0)

  // inline: hovering the second picture shows its comment button
  const add = frame.locator('#factory-image-layer button.add')
  await expect(async () => {
    await frame.locator('#queue').hover()
    await expect(add).toBeVisible({ timeout: 1500 })
  }).toPass({ timeout: 20_000 })
  await add.click()
  await expect(composer).toBeVisible()
  await composer.getByRole('textbox', { name: 'Comment' }).fill('The queue column is too narrow here.')
  await composer.getByRole('button', { name: 'Add comment' }).click()
  await expect(composer).toBeHidden()
  await expect(card(page, 'The queue column is too narrow here.')).toBeVisible()
  await expect.poll(() => badgeOn(frame, 'queue')).toBe('1')
  expect(await badgeOn(frame, 'home')).toBe('')

  // in the lightbox: a spot on the third picture
  await frame.locator('#settings').scrollIntoViewIfNeeded()
  await frame.locator('#settings').click()
  const dialog = frame.locator('dialog.factory-lightbox')
  await expect(dialog).toBeVisible()
  await expect(dialog.locator('.factory-lightbox-count')).toHaveText('3 / 3')
  await dialog.getByRole('button', { name: 'Mark a spot on this picture' }).click()
  await dialog.locator('.factory-lightbox-holder img').click({ position: { x: 420, y: 180 } })
  await expect(composer).toBeVisible()
  await composer.getByRole('textbox', { name: 'Comment' }).fill('This toggle should be a switch.')
  await composer.getByRole('button', { name: 'Add comment' }).click()
  await expect(composer).toBeHidden()
  await expect(dialog.locator('.factory-lightbox-pin')).toHaveCount(1)
  await expect(dialog.locator('.factory-lightbox-side')).toContainText('This toggle should be a switch.')
  await page.screenshot({ path: join(OUT, 'artifact-images-lightbox-dark.png'), animations: 'disabled' })
  await dialog.getByRole('button', { name: 'Close' }).click()
  await expect(dialog).toBeHidden()

  // both persist with their anchors, and list with a thumbnail
  await expect.poll(async () => (await api<Detail>(apiUrl, `/v1/artifacts/${id}`)).annotations.length).toBe(2)
  const stored = (await api<Detail>(apiUrl, `/v1/artifacts/${id}`)).annotations
  const second = stored.find((a) => a.image?.occurrence === 1)
  const third = stored.find((a) => a.image?.occurrence === 2)
  expect(second?.image).toMatchObject({ label: 'Queue screen', x: null, y: null })
  expect(third?.image?.x).toBeGreaterThan(0.3)
  expect(third?.image?.x).toBeLessThan(0.6)
  expect(third?.image?.y).toBeGreaterThan(0.1)
  expect(third?.quote).toContain('Settings screen')
  await expect(card(page, 'This toggle should be a switch.').locator('img')).toBeVisible()
  await expect(card(page, 'The queue column is too narrow here.').locator('img')).toBeVisible()
  await frame.locator('#queue').scrollIntoViewIfNeeded()
  await page.screenshot({ path: join(OUT, 'artifact-images-inline-dark.png'), animations: 'disabled' })

  // after a reload each is back on its picture; a card jumps to it
  await page.reload()
  const again = await artifactFrame(page)
  await expect(card(page, 'This toggle should be a switch.')).toBeVisible()
  await expect.poll(() => badgeOn(again, 'queue')).toBe('1')
  await expect.poll(() => badgeOn(again, 'settings')).toBe('1')
  expect(await badgeOn(again, 'home')).toBe('')
  await card(page, 'The queue column is too narrow here.').getByRole('button').first().click()
  await expect(again.locator('#queue')).toHaveAttribute('data-factory-comment-focus', '')
  await card(page, 'This toggle should be a switch.').getByRole('button').first().click()
  const viewer = again.locator('dialog.factory-lightbox')
  await expect(viewer).toBeVisible()
  await expect(viewer.locator('.factory-lightbox-count')).toHaveText('3 / 3')
  await expect(viewer.locator('.factory-lightbox-pin')).toHaveCount(1)
  await viewer.getByRole('button', { name: 'Close' }).click()
  await expect(viewer).toBeHidden()

  // a revision that reorders the pictures keeps each comment on its picture
  await api(apiUrl, `/v1/artifacts/${id}/revisions`, {
    content: page_([SHOTS[2], SHOTS[0], SHOTS[1]], unique()),
  })
  await page.goto(`/artifacts/${id}`)
  const revised = await artifactFrame(page)
  await expect
    .poll(() => revised.evaluate<number>("document.getElementById('queue')?.naturalWidth ?? 0"))
    .toBeGreaterThan(0)
  await expect.poll(() => badgeOn(revised, 'queue')).toBe('1')
  await expect.poll(() => badgeOn(revised, 'settings')).toBe('1')
  expect(await badgeOn(revised, 'home')).toBe('')
  // the pictures are in a new order: the third is now first
  expect(await revised.evaluate<string[]>("[...document.querySelectorAll('img')].map((img) => img.id)")).toEqual([
    'settings',
    'home',
    'queue',
  ])
})
