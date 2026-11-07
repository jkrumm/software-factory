#!/usr/bin/env bun
/**
 * The server's boundary rules from `docs/architecture.md` §The server, checked on the import graph of
 * `apps/server/src`. A folder that does not exist yet has nothing to break. Run by `make check`; exits 1 on a violation.
 */
import { readdir, readFile } from 'node:fs/promises'
import { dirname, join, relative, resolve, sep } from 'node:path'

export interface Violation {
  file: string
  rule: string
  detail: string
}

const LAYERS = ['kernel', 'domains', 'app', 'adapters', 'api', 'read'] as const
type Layer = (typeof LAYERS)[number] | 'root'

/** Packages and modules a domain may never import: I/O, the web framework, SQL clients. */
const DOMAIN_FORBIDDEN_MODULES: RegExp[] = [
  /^elysia$/,
  /^@elysiajs\//,
  /^bun$/,
  /^bun:/,
  /^postgres$/,
  /^pg$/,
  /^pg-/,
  /^(node:)?(fs|fs\/promises|child_process|net|http|https|http2|dgram|dns|tls|os|cluster|worker_threads|readline)$/,
]

/** `Bun.*` members a domain may use: pure helpers, no I/O. */
const DOMAIN_BUN_ALLOWED = new Set(['hash', 'deepEquals', 'escapeHTML', 'stringWidth', 'CryptoHasher'])

/** SQL that writes; `read/` holds only reads. */
const WRITING_SQL =
  /\b(INSERT\s+INTO|UPDATE\s+[\w."]+\s+SET|DELETE\s+FROM|TRUNCATE|ALTER\s+TABLE|DROP\s+\w+|CREATE\s+\w+)\b/i

/** Opens a transaction on Bun's SQL client. */
const OPENS_TRANSACTION = /\.(begin|beginDistributed|transaction)\s*\(/

/** The only two files that may open one: the unit of work (which `app/` gets as a port) and the migration runner. */
const TRANSACTION_ADAPTERS = new Set(['adapters/postgres/unit-of-work.ts', 'adapters/postgres/migrate.ts'])

/** An intake source: it reads the outside world and hands signals to the sink, and touches nothing else of the server. */
const INTAKE_POLLER = /^adapters\/intake\/(github|beszel|launchd)\.ts$/

interface Import {
  specifier: string
  typeOnly: boolean
}

/** Drops comments so a word in a comment is no import and no `Bun.` call; strings stay, they hold the specifiers. */
export function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:'"`\\])\/\/[^\n]*/g, '$1')
}

export function importsOf(source: string): Import[] {
  const code = stripComments(source)
  const found: Import[] = []
  const statement = /(?:^|[;\n])\s*(import|export)\s+(type\s+)?(?:[^'";]*?\s+from\s+)?['"]([^'"]+)['"]/g
  for (const match of code.matchAll(statement)) {
    if (match[3]) found.push({ specifier: match[3], typeOnly: Boolean(match[2]) })
  }
  for (const match of code.matchAll(/\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)|\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g)) {
    const specifier = match[1] ?? match[2]
    if (specifier) found.push({ specifier, typeOnly: false })
  }
  return found
}

interface Place {
  layer: Layer
  /** the domain folder, for `domains/<d>/…` */
  domain?: string
}

function placeOf(root: string, file: string): Place {
  const parts = relative(root, file).split(sep)
  const layer = LAYERS.find((name) => name === parts[0])
  if (!layer) return { layer: 'root' }
  if (layer === 'domains') return parts.length > 2 ? { layer, domain: parts[1] } : { layer }
  return { layer }
}

async function sourceFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) return entry.name === 'node_modules' ? [] : sourceFiles(path)
      return /\.(ts|tsx|mts)$/.test(entry.name) ? [path] : []
    }),
  )
  return nested.flat()
}

/** Every violation under `root` (the server's `src`), sorted by file. */
export async function checkBoundaries(root: string): Promise<Violation[]> {
  const violations: Violation[] = []
  for (const file of (await sourceFiles(root)).sort()) {
    const source = await readFile(file, 'utf8')
    const here = placeOf(root, file)
    const name = relative(root, file)
    const flag = (rule: string, detail: string) => violations.push({ file: name, rule, detail })
    const domainsReached = new Set<string>()

    for (const { specifier, typeOnly } of importsOf(source)) {
      const internal = specifier.startsWith('.')
      const target = internal ? resolve(dirname(file), specifier) : undefined
      const inside = target !== undefined && !relative(root, target).startsWith('..')
      const there = target && inside ? placeOf(root, target) : undefined

      if (here.layer === 'kernel' && internal && there?.layer !== 'kernel') {
        flag('kernel imports nothing of the server', specifier)
      }
      if (here.layer === 'domains') {
        if (internal && !(there?.layer === 'kernel' || (there?.layer === 'domains' && there.domain === here.domain))) {
          flag('a domain imports only kernel and its own folder', specifier)
        }
        if (!internal && DOMAIN_FORBIDDEN_MODULES.some((pattern) => pattern.test(specifier))) {
          flag('a domain does no I/O: no elysia, SQL client, node:fs or bun module', specifier)
        }
      }
      if (here.layer === 'read' && there?.layer === 'domains' && !typeOnly) {
        flag('read/ imports only types from a domain, never code that writes', specifier)
      }
      if (here.layer === 'read' && there?.layer === 'app') {
        flag('read/ imports no use case: they write', specifier)
      }
      if (here.layer === 'app' && there?.layer === 'adapters') {
        flag('app/ imports no adapter: it gets ports, main.ts composes them', specifier)
      }
      if (INTAKE_POLLER.test(name.split(sep).join('/'))) {
        const resolved = target ? relative(root, target).split(sep).join('/') : ''
        const reachesStore = /^adapters\/(postgres\/|intake\/store)/.test(resolved)
        const otherDomain = there?.layer === 'domains' && there.domain !== 'intake'
        if (internal && (there?.layer === 'app' || there?.layer === 'read' || otherDomain || reachesStore)) {
          flag(
            'an intake source reaches the server only through the IntakeSink: no app, read, store or other domain',
            specifier,
          )
        }
        if (!internal && specifier === 'bun') flag('an intake source holds no database client', specifier)
      }
      if (there?.layer === 'domains' && there.domain) domainsReached.add(there.domain)
    }

    if (here.layer !== 'app' && here.layer !== 'domains' && domainsReached.size > 1) {
      flag('only app/ imports from more than one domain', [...domainsReached].sort().join(', '))
    }
    if (here.layer === 'domains') {
      const code = stripComments(source)
      for (const match of code.matchAll(/\bBun\.([A-Za-z$_]+)/g)) {
        if (match[1] && !DOMAIN_BUN_ALLOWED.has(match[1])) flag('a domain does no I/O: no Bun.* I/O', `Bun.${match[1]}`)
      }
      if (/\bfetch\s*\(/.test(code)) flag('a domain does no I/O: no fetch', 'fetch(')
    }
    const opens = OPENS_TRANSACTION.exec(stripComments(source))
    if (opens && !TRANSACTION_ADAPTERS.has(name.split(sep).join('/'))) {
      flag('only the Postgres unit of work and the migration runner open a transaction', opens[0])
    }
    if (here.layer === 'read') {
      const write = WRITING_SQL.exec(stripComments(source))
      if (write) flag('read/ is read-only: no SQL that writes', write[0])
    }
  }
  return violations
}

/** The only modules `factory hook` may load: it runs inside every Claude Code hook and prints on stdout only when told to. */
const HOOK_ALLOWED = new Set(['node:fs', '@software-factory/contract/spool'])

/** The hook's import rule (`AGENTS.md`, Hooks): `node:fs` and the contract's spool module, nothing else. */
export function checkHook(source: string, name = 'apps/cli/src/hook.ts'): Violation[] {
  return importsOf(source)
    .filter(({ specifier }) => !HOOK_ALLOWED.has(specifier))
    .map(({ specifier }) => ({
      file: name,
      rule: 'the hook imports only node:fs and the contract spool module',
      detail: specifier,
    }))
}

export const HOOK_FILE = join(import.meta.dir, '..', 'apps', 'cli', 'src', 'hook.ts')

export const SERVER_SRC = join(import.meta.dir, '..', 'apps', 'server', 'src')

if (import.meta.main) {
  const violations = [...(await checkBoundaries(SERVER_SRC)), ...checkHook(await readFile(HOOK_FILE, 'utf8'))]
  for (const v of violations) console.error(`${v.file}: ${v.rule} (${v.detail})`)
  if (violations.length) {
    console.error(`${violations.length} boundary violation(s); docs/architecture.md §The server has the rules`)
    process.exit(1)
  }
  console.log('boundaries hold')
}
