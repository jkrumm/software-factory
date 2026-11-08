#!/usr/bin/env bun
/**
 * The words `docs/language.md` retires, found in `apps/`, `packages/`, `tests/` and `scripts/`: whole words,
 * case-insensitive, in identifiers (camelCase, snake_case and kebab-case are split into words), strings and comments.
 * `docs/` is not scanned. An exception is a line in `retired-words.allow` with its reason. Run by
 * `make check`; exits 1 on a finding, a reasonless exception or an exception that no longer matches anything.
 * `--files <paths…>` scans exactly those files (relative to the repo root, docs included) for the hygiene sweep.
 */
import { readdir, readFile } from 'node:fs/promises'
import { join, relative } from 'node:path'

export interface Retired {
  /** the key an exception names */
  term: string
  /** matched against the normalized text (lowercase, identifiers split into words), between word boundaries */
  pattern: string
  /** what to say instead */
  use: string
}

/**
 * One line per retired word, from the Retires cells of `docs/language.md`. Left out on purpose, because the plain
 * English word collides with code and the factory sense cannot be matched precisely: request (HTTP), item, task,
 * track, worker, document, question, ask, and hold (triage's `held` and the memory hold are live words).
 * Tool names on screen are a Console rule, not a word: `hyperdx` and `beszel` stay as signal sources.
 */
export const RETIRED: Retired[] = [
  { term: 'mother', pattern: 'mothers?', use: 'lead' },
  { term: 'wave', pattern: 'waves?', use: 'plan (rows of docs/plan.yaml)' },
  { term: 'initiative', pattern: 'initiatives?', use: 'plan' },
  { term: 'park', pattern: 'park(s|ed|ing)?', use: 'stall' },
  { term: 'manifest', pattern: 'manifests?', use: 'project (project.yaml)' },
  { term: 'ticket', pattern: 'tickets?', use: 'Issue' },
  { term: 'linked issue', pattern: 'linked\\s+issues?', use: 'chain' },
  { term: 'scorer', pattern: 'scorers?', use: 'loop' },
  { term: 'babysitter', pattern: 'babysitters?', use: 'loop' },
  { term: 'ask judge', pattern: 'ask\\s+judges?', use: 'Judge' },
  { term: 'light review', pattern: 'light\\s+reviews?', use: 'review (standard or deep)' },
  { term: 'per-commit coverage', pattern: 'per\\s+commit\\s+coverage', use: 'review, once per ship range' },
  { term: 'taste gate', pattern: 'taste\\s+gates?', use: 'checkpoint' },
  { term: 'decision card', pattern: 'decision\\s+cards?', use: 'Decision' },
  { term: 'hands-only', pattern: 'hands\\s+only', use: 'errand' },
  { term: 'human queue', pattern: 'human\\s+queues?', use: 'errand' },
  { term: 'zero-touch', pattern: 'zero\\s+touch', use: 'touch, avoidable touch' },
  { term: 'classify', pattern: 'classif(y|ies|ied|ying|ier|iers)', use: 'triage' },
  { term: 'dedup', pattern: 'dedup(e|es|ed|ing|licate|licated|lication)?', use: 'triage (amend or incident)' },
]

const MATCHERS = RETIRED.map((r) => ({ ...r, regex: new RegExp(`\\b(?:${r.pattern})\\b`, 'gi') }))

/** Splits identifiers into words: `askJudge`, `ask_judge` and `ask-judge` all read `ask judge`. */
export function normalize(line: string): string {
  return line
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .toLowerCase()
}

export interface Finding {
  file: string
  line: number
  term: string
  found: string
  use: string
}

export interface Exception {
  file: string
  /** a term's key, or `*` for every term */
  term: string
  reason: string
  /** the line in the allow file */
  at: number
}

export function findingsIn(file: string, text: string): Finding[] {
  const findings: Finding[] = []
  text.split('\n').forEach((raw, i) => {
    const line = normalize(raw)
    for (const m of MATCHERS) {
      for (const match of line.matchAll(m.regex)) {
        findings.push({ file, line: i + 1, term: m.term, found: match[0], use: m.use })
      }
    }
  })
  return findings
}

/** `<path> <term or *>  # <reason>`; a line without a reason is returned as a problem. */
export function parseExceptions(text: string): { exceptions: Exception[]; problems: string[] } {
  const exceptions: Exception[] = []
  const problems: string[] = []
  const terms = new Set(RETIRED.map((r) => r.term))
  text.split('\n').forEach((raw, i) => {
    const line = raw.trim()
    if (!line || line.startsWith('#')) return
    const [spec = '', ...rest] = line.split('#')
    const reason = rest.join('#').trim()
    const match = /^(\S+)\s+(.+?)\s*$/.exec(spec.trim())
    if (!match?.[1] || !match[2] || !reason) {
      problems.push(`retired-words.allow:${i + 1}: needs "<path> <term or *>  # <reason>"`)
      return
    }
    if (match[2] !== '*' && !terms.has(match[2])) {
      problems.push(`retired-words.allow:${i + 1}: "${match[2]}" is not a retired term`)
      return
    }
    exceptions.push({ file: match[1], term: match[2], reason, at: i + 1 })
  })
  return { exceptions, problems }
}

const SCANNED = ['apps', 'packages', 'tests', 'scripts']
const SKIPPED_DIRS = new Set(['node_modules', 'dist', '.git'])
const TEXT_FILE = /\.(ts|tsx|mts|js|mjs|json|sql|sh|ya?ml|md|toml|txt|css|html)$|^[^.]+$/

async function filesUnder(root: string, dir: string): Promise<string[]> {
  const entries = await readdir(join(root, dir), { withFileTypes: true }).catch(() => [])
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) return SKIPPED_DIRS.has(entry.name) ? [] : filesUnder(root, path)
      return entry.isFile() && TEXT_FILE.test(entry.name) ? [path] : []
    }),
  )
  return nested.flat()
}

/** The findings in `files` (relative to `root`) that no exception covers, marking the exceptions used. */
async function scan(root: string, files: string[], exceptions: Exception[], used: Set<Exception>): Promise<string[]> {
  const out: string[] = []
  for (const file of files) {
    const name = relative(root, join(root, file))
    for (const f of findingsIn(name, await readFile(join(root, file), 'utf8'))) {
      const exception = exceptions.find((e) => e.file === f.file && (e.term === '*' || e.term === f.term))
      if (exception) {
        used.add(exception)
        continue
      }
      out.push(`${f.file}:${f.line}: "${f.found}" is retired (docs/language.md); say ${f.use}`)
    }
  }
  return out
}

/** Every finding not covered by an exception, and every problem with the exceptions themselves. */
export async function checkRetiredWords(root: string, allowText: string): Promise<string[]> {
  const { exceptions, problems } = parseExceptions(allowText)
  const used = new Set<Exception>()
  const files = (await Promise.all(SCANNED.map((dir) => filesUnder(root, dir)))).flat().sort()
  const out = [...problems, ...(await scan(root, files, exceptions, used))]
  for (const e of exceptions) {
    if (!used.has(e)) out.push(`retired-words.allow:${e.at}: ${e.file} ${e.term} matches nothing any more; delete it`)
  }
  return out
}

/** `--files` mode: exactly `files`, with the exceptions that name them; an exception left unused is not reported. */
export async function checkRetiredWordsIn(root: string, files: string[], allowText: string): Promise<string[]> {
  const { exceptions, problems } = parseExceptions(allowText)
  return [...problems, ...(await scan(root, files, exceptions, new Set()))]
}

export const ROOT = join(import.meta.dir, '..')
export const ALLOW_FILE = join(import.meta.dir, 'retired-words.allow')

if (import.meta.main) {
  const args = process.argv.slice(2)
  const allowText = await readFile(ALLOW_FILE, 'utf8')
  const problems =
    args[0] === '--files'
      ? await checkRetiredWordsIn(ROOT, args.slice(1), allowText)
      : await checkRetiredWords(ROOT, allowText)
  for (const line of problems) console.error(line)
  if (problems.length) process.exit(1)
  console.log('no retired words')
}
