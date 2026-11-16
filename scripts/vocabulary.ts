#!/usr/bin/env bun
/**
 * The state words on a screen (`docs/language.md` "Where work stands"): the stored states are `settling`, `queued`,
 * `working`, `waiting` and `watching`, and no surface shows them as words. The owner reads Running, Paused, Ready, Held,
 * Checking and Planned; one definition lives in `packages/contract/src/work-words.ts`. This script finds a stored state word
 * in text a person reads: the Console (`apps/console/src`), the Herdr bar (`integrations/herdr/jk-glance/main.js`) and the
 * sentences the server writes (`apps/server/src/read/describe.ts`).
 *
 * What counts as text a person reads: a JSX text node, and a string literal that has a space in it or starts with a capital
 * (a lone lower-case word such as `'queued'` is a stored value, a key or a route). Comments are not read. An exception is a
 * line in `vocabulary.allow` with its reason; one that matches nothing any more fails too. Run by `make check`.
 */
import { readdir, readFile } from 'node:fs/promises'
import { join, relative } from 'node:path'

/** The stored state words no screen shows. */
export const STATE_WORDS = ['queued', 'waiting', 'working', 'watching', 'settling'] as const
const BANNED = new RegExp(`\\b(${STATE_WORDS.join('|')})\\b`, 'i')

/** The files that draw text for the owner: a directory is every .ts and .tsx file under it that is not generated or a test. */
export const SURFACES = [
  'apps/console/src',
  'integrations/herdr/jk-glance/main.js',
  'apps/server/src/read/describe.ts',
] as const

export interface Finding {
  file: string
  line: number
  word: string
  text: string
}

export interface Exception {
  file: string
  /** a state word, or `*` */
  word: string
  reason: string
  /** the line in the allow file */
  at: number
}

interface Piece {
  /** the offset in the source */
  at: number
  text: string
  /** a JSX text node: always read; a string literal is read when it has a space or starts with a capital */
  jsx: boolean
}

/** The string literals of a source (comments skipped; a template's `${}` parts are code), as offsets and text. Loose, not a parser. */
export function literalsOf(source: string): Piece[] {
  const out: Piece[] = []
  let i = 0
  const n = source.length
  // a stack of the template depth: `{` counts inside a `${}` so its `}` returns to the template text
  const braces: number[] = []
  let depth = 0
  const readTemplate = (): void => {
    let start = i
    let text = ''
    while (i < n) {
      const c = source[i]
      if (c === '\\') {
        text += source.slice(i, i + 2)
        i += 2
        continue
      }
      if (c === '`') {
        out.push({ at: start, text, jsx: false })
        i++
        return
      }
      if (c === '$' && source[i + 1] === '{') {
        out.push({ at: start, text, jsx: false })
        i += 2
        braces.push(depth)
        depth = 0
        return
      }
      text += c
      i++
    }
    out.push({ at: start, text, jsx: false })
    start = i
  }
  while (i < n) {
    const c = source[i]
    const next = source[i + 1]
    if (c === '/' && next === '/') {
      while (i < n && source[i] !== '\n') i++
      continue
    }
    if (c === '/' && next === '*') {
      const end = source.indexOf('*/', i + 2)
      i = end === -1 ? n : end + 2
      continue
    }
    if (c === "'" || c === '"') {
      const start = i + 1
      i++
      let text = ''
      while (i < n && source[i] !== c && source[i] !== '\n') {
        if (source[i] === '\\') {
          text += source.slice(i, i + 2)
          i += 2
          continue
        }
        text += source[i]
        i++
      }
      out.push({ at: start, text, jsx: false })
      i++
      continue
    }
    if (c === '`') {
      i++
      readTemplate()
      continue
    }
    if (c === '{') depth++
    if (c === '}') {
      if (depth === 0 && braces.length > 0) {
        depth = braces.pop() ?? 0
        i++
        readTemplate()
        continue
      }
      depth = Math.max(0, depth - 1)
    }
    i++
  }
  return out
}

/** The text nodes of JSX: what sits between a `>` and the next `<`, with no braces. Loose: a comparison `a > b && c < d` reads as text. */
export function jsxTextsOf(source: string): Piece[] {
  const out: Piece[] = []
  for (const match of source.matchAll(/>([^<>{}]+)</g)) {
    const text = match[1] ?? ''
    if (/[A-Za-z]/.test(text)) out.push({ at: (match.index ?? 0) + 1, text, jsx: true })
  }
  return out
}

const lineOf = (source: string, at: number): number => source.slice(0, at).split('\n').length

/** The state words in the text a person reads in one file. */
export function findingsIn(file: string, source: string): Finding[] {
  const pieces = [...literalsOf(source), ...(file.endsWith('.tsx') ? jsxTextsOf(source) : [])]
  const findings: Finding[] = []
  for (const piece of pieces) {
    const read = piece.jsx || /\s/.test(piece.text) || /^[A-Z]/.test(piece.text.trim())
    if (!read) continue
    const found = BANNED.exec(piece.text)
    if (!found) continue
    findings.push({
      file,
      // the line of the word itself, not of the start of a long text
      line: lineOf(source, piece.at + found.index),
      word: found[1]?.toLowerCase() ?? '',
      text: piece.text.trim().replace(/\s+/g, ' ').slice(0, 80),
    })
  }
  return findings
}

/** `<path> <state word or *>  # <reason>`; a line without a reason is returned as a problem. */
export function parseExceptions(text: string): { exceptions: Exception[]; problems: string[] } {
  const exceptions: Exception[] = []
  const problems: string[] = []
  const words = new Set<string>(STATE_WORDS)
  text.split('\n').forEach((raw, i) => {
    const line = raw.trim()
    if (!line || line.startsWith('#')) return
    const [spec = '', ...rest] = line.split('#')
    const reason = rest.join('#').trim()
    const match = /^(\S+)\s+(\S+)\s*$/.exec(spec.trim())
    if (!match?.[1] || !match[2] || !reason) {
      problems.push(`vocabulary.allow:${i + 1}: needs "<path> <state word or *>  # <reason>"`)
      return
    }
    if (match[2] !== '*' && !words.has(match[2])) {
      problems.push(`vocabulary.allow:${i + 1}: "${match[2]}" is not a state word`)
      return
    }
    exceptions.push({ file: match[1], word: match[2], reason, at: i + 1 })
  })
  return { exceptions, problems }
}

const SKIPPED = /(^|\/)(node_modules|dist|test|tests)(\/|$)|\.gen\.ts$|\.test\.tsx?$/

async function filesUnder(root: string, path: string): Promise<string[]> {
  if (SKIPPED.test(path)) return []
  if (/\.(tsx?|js)$/.test(path)) return [path]
  const entries = await readdir(join(root, path), { withFileTypes: true }).catch(() => [])
  const nested = await Promise.all(entries.map((entry) => filesUnder(root, join(path, entry.name))))
  return nested.flat()
}

/** Every finding not covered by an exception, and every problem with the exceptions themselves. */
export async function checkVocabulary(root: string, allowText: string, surfaces: readonly string[] = SURFACES) {
  const { exceptions, problems } = parseExceptions(allowText)
  const used = new Set<Exception>()
  const out = [...problems]
  const files = (await Promise.all(surfaces.map((surface) => filesUnder(root, surface)))).flat().sort()
  for (const file of files) {
    const name = relative(root, join(root, file))
    for (const f of findingsIn(name, await readFile(join(root, file), 'utf8'))) {
      const exception = exceptions.find((e) => e.file === f.file && (e.word === '*' || e.word === f.word))
      if (exception) {
        used.add(exception)
        continue
      }
      out.push(
        `${f.file}:${f.line}: "${f.word}" is a stored state, not a word a screen shows (docs/language.md "Where work stands"): say Running, Paused, Ready, Held, Checking or Planned; in: ${f.text}`,
      )
    }
  }
  for (const e of exceptions) {
    if (!used.has(e)) out.push(`vocabulary.allow:${e.at}: ${e.file} ${e.word} matches nothing any more; delete it`)
  }
  return out
}

export const ROOT = join(import.meta.dir, '..')
export const ALLOW_FILE = join(import.meta.dir, 'vocabulary.allow')

if (import.meta.main) {
  const problems = await checkVocabulary(ROOT, await readFile(ALLOW_FILE, 'utf8'))
  for (const line of problems) console.error(line)
  if (problems.length) process.exit(1)
  console.log('no state word on a screen')
}
