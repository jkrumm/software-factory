#!/usr/bin/env bun
/**
 * Which e2e files one CI shard runs (`make e2e` with E2E_SHARD=i/n). Playwright's own `--shard` cuts the file list into
 * contiguous runs of equal test COUNT, so one file of 36 slow tests and a file of 36 fast ones weigh the same and the last
 * shard finished last in most runs. This plans by seconds instead: each file's weight is in `tests/e2e/shard-weights.json`,
 * the files go heaviest first onto the lightest shard (deterministic, ties by name), and the shard's files are printed
 * one path per line for `playwright test <paths…>`.
 *
 * `bun scripts/e2e-shard.ts 2/3` prints shard 2 of 3. `--check` (in `make check`) exits 1 when a `*.e2e.ts` file has no
 * weight or a weight names no file, so the plan always covers every file exactly once. The weights are the seconds a file
 * took in a CI run (the list reporter prints each test's time); they need not be exact, a new file takes a line.
 */
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'

const E2E_DIR = 'tests/e2e'
const WEIGHTS_FILE = join(E2E_DIR, 'shard-weights.json')
const E2E_FILE = /\.e2e\.ts$/

export async function e2eFiles(root: string): Promise<string[]> {
  return (await readdir(join(root, E2E_DIR))).filter((name) => E2E_FILE.test(name)).sort()
}

export async function readWeights(root: string): Promise<Record<string, number>> {
  const raw = JSON.parse(await readFile(join(root, WEIGHTS_FILE), 'utf8')) as Record<string, unknown>
  const weights: Record<string, number> = {}
  for (const [name, seconds] of Object.entries(raw)) {
    if (typeof seconds !== 'number' || !(seconds > 0))
      throw new Error(`${WEIGHTS_FILE}: ${name} must be a positive number of seconds`)
    weights[name] = seconds
  }
  return weights
}

/** Problems that keep the plan from covering every file once: files without a weight, weights without a file. */
export function checkWeights({ files, weights }: { files: string[]; weights: Record<string, number> }): string[] {
  const problems: string[] = []
  for (const file of files)
    if (!(file in weights)) problems.push(`${file} has no weight: add "${file}": <seconds> to ${WEIGHTS_FILE}`)
  for (const name of Object.keys(weights))
    if (!files.includes(name)) problems.push(`${WEIGHTS_FILE} weighs ${name}, which does not exist: remove the line`)
  return problems
}

/** The files of each of `total` shards: heaviest first onto the lightest shard so far. */
export function planShards({ weights, total }: { weights: Record<string, number>; total: number }): string[][] {
  const shards = Array.from({ length: total }, () => ({ load: 0, files: [] as string[] }))
  const ordered = Object.entries(weights).sort(([a, wa], [b, wb]) => wb - wa || a.localeCompare(b))
  for (const [file, weight] of ordered) {
    const lightest = shards.reduce((best, shard) => (shard.load < best.load ? shard : best))
    lightest.load += weight
    lightest.files.push(file)
  }
  return shards.map((shard) => shard.files.sort())
}

export function parseShard(value: string | undefined): { current: number; total: number } {
  const match = /^(\d+)\/(\d+)$/.exec(value ?? '')
  const current = Number(match?.[1])
  const total = Number(match?.[2])
  if (!match || current < 1 || current > total)
    throw new Error(`usage: e2e-shard.ts <i>/<n> | --check (got "${value ?? ''}")`)
  return { current, total }
}

if (import.meta.main) {
  const root = join(import.meta.dir, '..')
  const files = await e2eFiles(root)
  const weights = await readWeights(root)
  const problems = checkWeights({ files, weights })
  if (problems.length > 0) {
    for (const problem of problems) console.error(`e2e-shard: ${problem}`)
    process.exit(1)
  }
  if (process.argv[2] !== '--check') {
    const { current, total } = parseShard(process.argv[2])
    const mine = planShards({ weights, total })[current - 1] ?? []
    console.log(mine.map((file) => join(E2E_DIR, file)).join('\n'))
  }
}
