#!/usr/bin/env bun
/**
 * The merge guard (`make merge-guard`): what a lead runs just before it merges its pull request, so parallel leads
 * never land onto a master that moved or is red. It refuses, with the reason, when
 *   - the branch does not contain the current `origin/master` (rebase, then `make check` again),
 *   - the branch adds a migration whose number master already uses, or that another file of the branch repeats (the
 *     reason names the next free number; renaming an unmerged migration is fine, an applied one is never touched),
 *   - the head (`git rev-parse HEAD`) has no finished green CI run: none for that exact sha, one still running or one
 *     red (`--allow-red` never skips this; a merge needs green CI on the exact head),
 *   - master's last finished CI run is red (`--allow-red` is for the one change that fixes a red master). A master run
 *     still running is no refusal: the head contains origin/master and its green CI proved that exact combination.
 * `--wait` polls the head's CI every 30 s until its newest non-cancelled run is completed, then judges;
 * `--wait-minutes <n>` (default 45) bounds it, and on timeout the run is refused as still running.
 * `--next-migration` prints the next free migration number and nothing else; `make check` prints it too.
 * Exit 0 when clear, 1 on a refusal (the reasons on stderr), 2 on a usage error.
 */
import { spawnSync } from 'node:child_process'

export const MIGRATIONS_PATH = 'apps/server/migrations'
const MIGRATION_FILE = /^(\d{4})_[a-z0-9_]+\.sql$/
/** Numbers two applied migrations already share (`SHARED_NUMBERS` in migrate.ts). */
export const SHARED_NUMBERS = new Set(['0993'])

export interface CiRun {
  status: string
  conclusion: string
  url: string
}

export interface GuardPorts {
  /** `git <args>` in the repo; the trimmed stdout, or null when git exits non-zero */
  git(args: string[]): string | null
  /** master's workflow runs, newest first; null when they cannot be read */
  ciRuns(): CiRun[] | null
  /** the ci.yml runs for exactly this commit, newest first; null when they cannot be read */
  headRuns(sha: string): CiRun[] | null
}

export interface Verdict {
  refusals: string[]
  nextMigration: string
}

const number = (name: string): string | null => MIGRATION_FILE.exec(name)?.[1] ?? null

const names = (listing: string | null): string[] =>
  (listing ?? '')
    .split('\n')
    .map((line) => line.trim().split('/').pop() ?? '')
    .filter((name) => number(name) !== null)

/** The next number nothing uses: past the highest of the migrations on `ref` (when it exists) and in the working tree. */
export function nextFree(ports: GuardPorts, ref = 'origin/master'): string {
  const onMaster = names(ports.git(['ls-tree', '--name-only', ref, `${MIGRATIONS_PATH}/`]))
  const here = names(ports.git(['ls-files', `${MIGRATIONS_PATH}/`]))
  const highest = [...onMaster, ...here].reduce((max, name) => Math.max(max, Number(number(name))), 0)
  return String(highest + 1).padStart(4, '0')
}

/**
 * master's latest finished CI run; cancelled runs were superseded and are skipped. A refusal reason, or null when green.
 * A run still running or no finished run is not a refusal: the head's own green CI proved the combination.
 */
export function masterRed(runs: CiRun[] | null): string | null {
  if (runs === null)
    return "master's CI runs cannot be read (gh failed): refusing, a merge needs to know master is green"
  const last = runs.find((run) => run.conclusion !== 'cancelled' && run.status === 'completed')
  if (!last || last.conclusion === 'success') return null
  return `master's last CI run is ${last.conclusion} (${last.url}): fix master first, a merge onto red hides the next break (--allow-red only for the change that fixes it)`
}

/** The newest non-cancelled run: the one that counts for a head. */
const newest = (runs: CiRun[]): CiRun | undefined => runs.find((run) => run.conclusion !== 'cancelled')

/** The head's CI verdict: a refusal reason, or null when its newest non-cancelled run finished green. */
export function headRed(runs: CiRun[] | null, sha: string): string | null {
  if (runs === null)
    return `the head's CI runs cannot be read (gh failed): refusing, a merge needs green CI on ${sha.slice(0, 7)}`
  const last = newest(runs)
  if (!last)
    return `CI has not run on ${sha.slice(0, 7)}: push the branch (the head you tested), wait for CI (make merge-guard with MERGE_GUARD_ARGS=--wait waits)`
  if (last.status !== 'completed')
    return `CI on ${sha.slice(0, 7)} is still running (${last.url}): wait for it (MERGE_GUARD_ARGS=--wait waits)`
  if (last.conclusion !== 'success')
    return `CI on ${sha.slice(0, 7)} finished ${last.conclusion} (${last.url}): fix it and push, a merge needs green CI on the exact head`
  return null
}

export interface WaitOptions {
  minutes: number
  intervalMs?: number
  sleep(ms: number): Promise<void>
  now(): number
  log(line: string): void
}

/** Polls the head's CI until its newest non-cancelled run is completed, the runs are unreadable, or the time is up. */
export async function awaitHead(ports: GuardPorts, options: WaitOptions): Promise<void> {
  const sha = ports.git(['rev-parse', 'HEAD'])
  if (sha === null) return
  const interval = options.intervalMs ?? 30_000
  const deadline = options.now() + options.minutes * 60_000
  let previous = ''
  for (;;) {
    const runs = ports.headRuns(sha)
    if (runs === null) return
    const last = newest(runs)
    if (last?.status === 'completed') return
    const state = last ? `${last.status} (${last.url})` : 'no run yet'
    if (state !== previous) options.log(`merge-guard: waiting for CI on ${sha.slice(0, 7)}: ${state}`)
    previous = state
    if (options.now() + interval > deadline) return
    await options.sleep(interval)
  }
}

export function evaluate(ports: GuardPorts, options: { allowRed?: boolean } = {}): Verdict {
  const refusals: string[] = []
  const next = nextFree(ports)

  if (ports.git(['rev-parse', '--verify', '-q', 'origin/master']) === null) {
    refusals.push('origin/master is unknown: git fetch origin master')
    return { refusals, nextMigration: next }
  }
  if (ports.git(['merge-base', '--is-ancestor', 'origin/master', 'HEAD']) === null) {
    refusals.push(
      'master moved: this branch does not contain origin/master. git fetch origin master && git rebase origin/master, then make check again',
    )
  } else {
    const added = names(
      ports.git(['diff', '--name-only', '--diff-filter=A', 'origin/master...HEAD', '--', `${MIGRATIONS_PATH}/`]),
    )
    const onMaster = new Set(
      names(ports.git(['ls-tree', '--name-only', 'origin/master', `${MIGRATIONS_PATH}/`])).map((n) => number(n)),
    )
    const seen = new Set<string>()
    for (const name of added) {
      const n = number(name) as string
      if (onMaster.has(n) && !SHARED_NUMBERS.has(n))
        refusals.push(`migration ${name} takes ${n}, which master already uses: rename it to ${next}_<words>.sql`)
      else if (seen.has(n) && !SHARED_NUMBERS.has(n))
        refusals.push(`migration ${name} repeats the number ${n} of another migration on this branch`)
      seen.add(n)
    }
  }

  const sha = ports.git(['rev-parse', 'HEAD'])
  if (sha === null) refusals.push('HEAD is unknown: not a git checkout')
  else {
    const head = headRed(ports.headRuns(sha), sha)
    if (head) refusals.push(head)
  }

  if (!options.allowRed) {
    const red = masterRed(ports.ciRuns())
    if (red) refusals.push(red)
  }
  return { refusals, nextMigration: next }
}

function ghRuns(filter: string[]): CiRun[] | null {
  const out = spawnSync(
    'gh',
    ['run', 'list', ...filter, '--workflow', 'ci.yml', '--limit', '10', '--json', 'status,conclusion,url'],
    { encoding: 'utf8' },
  )
  if (out.status !== 0) return null
  try {
    return JSON.parse(out.stdout) as CiRun[]
  } catch {
    return null
  }
}

function realPorts(): GuardPorts {
  return {
    git(args) {
      const out = spawnSync('git', args, { encoding: 'utf8' })
      return out.status === 0 ? out.stdout.trim() : null
    },
    ciRuns: () => ghRuns(['--branch', 'master']),
    headRuns: (sha) => ghRuns(['--commit', sha]),
  }
}

if (import.meta.main) {
  const args = process.argv.slice(2)
  const flags = ['--next-migration', '--allow-red', '--no-fetch', '--wait']
  let waitMinutes = 45
  const rest: string[] = []
  for (let i = 0; i < args.length; i++) {
    if (args[i] !== '--wait-minutes') {
      rest.push(args[i] as string)
      continue
    }
    const value = args[++i] ?? ''
    if (!/^[1-9]\d*$/.test(value)) {
      console.error('merge-guard: --wait-minutes needs a positive integer')
      process.exit(2)
    }
    waitMinutes = Number(value)
  }
  const unknown = rest.filter((a) => !flags.includes(a))
  if (unknown.length > 0) {
    console.error(`merge-guard: unknown argument ${unknown[0]}`)
    process.exit(2)
  }
  const ports = realPorts()
  if (!rest.includes('--no-fetch')) ports.git(['fetch', '--quiet', 'origin', 'master'])
  if (rest.includes('--next-migration')) {
    console.log(nextFree(ports))
    process.exit(0)
  }
  if (rest.includes('--wait'))
    await awaitHead(ports, {
      minutes: waitMinutes,
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      now: () => Date.now(),
      log: (line) => console.error(line),
    })
  const verdict = evaluate(ports, { allowRed: rest.includes('--allow-red') })
  if (verdict.refusals.length > 0) {
    for (const reason of verdict.refusals) console.error(`merge-guard: refused: ${reason}`)
    process.exit(1)
  }
  console.log(
    `merge-guard: clear (rebased on origin/master, migrations distinct, the head's CI is green); next free migration number ${verdict.nextMigration}`,
  )
}
