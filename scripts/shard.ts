#!/usr/bin/env bun
/**
 * Which test files one CI shard runs, planned by seconds. Playwright's `--shard` and bun's both cut the file list by
 * COUNT, so the shards of the scenarios ran 227, 111, 132 and 133 s, and one e2e file of 36 slow tests left the last
 * shard at 5 min against 2.5. Here each file's weight (seconds it took in a CI run: the list reporter and bun print
 * each test's time, plus about 4 s a file for the server and Postgres it boots) is in the suite's `shard-weights.json`;
 * the files go heaviest first onto the lightest shard (deterministic, ties by name), and the shard's files are
 * printed one path per line for `make e2e` (E2E_SHARD) and `make test-scenarios` (SHARD).
 *
 * `bun scripts/shard.ts scenarios 2/3` prints shard 2 of 3. A file with no weight (a new one) counts as the median of
 * the suite, so a lead adding a test file touches nothing here; the weights are refreshed from a CI log now and then.
 * `bun scripts/shard.ts --check` (in `make check`) exits 1 when a weight names a file that does not exist.
 */
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'

export interface Suite {
  /** the directory the files are found under, from the repo root */
  dir: string
  match: RegExp
  /** the path of a file as the runner takes it, from the repo root */
  runPath(file: string): string
  weightsFile: string
}

export const SUITES = {
  e2e: {
    dir: 'tests/e2e',
    match: /\.e2e\.ts$/,
    runPath: (file) => join('tests/e2e', file),
    weightsFile: 'tests/e2e/shard-weights.json',
  },
  scenarios: {
    dir: 'tests',
    match: /\.test\.ts$/,
    runPath: (file) => `./${join('tests', file)}`,
    weightsFile: 'tests/scenarios/shard-weights.json',
  },
} satisfies Record<string, Suite>

export type SuiteName = keyof typeof SUITES

export async function suiteFiles({ root, suite }: { root: string; suite: Suite }): Promise<string[]> {
  const names = await readdir(join(root, suite.dir), { recursive: true })
  const own = names.filter((name) => suite.match.test(name) && !/(^|\/)(node_modules|out)\//.test(name))
  return own.sort()
}

export async function readWeights({ root, suite }: { root: string; suite: Suite }): Promise<Record<string, number>> {
  const raw = JSON.parse(await readFile(join(root, suite.weightsFile), 'utf8')) as Record<string, unknown>
  const weights: Record<string, number> = {}
  for (const [name, seconds] of Object.entries(raw)) {
    if (typeof seconds !== 'number' || !(seconds > 0))
      throw new Error(`${suite.weightsFile}: ${name} must be a positive number of seconds`)
    weights[name] = seconds
  }
  return weights
}

/** The weights that name no file of the suite: the only thing that is wrong, a missing weight is the median. */
export function staleWeights({ files, weights }: { files: string[]; weights: Record<string, number> }): string[] {
  return Object.keys(weights).filter((name) => !files.includes(name))
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)] ?? 10
}

/** The files of each of `total` shards: heaviest first onto the lightest shard so far. */
export function planShards({
  files,
  weights,
  total,
}: {
  files: string[]
  weights: Record<string, number>
  total: number
}): string[][] {
  const fallback = median(Object.values(weights))
  const weightOf = (file: string) => weights[file] ?? fallback
  const shards = Array.from({ length: total }, () => ({ load: 0, files: [] as string[] }))
  const ordered = [...files].sort((a, b) => weightOf(b) - weightOf(a) || a.localeCompare(b))
  for (const file of ordered) {
    const lightest = shards.reduce((best, shard) => (shard.load < best.load ? shard : best))
    lightest.load += weightOf(file)
    lightest.files.push(file)
  }
  return shards.map((shard) => shard.files.sort())
}

export function parseShard(value: string | undefined): { current: number; total: number } {
  const match = /^(\d+)\/(\d+)$/.exec(value ?? '')
  const current = Number(match?.[1])
  const total = Number(match?.[2])
  if (!match || current < 1 || current > total)
    throw new Error(`usage: shard.ts <e2e|scenarios> <i>/<n> | --check (got "${value ?? ''}")`)
  return { current, total }
}

if (import.meta.main) {
  const root = join(import.meta.dir, '..')
  if (process.argv[2] === '--check') {
    let failed = false
    for (const [name, suite] of Object.entries<Suite>(SUITES)) {
      const stale = staleWeights({
        files: await suiteFiles({ root, suite }),
        weights: await readWeights({ root, suite }),
      })
      for (const file of stale) {
        console.error(`shard: ${suite.weightsFile} weighs ${file} (${name}), which does not exist: remove the line`)
        failed = true
      }
    }
    process.exit(failed ? 1 : 0)
  }
  const suite = SUITES[process.argv[2] as SuiteName]
  if (!suite) throw new Error(`usage: shard.ts <${Object.keys(SUITES).join('|')}> <i>/<n> | --check`)
  const { current, total } = parseShard(process.argv[3])
  const files = await suiteFiles({ root, suite })
  const mine = planShards({ files, weights: await readWeights({ root, suite }), total })[current - 1] ?? []
  console.log(mine.map((file) => suite.runPath(file)).join('\n'))
}
