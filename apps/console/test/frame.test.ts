import { readFileSync } from 'node:fs'
import { join } from 'node:path'
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
    expect(loader).toContain('/frame/annotator.js')
  })

  test('the annotator believes only its parent, announces itself and names no network API', () => {
    const annotator = read('public/frame/annotator.js')
    expect(annotator).toContain('event.source !== parent')
    expect(annotator).toContain("type: 'factory.ready'")
    expect(annotator).toContain("type: 'factory.select'")
    for (const api of ['fetch(', 'XMLHttpRequest', 'WebSocket', 'sendBeacon', 'eval(', 'Function(', 'innerHTML']) {
      expect(annotator).not.toContain(api)
      expect(read('public/frame/frame.js')).not.toContain(api)
    }
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
