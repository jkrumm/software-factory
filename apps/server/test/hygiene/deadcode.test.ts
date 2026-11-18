import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { defaultTools, type Tools } from '../../src/adapters/hygiene/git.ts'
import { deadcodeProbe, parseFallow } from '../../src/adapters/hygiene/probes/deadcode.ts'

const REPORT = readFileSync(join(import.meta.dir, 'fixtures', 'fallow-dead-code.json'), 'utf8')

let base: string
let counter = 0

const ID = {
  GIT_AUTHOR_NAME: 'T',
  GIT_AUTHOR_EMAIL: 't@example.com',
  GIT_COMMITTER_NAME: 'T',
  GIT_COMMITTER_EMAIL: 't@example.com',
}

function repo(files: Record<string, string>): string {
  const dir = join(base, `repo-${++counter}`)
  mkdirSync(dir, { recursive: true })
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, file)), { recursive: true })
    writeFileSync(join(dir, file), text)
  }
  for (const args of [
    ['init', '-q', '-b', 'master'],
    ['add', '-A'],
    ['commit', '-q', '-m', 'init'],
  ]) {
    const result = Bun.spawnSync(['git', ...args], { cwd: dir, env: { ...process.env, ...ID } })
    if (result.exitCode !== 0) throw new Error(result.stderr.toString())
  }
  return dir
}

function fakeTool(name: string, stdout: string, code: number, stderr = ''): string {
  const dir = mkdtempSync(join(base, `${name}-`))
  writeFileSync(join(dir, 'out'), stdout)
  const script = join(dir, name)
  writeFileSync(
    script,
    `#!/bin/sh\necho "$@" >> "${dir}/args.log"\ncat "${dir}/out"\n${stderr ? `echo '${stderr}' >&2\n` : ''}exit ${code}\n`,
  )
  chmodSync(script, 0o755)
  return script
}

const tools = (extra: Partial<Tools>): Tools => ({ ...defaultTools(), ...extra })
const withModules = { 'package.json': '{}', 'node_modules/.keep': '' }

beforeAll(() => {
  base = mkdtempSync(join(tmpdir(), 'factory-deadcode-test-'))
})
afterAll(() => rmSync(base, { recursive: true, force: true }))

const emptyReport = (extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    kind: 'dead-code',
    unused_files: [],
    unused_exports: [],
    unused_dependencies: [],
    unused_dev_dependencies: [],
    ...extra,
  })

describe('parseFallow', () => {
  test('files, exports as path:line name, and dependencies of every section', () => {
    expect(parseFallow(REPORT)).toEqual({
      files: ['orphan.js'],
      exports: ['src/a.ts:3 unusedExport'],
      deps: ['left-pad', 'lodash'],
    })
  })
  test("fallow's own error document, other JSON and no JSON are errors", () => {
    expect(parseFallow('{"error":true,"message":"invalid root path","exit_code":2}')).toEqual({
      error: 'invalid root path',
    })
    expect(parseFallow('{"a":1}')).toEqual({ error: 'not a fallow dead-code report' })
    expect(parseFallow('')).toEqual({ error: 'no JSON on stdout' })
  })
})

describe('deadcodeProbe', () => {
  test('red: one finding per kind, the first 8 lines, the count of all', async () => {
    const exports = Array.from({ length: 11 }, (_, i) => ({
      path: `src/m${String(i).padStart(2, '0')}.ts`,
      export_name: `e${i}`,
      line: i + 1,
    }))
    const fallow = fakeTool('fallow', emptyReport({ unused_files: [{ path: 'a.ts' }], unused_exports: exports }), 1)
    const outcome = await deadcodeProbe(tools({ fallow }), repo(withModules))
    expect(outcome.outcome).toBe('found')
    expect(outcome.findings.map((f) => [f.key, f.title, f.count])).toEqual([
      ['deadcode:files', 'Hygiene: unused files', 1],
      ['deadcode:exports', 'Hygiene: unused exports', 11],
    ])
    expect(outcome.findings[1]?.lines).toHaveLength(8)
    expect(outcome.findings[1]?.lines[0]).toBe('src/m00.ts:1 e0')
    expect(readFileSync(join(dirname(fallow), 'args.log'), 'utf8')).toBe('dead-code --format json --quiet --no-cache\n')
  })

  test('red: unused dependencies, devDependencies included', async () => {
    const fallow = fakeTool('fallow', REPORT, 1)
    const outcome = await deadcodeProbe(tools({ fallow }), repo(withModules))
    expect(outcome.findings.find((f) => f.key === 'deadcode:deps')).toMatchObject({
      title: 'Hygiene: unused dependencies',
      lines: ['left-pad', 'lodash'],
      count: 2,
    })
  })

  test('green: exit 0 and an empty report is clean', async () => {
    const outcome = await deadcodeProbe(tools({ fallow: fakeTool('fallow', emptyReport(), 0) }), repo(withModules))
    expect(outcome.outcome).toBe('clean')
  })

  test('skip: no package.json; fallow not installed', async () => {
    expect((await deadcodeProbe(tools({}), repo({ 'a.txt': 'x' }))).outcome).toBe('skipped')
    expect(await deadcodeProbe(tools({ fallow: join(base, 'no-such-fallow') }), repo(withModules))).toEqual({
      outcome: 'skipped',
      detail: 'fallow is not installed on this host',
      findings: [],
    })
  })

  test('unusual: fallow exit 2 with its error document is failed with the message', async () => {
    const error = '{"error":true,"message":"Failed to parse config file","exit_code":2}'
    const outcome = await deadcodeProbe(tools({ fallow: fakeTool('fallow', error, 2) }), repo(withModules))
    expect(outcome).toEqual({
      outcome: 'failed',
      detail: 'fallow failed (exit 2): Failed to parse config file',
      findings: [],
    })
  })

  test('unusual: a crash with unparseable output is failed with the first stderr line', async () => {
    const outcome = await deadcodeProbe(
      tools({ fallow: fakeTool('fallow', 'garbage', 101, 'thread panicked') }),
      repo(withModules),
    )
    expect(outcome.outcome).toBe('failed')
    expect(outcome.detail).toBe('fallow failed (exit 101): thread panicked')
  })

  test('unusual: without node_modules a bun.lock repo is installed first; a failed install is failed', async () => {
    const files = { 'package.json': '{}', 'bun.lock': '{}' }
    const fallow = fakeTool('fallow', emptyReport(), 0)
    const ok = await deadcodeProbe(tools({ fallow, bun: fakeTool('bun', '', 0) }), repo(files))
    expect(ok.outcome).toBe('clean')
    expect(ok.detail).toContain('bun install --frozen-lockfile')
    const bad = await deadcodeProbe(tools({ fallow, bun: fakeTool('bun', '', 1) }), repo(files))
    expect(bad).toEqual({ outcome: 'failed', detail: 'bun install --frozen-lockfile failed (exit 1)', findings: [] })
  })

  test('unusual: a package directory without node_modules is installed too, so its dependencies are judged', async () => {
    const dir = repo({
      'package.json': '{}',
      'bun.lock': '{}',
      'node_modules/.keep': '',
      'ui/package.json': '{}',
      'ui/bun.lock': '{}',
    })
    const bun = join(base, `bun-${++counter}`)
    writeFileSync(bun, '#!/bin/sh\nmkdir -p node_modules\n')
    chmodSync(bun, 0o755)
    const outcome = await deadcodeProbe(tools({ fallow: fakeTool('fallow', REPORT, 1), bun }), dir)
    expect(existsSync(join(dir, 'ui', 'node_modules'))).toBe(true)
    expect(outcome.findings.map((f) => f.key)).toContain('deadcode:deps')
    expect(outcome.detail).toContain('in ui')
  })

  test('unusual: no node_modules and no bun.lock leaves unused dependencies out', async () => {
    const outcome = await deadcodeProbe(
      tools({ fallow: fakeTool('fallow', REPORT, 1) }),
      repo({ 'package.json': '{}' }),
    )
    expect(outcome.findings.map((f) => f.key)).toEqual(['deadcode:files', 'deadcode:exports'])
  })
})
