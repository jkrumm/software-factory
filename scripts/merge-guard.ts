#!/usr/bin/env bun
/**
 * The merge guard (`make merge-guard`): what a lead runs just before it merges its pull request, so parallel leads
 * never land onto a master that moved or is red. It refuses, with the reason, when
 *   - the branch does not contain the current `origin/master` (rebase, then `make check` again),
 *   - the branch adds a migration whose number master already uses, or that another file of the branch repeats (the
 *     reason names the next free number; renaming an unmerged migration is fine, an applied one is never touched),
 *   - master's last CI run is red or still running (`--allow-red` is for the one change that fixes a red master).
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

/** master's last CI run: cancelled runs were superseded by a newer one and are skipped. A refusal reason, or null when green. */
export function masterRed(runs: CiRun[] | null): string | null {
  if (runs === null)
    return "master's CI runs cannot be read (gh failed): refusing, a merge needs to know master is green"
  const last = runs.find((run) => run.conclusion !== 'cancelled')
  if (!last) return 'master has no finished CI run: wait for the first one before merging'
  if (last.status !== 'completed') return `master's CI run is still running (${last.url}): merge once it is green`
  if (last.conclusion !== 'success')
    return `master's last CI run is ${last.conclusion} (${last.url}): fix master first, a merge onto red hides the next break (--allow-red only for the change that fixes it)`
  return null
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

  if (!options.allowRed) {
    const red = masterRed(ports.ciRuns())
    if (red) refusals.push(red)
  }
  return { refusals, nextMigration: next }
}

function realPorts(): GuardPorts {
  return {
    git(args) {
      const out = spawnSync('git', args, { encoding: 'utf8' })
      return out.status === 0 ? out.stdout.trim() : null
    },
    ciRuns() {
      const out = spawnSync(
        'gh',
        [
          'run',
          'list',
          '--branch',
          'master',
          '--workflow',
          'ci.yml',
          '--limit',
          '10',
          '--json',
          'status,conclusion,url',
        ],
        { encoding: 'utf8' },
      )
      if (out.status !== 0) return null
      try {
        return JSON.parse(out.stdout) as CiRun[]
      } catch {
        return null
      }
    },
  }
}

if (import.meta.main) {
  const args = process.argv.slice(2)
  const unknown = args.filter((a) => !['--next-migration', '--allow-red', '--no-fetch'].includes(a))
  if (unknown.length > 0) {
    console.error(`merge-guard: unknown argument ${unknown[0]}`)
    process.exit(2)
  }
  const ports = realPorts()
  if (!args.includes('--no-fetch')) ports.git(['fetch', '--quiet', 'origin', 'master'])
  if (args.includes('--next-migration')) {
    console.log(nextFree(ports))
    process.exit(0)
  }
  const verdict = evaluate(ports, { allowRed: args.includes('--allow-red') })
  if (verdict.refusals.length > 0) {
    for (const reason of verdict.refusals) console.error(`merge-guard: refused: ${reason}`)
    process.exit(1)
  }
  console.log(
    `merge-guard: clear (rebased on origin/master, migrations distinct, master green); next free migration number ${verdict.nextMigration}`,
  )
}
