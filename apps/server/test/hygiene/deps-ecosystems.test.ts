import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { defaultTools } from '../../src/adapters/hygiene/git.ts'
import {
  actionUses,
  cargoDependencies,
  depsProbe as probeWithDates,
  dockerImages,
  gap,
  lowerBound,
  type Lookup,
  newestRelease,
  newestSameShape,
  pythonDependencies,
  swiftPackages,
} from '../../src/adapters/hygiene/probes/deps.ts'

/** No registry is asked for a publish date: the plan's cooldown has its own tests. */
const depsProbe = (tools: Parameters<typeof probeWithDates>[0], dir: string, lookup: Lookup) =>
  probeWithDates(tools, dir, lookup, async () => undefined)

let base: string
let counter = 0

function repo(files: Record<string, string>): string {
  const dir = join(base, `repo-${++counter}`)
  mkdirSync(dir, { recursive: true })
  const git = (...args: string[]) => {
    const r = Bun.spawnSync(['git', ...args], {
      cwd: dir,
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 'T',
        GIT_AUTHOR_EMAIL: 't@example.com',
        GIT_COMMITTER_NAME: 'T',
        GIT_COMMITTER_EMAIL: 't@example.com',
      },
    })
    if (r.exitCode !== 0) throw new Error(r.stderr.toString())
  }
  git('init', '-q', '-b', 'master')
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, file)), { recursive: true })
    writeFileSync(join(dir, file), text)
  }
  git('add', '-A')
  git('commit', '-q', '-m', 'c')
  return dir
}

beforeAll(() => {
  base = mkdtempSync(join(tmpdir(), 'hygiene-deps-'))
})
afterAll(() => rmSync(base, { recursive: true, force: true }))

describe('parsers', () => {
  test('lowerBound', () => {
    expect(lowerBound('^1.2')).toBe('1.2')
    expect(lowerBound('1.2.3')).toBe('1.2.3')
    expect(lowerBound('>=1.2,<2')).toBe('1.2')
    expect(lowerBound('~=1.2')).toBe('1.2')
    expect(lowerBound('==v3.0')).toBe('3.0')
    expect(lowerBound('<2')).toBeUndefined()
    expect(lowerBound('*')).toBeUndefined()
  })

  test('cargo', () => {
    const toml = `[package]\nname = "x"\n[dependencies]\nserde = "1.0"\ntokio = { version = "1.30", features = ["full"] }\nlocal = { path = "../local", version = "0.1" }\ng = { git = "https://example.com/g.git" }\nrenamed = { package = "real", version = "^2" }\n[dev-dependencies]\ncriterion = ">=0.5, <1"\n[target.'cfg(unix)'.dependencies]\nlibc = "0.2"\n`
    expect(cargoDependencies(toml)).toEqual([
      { name: 'serde', current: '1.0' },
      { name: 'tokio', current: '1.30' },
      { name: 'real', current: '2' },
      { name: 'criterion', current: '0.5', dev: true },
      { name: 'libc', current: '0.2' },
    ])
    expect(cargoDependencies('not = [toml')).toEqual([])
  })

  test('python: dependency groups, Poetry groups and development requirements files are dev', () => {
    const toml = `[project]\ndependencies = ["requests>=2.30"]\n[dependency-groups]\ndev = ["pytest>=8.0"]\n[tool.poetry.group.lint.dependencies]\nruff = "^0.5"\n`
    expect(pythonDependencies(toml)).toEqual([
      { name: 'requests', current: '2.30' },
      { name: 'pytest', current: '8.0', dev: true },
      { name: 'ruff', current: '0.5', dev: true },
    ])
    expect(pythonDependencies('pytest>=8\n', 'requirements-dev.txt')).toEqual([
      { name: 'pytest', current: '8', dev: true },
    ])
    expect(pythonDependencies('flask>=2\n', 'requirements.txt')).toEqual([{ name: 'flask', current: '2' }])
  })

  test('python', () => {
    const toml = `[project]\nname = "x"\ndependencies = ["requests>=2.30", "httpx[http2]~=0.24; python_version>'3.8'", "bare", "pkg @ https://example.com/p.zip"]\n[project.optional-dependencies]\ndev = ["pytest==8.0.0"]\n[tool.poetry.dependencies]\npython = "^3.11"\nflask = "^2.0"\n`
    expect(pythonDependencies(toml)).toEqual([
      { name: 'requests', current: '2.30' },
      { name: 'httpx', current: '0.24' },
      { name: 'pytest', current: '8.0.0' },
      { name: 'flask', current: '2.0' },
    ])
    expect(pythonDependencies('# c\nrequests==2.31.0\n-r other.txt\nfoo>=1 # note\nbar\n', 'requirements.txt')).toEqual(
      [
        { name: 'requests', current: '2.31.0' },
        { name: 'foo', current: '1' },
      ],
    )
  })

  test('swift', () => {
    const text = `dependencies: [\n.package(url: "https://github.com/a/b.git", from: "1.2.0"),\n.package(url: "https://github.com/c/d", .upToNextMinor(from: "0.5.1")),\n.package(url: "https://github.com/e/f", exact: "2.0.0"),\n.package(url: "https://github.com/g/h", "3.0.0"..<"4.0.0"),\n.package(path: "../local"),\n]`
    expect(swiftPackages(text).map((d) => `${d.name} ${d.current}`)).toEqual([
      'https://github.com/a/b.git 1.2.0',
      'https://github.com/c/d 0.5.1',
      'https://github.com/e/f 2.0.0',
      'https://github.com/g/h 3.0.0',
    ])
  })

  test('docker', () => {
    const dockerfile = `FROM --platform=linux/amd64 node:20-alpine AS build\nFROM build AS test\nFROM scratch\nFROM alpine\nFROM busybox:latest\nFROM debian@sha256:abc\nFROM ghcr.io/o/i:1.2.3\nFROM base:\${V}\nFROM python:3.12-slim@sha256:abc\n`
    expect(dockerImages(dockerfile)).toEqual([
      { name: 'node', current: '20-alpine' },
      { name: 'ghcr.io/o/i', current: '1.2.3' },
      { name: 'python', current: '3.12-slim' },
    ])
    expect(dockerImages('services:\n  a:\n    image: "postgres:16"\n  b:\n    image: redis\n', 'compose.yaml')).toEqual(
      [{ name: 'postgres', current: '16' }],
    )
  })

  test('actions', () => {
    const text = `steps:\n  - uses: actions/checkout@v4\n  - uses: actions/cache/restore@v3.2.1 # c\n  - uses: a/b@main\n  - uses: c/d@${'a'.repeat(40)}\n  - uses: ./local\n`
    expect(actionUses(text)).toEqual([
      { name: 'actions/checkout', current: '4' },
      { name: 'actions/cache', current: '3.2.1' },
    ])
  })

  test('gap judges down to the precision of current', () => {
    expect(gap('4', '5.1.0')).toBe('major')
    expect(gap('4', '4.9.9')).toBeUndefined()
    expect(gap('1.2', '1.3.0')).toBe('minor')
    expect(gap('1.2.3', '1.2.9')).toBeUndefined()
    expect(gap('2.0', '1.9')).toBeUndefined()
  })

  test('newest release and shape', () => {
    expect(newestRelease(['v1.2.0', 'v1.10.0', 'v2.0.0-rc1', 'latest', 'v1.9'])).toBe('1.10.0')
    expect(newestSameShape('20-alpine', ['22-alpine', '22', '24-slim', '23.1-alpine', '23-alpine'])).toBe('23-alpine')
    expect(newestSameShape('latest', ['1'])).toBeUndefined()
  })

  test('a bare tag with no patch tag under it is a pre-release line, not an upgrade', () => {
    // valkey: 9.2 holds a release candidate; only 9.2.0-rc2 exists below it
    expect(newestSameShape('9.1', ['9.2', '9.2.0-rc2', '9.1', '9.1.3', '9.0.3', '9.0'])).toBe('9.1')
    expect(newestSameShape('9.1', ['9.2', '9.2.0', '9.1.3'])).toBe('9.2')
    // an image with no patch tags at all keeps its newest tag
    expect(newestSameShape('22.04', ['24.04', '22.04', '20.04'])).toBe('24.04')
  })

  test('a version prefix is kept and does not make a major of a minor line', () => {
    expect(newestSameShape('v3.7', ['v3.7', 'v3.7.19', 'v3.6', 'v3.6.2', '3.7'])).toBe('v3.7')
    expect(gap('v3.7', 'v3.7')).toBeUndefined()
    expect(gap('v3.7', 'v3.8')).toBe('minor')
    expect(gap('v3.7', 'v4.0')).toBe('major')
  })
})

describe('depsProbe', () => {
  const lookup =
    (table: Record<string, string | undefined>, fail: string[] = []): Lookup =>
    async ({ ecosystem, name }) => {
      if (fail.includes(name)) throw new Error('down')
      return table[`${ecosystem}:${name}`]
    }

  test('red: each ecosystem is its own finding, major first, patch ignored', async () => {
    const dir = repo({
      'Cargo.toml': '[dependencies]\nserde = "1.0"\nrand = "0.8"\nlog = "0.4.1"\nfoo = "1.0"\n',
      'pyproject.toml': '[project]\ndependencies = ["requests>=2.0"]\n',
      '.github/workflows/ci.yml': 'jobs:\n  a:\n    steps:\n      - uses: actions/checkout@v3\n',
      Dockerfile: 'FROM node:20-alpine\n',
    })
    const out = await depsProbe(
      defaultTools(),
      dir,
      lookup(
        {
          'cargo:serde': '1.0.229',
          'cargo:rand': '0.9.2',
          'cargo:log': '0.4.9',
          'python:requests': '3.0.0',
          'actions:actions/checkout': '5.0.0',
          'docker:node': '24-alpine',
        },
        ['foo'],
      ),
    )
    expect(out.outcome).toBe('found')
    expect(out.findings.map((f) => f.key).sort()).toEqual(['deps:actions', 'deps:cargo', 'deps:docker', 'deps:python'])
    const cargo = out.findings.find((f) => f.key === 'deps:cargo')
    expect(cargo?.lines).toEqual(['rand 0.8 -> 0.9.2 (minor)'])
    expect(cargo?.rows).toMatchObject([{ ecosystem: 'cargo', name: 'rand', size: 'minor', dev: false }])
    // a workflow's actions run in CI, never in the product: they are tooling
    expect(out.findings.find((f) => f.key === 'deps:actions')?.rows?.map((row) => row.dev)).toEqual([true])
    expect(out.findings.find((f) => f.key === 'deps:docker')?.rows?.map((row) => row.dev)).toEqual([false])
    expect(out.detail).toContain('1 not looked up')
    expect(out.findings.find((f) => f.key === 'deps:docker')?.lines).toEqual(['node 20-alpine -> 24-alpine (major)'])
  })

  test('a row carries the day its latest version was published, for the refresh to plan the cooldown', async () => {
    const dir = repo({ 'compose.yaml': 'services:\n  db:\n    image: mariadb:11.4\n' })
    const out = await probeWithDates(
      defaultTools(),
      dir,
      lookup({ 'docker:mariadb': '13.0' }),
      async ({ ecosystem, version }) =>
        ecosystem === 'docker' && version === '13.0' ? new Date('2026-11-12') : undefined,
    )
    expect(out.findings[0]?.rows).toMatchObject([
      { name: 'mariadb', latest: '13.0', size: 'major', releasedAt: new Date('2026-11-12') },
    ])
  })

  test('a found run with a look-up that failed leaves the key unjudged: it is no green verdict', async () => {
    const dir = repo({ 'Cargo.toml': '[dependencies]\nserde = "1.0"\nrand = "0.8"\n' })
    const out = await depsProbe(defaultTools(), dir, lookup({ 'cargo:serde': '2.0.0' }, ['rand']))
    expect(out.outcome).toBe('found')
    expect(out.unjudged).toEqual(['deps'])
  })

  test('green', async () => {
    const dir = repo({ 'Cargo.toml': '[dependencies]\nserde = "1.0"\n' })
    expect((await depsProbe(defaultTools(), dir, lookup({ 'cargo:serde': '1.0.229' }))).outcome).toBe('clean')
  })

  test('a look-up that failed leaves its key unjudged, a green one does not', async () => {
    const dir = repo({
      'Cargo.toml': '[dependencies]\nserde = "1.0"\nrand = "0.8"\n',
      Dockerfile: 'FROM node:20-alpine\n',
    })
    const partial = await depsProbe(
      defaultTools(),
      dir,
      lookup({ 'cargo:serde': '1.0.229', 'docker:node': '20-alpine' }, ['rand']),
    )
    expect(partial.outcome).toBe('clean')
    expect(partial.unjudged).toEqual(['deps'])
    const whole = await depsProbe(
      defaultTools(),
      dir,
      lookup({ 'cargo:serde': '1.0.229', 'cargo:rand': '0.8.5', 'docker:node': '20-alpine' }),
    )
    expect(whole.outcome).toBe('clean')
    expect(whole.unjudged).toBeUndefined()
  })

  test('skip: no package file', async () => {
    const out = await depsProbe(defaultTools(), repo({ 'a.txt': 'x' }), lookup({}))
    expect(out).toMatchObject({ outcome: 'skipped', detail: 'no package file' })
  })

  test('failed only when every look-up failed; a broken package file is no crash', async () => {
    const dir = repo({ 'Cargo.toml': '[dependencies]\nserde = "1.0"\nrand = "0.8"\n', 'pyproject.toml': '= broken [' })
    const out = await depsProbe(defaultTools(), dir, lookup({}, ['serde', 'rand']))
    expect(out.outcome).toBe('failed')
    expect(out.detail).toContain('2 not looked up')
  })
})
