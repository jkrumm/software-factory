import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { basename, dirname, join, posix } from 'node:path'
import { gitOut, gitTry, type Tools } from '../git.ts'
import { type Outcome, clean, finding, found, skipped } from './finding.ts'

const FENCE = /^ {0,3}(`{3,}|~{3,})\s*([^\s`]*)(.*)$/
const SHELL_LANGS = new Set(['sh', 'bash', 'console', 'shell', 'zsh'])
const INLINE_CODE = /(`+)([^`]+?)\1/g
const BUN_BUILTINS = new Set([
  'install',
  'i',
  'add',
  'a',
  'remove',
  'rm',
  'update',
  'upgrade',
  'link',
  'unlink',
  'pm',
  'build',
  'test',
  'run',
  'x',
  'init',
  'create',
  'repl',
  'outdated',
  'audit',
  'publish',
  'patch',
  'exec',
  'completions',
  'help',
  'info',
  'why',
  'ci',
  'pack',
])
const FILE_EXTENSIONS = /\.(?:ts|tsx|js|jsx|mjs|cjs|md|sh|json|ya?ml|sql|toml|css|html|plist|swift|py|rs)$/
const SKIP_ROOTS = new Set([
  'node_modules',
  'dist',
  'build',
  'out',
  'coverage',
  'tmp',
  'var',
  'etc',
  'usr',
  'opt',
  'home',
  'dev',
  'proc',
])

export type Claim = { kind: 'make' | 'script' | 'file' | 'path'; line: number; value: string }

/** Frozen records: a README under one of these directories describes a past state on purpose. */
const FROZEN_DIRS = new Set(['evidence', 'archive', 'archives', 'history'])
/** A paragraph that talks about another repository (a phrase, or the name of a directory beside this repo): what it names is not expected in this checkout. */
const FOREIGN = /\b(?:not in this repo|other repos?|another repo(?:sitory)?|elsewhere|lives in)\b/i

/** The words of one command: a leading `$ ` prompt and `VAR=x` assignments dropped. */
function words(segment: string): string[] {
  const parts = segment
    .trim()
    .replace(/^\$\s+/, '')
    .split(/\s+/)
  while (parts.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(parts[0] ?? '')) parts.shift()
  return parts
}

const isTarget = (word: string): boolean => /^[a-z][\w.-]*$/.test(word)

/** What a shell command (`&&`, `;`, `|` separated) claims exists: Make targets, package scripts, script files. */
export function commandClaims(command: string, line: number): Claim[] {
  const claims: Claim[] = []
  for (const segment of command.split(/&&|\|\||;|\|/)) {
    const [cmd, ...args] = words(segment)
    if (cmd === 'make') {
      if (args.some((a) => a === '-C' || a === '-f' || a.startsWith('--directory') || a.startsWith('--file'))) continue
      const target = args.find((a) => !a.startsWith('-'))
      if (target && isTarget(target)) claims.push({ kind: 'make', line, value: target })
      continue
    }
    if (cmd !== 'bun' && cmd !== 'npm' && cmd !== 'pnpm' && cmd !== 'yarn') continue
    const explicitRun = args[0] === 'run' || args[0] === 'run-script'
    const first = explicitRun ? args[1] : cmd === 'bun' ? args[0] : undefined
    if (!first || first.startsWith('-') || /[<$*{]/.test(first)) continue
    if (args.some((a) => a.startsWith('--filter') || a.startsWith('--cwd') || a === '-w' || a === '--workspace'))
      continue
    if (!explicitRun && BUN_BUILTINS.has(first)) continue
    if (first.includes('/') || /\.[cm]?[jt]sx?$/.test(first)) {
      if (!first.startsWith('/') && !first.startsWith('~'))
        claims.push({ kind: 'file', line, value: first.replace(/^\.\//, '') })
    } else if (/^[A-Za-z][\w:.-]*$/.test(first)) claims.push({ kind: 'script', line, value: first })
  }
  return claims
}

/** A code span that is exactly one repo path: has a `/`, no glob, placeholder, variable, URL, `~` or absolute start. */
export function pathClaim(span: string): string | undefined {
  const token = span.trim().replace(/:\d+(?::\d+)?$/, '')
  if (!token || /\s/.test(token) || !token.includes('/')) return undefined
  if (
    /[*?[\]{}<>$~\\|=,;'"()@#%!]/.test(token) ||
    token.includes('://') ||
    token.startsWith('/') ||
    token.includes('..')
  )
    return undefined
  const normal = token.replace(/^\.\//, '')
  const segments = normal.split('/').filter(Boolean)
  const [root = ''] = segments
  if (SKIP_ROOTS.has(root) || /^[\w-]+\.[a-z]{2,}$/i.test(root)) return undefined
  if (segments.some((s) => !/^[\w.@+-]+$/.test(s))) return undefined
  if (!normal.endsWith('/') && !FILE_EXTENSIONS.test(segments.at(-1) ?? '')) return undefined
  return normal
}

const escape = (name: string): string => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** A name of a directory beside the repo, as a whole word (hyphen and path characters do not end it); names under 4 characters are too common to mean a repo. */
function siblingPattern(siblings: string[]): RegExp | undefined {
  const names = siblings.filter((n) => n.length >= 4 && /^[\w.-]+$/.test(n)).map(escape)
  return names.length ? new RegExp(`(?<![\\w./-])(?:${names.join('|')})(?![\\w-])`) : undefined
}

/** The names of the directories next to the main checkout of the repo (the checkout itself excluded). */
export async function siblingNames(tools: Tools, path: string): Promise<string[]> {
  const common = (await gitTry(tools, path, ['rev-parse', '--path-format=absolute', '--git-common-dir']))?.trim()
  if (!common) return []
  const main = basename(common) === '.git' ? dirname(common) : common
  try {
    return readdirSync(dirname(main)).filter((n) => !n.startsWith('.') && n !== basename(main))
  } catch {
    return []
  }
}

/** The lines of paragraphs (blank-line separated, outside fences) that talk about another repository. */
function foreignLines(lines: string[], siblings: RegExp | undefined): Set<number> {
  const out = new Set<number>()
  let paragraph: number[] = []
  let fence = false
  const flush = () => {
    if (paragraph.some((n) => FOREIGN.test(lines[n - 1] ?? '') || siblings?.test(lines[n - 1] ?? '')))
      for (const n of paragraph) out.add(n)
    paragraph = []
  }
  lines.forEach((raw, index) => {
    if (FENCE.test(raw)) {
      flush()
      fence = !fence
      return
    }
    if (fence) return
    if (!raw.trim()) flush()
    else paragraph.push(index + 1)
  })
  flush()
  return out
}

/** The claims of a README: code spans and `sh`/`bash`/`console` fences, outside blocks marked as examples or output. */
export function readmeClaims(text: string, siblings: string[] = []): Claim[] {
  const claims: Claim[] = []
  const lines = text.split('\n')
  const foreign = foreignLines(lines, siblingPattern(siblings))
  let fence: { mark: string; shell: boolean } | undefined
  lines.forEach((raw, index) => {
    const line = index + 1
    if (foreign.has(line)) return
    const opening = FENCE.exec(raw)
    if (opening) {
      const mark = opening[1] ?? '```'
      if (!fence) {
        const lang = (opening[2] ?? '').toLowerCase()
        const marked = /example|output/i.test(opening[3] ?? '')
        fence = { mark, shell: SHELL_LANGS.has(lang) && !marked }
      } else if (mark[0] === fence.mark[0] && mark.length >= fence.mark.length && !opening[2] && !opening[3])
        fence = undefined
      return
    }
    if (fence) {
      const command = raw.trim()
      if (!fence.shell || !command || command.startsWith('#')) return
      claims.push(...commandClaims(command, line))
      return
    }
    for (const match of raw.matchAll(INLINE_CODE)) {
      const span = (match[2] ?? '').trim()
      if (/^(?:make|bun|npm|pnpm|yarn)\s/.test(span)) {
        claims.push(...commandClaims(span, line))
        continue
      }
      // `Other's `docs/x.md``: a path of somebody else's project.
      if (/['\u2019]s\s*$/.test(`${lines[index - 1] ?? ''} ${raw.slice(0, match.index)}`)) continue
      const path = pathClaim(span)
      if (path) claims.push({ kind: 'path', line, value: path })
    }
  })
  return claims
}

/** The targets a Makefile defines as rules. `.PHONY` and other special targets, assignments, recipes and patterns do not count. */
export function makeTargets(makefile: string): { targets: Set<string>; includes: boolean } {
  const targets = new Set<string>()
  let includes = false
  for (const raw of makefile.split('\n')) {
    if (/^-?include\s/.test(raw)) includes = true
    if (!raw || /^[\t #]/.test(raw) || /^[\w.-]+\s*[:+?!]?=/.test(raw)) continue
    const rule = /^([^\s:=#][^:=#]*?)\s*::?(?!=)/.exec(raw)
    for (const name of (rule?.[1] ?? '').split(/\s+/)) {
      if (name && !name.startsWith('.') && !/[%$()]/.test(name)) targets.add(name)
    }
  }
  return { targets, includes }
}

const readText = (root: string, file: string): string | undefined => {
  try {
    return readFileSync(join(root, file), 'utf8')
  } catch {
    return undefined
  }
}

/** `dir` and each parent up to the root (`''`). */
function ancestors(dir: string): string[] {
  const out: string[] = []
  for (let d = dir; d && d !== '.'; d = posix.dirname(d)) out.push(d)
  out.push('')
  return out
}

function packageScripts(root: string, file: string): Set<string> | undefined {
  const text = readText(root, file)
  if (text === undefined) return undefined
  try {
    return new Set(Object.keys((JSON.parse(text) as { scripts?: Record<string, unknown> } | null)?.scripts ?? {}))
  } catch {
    return undefined
  }
}

/** The README's claims the repo contradicts, as `line: what`. Looks in the README's directory and each parent. */
async function missing(
  tools: Tools,
  root: string,
  readme: string,
  text: string,
  siblings: string[],
): Promise<string[]> {
  const dirs = ancestors(posix.dirname(readme) === '.' ? '' : posix.dirname(readme))
  const out: string[] = []
  const seen = new Set<string>()
  for (const claim of readmeClaims(text, siblings)) {
    const mark = `${claim.kind}:${claim.value}`
    if (seen.has(mark)) continue
    seen.add(mark)
    if (claim.kind === 'make') {
      const makefiles = dirs.map((d) => readText(root, posix.join(d, 'Makefile'))).filter((m) => m !== undefined)
      if (!makefiles.length) continue
      if (makefiles.map(makeTargets).some((m) => m.includes || m.targets.has(claim.value))) continue
      out.push(`${claim.line}: make ${claim.value} (no such target)`)
    } else if (claim.kind === 'script') {
      const scripts = dirs
        .map((d) => packageScripts(root, posix.join(d, 'package.json')))
        .filter((s) => s !== undefined)
      if (!scripts.length || scripts.some((s) => s.has(claim.value))) continue
      out.push(`${claim.line}: script ${claim.value} (not in package.json)`)
    } else {
      const [top = ''] = claim.value.split('/')
      if (!dirs.some((d) => existsSync(join(root, d, top)))) continue
      const candidates = dirs.map((d) => posix.join(d, claim.value))
      if (candidates.some((c) => existsSync(join(root, c)))) continue
      if ((await gitTry(tools, root, ['check-ignore', '-q', '--', ...candidates])) !== undefined) continue
      out.push(`${claim.line}: ${claim.value} (not in the repo)`)
    }
  }
  return out
}

/** Every command and path a tracked `README.md` names exists: Makefile targets, package scripts, script files, repo paths. */
export async function readmeProbe(tools: Tools, path: string): Promise<Outcome> {
  const readmes = (await gitOut(tools, path, ['ls-files', '-z']))
    .split('\0')
    .filter((f) => basename(f) === 'README.md' && !f.split('/').some((s) => s === 'node_modules' || FROZEN_DIRS.has(s)))
  if (!readmes.length) return skipped('no README.md')
  const siblings = await siblingNames(tools, path)
  const findings = []
  for (const readme of readmes) {
    const text = readText(path, readme)
    if (text === undefined) continue
    const lines = await missing(tools, path, readme, text, siblings)
    if (!lines.length) continue
    findings.push(
      finding(
        'readme',
        `readme:${readme}`,
        `Hygiene: README names things that do not exist in ${readme}`,
        lines,
        lines.length,
      ),
    )
  }
  const detail = `${readmes.length} README files`
  return findings.length ? found(detail, findings) : clean(detail)
}
