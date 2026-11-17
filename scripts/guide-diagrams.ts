#!/usr/bin/env bun
/**
 * Exports the guide's diagrams: each `docs/guide/diagrams/<name>.json` is an archify source in the Basalt preset, and
 * its `<name>.svg` beside it is the self-contained dual-theme export the chapters embed as a relative image, so the
 * same file reads on github.com and on the site (it follows `prefers-color-scheme`).
 *
 *   bun scripts/guide-diagrams.ts            every source
 *   bun scripts/guide-diagrams.ts <name>...  only these
 *
 * Needs the archify skill (`ARCHIFY`, default `~/SourceRoot/dotfiles/skills/archify/bin/archify.mjs`) and Chrome. It is
 * a hand-run step, not part of `make check`: the SVGs are checked in, and `scripts/guide-links.ts` holds that every
 * image a chapter embeds resolves.
 */
import { chromium } from '@playwright/test'
import { spawnSync } from 'node:child_process'
import { readdirSync, readFileSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

const GUIDE = resolve(import.meta.dir, '../docs/guide')
const DIAGRAMS = join(GUIDE, 'diagrams')
const ARCHIFY = process.env.ARCHIFY ?? join(homedir(), 'SourceRoot/dotfiles/skills/archify/bin/archify.mjs')

/** Delivers `<name>.json` as a checked, standalone HTML under `docs/guide/.archify/` (archify's output must sit below its cwd). */
function deliver(name: string): string {
  const source = join(DIAGRAMS, `${name}.json`)
  const type = (JSON.parse(readFileSync(source, 'utf8')) as { diagram_type: string }).diagram_type
  const html = `.archify/${name}.html`
  const run = spawnSync('node', [ARCHIFY, 'finalize', type, source, html, '--quality', 'showcase'], {
    cwd: GUIDE,
    encoding: 'utf8',
  })
  if (run.status !== 0) throw new Error(`archify finalize ${name} failed:\n${run.stdout}${run.stderr}`)
  return join(GUIDE, html)
}

/**
 * The Viewer resolves each theme's variables on a probe `div`, but Basalt's dark tokens are written for `:root[data-theme]`
 * only, so the "dark" half of the export would come out light. Scoping them to any element with the attribute lets the
 * probe see them. (A defect of the vendored basalt preset; drop this when it resolves on the root.)
 */
const SCOPE_DARK_TOKENS_TO_PROBE = `(() => {
  const tokens = document.getElementById('basalt-tokens')?.textContent ?? ''
  const style = document.createElement('style')
  style.textContent = tokens.replace(/:root\\[data-theme='dark'\\]/g, "div[data-theme='dark']")
  document.head.append(style)
})()`

rmSync(join(GUIDE, '.archify'), { recursive: true, force: true }) // archify will not replace a finished delivery's evidence
const names = process.argv.slice(2)
const all = readdirSync(DIAGRAMS)
  .filter((file) => file.endsWith('.json'))
  .map((file) => file.slice(0, -'.json'.length))
const wanted = names.length > 0 ? names : all
const unknown = wanted.filter((name) => !all.includes(name))
if (unknown.length > 0) {
  console.error(`guide-diagrams: no source for ${unknown.join(', ')}`)
  process.exit(1)
}

const browser = await chromium.launch({ channel: 'chrome' })
try {
  for (const name of wanted) {
    const html = deliver(name)
    const page = await browser.newPage({ acceptDownloads: true })
    await page.goto(`file://${html}`)
    await page.evaluate(SCOPE_DARK_TOKENS_TO_PROBE)
    await page.click('#btn-export')
    const [download] = await Promise.all([page.waitForEvent('download'), page.click('button[data-format="svg"]')])
    await download.saveAs(join(DIAGRAMS, `${name}.svg`))
    await page.close()
    console.log(`guide-diagrams: ${name}.svg`)
  }
} finally {
  await browser.close()
}
