#!/usr/bin/env bun
/**
 * Renders the PNG icons from the SVG marks in `public/icons/`. The PNGs are committed, so a build needs none of this; run
 * it after the marks change. `mark.svg` (the favicon) and `glyph.svg` follow the colour scheme; a PNG cannot, so the PNGs
 * come from the fixed dark sources: `app.svg` (the rounded tile, transparent corners), `apple-touch.svg` and
 * `mark-maskable.svg` (full bleed: iOS and Android round them themselves).
 */
import { chromium } from '@playwright/test'
import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

const dir = resolve(import.meta.dir, '../public/icons')
const targets = [
  { svg: 'app.svg', size: 192, out: 'icon-192.png' },
  { svg: 'app.svg', size: 512, out: 'icon-512.png' },
  { svg: 'apple-touch.svg', size: 180, out: 'apple-touch-icon.png' },
  { svg: 'mark-maskable.svg', size: 512, out: 'icon-maskable-512.png' },
] as const

const browser = await chromium.launch()
try {
  for (const { svg, size, out } of targets) {
    const page = await browser.newPage({ viewport: { width: size, height: size } })
    const data = (await readFile(join(dir, svg))).toString('base64')
    await page.setContent(
      `<body style="margin:0;background:transparent"><img src="data:image/svg+xml;base64,${data}" width="${size}" height="${size}" style="display:block"></body>`,
    )
    await page.screenshot({ path: join(dir, out), omitBackground: true })
    await page.close()
    console.log(`public/icons/${out}`)
  }
} finally {
  await browser.close()
}
