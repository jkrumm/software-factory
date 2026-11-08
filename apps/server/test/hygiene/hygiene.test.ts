import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { rootedRepos } from '../../src/adapters/git/repos.ts'
import { createHygieneChecker } from '../../src/adapters/hygiene/index.ts'
import { brokenLinks } from '../../src/adapters/hygiene/probes/links.ts'
import { coChanged, parseLog } from '../../src/adapters/hygiene/probes/cochange.ts'
import { parseOutdated, severity } from '../../src/adapters/hygiene/probes/deps.ts'
import { retiredScope } from '../../src/adapters/hygiene/probes/retired.ts'
import type { SweepReport } from '../../src/domains/loops/hygiene-model.ts'

const REPO_ROOT = join(import.meta.dir, '..', '..', '..', '..')
const ID = {
  GIT_AUTHOR_NAME: 'T',
  GIT_AUTHOR_EMAIL: 't@example.com',
  GIT_COMMITTER_NAME: 'T',
  GIT_COMMITTER_EMAIL: 't@example.com',
}

let base: string
let fake: string
let counter = 0

function git(cwd: string, args: string[], env: Record<string, string> = {}): string {
  const result = Bun.spawnSync(['git', ...args], { cwd, env: { ...process.env, ...ID, ...env } })
  if (result.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr.toString()}`)
  return result.stdout.toString()
}

/** Writes files, commits them, and pushes to origin. */
function commit(work: string, files: Record<string, string>, message = 'c', date?: string): void {
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(dirname(join(work, file)), { recursive: true })
    writeFileSync(join(work, file), text)
  }
  git(work, ['add', '-A'])
  const env: Record<string, string> = date ? { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } : {}
  git(work, ['commit', '-q', '-m', message], env)
}

/** A repo named `repoN` under the allowed root whose origin is a bare repo next to it. */
function makeRepo(files: Record<string, string>): { name: string; work: string } {
  const name = `repo${++counter}`
  const origin = join(base, 'origins', `${name}.git`)
  const work = join(base, 'repos', name)
  mkdirSync(origin, { recursive: true })
  mkdirSync(work, { recursive: true })
  git(origin, ['init', '-q', '--bare', '-b', 'master'])
  git(work, ['init', '-q', '-b', 'master'])
  git(work, ['remote', 'add', 'origin', origin])
  commit(work, files, 'init')
  git(work, ['push', '-q', 'origin', 'master'])
  git(work, ['remote', 'set-head', 'origin', 'master'])
  return { name, work }
}

function push(work: string): void {
  git(work, ['push', '-q', '-f', 'origin', 'master'])
}

/** A `bun` that answers `install` and `outdated` from files in `fake` and runs everything else on the real bun. */
function fakeBun(table: string, installExit = 0): string {
  const dir = mkdtempSync(join(fake, 'bun-'))
  writeFileSync(join(dir, 'outdated.txt'), table)
  const script = join(dir, 'bun')
  writeFileSync(
    script,
    `#!/bin/sh\ncase "$1" in\n  outdated) cat "${dir}/outdated.txt" ;;\n  install) exit ${installExit} ;;\n  *) exec "${process.execPath}" "$@" ;;\nesac\n`,
  )
  chmodSync(script, 0o755)
  return script
}

const checker = (options: { make?: string; bun?: string } = {}) =>
  createHygieneChecker({ repos: rootedRepos([join(base, 'repos')]), bun: fakeBun(''), ...options })

async function sweep(name: string, options: { make?: string; bun?: string } = {}): Promise<SweepReport> {
  const c = checker(options)
  const result = await c.withCheckout(name, null, (checkout) => c.sweep(checkout))
  if (!result.ok) throw new Error(result.error.detail)
  return result.value
}

const run = (report: SweepReport, probe: string) => report.runs.find((r) => r.probe === probe)
const findings = (report: SweepReport, probe: string) => report.findings.filter((f) => f.probe === probe)

const RETIRED_SCRIPT = {
  'scripts/retired-words.ts': readFileSync(join(REPO_ROOT, 'scripts/retired-words.ts'), 'utf8'),
  'scripts/retired-words.allow': '',
}

beforeAll(() => {
  base = mkdtempSync(join(tmpdir(), 'factory-hygiene-test-'))
  fake = mkdtempSync(join(tmpdir(), 'factory-hygiene-fake-'))
})
afterAll(() => {
  rmSync(base, { recursive: true, force: true })
  rmSync(fake, { recursive: true, force: true })
})

describe('withCheckout', () => {
  test('a detached worktree of origin default at a full sha, removed afterwards', async () => {
    const { name, work } = makeRepo({ 'a.txt': 'one\n' })
    const c = checker()
    let seen = ''
    const result = await c.withCheckout(name, null, async (checkout) => {
      seen = checkout.path
      expect(checkout.ref).toBe(git(work, ['rev-parse', 'HEAD']).trim())
      expect(git(checkout.path, ['rev-parse', '--abbrev-ref', 'HEAD']).trim()).toBe('HEAD')
      expect(readFileSync(join(checkout.path, 'a.txt'), 'utf8')).toBe('one\n')
      expect(checkout.path.startsWith(join(tmpdir(), 'factory-hygiene'))).toBe(true)
      return 'used'
    })
    expect(result).toEqual({ ok: true, value: 'used' })
    expect(existsSync(seen)).toBe(false)
    expect(git(work, ['worktree', 'list', '--porcelain'])).not.toContain('/factory-hygiene/')
  })

  test('removed when use throws, which is a gone', async () => {
    const { name, work } = makeRepo({ 'a.txt': 'one\n' })
    let seen = ''
    const result = await checker().withCheckout(name, null, async (checkout) => {
      seen = checkout.path
      throw new Error('boom')
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.kind).toBe('gone')
    expect(existsSync(seen)).toBe(false)
    expect(git(work, ['worktree', 'list', '--porcelain'])).not.toContain('/factory-hygiene/')
  })

  test('fetches first: a commit pushed from elsewhere is what gets checked out; a stored sha is used as given', async () => {
    const { name, work } = makeRepo({ 'a.txt': 'one\n' })
    const first = git(work, ['rev-parse', 'HEAD']).trim()
    const other = join(base, 'other-clone')
    git(base, ['clone', '-q', join(base, 'origins', `${name}.git`), other])
    commit(other, { 'b.txt': 'two\n' })
    git(other, ['push', '-q', 'origin', 'master'])
    const c = checker()
    const latest = await c.withCheckout(name, null, async (checkout) => existsSync(join(checkout.path, 'b.txt')))
    expect(latest).toEqual({ ok: true, value: true })
    const pinned = await c.withCheckout(name, first, async (checkout) => existsSync(join(checkout.path, 'b.txt')))
    expect(pinned).toEqual({ ok: true, value: false })
  })

  test('a ref that no longer resolves, and a repo outside the roots, are port errors', async () => {
    const { name } = makeRepo({ 'a.txt': 'one\n' })
    const c = checker()
    const missing = await c.withCheckout(name, 'f'.repeat(40), async () => 'x')
    expect(missing.ok).toBe(false)
    const outside = await c.withCheckout('/etc', null, async () => 'x')
    expect(outside.ok).toBe(false)
  })
})

describe('check probe', () => {
  test('clean, found with the tail of the output, skipped, failed', async () => {
    const green = await sweep(makeRepo({ Makefile: 'check:\n\t@exit 0\n' }).name)
    expect(run(green, 'check')?.outcome).toBe('clean')
    expect(run(green, 'check')?.detail).toMatch(/^make check, \d+s, exit 0$/)

    const noisy = Array.from({ length: 12 }, (_, i) => `\t@echo line${i + 1}`).join('\n')
    const red = await sweep(makeRepo({ Makefile: `check:\n${noisy}\n\t@echo oops >&2; exit 1\n` }).name)
    expect(run(red, 'check')?.outcome).toBe('found')
    const [item] = findings(red, 'check')
    expect(item?.key).toBe('check')
    expect(item?.title).toBe('Hygiene: make check is red on the default branch')
    expect(item?.count).toBe(1)
    expect(item?.lines.at(-2)).toBe('oops')
    expect(item?.lines).toHaveLength(8)
    expect(item?.lines[0]).toBe('line7')

    expect(run(await sweep(makeRepo({ 'a.txt': 'x' }).name), 'check')?.outcome).toBe('skipped')
    const broken = await sweep(makeRepo({ Makefile: 'check:\n\t@exit 0\n' }).name, { make: '/nonexistent/make' })
    expect(run(broken, 'check')?.outcome).toBe('failed')
  })

  test('the sweep runs the probes in PROBES order, one run each', async () => {
    const report = await sweep(makeRepo({ 'a.txt': 'x' }).name)
    expect(report.runs.map((r) => r.probe)).toEqual(['check', 'links', 'retired', 'deps', 'cochange'])
  })
})

describe('links probe', () => {
  test('one finding per file, ignoring code, schemes, anchors and absolute paths', async () => {
    const doc = [
      '# Doc',
      '[ok](other.md) [dir](sub/) [anchor](#top) [web](https://example.com/x) [mail](mailto:a@example.com)',
      '[abs](/etc/passwd) [frag](other.md#part) [query](other.md?x=1) [enc](my%20file.md)',
      '[gone](missing.md) and `[code](nope.md)`',
      '```',
      '[fenced](nope.md)',
      '```',
      '[also gone](sub/none.md#x "title")',
    ].join('\n')
    const { name } = makeRepo({
      'docs/a.md': doc,
      'docs/other.md': '# o',
      'docs/sub/x.md': '# x',
      'docs/my file.md': '# m',
      'docs/research/r.md': '[archived](nope.md)',
      'README.md': '[fine](docs/a.md)',
    })
    const report = await sweep(name)
    expect(run(report, 'links')?.outcome).toBe('found')
    expect(findings(report, 'links')).toEqual([
      {
        probe: 'links',
        key: 'links:docs/a.md',
        title: 'Hygiene: broken links in docs/a.md',
        lines: ['4: missing.md', '8: sub/none.md#x'],
        count: 2,
      },
    ])
  })

  test('clean when every link resolves; escaping the checkout is broken', () => {
    const root = mkdtempSync(join(base, 'links-'))
    writeFileSync(join(root, 'a.md'), '')
    expect(brokenLinks(root, 'b.md', '[x](a.md)')).toEqual([])
    expect(brokenLinks(root, 'b.md', '[x](../../etc/passwd)')).toHaveLength(1)
  })
})

describe('retired probe', () => {
  test('scope is AGENTS/README/REVIEW and the top of docs, minus the history documents', () => {
    expect(
      retiredScope([
        'AGENTS.md',
        'README.md',
        'docs/a.md',
        'docs/language.md',
        'docs/decisions.md',
        'docs/program.md',
        'docs/deep/b.md',
        'packages/x/README.md',
      ]),
    ).toEqual(['AGENTS.md', 'README.md', 'docs/a.md'])
  })

  test('found per file, clean, skipped without the script, failed on an unreadable exit', async () => {
    const dirty = await sweep(
      makeRepo({
        ...RETIRED_SCRIPT,
        'README.md': 'first\na wave of work\nanother wave\n',
        'docs/a.md': 'fine\n',
        'docs/language.md': 'wave is retired here\n',
      }).name,
    )
    expect(run(dirty, 'retired')?.outcome).toBe('found')
    const [item] = findings(dirty, 'retired')
    expect(findings(dirty, 'retired')).toHaveLength(1)
    expect(item?.key).toBe('retired:README.md')
    expect(item?.title).toBe('Hygiene: retired words in README.md')
    expect(item?.count).toBe(2)
    expect(item?.lines[0]).toBe('README.md:2: "wave" is retired (docs/language.md); say plan (rows of docs/plan.yaml)')

    const tidy = await sweep(makeRepo({ ...RETIRED_SCRIPT, 'README.md': 'fine\n' }).name)
    expect(run(tidy, 'retired')?.outcome).toBe('clean')
    expect(run(await sweep(makeRepo({ 'README.md': 'a wave\n' }).name), 'retired')?.outcome).toBe('skipped')
    const bad = await sweep(
      makeRepo({ 'scripts/retired-words.ts': 'console.error("nope"); process.exit(1)\n', 'README.md': 'x\n' }).name,
    )
    expect(run(bad, 'retired')?.outcome).toBe('failed')
  })
})

const TABLE = `bun outdated v1.4.2 (744846f84)
|-----------------------------------------------------|
| Package                | Current | Update | Latest   |
|------------------------|---------|--------|----------|
| zod                    | 4.1.0   | 4.1.0  | 4.1.0 *  |
| oxlint (dev)           | 1.91.0  | 1.91.0 | 1.92.1 * |
| left-pad               | 1.0.0   | 1.0.1  | 2.0.0    |
| typescript (dev)       | 5.8.0   | 5.8.3  | 5.9.1    |
| hono                   | 4.2.3   | 4.2.9  | 4.2.9    |
|-----------------------------------------------------|
Note: The * indicates that version isn't true latest due to minimum release age
`

describe('deps probe', () => {
  test('parses the table: names without (dev), Latest without *', () => {
    expect(parseOutdated(TABLE)).toEqual([
      { name: 'zod', current: '4.1.0', latest: '4.1.0', heldBack: true },
      { name: 'oxlint', current: '1.91.0', latest: '1.92.1', heldBack: true },
      { name: 'left-pad', current: '1.0.0', latest: '2.0.0', heldBack: false },
      { name: 'typescript', current: '5.8.0', latest: '5.9.1', heldBack: false },
      { name: 'hono', current: '4.2.3', latest: '4.2.9', heldBack: false },
    ])
    expect(severity('1.0.0', '2.0.0')).toBe('major')
    expect(severity('5.8.0', '5.9.1')).toBe('minor')
    expect(severity('4.2.3', '4.2.9')).toBe('patch')
  })

  test('one finding, major first, held back noted; clean; skipped; failed', async () => {
    const found = await sweep(makeRepo({ 'package.json': '{}' }).name, { bun: fakeBun(TABLE) })
    expect(run(found, 'deps')?.outcome).toBe('found')
    expect(findings(found, 'deps')).toEqual([
      {
        probe: 'deps',
        key: 'deps',
        title: 'Hygiene: outdated dependencies',
        lines: [
          'left-pad 1.0.0 -> 2.0.0 (major)',
          'oxlint 1.91.0 -> 1.92.1 (minor), held back by the release-age cooldown',
          'typescript 5.8.0 -> 5.9.1 (minor)',
          'hono 4.2.3 -> 4.2.9 (patch)',
        ],
        count: 4,
      },
    ])

    const tidy = await sweep(makeRepo({ 'package.json': '{}' }).name, {
      bun: fakeBun('|--|\n| Package | Current | Update | Latest |\n|--|\n| zod | 1.0.0 | 1.0.0 | 1.0.0 * |\n'),
    })
    expect(run(tidy, 'deps')?.outcome).toBe('clean')
    expect(run(await sweep(makeRepo({ 'a.txt': 'x' }).name), 'deps')?.outcome).toBe('skipped')
    const noInstall = await sweep(makeRepo({ 'package.json': '{}' }).name, { bun: fakeBun(TABLE, 1) })
    expect(run(noInstall, 'deps')?.outcome).toBe('failed')
    // a gate that could not get its dependencies is not a red gate
    const withGate = makeRepo({ 'package.json': '{}', Makefile: 'check:\n\texit 1\n' })
    const gated = await sweep(withGate.name, { bun: fakeBun(TABLE, 1) })
    expect(run(gated, 'check')?.outcome).toBe('failed')
    expect(findings(gated, 'check')).toEqual([])
  })
})

describe('cochange probe', () => {
  const commits = (n: number, files: string[]) => Array.from({ length: n }, () => files)

  test('a pair in different directories that moves together is a finding; filters hold', () => {
    const pairs = coChanged([
      ...commits(7, ['src/a/x.ts', 'lib/y.ts']),
      ...commits(8, ['src/a/gen.ts', 'src/b/gen.sql']), // same stem
      ...commits(8, ['src/c/one.ts', 'src/c/two.ts']), // same directory
      ...commits(5, ['src/d/p.ts', 'src/e/q.ts']), // too few
      ...commits(6, ['src/f/m.ts', 'src/g/n.ts']), // 6 of n's 12 commits: 0.5 < 0.7
      ...commits(6, ['src/f/m.ts', 'src/h/o.ts']),
      ...commits(6, ['src/g/n.ts']),
      ...commits(6, ['src/h/o.ts']),
      ...commits(
        7,
        Array.from({ length: 30 }, (_, i) => `big/d${i}/f${i}.ts`),
      ), // too many files
    ])
    expect(pairs.map((p) => `${p.a}|${p.b}`)).toEqual(['lib/y.ts|src/a/x.ts'])
    expect(pairs[0]).toMatchObject({ together: 7, inA: 7, inB: 7 })
    expect(coChanged(commits(7, ['src/a/x.ts', 'lib/y.ts']), (file) => file !== 'lib/y.ts')).toEqual([])
  })

  test('ignores lockfiles, docs, generated, fixtures and tests', () => {
    const log = `\0${'a'.repeat(40)}\n\nbun.lock\nREADME.md\ndocs/x.ts\nsrc/generated/g.ts\nsrc/a.test.ts\ntest/t.ts\nsrc/real.ts\n`
    expect(parseLog(log)).toEqual([['src/real.ts']])
  })

  test('over a real history', async () => {
    const { name, work } = makeRepo({ 'src/a/x.ts': '0', 'lib/y.ts': '0' })
    for (let i = 1; i <= 7; i++) commit(work, { 'src/a/x.ts': `${i}`, 'lib/y.ts': `${i}` })
    push(work)
    const report = await sweep(name)
    expect(run(report, 'cochange')?.outcome).toBe('found')
    expect(findings(report, 'cochange')[0]).toMatchObject({
      key: 'cochange:lib/y.ts|src/a/x.ts',
      title: 'Hygiene: lib/y.ts and src/a/x.ts change together',
      lines: ['changed together in 8 of the last 300 commits (lib/y.ts: 8, src/a/x.ts: 8)'],
      count: 8,
    })
  })
})

describe('stale and slop candidates', () => {
  test('stale: old doc, 20 code commits since; slop: a doc with 15 lines edited lately', async () => {
    const old = '2020-01-01T00:00:00Z'
    const { name, work } = makeRepo({ 'README.md': 'old\n', 'code.ts': '0' })
    git(work, ['commit', '-q', '--amend', '--no-edit', '--date', old], { GIT_COMMITTER_DATE: old })
    for (let i = 1; i <= 20; i++) commit(work, { 'code.ts': `${i}` }, `c${i}`, old)
    commit(work, { 'docs/notes.md': Array.from({ length: 20 }, (_, i) => `line ${i}`).join('\n') })
    commit(work, { 'docs/research/r.md': Array.from({ length: 20 }, (_, i) => `line ${i}`).join('\n') })
    push(work)
    const report = await sweep(name)
    expect(report.stale).toEqual([{ path: 'README.md', why: 'last edited 2020-01-01; 20 commits to code since' }])
    expect(report.slop).toEqual([{ path: 'docs/notes.md', why: 'edited 0 days ago; 20 lines' }])
  })
})
