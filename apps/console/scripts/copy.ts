#!/usr/bin/env bun
/**
 * The Console's copy rules (`DESIGN.md` "Copy"), as a check over `src/`: the words a person reads on a screen.
 *
 * - **Banned words** from the owner's voice guide (`brain/voice.md`, "Banned defaults"): the lexical and metaphor-noun lists,
 *   and the phrases that pad (`please note`, `in order to`).
 * - **One word per glossary term** (`docs/language.md`): `repository` for a repo, `document` for an artifact, `item` or `task`
 *   for an Issue are drift, not synonyms.
 * - **A label is an action**: a button that reads `Submit`, `OK` or `Click here` says nothing.
 * - **An error says what to do next**: a bare `Error`, `Failed` or `Something went wrong` is refused.
 * - **A card explains its figure**: every `<StatCard>` carries a `hint`, the glossary word whose definition says what the
 *   figure counts and what to do about it. An `<EmptyState>` carries a line (why it is empty) or an action (the next step).
 *
 * What counts as text a person reads is `scripts/vocabulary.ts`'s rule: a JSX text node, and a string literal with a space in it
 * or a capital first letter. An exception is a line in `copy.allow` with its reason; one that matches nothing fails too.
 *
 *   bun scripts/copy.ts            list every finding, exit 1 when there is one
 *   bun scripts/copy.ts --strings  the inventory: every string a person reads, with where it shows
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { jsxTextsOf, literalsOf } from '../../../scripts/vocabulary.ts'

export interface Rule {
  /** the key an exception names */
  id: string
  pattern: RegExp
  /** what to say instead */
  use: string
}

/** The voice guide's lexical and metaphor-noun bans. `surface`, `harness` and `primitive` are real jargon but banned in broad copy, which a screen is. */
const BANNED_WORDS = [
  'delve',
  'tapestry',
  'testament',
  'leverage[sd]?',
  'leveraging',
  'unlock(s|ed|ing)?',
  'crucial',
  'robust',
  'seamless(ly)?',
  'ever-evolving',
  'transformative',
  'landscape',
  'realm',
  'myriad',
  'foster(s|ed|ing)?',
  'pivotal',
  'vibrant',
  'meticulous(ly)?',
  'holistic(ally)?',
  'game-changer',
  'substrate',
  'nexus',
  'locus',
  'vantage',
  'bedrock',
  'flywheel',
  'north star',
  'endgame',
  'gold-plating',
  'scaffolding',
  'ratchet',
  'harness',
  'primitives?',
  'utili[sz](e|es|ed|ing)',
  'facilitate[sd]?',
  'numerous',
  'streamlin(e|es|ed|ing)',
  'empower(s|ed|ing)?',
  'cutting-edge',
  'state-of-the-art',
]

export const BANNED: Rule[] = [
  ...BANNED_WORDS.map((word) => ({
    id: `banned:${word.replace(/\(.*$|\[.*$|\?.*$/g, '')}`,
    pattern: new RegExp(`(?<![\\w-])(${word})(?![\\w-])`, 'i'),
    use: 'a plain word (the voice guide, "Banned defaults")',
  })),
  { id: 'banned:please note', pattern: /\bplease note\b/i, use: 'the sentence without the preamble' },
  { id: 'banned:worth noting', pattern: /\bit['’]?s worth noting\b/i, use: 'the sentence without the preamble' },
  { id: 'banned:in order to', pattern: /\bin order to\b/i, use: 'to' },
  { id: 'banned:due to the fact', pattern: /\bdue to the fact that\b/i, use: 'because' },
  { id: 'banned:oops', pattern: /\b(oops|whoops|uh-oh)\b/i, use: 'what happened and what to do next' },
  { id: 'banned:click here', pattern: /\bclick here\b/i, use: 'a link that names where it goes' },
  { id: 'banned:something went wrong', pattern: /\bsomething went wrong\b/i, use: 'what happened and what to do next' },
]

/** One word per glossary term: the screen word is the glossary's, these are the near-synonyms it drifts to. Words the glossary retires are `scripts/retired-words.ts`'s. */
export const DRIFT: Rule[] = [
  { id: 'drift:repository', pattern: /\brepositor(y|ies)\b/i, use: 'repo (docs/language.md "Work repo")' },
  { id: 'drift:document', pattern: /\bdocuments?\b/i, use: 'artifact, or page (docs/language.md "Artifact")' },
  { id: 'drift:item', pattern: /\bitems?\b/i, use: 'Issue, or the thing itself (docs/language.md "Issue")' },
  { id: 'drift:task', pattern: /\btasks?\b/i, use: 'Issue, or Errand (docs/language.md "Issue", "Errand")' },
  { id: 'drift:worker', pattern: /\bworkers?\b/i, use: 'lead (docs/language.md "Lead")' },
]

/** A button or link that is only one of these says nothing (voice guide: "Labels are actions. Verb + object"). */
const EMPTY_LABELS = new Set(['submit', 'ok', 'okay', 'yes', 'no', 'go', 'click here', 'confirm', 'continue'])

/** A message that is only this says what failed nowhere (voice guide: "Errors say what happened and what to do next"). */
const BARE_ERROR = /^(error|failed|failure|an error occurred|unknown error|unexpected error|invalid)[.!:]?$/i

export interface Finding {
  file: string
  line: number
  rule: string
  /** the offending text, or the tag */
  text: string
  use: string
}

const lineOf = (source: string, at: number): number => source.slice(0, at).split('\n').length
const squash = (text: string): string => text.trim().replace(/\s+/g, ' ')

/** One string a person reads and where it shows. */
export interface Reading {
  file: string
  line: number
  /** `jsx` text between tags, `string` a literal */
  kind: 'jsx' | 'string'
  text: string
}

/** A tailwind class list or a CSS value is not copy. */
const STYLE =
  /(^|\s)(flex|grid|inline|block|hidden|text-|bg-|px-|py-|p-\d|m[trblxy]?-|gap-|size-|rounded|border|min-|max-|items-|justify-|w-|h-|absolute|relative|font-|truncate|data-\[|aria-|hover:|focus|group-|after:|before:|sm:|md:|lg:|xl:|@|\[&|-translate|translate-|opacity-|isolate|overflow|line-clamp|whitespace|tabular|underline|outline|ring|shadow|z-\d|calc\(|color-mix|var\(|\()/

/** Whether a piece of source is a sentence for a person, not code between two angle brackets. */
function isText(text: string, jsx: boolean): boolean {
  const t = squash(text)
  if (!/[A-Za-z]{2}/.test(t)) return false
  // between two angle brackets, loose parsing also reads code: `item.issue ? (`, `a > b && c < d`
  if (jsx) return !/[=;]|=>|\?\s*\(|\)\s*:|\w\.\w|\bconst\b|\breturn\b/.test(t)
  if (/[{}]|=>/.test(t)) return false
  if (!/\s/.test(t) && !/^[A-Z]/.test(t)) return false
  if (/^[\w.-]+\.(tsx?|css|json|ya?ml)$/.test(t)) return false
  return !STYLE.test(t)
}

/** Every string a person reads in a source, in file order. */
export function readings(file: string, source: string): Reading[] {
  const pieces = [...literalsOf(source), ...(file.endsWith('.tsx') ? jsxTextsOf(source) : [])]
  const out: Reading[] = []
  for (const piece of pieces) {
    if (!isText(piece.text, piece.jsx)) continue
    out.push({ file, line: lineOf(source, piece.at), kind: piece.jsx ? 'jsx' : 'string', text: squash(piece.text) })
  }
  return out.sort((a, b) => a.line - b.line)
}

/** The opening tag of every `<Name …>` in a source: from `<Name` to its closing `>`, with `{}` and quotes balanced. */
export function openingTags(source: string, name: string): { at: number; tag: string }[] {
  const out: { at: number; tag: string }[] = []
  const start = new RegExp(`<${name}(?=[\\s/>])`, 'g')
  for (const match of source.matchAll(start)) {
    const at = match.index ?? 0
    let depth = 0
    let quote = ''
    let i = at + name.length + 1
    for (; i < source.length; i++) {
      const c = source[i]
      if (quote) {
        if (c === '\\') i++
        else if (c === quote) quote = ''
        continue
      }
      if (c === '"' || c === "'" || c === '`') quote = c
      else if (c === '{') depth++
      else if (c === '}') depth--
      else if (c === '>' && depth === 0 && source[i - 1] !== '=') break
    }
    out.push({ at, tag: source.slice(at, i + 1) })
  }
  return out
}

const hasProp = (tag: string, prop: string): boolean => new RegExp(`\\s${prop}(=|\\s|/|>)`).test(tag)

/** The text of the element opened at `at`: its children up to the matching close tag (a self-closing tag has none). */
function childrenOf(source: string, at: number, tag: string, name: string): string {
  if (tag.endsWith('/>')) return ''
  const close = source.indexOf(`</${name}>`, at + tag.length)
  return close === -1 ? '' : source.slice(at + tag.length, close)
}

/** The `<StatCard>` of a source that has no `hint`, and each `<EmptyState>` with neither a line nor an action. */
export function structureFindings(file: string, source: string): Finding[] {
  const out: Finding[] = []
  for (const { at, tag } of openingTags(source, 'StatCard')) {
    if (hasProp(tag, 'hint')) continue
    out.push({
      file,
      line: lineOf(source, at),
      rule: 'card:hint',
      text: squash(tag).slice(0, 80),
      use: 'a hint: the glossary word that says what the figure counts and what to do about it',
    })
  }
  for (const { at, tag } of openingTags(source, 'EmptyState')) {
    if (hasProp(tag, 'action')) continue
    if (squash(childrenOf(source, at, tag, 'EmptyState')) !== '') continue
    out.push({
      file,
      line: lineOf(source, at),
      rule: 'empty:next',
      text: squash(tag).slice(0, 80),
      use: 'a line that says why it is empty, or an action that is the first step',
    })
  }
  return out
}

/** Banned words, drift, empty labels and bare errors in the text of one file, plus its structure findings. */
export function findingsIn(file: string, source: string): Finding[] {
  const out: Finding[] = []
  for (const reading of readings(file, source)) {
    for (const rule of [...BANNED, ...DRIFT]) {
      if (!rule.pattern.test(reading.text)) continue
      out.push({ file, line: reading.line, rule: rule.id, text: reading.text.slice(0, 80), use: rule.use })
    }
    const label = reading.text.toLowerCase().replace(/[.!…]+$/, '')
    if (reading.kind === 'jsx' && EMPTY_LABELS.has(label)) {
      out.push({
        file,
        line: reading.line,
        rule: 'label:action',
        text: reading.text,
        use: 'a verb and its object ("Create room", not "Submit")',
      })
    }
    if (BARE_ERROR.test(reading.text)) {
      out.push({
        file,
        line: reading.line,
        rule: 'error:next',
        text: reading.text,
        use: 'what happened and what to do next',
      })
    }
  }
  return [...out, ...structureFindings(file, source)].sort((a, b) => a.line - b.line)
}

export interface Exception {
  file: string
  rule: string
  reason: string
  at: number
}

/** `<path> <rule>  # <reason>`; a line without a reason is a problem. */
export function parseExceptions(text: string): { exceptions: Exception[]; problems: string[] } {
  const exceptions: Exception[] = []
  const problems: string[] = []
  text.split('\n').forEach((raw, i) => {
    const line = raw.trim()
    if (!line || line.startsWith('#')) return
    const [spec = '', ...rest] = line.split('#')
    const reason = rest.join('#').trim()
    const match = /^(\S+)\s+(\S+)\s*$/.exec(spec.trim())
    if (!match?.[1] || !match[2] || !reason) {
      problems.push(`copy.allow:${i + 1}: needs "<path> <rule>  # <reason>"`)
      return
    }
    exceptions.push({ file: match[1], rule: match[2], reason, at: i + 1 })
  })
  return { exceptions, problems }
}

const SKIPPED = /(^|\/)(node_modules|dist|ui)(\/|$)|\.gen\.tsx?$|\.test\.tsx?$/

/** Every .ts and .tsx file under a directory that draws or words something a person reads. */
export function sourceFiles(dir: string): string[] {
  if (SKIPPED.test(dir)) return []
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    if (SKIPPED.test(path)) return []
    return statSync(path).isDirectory() ? sourceFiles(path) : /\.tsx?$/.test(name) ? [path] : []
  })
}

/** The findings of the whole Console, each file's path relative to `root`, with the exceptions applied. */
export function checkCopy(root: string, allowText: string): string[] {
  const { exceptions, problems } = parseExceptions(allowText)
  const used = new Set<Exception>()
  const out = [...problems]
  for (const path of sourceFiles(join(root, 'src')).sort()) {
    const file = relative(root, path)
    for (const f of findingsIn(file, readFileSync(path, 'utf8'))) {
      const exception = exceptions.find((e) => e.file === f.file && (e.rule === '*' || e.rule === f.rule))
      if (exception) {
        used.add(exception)
        continue
      }
      out.push(`${f.file}:${f.line}: ${f.rule}: say ${f.use}; in: ${f.text}`)
    }
  }
  for (const e of exceptions) {
    if (!used.has(e)) out.push(`copy.allow:${e.at}: ${e.file} ${e.rule} matches nothing any more; delete it`)
  }
  return out
}

export const ROOT = join(import.meta.dir, '..')
export const ALLOW_FILE = join(import.meta.dir, 'copy.allow')

if (import.meta.main) {
  if (process.argv.includes('--strings')) {
    for (const path of sourceFiles(join(ROOT, 'src')).sort()) {
      const file = relative(ROOT, path)
      for (const r of readings(file, readFileSync(path, 'utf8')))
        console.log(`${r.file}:${r.line}\t${r.kind}\t${r.text}`)
    }
  } else {
    const problems = checkCopy(ROOT, readFileSync(ALLOW_FILE, 'utf8'))
    for (const line of problems) console.error(line)
    if (problems.length) process.exit(1)
    console.log('the Console copy follows the rules')
  }
}
