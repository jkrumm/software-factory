#!/usr/bin/env bun
/**
 * The guide (`docs/guide/`) is one Markdown source for two renderings, github.com and the VitePress site, and its code
 * links are permalinks that must hold at the commit they were written against. This check holds both, offline:
 *
 * - every page opens with its `# H1` and uses no frontmatter, no `:::` container and no component tag (GitHub shows
 *   them as raw text);
 * - a relative link or image resolves to a file inside `docs/guide/`; a root-absolute link (`/x`) is refused, it
 *   breaks on GitHub;
 * - a link into this repo on GitHub (`blob/` or `tree/`) names a full commit sha, never a branch; the commit is on
 *   master (`origin/master`, else `HEAD`), holds the path, and holds every line a `#Lx-Ly` anchor names.
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

/** A link into this repo pinned to a commit: `blob/<sha>/<path>#L3-L9` or `tree/<sha>/<path>`. */
export interface Permalink {
  sha: string
  path: string
  from?: number
  to?: number
}

/** What the git side answers; the real one reads the repo, tests pass a fake. */
export interface Git {
  /** the commit exists and is an ancestor of master */
  onMaster(sha: string): boolean
  /** the path's line count at the commit (a directory: 0), or null when the commit does not hold it */
  lines(sha: string, path: string): number | null
}

const LINK = /(!?)\[[^\]]*\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g

/** The text of a line outside inline code spans, so a link written as code is not a link. */
function stripInlineCode(line: string): string {
  return line.replace(/(`+)[\s\S]*?\1/g, '')
}

/** Parses a GitHub URL into this repo; null when it is not one, 'unpinned' when it names a branch. */
export function parsePermalink(url: string): Permalink | 'unpinned' | null {
  if (!url.startsWith(`${REPO_URL}/blob/`) && !url.startsWith(`${REPO_URL}/tree/`)) return null
  const rest = url.slice(REPO_URL.length + '/blob/'.length)
  const [pathPart = '', anchor] = rest.split('#')
  const slash = pathPart.indexOf('/')
  const ref = slash === -1 ? pathPart : pathPart.slice(0, slash)
  if (!/^[0-9a-f]{40}$/.test(ref)) return 'unpinned'
  const path = slash === -1 ? '' : decodeURIComponent(pathPart.slice(slash + 1))
  const range = anchor?.match(/^L(\d+)(?:-L(\d+))?$/)
  if (!range) return { sha: ref, path }
  const from = Number(range[1])
  return { sha: ref, path, from, to: range[2] ? Number(range[2]) : from }
}

/** Every finding of one page. `file` is relative to the repo root; `exists` answers for a path relative to it. */
export function checkPage(file: string, text: string, git: Git, exists: (path: string) => boolean): Finding[] {
  const findings: Finding[] = []
  const add = (line: number, message: string): void => {
    findings.push({ file, line, message })
  }
  const lines = text.split('\n')

  if (lines[0]?.trim() === '---') add(1, 'frontmatter: GitHub shows it as a table; the title is the # H1')
  const first = lines.findIndex((l) => l.trim() !== '')
  if (first === -1 || !lines[first]?.startsWith('# ')) add(first + 1, 'the page must open with its # H1')

  let fence: string | null = null
  lines.forEach((raw, i) => {
    const n = i + 1
    const opener = raw.match(/^\s*(```+|~~~+)/)
    if (opener?.[1]) {
      if (fence === null) fence = opener[1]
      else if (opener[1].startsWith(fence)) fence = null
      return
    }
    if (fence !== null) return
    if (/^\s*:::/.test(raw)) add(n, '`:::` container: GitHub shows it as text; use a GitHub alert (> [!NOTE])')
    if (/^\s*<[A-Z][\w.]*[\s/>]/.test(raw) || /^\s*<script\b/.test(raw))
      add(n, 'component tag: GitHub shows it as text')

    for (const m of stripInlineCode(raw).matchAll(LINK)) {
      const target = m[2] ?? ''
      if (target.startsWith('#') || target.startsWith('mailto:')) continue
      if (target.startsWith('/')) {
        add(n, `${target}: a root-absolute link breaks on GitHub; link the file relatively`)
        continue
      }
      if (/^[a-z]+:/i.test(target)) {
        if (target.startsWith(`${REPO_URL}/`)) checkPermalink(target, n)
        continue
      }
      const path = relative('.', resolve(dirname(file), decodeURIComponent(target.split('#')[0] ?? '')))
      if (!path.startsWith(`${GUIDE}/`)) add(n, `${target}: leaves ${GUIDE}/; link code with a permalink to a commit`)
      else if (!exists(path)) add(n, `${target}: no such file (${path})`)
    }
  })
  return findings

  function checkPermalink(url: string, n: number): void {
    const link = parsePermalink(url)
    if (link === null) return
    if (link === 'unpinned') return add(n, `${url}: pin it to a full commit sha, a branch moves`)
    if (!git.onMaster(link.sha)) return add(n, `${url}: commit ${link.sha.slice(0, 12)} is not on master`)
    const count = git.lines(link.sha, link.path)
    if (count === null) return add(n, `${url}: ${link.path} does not exist at ${link.sha.slice(0, 12)}`)
    if (link.to !== undefined && (link.to > count || (link.from ?? 1) > link.to))
      add(
        n,
        `${url}: lines ${link.from}-${link.to} are outside ${link.path} (${count} lines) at ${link.sha.slice(0, 12)}`,
      )
  }
}

function git(args: string[]): { ok: boolean; out: string } {
  const proc = Bun.spawnSync(['git', ...args], { stdout: 'pipe', stderr: 'pipe' })
  return { ok: proc.exitCode === 0, out: proc.stdout.toString() }
}

function repoGit(): Git {
  const master = git(['rev-parse', '--verify', '--quiet', 'origin/master']).ok ? 'origin/master' : 'HEAD'
  const onMaster = new Map<string, boolean>()
  const lines = new Map<string, number | null>()
  return {
    onMaster(sha) {
      if (!onMaster.has(sha)) onMaster.set(sha, git(['merge-base', '--is-ancestor', sha, master]).ok)
      return onMaster.get(sha) ?? false
    },
    lines(sha, path) {
      const key = `${sha}:${path}`
      if (!lines.has(key)) {
        const type = git(['cat-file', '-t', key])
        if (!type.ok) lines.set(key, null)
        else if (type.out.trim() !== 'blob') lines.set(key, 0)
        else lines.set(key, git(['cat-file', '-p', key]).out.split('\n').length - 1)
      }
      return lines.get(key) ?? null
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
  const repo = repoGit()
  const files = pages(GUIDE)
  const findings = files.flatMap((f) => checkPage(f, readFileSync(f, 'utf8'), repo, (p) => existsSync(p)))
  for (const f of findings) console.error(`${f.file}:${f.line}: ${f.message}`)
  if (findings.length > 0) {
    console.error(`guide-links: ${findings.length} finding(s) in ${files.length} page(s)`)
    process.exit(1)
  }
  console.error(`guide-links: ${files.length} page(s) clean`)
}
