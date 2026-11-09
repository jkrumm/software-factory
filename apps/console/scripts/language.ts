#!/usr/bin/env bun
/**
 * Keeps `src/lib/language.gen.ts` in step with `docs/language.md`: the definition of every word of its `Word | Means`
 * tables, as plain text keyed by the lower-cased word, so an InfoHint never carries a retyped definition.
 *
 *   bun scripts/language.ts            rewrite the file
 *   bun scripts/language.ts --check    exit 1 when the file is stale
 *
 * The output is written the way oxfmt formats it (single quotes, 120 columns), so `make check`'s format check holds.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const root = resolve(import.meta.dir, '..')
const SOURCE = join(root, '../../docs/language.md')
const TARGET = join(root, 'src/lib/language.gen.ts')
const WIDTH = 120
const SHORT_KEY = 4

/** Rows whose Means cell lists words of their own, each as `` `word` (what it is) ``: the states and the outcomes. */
const LISTS = new Set(['state', 'outcome'])

const plain = (markdown: string): string =>
  markdown
    .replace(/`([^`]*)`/g, '$1')
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/(?<![\w*])\*([^*\n]+)\*(?!\*)/g, '$1')
    .replace(/\s+/g, ' ')
    .trim()

/** The words a row defines: its bold words, or its plain text, split on `/`. */
function wordsOf(cell: string): string[] {
  const bold = [...cell.matchAll(/\*\*(.+?)\*\*/g)].map((m) => m[1] ?? '')
  const named = bold.length > 0 ? bold : [cell]
  return named.flatMap((name) => plain(name).split('/')).map((name) => name.trim())
}

export function definitions(markdown: string): Map<string, string> {
  const found = new Map<string, string>()
  const add = (word: string, means: string) => {
    const key = word.toLowerCase()
    if (key !== '' && means !== '' && !found.has(key)) found.set(key, means)
  }
  let inTable = false
  for (const line of markdown.split('\n')) {
    if (!line.startsWith('|')) {
      inTable = false
      continue
    }
    const cells = line.split('|').slice(1, -1)
    if (/^\s*Word\s*$/.test(cells[0] ?? '') && /^\s*Means\s*$/.test(cells[1] ?? '')) {
      inTable = true
      continue
    }
    if (!inTable || /^[-\s]*$/.test(cells[0] ?? '')) continue
    const means = (cells[1] ?? '').trim()
    for (const word of wordsOf((cells[0] ?? '').trim())) {
      add(word, plain(means))
      if (!LISTS.has(word.toLowerCase())) continue
      for (const m of means.matchAll(/`(\w+)` \(([^)]*)\)/g)) add(m[1] ?? '', `${word}: ${plain(m[2] ?? '')}`)
    }
  }
  return found
}

/** A string literal as oxfmt prints it: single quotes unless that needs more escapes. */
function literal(text: string): string {
  const singles = text.split("'").length - 1
  const doubles = text.split('"').length - 1
  const quote = singles > doubles ? '"' : "'"
  return `${quote}${text.replaceAll('\\', '\\\\').replaceAll(quote, `\\${quote}`)}${quote}`
}

export function render(found: Map<string, string>): string {
  const entries = [...found].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  const rows = entries.map(([word, means]) => {
    const key = /^[A-Za-z_$][\w$]*$/.test(word) ? word : literal(word)
    const oneLine = `  ${key}: ${literal(means)},`
    // oxfmt keeps a long string beside a key of four characters or fewer, and moves it below any longer key
    return oneLine.length <= WIDTH || key.length <= SHORT_KEY ? oneLine : `  ${key}:\n    ${literal(means)},`
  })
  return [
    '// Generated from docs/language.md by scripts/language.ts: do not edit (`bun run --cwd apps/console language`).',
    'export const LANGUAGE = {',
    ...rows,
    '} as const satisfies Record<string, string>',
    '',
  ].join('\n')
}

if (import.meta.main) {
  const next = render(definitions(readFileSync(SOURCE, 'utf8')))
  if (process.argv.includes('--check')) {
    const current = (() => {
      try {
        return readFileSync(TARGET, 'utf8')
      } catch {
        return ''
      }
    })()
    if (next !== current) {
      console.error('src/lib/language.gen.ts is stale: run `bun run --cwd apps/console language`')
      process.exit(1)
    }
  } else {
    writeFileSync(TARGET, next)
  }
}
