import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { runInNewContext } from 'node:vm'
import { describe, expect, test } from 'bun:test'
import { tokenBlock, withBlock } from '../scripts/templates.ts'

const root = join(import.meta.dir, '..')
const read = (path: string) => readFileSync(join(root, path), 'utf8')

describe('the artifact frame (public/frame.html, public/frame/*)', () => {
  test('frame.html holds no inline script: one external classic script', () => {
    const html = read('public/frame.html')
    expect(html.match(/<script\b[^>]*>/g)).toEqual(['<script src="/frame/frame.js">'])
    expect(html).not.toMatch(/<script[^>]*>\s*[^<\s]/)
    expect(html).not.toContain('type="module"')
  })

  test('the shell, the frame and the rendered artifact tell Dark Reader to stay off', () => {
    expect(read('index.html')).toContain('<meta name="darkreader-lock" />')
    expect(read('public/frame.html')).toContain('<meta name="darkreader-lock" />')
    const loader = read('public/frame/frame.js')
    expect(loader).toContain("lock.name = 'darkreader-lock'")
    expect(loader.indexOf('document.close()')).toBeLessThan(loader.indexOf("lock.name = 'darkreader-lock'"))
  })

  test('the loader believes only its parent window, and renders once', () => {
    const loader = read('public/frame/frame.js')
    expect(loader).toContain('event.source !== parent')
    expect(loader).toContain("data?.type !== 'factory.render'")
    expect(loader).toContain('rendered')
    expect(loader).toContain("script('annotator')")
    expect(loader).toContain('/frame/')
  })

  test('the annotator believes only its parent, announces itself and names no network API', () => {
    const annotator = read('public/frame/annotator.js')
    expect(annotator).toContain('event.source !== parent')
    expect(annotator).toContain("type: 'factory.ready'")
    expect(annotator).toContain("type: 'factory.select'")
    for (const api of ['fetch(', 'XMLHttpRequest', 'WebSocket', 'sendBeacon', 'eval(', 'Function(', 'innerHTML']) {
      expect(annotator).not.toContain(api)
      expect(read('public/frame/frame.js')).not.toContain(api)
      expect(read('public/frame/lightbox.js')).not.toContain(api)
    }
  })
})

/** The loader's pure parts, run without a browser through the seam at the end of frame.js. */
interface Loader {
  followConsole: (css: string, theme: string) => string
  declaresScheme: (css: string) => boolean
  parseColor: (value: string) => { r: number; g: number; b: number; a: number } | null
  surfaceOf: (c: ReturnType<Loader['parseColor']>) => { state: string; mark: string }
  inkOf: (c: ReturnType<Loader['parseColor']>) => string
  isLightLine: (c: ReturnType<Loader['parseColor']>) => boolean
  DARK_BASE_CSS: string
}
function loadFrame(): Loader {
  const module = { exports: {} as Loader }
  const stub = { addEventListener: () => {} }
  runInNewContext(read('public/frame/frame.js'), { module, window: stub, document: stub, parent: stub })
  return module.exports
}

describe('the theme of an artifact in the frame (public/frame/frame.js)', () => {
  const loader = read('public/frame/frame.js')
  const frame = loadFrame()
  const color = (value: string) => frame.parseColor(value)

  test('the render message carries the Console theme, and the frame follows {type:factory.theme} afterwards', () => {
    expect(loader).toContain("data.theme === 'dark' ? 'dark' : 'light'")
    expect(loader).toContain("'factory.theme'")
    expect(loader).toContain('root.dataset.theme = theme')
    expect(loader).toContain('root.style.colorScheme = theme')
    expect(loader).toContain("schemeMeta.name = 'color-scheme'")
    // both listeners believe only the parent
    expect(loader.match(/\.source !== parent/g)?.length).toBe(2)
    const page = read('src/components/artifact-content.tsx')
    expect(page).toContain('theme: currentTheme()')
    expect(page).toContain("send({ type: 'factory.theme', theme })")
  })

  test('an artifact that names a scheme is left alone; one that does not gets the base', () => {
    for (const css of [
      ':root { color-scheme: light dark }',
      '@media (prefers-color-scheme: dark) { body { background: #000 } }',
      ":root[data-theme='dark'] { --bg: #000 }",
      'COLOR-SCHEME: dark',
    ]) {
      expect(frame.declaresScheme(css)).toBe(true)
    }
    for (const css of ['body{color:#222;background:#fff}', '/* no color-scheme here */ p{margin:0}', '']) {
      expect(frame.declaresScheme(css)).toBe(false)
    }
    // the template declares one, so it is never repainted
    expect(frame.declaresScheme(read('templates/artifact.html'))).toBe(true)
  })

  test('only a pure light grey or white surface is swapped; colours and dark surfaces stay', () => {
    const bg = (value: string) => frame.surfaceOf(color(value))
    expect(bg('rgb(255, 255, 255)')).toEqual({ state: 'light', mark: 'panel' })
    expect(bg('rgb(246, 248, 250)')).toEqual({ state: 'light', mark: 'panel' })
    expect(bg('rgb(225, 228, 232)')).toEqual({ state: 'light', mark: 'subtle' })
    expect(bg('rgb(255, 248, 197)').mark).toBe('')
    expect(bg('rgb(3, 102, 214)').mark).toBe('')
    expect(bg('rgb(30, 30, 30)')).toEqual({ state: 'dark', mark: '' })
    expect(bg('rgba(0, 0, 0, 0)').state).toBe('none')
    expect(bg('rgba(0, 0, 0, 0.05)')).toEqual({ state: 'none', mark: 'subtle' })
    expect(frame.surfaceOf(color('oklch(0.9 0 0)'))).toEqual({ state: 'none', mark: '' })
  })

  test('dark text on a light surface is lifted; light text and mid greys are not', () => {
    const ink = (value: string) => frame.inkOf(color(value))
    expect(ink('rgb(34, 34, 34)')).toBe('ink')
    expect(ink('rgb(102, 102, 102)')).toBe('faint')
    expect(ink('rgb(11, 61, 145)')).toBe('tint')
    expect(ink('rgb(255, 255, 255)')).toBe('')
    expect(ink('rgb(153, 153, 153)')).toBe('')
    expect(ink('rgb(192, 57, 43)')).toBe('')
    expect(frame.isLightLine(color('rgb(225, 228, 232)'))).toBe(true)
    expect(frame.isLightLine(color('rgb(30, 30, 30)'))).toBe(false)
  })

  test('the base uses the dark values of src/styles/tokens.css and inverts nothing', () => {
    const tokens = read('src/styles/tokens.css')
    const dark = tokens.slice(tokens.indexOf(":root,\n:root[data-theme='dark'] {"))
    const value = (name: string) => new RegExp(`${name}:\\s*([^;]+);`).exec(dark)?.[1]?.trim()
    const base = frame.DARK_BASE_CSS
    for (const [local, token] of [
      ['--fd-bg', '--vx-surface-bg'],
      ['--fd-panel', '--vx-surface-panel'],
      ['--fd-subtle', '--vx-surface-subtle'],
      ['--fd-border', '--vx-surface-border'],
      ['--fd-ink', '--vx-ink'],
      ['--fd-faint', '--vx-faint'],
      ['--fd-accent', '--vx-accent'],
    ] as const) {
      expect(value(token)).toBeDefined()
      expect(base).toContain(`${local}: ${value(token)};`)
    }
    expect(base).not.toMatch(/invert|filter/)
    expect(loader).not.toMatch(/filter\s*:/)
  })

  test("an artifact's system-scheme media queries answer to the Console theme", () => {
    const css =
      '@media (prefers-color-scheme: dark) { a { color: red } } @media (prefers-color-scheme: light) { a { color: blue } }'
    const dark = frame.followConsole(css, 'dark')
    expect(dark).toContain('@media (min-width: 0px) { a { color: red } }')
    expect(dark).toContain('@media ((min-width: 1px) and (max-width: 0px)) { a { color: blue } }')
    expect(frame.followConsole(css, 'light')).toContain('@media (min-width: 0px) { a { color: blue } }')
    expect(frame.followConsole('p { color: red }', 'dark')).toBe('p { color: red }')
  })

  test('the template follows the Console theme before the system one', () => {
    const template = read('templates/artifact.html')
    expect(template).toContain(":root:not([data-theme='light'])")
    expect(template).toContain(":root[data-theme='dark']")
    expect(template).toContain('color-scheme')
  })
})

describe('the text column and the wide track (public/frame/frame.js)', () => {
  const loader = read('public/frame/frame.js')

  test('running text and every heading share one measure wherever they sit', () => {
    expect(loader).toContain(':is(p, ul, ol, dl, blockquote, h1, h2, h3, h4, h5, h6):not(')
    // the old rule held only direct children of body, main, article, section and div
    expect(loader).not.toContain(':where(body, main, article, section, div) >')
    expect(loader).toContain('max-width: min(100%, var(--factory-measure)) !important')
  })

  test('a picture wider than the column leaves it, centred and never past its own width; data-measure stays', () => {
    expect(loader).toContain('[data-factory-wide]:not([data-measure])')
    expect(loader).toContain('min(var(--factory-natural, 100%), var(--factory-room, 100%))')
    expect(loader).toContain('natural > column + 1')
    expect(loader).toContain("el.closest('[data-measure]')")
    expect(loader).toContain('.factory-table.factory-wide')
  })
})

describe('the lightbox (public/frame/lightbox.js)', () => {
  const lightbox = read('public/frame/lightbox.js')

  test('the loader writes it after the artifact, with or without the annotator', () => {
    expect(read('public/frame/frame.js')).toContain("script('lightbox')")
  })

  test('is a native dialog outside the body, closed by Esc, a button or a click beside the picture', () => {
    expect(lightbox).toContain("document.createElement('dialog')")
    expect(lightbox).toContain('dialog.showModal()')
    expect(lightbox).toContain('document.documentElement.appendChild(dialog)')
    expect(lightbox).toContain("!event.target.closest('button')")
    expect(lightbox).toContain("'Close'")
  })

  test('steps through the pictures with arrows, buttons and an n / N counter, and shows the caption', () => {
    expect(lightbox).toContain("event.key === 'ArrowLeft'")
    expect(lightbox).toContain("event.key === 'ArrowRight'")
    expect(lightbox).toContain('$' + '{at + 1} / $' + '{items.length}')
    expect(lightbox).toContain("querySelector('figcaption')")
  })

  test("never takes a selection drag or the annotator's clicks, and needs no network", () => {
    expect(lightbox).toContain('selection && !selection.isCollapsed')
    expect(lightbox).toContain('> DRAG')
    expect(lightbox).toContain('event.stopPropagation()')
    expect(lightbox).toContain('prefers-reduced-motion: no-preference')
    expect(lightbox).toContain('opener?.focus')
    expect(lightbox).not.toMatch(/https?:\/\//)
  })
})

/** Every URL the browser would fetch for this markup: element sources, link hrefs, CSS `url()` and `@import`. */
function fetchedUrls(html: string): string[] {
  const urls: string[] = []
  for (const match of html.matchAll(
    /<(?:img|script|iframe|embed|source|video|audio|input)\b[^>]*?\ssrc\s*=\s*["']?([^"'\s>]+)/gi,
  )) {
    urls.push(match[1] ?? '')
  }
  for (const match of html.matchAll(/<link\b[^>]*?\shref\s*=\s*["']?([^"'\s>]+)/gi)) urls.push(match[1] ?? '')
  for (const match of html.matchAll(/<form\b[^>]*?\saction\s*=\s*["']?([^"'\s>]+)/gi)) urls.push(match[1] ?? '')
  for (const match of html.matchAll(/\ssrcset\s*=\s*["']([^"']+)/gi)) urls.push(...(match[1] ?? '').split(','))
  for (const match of html.matchAll(/url\(\s*["']?([^"')]+)/gi)) urls.push(match[1] ?? '')
  for (const match of html.matchAll(/@import\s+["']?([^"';\s]+)/gi)) urls.push(match[1] ?? '')
  return urls.map((url) => url.trim())
}

describe('templates/artifact.html', () => {
  const template = read('templates/artifact.html')

  test('fetches nothing: no element source, link, form action or CSS url', () => {
    expect(fetchedUrls(template)).toEqual([])
    expect(fetchedUrls('<img src="http://example.com/a.png"><style>a{background:url(//x/y)}</style>')).toHaveLength(2)
  })

  test('has no http(s) reference at all', () => {
    expect(template.match(/https?:\/\/[^\s"')]+/g) ?? []).toEqual([])
  })

  test('its token block is current with src/styles/tokens.css (run `bun run --cwd apps/console templates`)', () => {
    expect(withBlock(template, tokenBlock(read('src/styles/tokens.css')))).toBe(template)
  })

  test('carries light and dark tokens and the semantic classes', () => {
    expect(template).toContain('prefers-color-scheme: dark')
    expect(template).toContain('--vx-surface-bg')
    for (const cls of ['.callout', 'table', 'pre', 'figure']) expect(template).toContain(cls)
    expect(template).toContain('<svg')
  })
})

test('templates/artifact.md follows the minimum table separator', () => {
  const md = read('templates/artifact.md')
  expect(md).toContain('|-|-|-|')
  expect(md).not.toMatch(/\|-{2,}/)
  expect(md.split('\n')[0]).toMatch(/^# /)
  expect(md).toMatch(/TLDR/)
})
