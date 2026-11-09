import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/** DESIGN.md "Rules": no coloured left bar on a card, a block or a quote. The shared templates and the frame's own CSS keep to it. */
const root = join(import.meta.dir, '..')
const FILES = [
  'templates/artifact.md',
  'templates/artifact.html',
  'src/styles/index.css',
  'public/frame.html',
  'public/frame/frame.js',
  'public/frame/annotator.js',
]

/** `border-left`, `border-inline-start`, Tailwind's `border-l-*` / `border-s-*`, and an inset box-shadow stripe. */
const ACCENT_BAR = [
  /border-left(?!-)/i,
  /border-left-(?:width|color|style)/i,
  /border-inline-start/i,
  /(?:^|[\s"'`:])(?:[a-z-]+:)*border-[ls](?:-|\b)/,
  /box-shadow\s*:[^;}]*inset/i,
  /shadow-\[inset/i,
]

test('no template, prose style or frame style draws a left-border accent', () => {
  const found = FILES.flatMap((file) =>
    readFileSync(join(root, file), 'utf8')
      .split('\n')
      .flatMap((line, i) =>
        ACCENT_BAR.some((pattern) => pattern.test(line)) ? [`${file}:${i + 1}: ${line.trim()}`] : [],
      ),
  )
  expect(found).toEqual([])
})

test('the detector catches the usual stripes', () => {
  for (const line of [
    'blockquote { border-left: 4px solid red; }',
    '.callout { border-inline-start: 3px solid blue }',
    '@apply border-l-4 border-primary;',
    'class="border-l-2 pl-3"',
    '.x { box-shadow: inset 4px 0 0 var(--vx-accent); }',
  ])
    expect(ACCENT_BAR.some((pattern) => pattern.test(line))).toBe(true)
  for (const line of [
    'border-bottom: 1px solid var(--vx-surface-border);',
    '@apply border-b px-3;',
    'border-collapse: collapse;',
  ])
    expect(ACCENT_BAR.some((pattern) => pattern.test(line))).toBe(false)
})
