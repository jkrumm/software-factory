import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { defaultTools } from '../../src/adapters/hygiene/git.ts'
import {
  type PrivacyLookup,
  ciProbe,
  githubRepoOf,
  pinBreach,
  runnerBreach,
  runsMake,
} from '../../src/adapters/hygiene/probes/ci.ts'

let base: string
let counter = 0

function git(cwd: string, args: string[]): void {
  const result = Bun.spawnSync(['git', ...args], {
    cwd,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'T',
      GIT_AUTHOR_EMAIL: 't@example.com',
      GIT_COMMITTER_NAME: 'T',
      GIT_COMMITTER_EMAIL: 't@example.com',
    },
  })
  if (result.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr.toString()}`)
}

function repo(
  files: Record<string, string>,
  origin: string | undefined = 'https://github.com/owner-a/repo-a.git',
): string {
  const dir = join(base, `repo-${++counter}`)
  mkdirSync(dir, { recursive: true })
  git(dir, ['init', '-q', '-b', 'master'])
  if (origin) git(dir, ['remote', 'add', 'origin', origin])
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, file)), { recursive: true })
    writeFileSync(join(dir, file), text)
  }
  git(dir, ['add', '-A'])
  git(dir, ['commit', '-q', '-m', 'c'])
  return dir
}

const workflow = (runsOn: string, steps: string): string =>
  `name: ci\non: push\njobs:\n  build:\n    runs-on: ${runsOn}\n    steps:\n${steps}`

const GOOD = `      - uses: actions/checkout@v4\n      - run: make check\n`
const priv: PrivacyLookup = async () => true
const pub: PrivacyLookup = async () => false
const unknown: PrivacyLookup = async () => undefined

beforeAll(() => {
  base = mkdtempSync(join(tmpdir(), 'hygiene-ci-'))
})
afterAll(() => rmSync(base, { recursive: true, force: true }))

describe('rules', () => {
  test('the runner by privacy', () => {
    expect(runnerBreach(['self-hosted', 'vps'], true)).toBeUndefined()
    expect(runnerBreach('ubuntu-latest', true)).toContain('[self-hosted, vps]')
    expect(runnerBreach('ubuntu-latest', false)).toBeUndefined()
    expect(runnerBreach(['self-hosted', 'vps'], false)).toContain('public repo')
    expect(runnerBreach(['$', '{{ matrix.os }}'].join(''), true)).toBeUndefined()
    expect(runnerBreach({ group: 'g', labels: ['macos-14'] }, true)).toContain('macos-14')
  })

  test('pins', () => {
    for (const ok of ['actions/checkout@v4', 'a/b@v4.2.1', `a/b/sub@${'a'.repeat(40)}`, './local', 'docker://alpine:3'])
      expect(pinBreach(ok)).toBeUndefined()
    for (const bad of ['a/b@main', 'a/b@master', 'a/b@latest', 'a/b']) expect(pinBreach(bad)).toBeDefined()
  })

  test('make target is a whole word', () => {
    expect(runsMake('make check', 'check')).toBe(true)
    expect(runsMake('make -C app check', 'check')).toBe(true)
    expect(runsMake('echo hi && make check\n', 'check')).toBe(true)
    expect(runsMake('make check-fast', 'check')).toBe(false)
  })

  test('github remotes', () => {
    expect(githubRepoOf('git@github.com:o/r.git')).toEqual({ owner: 'o', repo: 'r' })
    expect(githubRepoOf('https://github.com/o/r')).toEqual({ owner: 'o', repo: 'r' })
    expect(githubRepoOf('https://gitlab.example.com/o/r.git')).toBeUndefined()
  })
})

describe('ciProbe', () => {
  const run = (dir: string, privacy = priv) => ciProbe(defaultTools(), dir, privacy)

  test('red: hosted runner on a private repo and a branch pin, one finding per workflow', async () => {
    const dir = repo({
      '.github/workflows/ci.yml': workflow(
        'ubuntu-latest',
        `      - uses: actions/checkout@main\n      - run: make check\n`,
      ),
    })
    const out = await run(dir)
    expect(out.outcome).toBe('found')
    expect(out.findings).toHaveLength(1)
    const [f] = out.findings
    expect(f?.key).toBe('ci:.github/workflows/ci.yml')
    expect(f?.title).toBe("Hygiene: CI workflow .github/workflows/ci.yml breaks the repo's rules")
    expect(f?.lines.join('\n')).toContain('[self-hosted, vps]')
    expect(f?.lines.join('\n')).toContain('actions/checkout@main')
  })

  test('red: a self-hosted runner in a public repo', async () => {
    const dir = repo({ '.github/workflows/ci.yml': workflow('[self-hosted, vps]', GOOD) })
    const out = await run(dir, pub)
    expect(out.findings[0]?.lines.join('\n')).toContain('public repo')
  })

  test('red: the gate target is not run', async () => {
    const dir = repo({
      '.github/workflows/ci.yml': workflow(
        '[self-hosted, vps]',
        `      - uses: actions/checkout@v4\n      - run: make check-fast\n`,
      ),
      'project.yaml': 'checks:\n  fast: make check-fast\n  full: make check\n  ci: true\n',
    })
    const out = await run(dir)
    expect(out.findings.map((f) => f.key)).toEqual(['ci:gate'])
  })

  test('green', async () => {
    const dir = repo({
      '.github/workflows/ci.yml': workflow('[self-hosted, vps]', GOOD),
      'project.yaml': 'checks:\n  fast: make check-fast\n  full: make check\n  ci: true\n',
    })
    const out = await run(dir)
    expect(out.outcome).toBe('clean')
  })

  test('skip: no workflow files', async () => {
    expect((await run(repo({ 'a.txt': 'x' }))).outcome).toBe('skipped')
  })

  test('unknown privacy skips only the runner rule; a broken workflow is noted, not a crash', async () => {
    const dir = repo({
      '.github/workflows/ci.yml': workflow('ubuntu-latest', `      - uses: a/b@main\n`),
      '.github/workflows/broken.yml': 'jobs: [unclosed\n',
    })
    const out = await run(dir, unknown)
    expect(out.outcome).toBe('found')
    expect(out.findings[0]?.lines.join('\n')).not.toContain('runs-on')
    expect(out.detail).toContain('runner rule skipped')
    expect(out.detail).toContain('not valid YAML')
  })

  test('no GitHub origin skips the runner rule', async () => {
    const dir = repo(
      { '.github/workflows/ci.yml': workflow('ubuntu-latest', GOOD) },
      'https://gitlab.example.com/o/r.git',
    )
    const out = await run(dir, async () => {
      throw new Error('must not be asked')
    })
    expect(out.outcome).toBe('clean')
    expect(out.detail).toContain('no GitHub origin')
    // the runner rule was not judged, so a workflow's key is not green; the gate rule was judged
    expect(out.unjudged).toEqual(['ci:.github/workflows/ci.yml'])
  })
})
