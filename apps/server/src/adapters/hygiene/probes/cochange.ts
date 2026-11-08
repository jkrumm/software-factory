import { existsSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { gitOut, type Tools } from '../git.ts'
import { type Outcome, clean, finding, found } from './finding.ts'

const COMMITS = 300
const MIN_FILES = 2
const MAX_FILES = 25
const MIN_TOGETHER = 6
const MIN_SHARE = 0.7
const TOP = 3

const IGNORED = [
  /(^|\/)(bun\.lockb?|package-lock\.json|pnpm-lock\.yaml|yarn\.lock|Cargo\.lock|uv\.lock|poetry\.lock)$/,
  /\.md$/,
  /^docs\//,
  /(^|\/)generated\//,
  /(^|\/)migrations\//,
  /(^|\/)fixtures\//,
  /__snapshots__/,
  /evidence.*\.(png|svg|json)$/,
  /(^|\/)(test|tests)\//,
  /\.(test|spec)\./,
]

const stem = (file: string): string => basename(file).split('.')[0] ?? ''

/** Files that change with their own derivations or their own tests say nothing about hidden coupling. */
export const ignored = (file: string): boolean => IGNORED.some((pattern) => pattern.test(file))

/** The changed files of each commit (`%x00%H` then `--name-only`), the ignored ones removed. */
export function parseLog(log: string): string[][] {
  return log
    .split('\0')
    .slice(1)
    .map((block) =>
      block
        .split('\n')
        .slice(1)
        .map((line) => line.trim())
        .filter((file) => file && !ignored(file)),
    )
}

export interface Pair {
  a: string
  b: string
  together: number
  inA: number
  inB: number
}

/** Pairs of files in different directories, with different names, that changed together over and over. */
export function coChanged(commits: string[][], exists: (file: string) => boolean = () => true): Pair[] {
  const per = new Map<string, number>()
  const pairs = new Map<string, number>()
  for (const files of commits) {
    for (const file of files) per.set(file, (per.get(file) ?? 0) + 1)
    if (files.length < MIN_FILES || files.length > MAX_FILES) continue
    const sorted = [...files].sort()
    for (const [i, a] of sorted.entries()) {
      for (const b of sorted.slice(i + 1)) pairs.set(`${a}\0${b}`, (pairs.get(`${a}\0${b}`) ?? 0) + 1)
    }
  }
  const found: Pair[] = []
  for (const [key, together] of pairs) {
    const [a = '', b = ''] = key.split('\0')
    const inA = per.get(a) ?? 0
    const inB = per.get(b) ?? 0
    if (together < MIN_TOGETHER || together / Math.min(inA, inB) < MIN_SHARE) continue
    if (dirname(a) === dirname(b) || stem(a) === stem(b)) continue
    // a file that is gone (moved or deleted since) cannot be untangled
    if (!exists(a) || !exists(b)) continue
    found.push({ a, b, together, inA, inB })
  }
  return found.sort((x, y) => y.together - x.together || `${x.a}|${x.b}`.localeCompare(`${y.a}|${y.b}`)).slice(0, TOP)
}

export async function cochangeProbe(tools: Tools, path: string): Promise<Outcome> {
  const log = await gitOut(tools, path, ['log', '-n', String(COMMITS), '--no-merges', '--name-only', '--format=%x00%H'])
  const pairs = coChanged(parseLog(log), (file) => existsSync(join(path, file)))
  const detail = `last ${COMMITS} commits`
  if (!pairs.length) return clean(detail)
  return found(
    detail,
    pairs.map((p) =>
      finding(
        'cochange',
        `cochange:${p.a}|${p.b}`,
        `Hygiene: ${p.a} and ${p.b} change together`,
        [`changed together in ${p.together} of the last ${COMMITS} commits (${p.a}: ${p.inA}, ${p.b}: ${p.inB})`],
        p.together,
      ),
    ),
  )
}
