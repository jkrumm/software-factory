import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fixDeps } from '../../src/adapters/hygiene/fixes/deps.ts'
import { fixStale } from '../../src/adapters/hygiene/fixes/stale.ts'
import { defaultTools, type Tools } from '../../src/adapters/hygiene/git.ts'
import type { CiWait } from '../../src/adapters/hygiene/fixes/landing.ts'
import type { Checkout } from '../../src/domains/loops/hygiene-model.ts'

const ID = {
  GIT_AUTHOR_NAME: 'T',
  GIT_AUTHOR_EMAIL: 't@example.com',
  GIT_COMMITTER_NAME: 'T',
  GIT_COMMITTER_EMAIL: 't@example.com',
}
let base: string
let counter = 0

function git(cwd: string, args: string[], env: Record<string, string> = {}): string {
  const result = Bun.spawnSync(['git', ...args], { cwd, env: { ...process.env, ...ID, ...env } })
  if (result.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr.toString()}`)
  return result.stdout.toString()
}

beforeAll(() => {
  base = mkdtempSync(join(tmpdir(), 'factory-hygiene-fix-'))
})
afterAll(() => rmSync(base, { recursive: true, force: true }))

/** A bare origin with master holding `files`, a clone, and the detached throwaway worktree of origin/master a sweep gets. */
function fixture(files: Record<string, string> = { 'a.txt': 'a' }) {
  const n = ++counter
  const origin = join(base, `origin-${n}.git`)
  const work = join(base, `work-${n}`)
  mkdirSync(origin)
  mkdirSync(work)
  git(origin, ['init', '-q', '--bare', '-b', 'master'])
  git(work, ['init', '-q', '-b', 'master'])
  git(work, ['remote', 'add', 'origin', origin])
  for (const [file, text] of Object.entries(files)) writeFileSync(join(work, file), text)
  git(work, ['add', '-A'])
  git(work, ['commit', '-q', '-m', 'init'])
  git(work, ['push', '-q', 'origin', 'master'])
  git(work, ['remote', 'set-head', 'origin', 'master'])
  const throwaway = join(base, 'hygiene', `t-${n}`)
  git(work, ['worktree', 'add', '-q', '--detach', throwaway, 'origin/master'])
  // a sweep's checkout has an identity through the host's git config; the test gives it one
  git(throwaway, ['config', 'user.name', 'T'])
  git(throwaway, ['config', 'user.email', 't@example.com'])
  const checkout: Checkout = { path: throwaway, ref: git(throwaway, ['rev-parse', 'HEAD']).trim(), source: work }
  return { n, origin, work, throwaway, checkout }
}

const remoteBranches = (origin: string): string[] =>
  git(origin, ['for-each-ref', '--format=%(refname:short)', 'refs/heads']).trim().split('\n').sort()

function branch(work: string, name: string, ageDays: number, mergeIt = false): void {
  const date = new Date(Date.now() - ageDays * 86_400_000).toISOString()
  git(work, ['checkout', '-q', '-b', name, 'master'])
  writeFileSync(join(work, `${name}.txt`), name)
  git(work, ['add', '-A'])
  git(work, ['commit', '-q', '-m', name], { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date })
  git(work, ['push', '-q', 'origin', name])
  git(work, ['checkout', '-q', 'master'])
  if (mergeIt) {
    git(work, ['merge', '-q', '--ff-only', name])
    git(work, ['push', '-q', 'origin', 'master'])
  }
  git(work, ['fetch', '-q', 'origin'])
}

const tools = defaultTools()

describe('fixStale', () => {
  test('deletes the merged remote branches and nothing else', async () => {
    const f = fixture()
    branch(f.work, 'done-one', 3, true)
    branch(f.work, 'old-one', 90)
    git(f.throwaway, ['fetch', '-q', 'origin'])
    const entries = await fixStale(tools, f.checkout, new Set(['stale:branches', 'stale:worktrees']))
    expect(entries).toEqual([{ key: 'stale:branches', outcome: 'fixed', detail: 'deleted 1 merged remote branch' }])
    expect(remoteBranches(f.origin)).toEqual(['master', 'old-one'])
    // run again: nothing is left to do, which is no entry and no error
    expect(await fixStale(tools, f.checkout, new Set(['stale:branches']))).toEqual([])
  })

  test('a branch the remote refuses to delete is a failed fix with the remote words', async () => {
    const f = fixture()
    branch(f.work, 'prot', 3, true)
    const hook = join(f.origin, 'hooks', 'pre-receive')
    writeFileSync(
      hook,
      '#!/bin/sh\nwhile read old new ref; do\n  if [ "$ref" = refs/heads/prot ] && [ "$new" = 0000000000000000000000000000000000000000 ]; then echo "protected branch" >&2; exit 1; fi\ndone\n',
    )
    chmodSync(hook, 0o755)
    git(f.throwaway, ['fetch', '-q', 'origin'])
    const [entry] = await fixStale(tools, f.checkout, new Set(['stale:branches']))
    expect(entry).toMatchObject({ key: 'stale:branches', outcome: 'failed', detail: expect.stringContaining('0 of 1') })
    expect(entry?.output?.[0]).toContain('prot:')
    expect(remoteBranches(f.origin)).toContain('prot')
  })

  test("a lead's own worktree is left alone, merged, idle or prunable: its finalization removes it", async () => {
    const f = fixture()
    branch(f.work, 'lead9', 3, true)
    git(f.work, ['branch', '-m', 'lead9', 'factory/9-1'])
    git(f.work, ['commit', '-q', '--allow-empty', '-m', 'later'])
    git(f.work, ['push', '-q', 'origin', 'master'])
    const wts = join(base, 'wts')
    const idle = join(wts, `factory-9-1`)
    const gone = join(wts, `factory-9-2`)
    git(f.work, ['worktree', 'add', '-q', idle, 'factory/9-1'])
    git(f.work, ['worktree', 'add', '-q', gone, '-b', 'factory/9-2'])
    rmSync(gone, { recursive: true })
    const dir = git(idle, ['rev-parse', '--absolute-git-dir']).trim()
    const old = new Date(Date.now() - 4 * 86_400_000)
    for (const name of ['index', 'HEAD']) utimesSync(join(dir, name), old, old)
    git(f.throwaway, ['fetch', '-q', 'origin'])
    expect(await fixStale(tools, f.checkout, new Set(['stale:worktrees']))).toEqual([])
    expect(git(f.work, ['worktree', 'list'])).toContain('factory-9-1')
    expect(git(f.work, ['worktree', 'list'])).toContain('factory-9-2')
  })

  test('removes a merged idle worktree and a prunable one; a dirty one stays and fails the fix', async () => {
    const f = fixture()
    branch(f.work, 'done-two', 3, true)
    branch(f.work, 'done-three', 3, true)
    git(f.work, ['commit', '-q', '--allow-empty', '-m', 'later'])
    git(f.work, ['push', '-q', 'origin', 'master'])
    const wts = join(base, 'wts')
    const idle = (path: string) => {
      const dir = git(path, ['rev-parse', '--absolute-git-dir']).trim()
      const old = new Date(Date.now() - 4 * 86_400_000)
      for (const name of ['index', 'HEAD']) utimesSync(join(dir, name), old, old)
    }
    const clean = join(wts, `clean-${f.n}`)
    const dirty = join(wts, `dirty-${f.n}`)
    const gone = join(wts, `gone-${f.n}`)
    git(f.work, ['worktree', 'add', '-q', clean, 'done-two'])
    git(f.work, ['worktree', 'add', '-q', dirty, 'done-three'])
    git(f.work, ['worktree', 'add', '-q', gone, '-b', 'gone-branch'])
    rmSync(gone, { recursive: true })
    writeFileSync(join(dirty, 'wip.txt'), 'work in progress')
    idle(clean)
    idle(dirty)
    git(f.throwaway, ['fetch', '-q', 'origin'])
    const [entry] = await fixStale(tools, f.checkout, new Set(['stale:worktrees']))
    expect(entry).toMatchObject({
      key: 'stale:worktrees',
      outcome: 'failed',
      detail: expect.stringContaining('2 of 3'),
    })
    expect(git(f.work, ['worktree', 'list'])).not.toContain(`clean-${f.n}`)
    expect(git(f.work, ['worktree', 'list'])).not.toContain(`gone-${f.n}`)
    expect(git(f.work, ['worktree', 'list'])).toContain(`dirty-${f.n}`)
  })
})

// ---- deps ------------------------------------------------------------------------------------------------------------------

const NOW = new Date('2026-11-18T12:00:00Z')
const TABLE = `|--|
| Package | Current | Update | Latest |
|--|
| hono | 4.2.3 | 4.2.9 | 4.2.9 |
| typescript (dev) | 5.8.0 | 5.9.1 | 5.9.1 |
| left-pad | 1.0.0 | 1.0.1 | 2.0.0 |
|--|
`
const PKG = `${JSON.stringify({ dependencies: { hono: '4.2.3' }, devDependencies: { typescript: '5.8.0' } }, null, 2)}\n`

/** A bun that prints `table` for `outdated` and, for `add`, rewrites the version of each named package in package.json. */
function fakeBun(table: string): string {
  const dir = mkdtempSync(join(base, 'bun-'))
  writeFileSync(join(dir, 'outdated.txt'), table)
  writeFileSync(
    join(dir, 'add.js'),
    `const fs = require('fs'); const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'))
for (const arg of process.argv.slice(2).filter((a) => !a.startsWith('-'))) {
  const at = arg.lastIndexOf('@'); const name = arg.slice(0, at)
  for (const section of ['dependencies', 'devDependencies', 'optionalDependencies']) if (pkg[section]?.[name]) pkg[section][name] = arg.slice(at + 1)
}
fs.writeFileSync('package.json', JSON.stringify(pkg, null, 2) + '\\n')`,
  )
  const script = join(dir, 'bun')
  writeFileSync(
    script,
    `#!/bin/sh\ncase "$1" in\n  outdated) cat "${dir}/outdated.txt" ;;\n  add) shift; exec "${process.execPath}" "${dir}/add.js" "$@" ;;\n  *) exit 0 ;;\nesac\n`,
  )
  chmodSync(script, 0o755)
  return script
}

const released = (daysAgo: number) => async () => new Date(NOW.getTime() - daysAgo * 86_400_000)
const withBun = (table = TABLE, slot = ['env']): Tools => ({ ...defaultTools(), bun: fakeBun(table), slot })
const MAKE_GREEN = 'check-fast:\n\t@echo green\n'

describe('fixDeps', () => {
  test('bumps the patches and minors past their cooldown, runs the check, pushes to the default branch', async () => {
    const f = fixture({ 'package.json': PKG, 'bun.lock': '{}\n', Makefile: MAKE_GREEN })
    const entries = await fixDeps(withBun(), f.checkout, { landing: 'push', released: released(30), now: NOW })
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({
      key: 'deps',
      outcome: 'fixed',
      detail: expect.stringContaining('bumped 2 packages'),
    })
    expect(git(f.origin, ['log', '-1', '--format=%s', 'master']).trim()).toBe(
      'chore(deps): bump 2 patch and minor packages',
    )
    const pkg = JSON.parse(git(f.origin, ['show', 'master:package.json']))
    expect(pkg.dependencies.hono).toBe('4.2.9')
    expect(pkg.devDependencies.typescript).toBe('5.9.1')
  })

  test('a red check pushes nothing and puts its output on the failure', async () => {
    const f = fixture({
      'package.json': PKG,
      'bun.lock': '{}\n',
      Makefile: 'check-fast:\n\t@echo boom-in-test\n\t@exit 1\n',
    })
    const before = git(f.origin, ['rev-parse', 'master']).trim()
    const [entry] = await fixDeps(withBun(), f.checkout, { landing: 'push', released: released(30), now: NOW })
    expect(entry).toMatchObject({ outcome: 'failed', detail: expect.stringContaining('make check-fast is red') })
    expect(entry?.output?.join('\n')).toContain('boom-in-test')
    expect(git(f.origin, ['rev-parse', 'master']).trim()).toBe(before)
  })

  test('no test slot in time is deferred', async () => {
    const f = fixture({ 'package.json': PKG, 'bun.lock': '{}\n', Makefile: MAKE_GREEN })
    const before = git(f.origin, ['rev-parse', 'master']).trim()
    const [late] = await fixDeps(withBun(TABLE, ['sh', '-c', 'exit 75', 'sh']), f.checkout, {
      landing: 'push',
      released: released(30),
      now: NOW,
    })
    expect(late).toMatchObject({ outcome: 'deferred' })
    expect(git(f.origin, ['rev-parse', 'master']).trim()).toBe(before)
  })

  test('with every version inside its cooldown nothing is bumped', async () => {
    const f = fixture({ 'package.json': PKG, 'bun.lock': '{}\n', Makefile: MAKE_GREEN })
    const before = git(f.origin, ['rev-parse', 'master']).trim()
    const table = TABLE.replace('| left-pad | 1.0.0 | 1.0.1 | 2.0.0 |\n', '')
    expect(await fixDeps(withBun(table), f.checkout, { landing: 'push', released: released(1), now: NOW })).toEqual([])
    expect(git(f.origin, ['rev-parse', 'master']).trim()).toBe(before)
  })

  test('a package.json without a tracked bun.lock is not ours', async () => {
    const f = fixture({ 'package.json': PKG, 'package-lock.json': '{}\n', Makefile: MAKE_GREEN })
    const before = git(f.origin, ['rev-parse', 'master']).trim()
    const [entry] = await fixDeps(withBun(), f.checkout, { landing: 'push', released: released(30), now: NOW })
    expect(entry).toMatchObject({ outcome: 'skipped', detail: expect.stringContaining('not a bun repo') })
    expect(git(f.origin, ['rev-parse', 'master']).trim()).toBe(before)
  })

  test('a version with no release date is never bumped by script', async () => {
    const f = fixture({ 'package.json': PKG, 'bun.lock': '{}\n', Makefile: MAKE_GREEN })
    const entries = await fixDeps(withBun(), f.checkout, { landing: 'push', released: async () => undefined, now: NOW })
    expect(entries).toEqual([])
  })
})

// ---- deps, by pull request -------------------------------------------------------------------------------------------------

const FAST: CiWait = { everyMs: 5, noChecksMs: 100, maxMs: 1500 }
const GREEN = '[{"name":"ci","bucket":"pass"},{"name":"lint","bucket":"skipping"}]'
const PASSTHROUGH = ['sh', '-c', 'while [ "$1" != -- ]; do shift; done; shift; exec "$@"', 'sh']

/**
 * A gh that keeps its state in a directory: the repo allows squash, `pr create` answers a URL, `pr checks` prints `checks.json`
 * (and the first `pending` calls of it print a running check), `pr merge` lands the branch on origin's master, `pr close`
 * deletes the branch. Every call is a line of `calls.log`.
 */
function fakeGh(options: { checks?: string; pending?: number; repoView?: string } = {}): { gh: string; dir: string } {
  const dir = mkdtempSync(join(base, 'gh-'))
  writeFileSync(join(dir, 'checks.json'), options.checks ?? GREEN)
  writeFileSync(join(dir, 'pending'), String(options.pending ?? 0))
  const script = join(dir, 'gh')
  writeFileSync(
    script,
    `#!/bin/sh
d="${dir}"
echo "$*" >> "$d/calls.log"
case "$1 $2" in
  "repo view") ${options.repoView === undefined ? 'echo \'{"squashMergeAllowed":true,"rebaseMergeAllowed":true,"mergeCommitAllowed":false}\'' : options.repoView} ;;
  "pr list") echo '[]' ;;
  "pr create") echo "https://github.com/o/r/pull/7" ;;
  "pr checks")
    n=$(cat "$d/pending")
    if [ "$n" -gt 0 ]; then echo $((n - 1)) > "$d/pending"; echo '[{"name":"ci","bucket":"pending"}]'; exit 8; fi
    cat "$d/checks.json" ;;
  "run list") echo '[{"status":"completed","conclusion":"success"}]' ;;
  "pr merge") git push -q origin HEAD:refs/heads/master ;;
  "pr close") git push -q origin :refs/heads/factory/hygiene-deps ;;
esac
`,
  )
  chmodSync(script, 0o755)
  return { gh: script, dir }
}

const byPr = (gh: string, mergeLock = PASSTHROUGH): Tools => ({ ...withBun(), gh, mergeLock })
const prInput = { landing: 'pr' as const, project: 'demo', released: released(30), now: NOW, wait: FAST }
const callsOf = (dir: string): string => readFileSync(join(dir, 'calls.log'), 'utf8')

describe('fixDeps for a repo that ships by pull request', () => {
  const files = { 'package.json': PKG, 'bun.lock': '{}\n', Makefile: MAKE_GREEN }

  test('opens the pull request on its branch, waits for green CI and merges it by the allowed method', async () => {
    const f = fixture(files)
    const { gh, dir } = fakeGh({ pending: 2 })
    const entries = await fixDeps(byPr(gh), f.checkout, prInput)
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({
      key: 'deps',
      outcome: 'fixed',
      detail: expect.stringContaining('pull request #7 (squash)'),
    })
    const calls = callsOf(dir)
    expect(calls).toContain(
      'pr create --base master --head factory/hygiene-deps --title chore(deps): bump 2 patch and minor packages',
    )
    expect(calls).toContain('pr merge 7 --squash --delete-branch')
    expect(calls.match(/pr checks/g)).toHaveLength(4)
    expect(JSON.parse(git(f.origin, ['show', 'master:package.json'])).dependencies.hono).toBe('4.2.9')
    expect(remoteBranches(f.origin)).toEqual(['factory/hygiene-deps', 'master'])
  })

  test('master moved while the check ran: the bump is rebased onto it inside the window', async () => {
    const f = fixture(files)
    writeFileSync(join(f.work, 'other.txt'), 'later')
    git(f.work, ['add', '-A'])
    git(f.work, ['commit', '-q', '-m', 'later work'])
    git(f.work, ['push', '-q', 'origin', 'master'])
    const { gh } = fakeGh()
    const [entry] = await fixDeps(byPr(gh), f.checkout, prInput)
    expect(entry).toMatchObject({ outcome: 'fixed' })
    expect(git(f.origin, ['show', 'master:other.txt'])).toBe('later')
    expect(JSON.parse(git(f.origin, ['show', 'master:package.json'])).dependencies.hono).toBe('4.2.9')
  })

  test('red CI closes the pull request and merges nothing; the failing check is on the failure', async () => {
    const f = fixture(files)
    const { gh, dir } = fakeGh({ checks: '[{"name":"unit","bucket":"fail"},{"name":"lint","bucket":"pass"}]' })
    const before = git(f.origin, ['rev-parse', 'master']).trim()
    const [entry] = await fixDeps(byPr(gh), f.checkout, prInput)
    expect(entry).toMatchObject({
      outcome: 'failed',
      detail: expect.stringContaining('#7 is red'),
      output: ['failed: unit'],
    })
    expect(callsOf(dir)).toContain('pr close 7 --delete-branch')
    expect(callsOf(dir)).not.toContain('pr merge')
    expect(git(f.origin, ['rev-parse', 'master']).trim()).toBe(before)
    expect(remoteBranches(f.origin)).toEqual(['master'])
  })

  test('a pull request that gets no CI check at all is closed, not merged', async () => {
    const f = fixture(files)
    const { gh, dir } = fakeGh({ checks: '[]' })
    const [entry] = await fixDeps(byPr(gh), f.checkout, prInput)
    expect(entry).toMatchObject({ outcome: 'failed', detail: expect.stringContaining('no CI check appeared') })
    expect(callsOf(dir)).not.toContain('pr merge')
  })

  test('checks that were all skipped are no CI: the pull request is closed, not merged', async () => {
    const f = fixture(files)
    const { gh, dir } = fakeGh({ checks: '[{"name":"ci","bucket":"skipping"}]' })
    const [entry] = await fixDeps(byPr(gh), f.checkout, prInput)
    expect(entry).toMatchObject({ outcome: 'failed', detail: expect.stringContaining('no CI check appeared') })
    expect(callsOf(dir)).not.toContain('pr merge')
  })

  test('a merge window that is not free in time is deferred before anything is pushed', async () => {
    const f = fixture(files)
    const { gh, dir } = fakeGh()
    const [entry] = await fixDeps(byPr(gh, ['sh', '-c', 'exit 75', 'sh']), f.checkout, prInput)
    expect(entry).toMatchObject({ outcome: 'deferred', detail: expect.stringContaining('merge window') })
    expect(callsOf(dir)).not.toContain('pr create')
    expect(remoteBranches(f.origin)).toEqual(['master'])
  })

  test("the repo's own merge guard is run when the Makefile has one, and its refusal defers the merge", async () => {
    const f = fixture({ ...files, Makefile: `${MAKE_GREEN}merge-guard:\n\t@echo master-is-red >&2\n\t@exit 1\n` })
    const { gh, dir } = fakeGh()
    const [entry] = await fixDeps(byPr(gh), f.checkout, prInput)
    expect(entry).toMatchObject({ outcome: 'deferred', detail: expect.stringContaining('merge guard refused') })
    expect(callsOf(dir)).toContain('pr close 7')
    expect(callsOf(dir)).not.toContain('pr merge')
  })

  test('a merge guard declared in a GNUmakefile is run too, and a broken include defers instead of reading as no guard', async () => {
    const guarded = fixture({ ...files, GNUmakefile: 'include Makefile\nmerge-guard:\n\t@echo red >&2\n\t@exit 1\n' })
    const first = fakeGh()
    const [refused] = await fixDeps(byPr(first.gh), guarded.checkout, prInput)
    expect(refused).toMatchObject({ outcome: 'deferred', detail: expect.stringContaining('merge guard refused') })
    expect(callsOf(first.dir)).not.toContain('pr merge')

    const broken = fixture({ ...files, GNUmakefile: 'include Makefile\nmerge-guard: missing.stamp\n\t@true\n' })
    const second = fakeGh()
    const [deferred] = await fixDeps(byPr(second.gh), broken.checkout, prInput)
    expect(deferred).toMatchObject({ outcome: 'deferred', detail: expect.stringContaining('merge guard refused') })
    expect(callsOf(second.dir)).not.toContain('pr merge')
  })

  test('a gh that cannot read the repo skips the fix before any work', async () => {
    const f = fixture(files)
    const { gh } = fakeGh({ repoView: 'exit 1' })
    const before = git(f.origin, ['rev-parse', 'master']).trim()
    const [entry] = await fixDeps(byPr(gh), f.checkout, prInput)
    expect(entry).toMatchObject({ outcome: 'skipped', detail: expect.stringContaining('gh cannot read') })
    expect(git(f.origin, ['rev-parse', 'master']).trim()).toBe(before)
  })
})
