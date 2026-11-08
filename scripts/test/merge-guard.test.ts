import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { evaluate, masterRed, nextFree, type CiRun, type GuardPorts } from '../merge-guard.ts'

const GREEN: CiRun = { status: 'completed', conclusion: 'success', url: 'https://ci/green' }
const RED: CiRun = { status: 'completed', conclusion: 'failure', url: 'https://ci/red' }
const RUNNING: CiRun = { status: 'in_progress', conclusion: '', url: 'https://ci/running' }
const CANCELLED: CiRun = { status: 'completed', conclusion: 'cancelled', url: 'https://ci/cancelled' }

let root = ''

function git(cwd: string, ...args: string[]): string {
  const out = spawnSync('git', args, { cwd, encoding: 'utf8' })
  if (out.status !== 0) throw new Error(`git ${args.join(' ')}: ${out.stderr}`)
  return out.stdout.trim()
}

/** A bare origin with master holding 0001 and 0002, and a clone per lead. */
async function lead(name: string): Promise<string> {
  const dir = join(root, name)
  git(root, 'clone', '-q', join(root, 'origin.git'), dir)
  git(dir, 'config', 'user.email', 'lead@example.com')
  git(dir, 'config', 'user.name', name)
  return dir
}

async function commit(dir: string, files: Record<string, string>, message: string): Promise<void> {
  for (const [path, text] of Object.entries(files)) {
    await mkdir(join(dir, path, '..'), { recursive: true })
    await writeFile(join(dir, path), text)
  }
  git(dir, 'add', '-A')
  git(dir, 'commit', '-q', '-m', message)
}

function portsFor(cwd: string, runs: CiRun[] | null): GuardPorts {
  return {
    git(args) {
      const out = spawnSync('git', args, { cwd, encoding: 'utf8' })
      return out.status === 0 ? out.stdout.trim() : null
    },
    ciRuns: () => runs,
  }
}

beforeEach(async () => {
  root = await mkdtemp('/tmp/factory-merge-guard-')
  git(root, 'init', '-q', '--bare', '-b', 'master', 'origin.git')
  const seed = await lead('seed')
  git(seed, 'checkout', '-q', '-b', 'master')
  await commit(
    seed,
    { 'apps/server/migrations/0001_a.sql': 'select 1', 'apps/server/migrations/0002_b.sql': 'select 2' },
    'seed',
  )
  git(seed, 'push', '-q', 'origin', 'master')
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

/** A lead on its own branch off master that adds one migration and fetches. */
async function leadAdding(name: string, file: string): Promise<string> {
  const dir = await lead(name)
  git(dir, 'checkout', '-q', '-b', `factory/${name}`)
  await commit(dir, { [`apps/server/migrations/${file}`]: 'select 3' }, `add ${file}`)
  return dir
}

describe('two leads adding migrations', () => {
  test('the first to merge is clear; the next free number moves past it for the second', async () => {
    const one = await leadAdding('one', '0003_one.sql')
    const two = await leadAdding('two', '0003_two.sql')
    git(one, 'fetch', '-q', 'origin', 'master')
    expect(evaluate(portsFor(one, [GREEN]))).toEqual({ refusals: [], nextMigration: '0004' })

    git(one, 'push', '-q', 'origin', 'HEAD:master')
    git(two, 'fetch', '-q', 'origin', 'master')
    expect(nextFree(portsFor(two, [GREEN]))).toBe('0004')
  })

  test('the colliding branch is refused with the free number, then clears after the rename', async () => {
    const one = await leadAdding('one', '0003_one.sql')
    const two = await leadAdding('two', '0003_two.sql')
    git(one, 'push', '-q', 'origin', 'HEAD:master')
    git(two, 'fetch', '-q', 'origin', 'master')
    git(two, 'rebase', '-q', 'origin/master')

    const refused = evaluate(portsFor(two, [GREEN]))
    expect(refused.nextMigration).toBe('0004')
    expect(refused.refusals).toEqual([
      expect.stringContaining('0003_two.sql takes 0003, which master already uses: rename it to 0004_'),
    ])

    git(two, 'mv', 'apps/server/migrations/0003_two.sql', 'apps/server/migrations/0004_two.sql')
    git(two, 'commit', '-q', '-am', 'take the next number')
    expect(evaluate(portsFor(two, [GREEN])).refusals).toEqual([])
  })

  test('a branch repeating its own number is refused', async () => {
    const dir = await leadAdding('solo', '0003_a.sql')
    await commit(dir, { 'apps/server/migrations/0003_b.sql': 'select 4' }, 'again')
    git(dir, 'fetch', '-q', 'origin', 'master')
    expect(evaluate(portsFor(dir, [GREEN])).refusals).toEqual([expect.stringContaining('repeats the number 0003')])
  })
})

describe('master moved', () => {
  test('a branch that does not contain origin/master is refused until rebased', async () => {
    const one = await leadAdding('one', '0003_one.sql')
    const two = await leadAdding('two', '0004_two.sql')
    git(one, 'push', '-q', 'origin', 'HEAD:master')
    git(two, 'fetch', '-q', 'origin', 'master')
    expect(evaluate(portsFor(two, [GREEN])).refusals).toEqual([expect.stringContaining('master moved')])
    git(two, 'rebase', '-q', 'origin/master')
    expect(evaluate(portsFor(two, [GREEN])).refusals).toEqual([])
  })
})

describe('master red', () => {
  test('a merge while master is red is refused with the run, unless it fixes master', async () => {
    const dir = await leadAdding('one', '0003_one.sql')
    git(dir, 'fetch', '-q', 'origin', 'master')
    const refused = evaluate(portsFor(dir, [RED, GREEN]))
    expect(refused.refusals).toEqual([expect.stringContaining("master's last CI run is failure (https://ci/red)")])
    expect(evaluate(portsFor(dir, [RED]), { allowRed: true }).refusals).toEqual([])
  })

  test('a running or unreadable CI is refused; a cancelled run is skipped', () => {
    expect(masterRed([RUNNING, GREEN])).toContain('still running')
    expect(masterRed(null)).toContain('cannot be read')
    expect(masterRed([])).toContain('no finished CI run')
    expect(masterRed([CANCELLED, GREEN])).toBeNull()
    expect(masterRed([CANCELLED, RED])).toContain('failure')
  })
})

test('the next free number is past master and the working tree', async () => {
  const dir = await leadAdding('one', '0009_far.sql')
  expect(nextFree(portsFor(dir, null))).toBe('0010')
})
