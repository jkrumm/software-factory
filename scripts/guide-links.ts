#!/usr/bin/env bun
/**
 * The guide (`docs/guide/`) is one Markdown source for two renderings, github.com and the VitePress site. It quotes
 * code, so this check holds that what it quotes is still the code, offline, against the tree it runs in (HEAD in CI):
 *
 * - every page opens with its `# H1` and uses no frontmatter, no `:::` container and no component tag (GitHub shows
 *   them as raw text);
 * - a relative link or image resolves to a file inside `docs/guide/`; a root-absolute link (`/x`) is refused, it
 *   breaks on GitHub;
 * - a link into this repo on GitHub (`blob/` or `tree/`) points at `master`, never a commit, and the path exists and
 *   holds every line a `#Lx-Ly` anchor names, and a symbol named beside
 *   the link declares it (a keyword form, or a quoted kind) inside them; a method or a key is named in prose, unchecked;
 * - a `ts` block quotes code, and the line above it names where: `<!-- snippet: <path> <symbol> -->`. The block must
 *   equal the code of that symbol in that file, line for line (indentation aside); a line `// …` stands for code left
 *   out between two parts. A quoted line that changed in the code fails the check, so the page is edited with it.
 *
 * Run by `make check` and the guide workflow; exits 1 on a finding.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'

export const REPO_URL = 'https://github.com/jkrumm/software-factory'
const GUIDE = 'docs/guide'
const SKIP_DIRS = new Set(['node_modules', '.vitepress'])

export interface Finding {
  file: string
  line: number
  message: string
}

/** A link into this repo at master: `blob/master/<path>#L3-L9` or `tree/master/<path>`. */
export interface Permalink {
  path: string
  from?: number
  to?: number
}

/** What the checkout answers; the real one reads the files, tests pass a fake. */
export interface Tree {
  /** the path's line count (a directory: 0), or null when the tree does not hold it */
  lines(path: string): number | null
  /** the file's text, or null when it is not a file */
  text(path: string): string | null
}

const LINK = /(!?)\[[^\]]*\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g
const SNIPPET = /^<!--\s*snippet:\s*(\S+)\s+(\S+)\s*-->$/
const ELISION = /^\s*\/\/\s*(…|\.\.\.)\s*$/

/** A code span: a backtick run, the text up to the same run. */
const CODE_SPAN = /(`+)[\s\S]*?\1/g

/** The text of a line outside inline code spans, so a link written as code is not a link. */
function stripInlineCode(line: string): string {
  return line.replace(CODE_SPAN, '')
}

/** Parses a GitHub URL into this repo; null when it is not one, 'unpinned' when it names a ref other than master. */
export function parsePermalink(url: string): Permalink | 'unpinned' | null {
  if (!url.startsWith(`${REPO_URL}/blob/`) && !url.startsWith(`${REPO_URL}/tree/`)) return null
  const rest = url.slice(REPO_URL.length + '/blob/'.length)
  const [pathPart = '', anchor] = rest.split('#')
  const slash = pathPart.indexOf('/')
  const ref = slash === -1 ? pathPart : pathPart.slice(0, slash)
  if (ref !== 'master') return 'unpinned'
  const path = slash === -1 ? '' : decodeURIComponent(pathPart.slice(slash + 1))
  const range = anchor?.match(/^L(\d+)(?:-L(\d+))?$/)
  if (!range) return { path }
  const from = Number(range[1])
  return { path, from, to: range[2] ? Number(range[2]) : from }
}

const indentOf = (line: string): number => line.length - line.trimStart().length

/** The lines without their common indentation and trailing space, so a block quoted from a nested place compares. */
function dedent(lines: string[]): string[] {
  const filled = lines.filter((l) => l.trim() !== '')
  const common = filled.length === 0 ? 0 : Math.min(...filled.map(indentOf))
  return lines.map((l) => l.slice(Math.min(common, indentOf(l))).trimEnd())
}

const isComment = (line: string): boolean => /^\s*(\/\*\*?|\*|\/\/)/.test(line)

/**
 * The lines a symbol covers, from one that names it: the comment block above it, then down to the line that closes it
 * (the first later line at its indentation or less; a closing bracket line belongs to it unless it opens a new block).
 */
function symbolSpans(code: string[], symbol: string): { start: number; end: number }[] {
  const word = new RegExp(`(^|[^\\w$])${symbol.replace(/[$]/g, '\\$&')}($|[^\\w$])`)
  const spans: { start: number; end: number }[] = []
  code.forEach((line, at) => {
    if (!word.test(line)) return
    let start = at
    while (start > 0 && isComment(code[start - 1] ?? '')) start -= 1
    let end = at
    const base = indentOf(line)
    for (let i = at + 1; i < code.length; i++) {
      const next = code[i] ?? ''
      if (next.trim() === '') continue
      if (indentOf(next) > base) {
        end = i
        continue
      }
      const closer = /^\s*[})\]>]/.test(next)
      if (closer) end = i
      if (closer && /[{([]$/.test(next.trimEnd())) continue // `): T {` closes the parameters and opens the body
      break
    }
    spans.push({ start, end })
  })
  return spans
}

/** Splits a quoted block at its `// …` lines into the parts that must each appear in the code, in order. */
function parts(block: string[]): string[][] {
  const out: string[][] = [[]]
  for (const line of block) {
    if (ELISION.test(line)) out.push([])
    else out[out.length - 1]?.push(line)
  }
  return out.map((part) => dedent(part)).filter((part) => part.length > 0)
}

/** Where `part` stands in `code` at or after `from`, within [start, end]; the lines of the closest miss otherwise. */
function locate(
  code: string[],
  part: string[],
  from: number,
  end: number,
): { at: number } | { miss: string; score: number } {
  let best = { matched: -1, text: '' }
  for (let at = from; at <= end; at++) {
    const window = dedent(code.slice(at, at + part.length))
    const matched = part.findIndex((line, k) => window[k] !== line)
    if (matched === -1 && window.length === part.length) return { at }
    const k = matched === -1 ? window.length : matched
    if (k > best.matched)
      best = {
        matched: k,
        text: `line ${k + 1} of the block, \`${(part[k] ?? '').trim()}\`, is \`${(window[k] ?? '').trim()}\``,
      }
  }
  return {
    miss: best.matched <= 0 ? `its first line, \`${(part[0] ?? '').trim()}\`, is not there` : best.text,
    score: best.matched,
  }
}

/** The finding for one quoted block, or null when it equals the code of the symbol. */
export function checkSnippet(tree: Tree, path: string, symbol: string, block: string[]): string | null {
  const source = tree.text(path)
  if (source === null) return `${path} is not a file`
  const code = source.split('\n')
  const spans = symbolSpans(code, symbol)
  if (spans.length === 0) return `${symbol} does not appear in ${path}`
  const wanted = parts(block)
  if (wanted.length === 0) return 'the block is empty'
  let closest = { score: -2, miss: '' }
  for (const span of spans) {
    let from = span.start
    let ok = true
    for (const [i, part] of wanted.entries()) {
      const found = locate(code, part, from, i === 0 ? span.end : code.length)
      if ('miss' in found) {
        if (found.score > closest.score) closest = found
        ok = false
        break
      }
      from = found.at + part.length
    }
    if (ok) return null
  }
  return `the block is not the code of ${symbol} in ${path}: ${closest.miss}`
}

/** The symbol a permalink names beside it: `](url): \`sym\`` or a `, \`sym\`` at the end of the link text. */
function namedSymbol(raw: string, url: string, occurrence: number): string | null {
  const escaped = url.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const close = new RegExp(`${escaped}>?(?:\\s+"[^"]*")?\\)`, 'g')
  let m: RegExpExecArray | null = null
  const outside = raw.replace(CODE_SPAN, (code) => ' '.repeat(code.length))
  for (let k = 0; k <= occurrence; k++) m = close.exec(outside)
  if (!m) return null
  const text = raw.slice(0, m.index).match(/\[([^\]]*)\]\(<?$/)?.[1] ?? ''
  const after = raw.slice(m.index + m[0].length).match(/^:\s*`([A-Za-z_$][\w$]*)`/)?.[1]
  return after ?? text.match(/,\s*`([A-Za-z_$][\w$]*)`$/)?.[1] ?? null
}

/** The 1-based lines that declare `symbol` in `source`: a keyword declaration (function, const, let, var, class, interface,
type, enum, namespace) or, where none, the lines that quote it as a kind ('x'). A method or a key is neither: it is not declared. */
export function declaredAt(source: string, symbol: string): number[] {
  const name = symbol.replace(/\$/g, '\\$')
  const top = new RegExp(
    `^(?:export\\s+|default\\s+|declare\\s+|async\\s+|abstract\\s+)*(?:(?:const\\s+)?enum|function\\*?|const|let|var|class|interface|type|namespace)\\s+${name}\\b`,
  )
  const topLines = source.split('\n').flatMap((line, i) => (top.test(line) ? [i + 1] : []))
  if (topLines.length > 0) return topLines
  const nested = new RegExp(
    `^\\s*(?:export\\s+|default\\s+|declare\\s+|async\\s+|abstract\\s+)*(?:(?:const\\s+)?enum|function\\*?|const|let|var|class|interface|type|namespace)\\s+${name}\\b`,
  )
  const nestedLines = source.split('\n').flatMap((line, i) => (nested.test(line) ? [i + 1] : []))
  if (nestedLines.length > 0) return nestedLines
  const quoted = new RegExp(`(['"])${name}\\1`)
  return source.split('\n').flatMap((line, i) => (quoted.test(line) ? [i + 1] : []))
}

/** Every finding of one page. `file` is relative to the repo root; `exists` answers for a path relative to it. */
export function checkPage(file: string, text: string, tree: Tree, exists: (path: string) => boolean): Finding[] {
  const findings: Finding[] = []
  const add = (line: number, message: string): void => {
    findings.push({ file, line, message })
  }
  const lines = text.split('\n')

  if (lines[0]?.trim() === '---') add(1, 'frontmatter: GitHub shows it as a table; the title is the # H1')
  const first = lines.findIndex((l) => l.trim() !== '')
  if (first === -1 || !lines[first]?.startsWith('# ')) add(first + 1, 'the page must open with its # H1')

  let fence: { mark: string; lang: string; start: number; body: string[] } | null = null
  lines.forEach((raw, i) => {
    const n = i + 1
    const opener = raw.match(/^\s*(```+|~~~+)(\S*)/)
    if (opener?.[1]) {
      if (fence === null) fence = { mark: opener[1], lang: opener[2] ?? '', start: n, body: [] }
      else if (opener[1].startsWith(fence.mark)) {
        checkBlock(fence, lines[fence.start - 2] ?? '')
        fence = null
      }
      return
    }
    if (fence !== null) {
      fence.body.push(raw)
      return
    }
    if (/^\s*:::/.test(raw)) add(n, '`:::` container: GitHub shows it as text; use a GitHub alert (> [!NOTE])')
    if (/^\s*<[A-Z][\w.]*[\s/>]/.test(raw) || /^\s*<script\b/.test(raw))
      add(n, 'component tag: GitHub shows it as text')

    const links = [...stripInlineCode(raw).matchAll(LINK)]
    for (const [at, m] of links.entries()) {
      const nth = links.slice(0, at).filter((x) => x[2] === m[2]).length
      const target = m[2] ?? ''
      if (target.startsWith('#') || target.startsWith('mailto:')) continue
      if (target.startsWith('/')) {
        add(n, `${target}: a root-absolute link breaks on GitHub; link the file relatively`)
        continue
      }
      if (/^[a-z]+:/i.test(target)) {
        if (target.startsWith(`${REPO_URL}/`)) checkPermalink(target, n, namedSymbol(raw, target, nth))
        continue
      }
      const path = relative('.', resolve(dirname(file), decodeURIComponent(target.split('#')[0] ?? '')))
      if (!path.startsWith(`${GUIDE}/`)) add(n, `${target}: leaves ${GUIDE}/; link code with a link into master`)
      else if (!exists(path)) add(n, `${target}: no such file (${path})`)
    }
  })
  return findings

  function checkBlock(block: { lang: string; start: number; body: string[] }, above: string): void {
    const marker = above.trim().match(SNIPPET)
    if (!marker) {
      if (block.lang === 'ts')
        add(block.start, 'a ts block quotes code: name it on the line above, <!-- snippet: <path> <symbol> -->')
      return
    }
    const problem = checkSnippet(tree, marker[1] ?? '', marker[2] ?? '', block.body)
    if (problem) add(block.start, problem)
  }

  function checkPermalink(url: string, n: number, symbol: string | null): void {
    const link = parsePermalink(url)
    if (link === null) return
    if (link === 'unpinned') return add(n, `${url}: link master, a commit goes stale`)
    const count = tree.lines(link.path)
    if (count === null) return add(n, `${url}: ${link.path} does not exist`)
    if (link.to !== undefined && (link.to > count || (link.from ?? 1) > link.to))
      return add(n, `${url}: lines ${link.from}-${link.to} are outside ${link.path} (${count} lines)`)
    if (symbol === null || link.from === undefined || link.to === undefined) return
    const source = tree.text(link.path)
    if (source === null) return add(n, `${url}: ${link.path} is not a file`)
    const at = declaredAt(source, symbol)
    if (at.length === 0) return add(n, `${url}: ${symbol} is not declared in ${link.path}`)
    if (!at.some((line) => line >= (link.from ?? 0) && line <= (link.to ?? 0)))
      add(n, `${url}: ${symbol} starts at line ${at[0]}, outside lines ${link.from}-${link.to}`)
  }
}

function git(args: string[]): { ok: boolean; out: string } {
  const proc = Bun.spawnSync(['git', ...args], { stdout: 'pipe', stderr: 'pipe' })
  return { ok: proc.exitCode === 0, out: proc.stdout.toString() }
}

function checkout(): Tree {
  const texts = new Map<string, string | null>()
  const text = (path: string): string | null => {
    if (!texts.has(path))
      texts.set(path, existsSync(path) && statSync(path).isFile() ? readFileSync(path, 'utf8') : null)
    return texts.get(path) ?? null
  }
  return {
    text,
    lines(path) {
      if (!existsSync(path)) return null
      const body = text(path)
      return body === null ? 0 : body.split('\n').length - 1
    },
  }
}

function pages(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) return SKIP_DIRS.has(name) ? [] : pages(path)
    return name.endsWith('.md') ? [path] : []
  })
}

if (import.meta.main) {
  const root = git(['rev-parse', '--show-toplevel']).out.trim()
  process.chdir(root)
  const tree = checkout()
  const files = pages(GUIDE)
  const findings = files.flatMap((f) => checkPage(f, readFileSync(f, 'utf8'), tree, (p) => existsSync(p)))
  for (const f of findings) console.error(`${f.file}:${f.line}: ${f.message}`)
  if (findings.length > 0) {
    console.error(`guide-links: ${findings.length} finding(s) in ${files.length} page(s)`)
    process.exit(1)
  }
  console.error(`guide-links: ${files.length} page(s) clean`)
}
