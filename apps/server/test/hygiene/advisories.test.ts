import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { defaultTools, type Tools } from '../../src/adapters/hygiene/git.ts'
import { advisoriesProbe, evidence, parseBunAudit, parseOsv } from '../../src/adapters/hygiene/probes/advisories.ts'

const fixture = (name: string): string => readFileSync(join(import.meta.dir, 'fixtures', name), 'utf8')
const BUN_AUDIT = fixture('bun-audit.json')
const OSV_CARGO = fixture('osv-cargo.json')

let base: string
let counter = 0

const ID = {
  GIT_AUTHOR_NAME: 'T',
  GIT_AUTHOR_EMAIL: 't@example.com',
  GIT_COMMITTER_NAME: 'T',
  GIT_COMMITTER_EMAIL: 't@example.com',
}

/** A git repo with the files committed. */
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

/** An executable that prints a file (or nothing) and exits with `code`; `args.log` gets its arguments. */
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

beforeAll(() => {
  base = mkdtempSync(join(tmpdir(), 'factory-advisories-test-'))
})
afterAll(() => rmSync(base, { recursive: true, force: true }))

describe('parseBunAudit', () => {
  test('keeps high and critical, critical first, with the fixed version from the range', () => {
    const advisories = parseBunAudit(BUN_AUDIT)
    expect(advisories?.map(evidence)).toEqual([
      'minimist >=1.0.0 <1.2.6: GHSA-xvch-5gv4-984h critical (fixed in 1.2.6)',
      'lodash <4.17.21: GHSA-35jh-r3h4-6jhm high (fixed in 4.17.21)',
      'lodash >=4.0.0 <=4.17.23: GHSA-r5fr-rjxr-66jc high (no fixed version)',
    ])
  })
  test('an empty object is no advisories; anything else is not the document', () => {
    expect(parseBunAudit('{}')).toEqual([])
    expect(parseBunAudit('')).toBeUndefined()
    expect(parseBunAudit('error: missing lockfile')).toBeUndefined()
    expect(parseBunAudit('[]')).toBeUndefined()
  })
})

describe('parseOsv', () => {
  test('a group with a CVSS score of 7.0 or more is high; unscored and lower ones are not counted', () => {
    expect(parseOsv(OSV_CARGO)?.map(evidence)).toEqual(['rmcp 3.5.1: RUSTSEC-2026-0461 high (fixed in 3.6.0)'])
  })
  test('critical by score, a GitHub label counts without a score, and the fix above the installed version is named', () => {
    const doc = JSON.parse(OSV_CARGO)
    const packages = doc.results[0].packages
    const tokio = packages.find((p: { package: { name: string } }) => p.package.name === 'tokio')
    tokio.groups[0].max_severity = '9.8'
    const rustls = packages.find((p: { package: { name: string } }) => p.package.name === 'rustls')
    rustls.vulnerabilities.find((v: { id: string }) => v.id === 'GHSA-c8m5-c952-6cm4').database_specific.severity =
      'HIGH'
    expect(parseOsv(JSON.stringify(doc))?.map(evidence)).toEqual([
      'tokio 1.53.1: RUSTSEC-2026-0386 critical (fixed in 1.53.3)',
      'rmcp 3.5.1: RUSTSEC-2026-0461 high (fixed in 3.6.0)',
      'rustls 0.23.45: RUSTSEC-2026-0346 high (fixed in 0.23.46)',
    ])
  })
  test('no results is no advisories; anything else is not the document', () => {
    expect(parseOsv('{"results":[]}')).toEqual([])
    expect(parseOsv('')).toBeUndefined()
    expect(parseOsv('{}')).toBeUndefined()
  })
})

describe('advisoriesProbe', () => {
  const bunRepo = () => repo({ 'package.json': '{}', 'bun.lock': '{}' })

  test('red: bun audit advisories are one finding with the evidence lines', async () => {
    const bun = fakeTool('bun', BUN_AUDIT, 1)
    const outcome = await advisoriesProbe(tools({ bun }), bunRepo())
    expect(outcome.outcome).toBe('found')
    const [item] = outcome.findings
    expect(item).toMatchObject({
      probe: 'advisories',
      key: 'advisories:bun',
      title: 'Hygiene: security advisories in Bun dependencies',
      count: 3,
    })
    expect(item?.lines[0]).toBe('minimist >=1.0.0 <1.2.6: GHSA-xvch-5gv4-984h critical (fixed in 1.2.6)')
    expect(readFileSync(join(dirname(bun), 'args.log'), 'utf8')).toBe('audit --json --audit-level=high\n')
  })

  test('red: osv advisories over every lockfile kind, one run, one finding', async () => {
    const osv = fakeTool('osv-scanner', OSV_CARGO, 1)
    const dir = repo({
      'Cargo.lock': '',
      'sub/uv.lock': '',
      'requirements.txt': 'requests==2.19.0\n',
      'requirements-dev.txt': 'flask>=1.0\n',
    })
    const outcome = await advisoriesProbe(tools({ osv }), dir)
    expect(outcome.findings).toHaveLength(1)
    expect(outcome.findings[0]).toMatchObject({
      key: 'advisories:osv',
      title: 'Hygiene: security advisories in the lockfiles',
      count: 1,
    })
    expect(readFileSync(join(dirname(osv), 'args.log'), 'utf8')).toBe(
      'scan source -L Cargo.lock -L requirements.txt -L sub/uv.lock --format json\n',
    )
  })

  test('green: exit 0 with no advisories is clean', async () => {
    const bun = fakeTool('bun', '{}', 0)
    const outcome = await advisoriesProbe(tools({ bun }), bunRepo())
    expect(outcome.outcome).toBe('clean')
  })

  test('green: moderate advisories alone raise nothing', async () => {
    const moderate = JSON.stringify({
      glob: [{ id: 1, url: 'https://example.com/GHSA-x', severity: 'moderate', vulnerable_versions: '<1.0.0' }],
    })
    const outcome = await advisoriesProbe(tools({ bun: fakeTool('bun', moderate, 1) }), bunRepo())
    expect(outcome.outcome).toBe('clean')
  })

  test('skip: no supported lockfile; unpinned requirements are not one', async () => {
    expect((await advisoriesProbe(tools({}), repo({ 'package.json': '{}' }))).outcome).toBe('skipped')
    expect((await advisoriesProbe(tools({}), repo({ 'requirements.txt': 'flask>=1.0\n' }))).outcome).toBe('skipped')
  })

  test('skip: osv-scanner not installed is a skip, never a finding', async () => {
    const outcome = await advisoriesProbe(tools({ osv: join(base, 'no-such-osv') }), repo({ 'Cargo.lock': '' }))
    expect(outcome).toEqual({ outcome: 'skipped', detail: 'osv-scanner is not installed on this host', findings: [] })
  })

  test('unusual: bun audit cannot reach the registry (exit 1, no JSON) is failed, never a finding', async () => {
    const bun = fakeTool('bun', '', 1, 'error: POST https://registry.example.com - ConnectionRefused')
    const outcome = await advisoriesProbe(tools({ bun }), bunRepo())
    expect(outcome.outcome).toBe('failed')
    expect(outcome.detail).toContain('ConnectionRefused')
    expect(outcome.findings).toEqual([])
  })

  test('unusual: a failed part does not hide the other one that ran', async () => {
    const bun = fakeTool('bun', '', 1, 'error: down')
    const osv = fakeTool('osv-scanner', '{"results":[]}', 0)
    const outcome = await advisoriesProbe(
      tools({ bun, osv }),
      repo({ 'package.json': '{}', 'bun.lock': '{}', 'Cargo.lock': '' }),
    )
    expect(outcome.outcome).toBe('clean')
    expect(outcome.detail).toContain('bun: bun audit failed')
  })

  test('unusual: osv-scanner exit 127 (usage or network error) is failed; 128 (no packages) is clean', async () => {
    const dir = repo({ 'Cargo.lock': '' })
    expect((await advisoriesProbe(tools({ osv: fakeTool('osv-scanner', '', 127) }), dir)).outcome).toBe('failed')
    expect((await advisoriesProbe(tools({ osv: fakeTool('osv-scanner', '', 128) }), dir)).outcome).toBe('clean')
  })
})
