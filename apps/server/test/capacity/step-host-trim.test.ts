import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { trimScript } from '../../src/adapters/remote/trim.ts'

/** The retention script (issue 2035) run for real against a temporary home: what it removes, what it leaves. */
const DAY = 86_400
let home: string

const ago = (days: number): number => Date.now() / 1000 - days * DAY
const touch = (path: string, days: number): void => utimesSync(path, ago(days), ago(days))

/** A slot copy: the worktree and its `.run` directory, the latter last written `days` ago. */
function slot(project: string, n: number, days: number): void {
  const dir = join(home, 'factory-steps', project, String(n))
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'package.json'), '{}')
  mkdirSync(`${dir}.run`, { recursive: true })
  touch(`${dir}.run`, days)
}

/** A scratch directory of the home with one file last written `days` ago. */
function exp(name: string, days: number): string {
  const dir = join(home, name)
  mkdirSync(join(dir, 'repo'), { recursive: true })
  const file = join(dir, 'repo', 'bench.log')
  writeFileSync(file, 'x')
  utimesSync(file, ago(days), ago(days))
  touch(join(dir, 'repo'), days)
  touch(dir, days)
  return dir
}

/** A bun cache entry (`<name>@<version>@@@1`, under `@scope/` for a scoped name) whose files were read `days` ago. */
function entry(name: string, days: number, kib = 1): string {
  const dir = join(home, 'factory-steps', '.cache', 'bun', name)
  mkdirSync(join(dir, 'dist'), { recursive: true })
  for (const file of ['package.json', 'dist/index.js']) {
    const path = join(dir, file)
    writeFileSync(path, 'x'.repeat(kib * 1024))
    utimesSync(path, ago(days), ago(days))
  }
  return dir
}

function run(docker: string, script = trimScript({ stepLabel: 'factory.step' })): { code: number; out: string } {
  const bin = join(home, 'bin')
  mkdirSync(bin, { recursive: true })
  writeFileSync(join(bin, 'docker'), `#!/bin/sh\n${docker}\n`, { mode: 0o755 })
  const proc = Bun.spawnSync(['sh', '-c', script], {
    env: { HOME: home, PATH: `${bin}:${process.env.PATH ?? '/usr/bin:/bin'}` },
  })
  return { code: proc.exitCode, out: proc.stdout.toString() + proc.stderr.toString() }
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'step-host-'))
})
afterEach(() => rmSync(home, { recursive: true, force: true }))

describe('the step host trim', () => {
  test('removes the copies of a slot idle past the age and keeps the rest', () => {
    slot('basalt-ui', 1, 1)
    slot('basalt-ui', 2, 9)
    slot('old-project', 1, 30)
    const result = run('exit 0')
    expect(result.code).toBe(0)
    expect(existsSync(join(home, 'factory-steps/basalt-ui/1/package.json'))).toBe(true)
    expect(existsSync(join(home, 'factory-steps/basalt-ui/1.run'))).toBe(true)
    expect(existsSync(join(home, 'factory-steps/basalt-ui/2'))).toBe(false)
    expect(existsSync(join(home, 'factory-steps/basalt-ui/2.run'))).toBe(false)
    expect(existsSync(join(home, 'factory-steps/old-project'))).toBe(false)
    expect(result.out).toContain('removed 2 idle slot copies')
  })

  test('removes a cache entry no install read for the age, whole, and keeps a read one', () => {
    const fresh = entry('internmap@1.0.1@@@1', 2)
    const stale = entry('left-pad@1.3.0@@@1', 20)
    entry('@types/node@22.0.0@@@1', 20)
    const scopedFresh = join(home, 'factory-steps/.cache/bun/@scope/pkg@1.0.0@@@1')
    mkdirSync(scopedFresh, { recursive: true })
    writeFileSync(join(scopedFresh, 'index.js'), 'x')
    const result = run('exit 0')
    expect(existsSync(join(fresh, 'dist/index.js'))).toBe(true)
    expect(existsSync(stale)).toBe(false)
    expect(existsSync(join(home, 'factory-steps/.cache/bun/@types'))).toBe(false)
    expect(existsSync(join(scopedFresh, 'index.js'))).toBe(true)
    expect(result.out).toContain('2 bun cache entries')
  })

  test('over the ceiling the age tightens until the cache fits', () => {
    const recent = entry('recent@1.0.0@@@1', 1, 400)
    const week = entry('week@1.0.0@@@1', 5, 400)
    const month = entry('month@1.0.0@@@1', 12, 400)
    // the ceiling is smaller than the three entries together (about 2.4 MiB with their directories) and holds one of them
    run('exit 0', trimScript({ stepLabel: 'factory.step', cacheCapGib: 0.0015 }))
    expect(existsSync(recent)).toBe(true)
    expect(existsSync(week)).toBe(false)
    expect(existsSync(month)).toBe(false)
  })

  test('removes nothing while a step container runs or when docker does not answer', () => {
    slot('basalt-ui', 1, 30)
    const stale = entry('left-pad@1.3.0@@@1', 20)
    expect(run('echo abc123').out).toContain('a step is running')
    expect(run('exit 1').out).toContain('docker did not answer')
    expect(existsSync(join(home, 'factory-steps/basalt-ui/1'))).toBe(true)
    expect(existsSync(stale)).toBe(true)
  })

  test('removes an exp<issue> directory idle past the age, keeps a busy one and anything not named so', () => {
    const idle = exp('exp2251', 5)
    const busy = exp('exp2614', 5)
    // one file written an hour ago keeps the whole directory, however old the rest is
    writeFileSync(join(busy, 'repo', 'fresh.log'), 'x')
    const other = exp('expert', 30)
    const named = exp('exp12-notes', 30)
    const link = join(home, 'exp9')
    const target = exp('target', 30)
    symlinkSync(target, link)
    const result = run('exit 0')
    expect(existsSync(idle)).toBe(false)
    expect(existsSync(busy)).toBe(true)
    expect(existsSync(other)).toBe(true)
    expect(existsSync(named)).toBe(true)
    expect(existsSync(target)).toBe(true)
    expect(result.out).toContain('trim: removed 1 idle exp dirs')
  })

  test('the exp part runs without a step directory, while a step runs and when docker does not answer', () => {
    rmSync(join(home, 'factory-steps'), { recursive: true, force: true })
    const none = exp('exp1', 9)
    expect(existsSync(none)).toBe(true)
    run('exit 0')
    expect(existsSync(none)).toBe(false)

    mkdirSync(join(home, 'factory-steps'), { recursive: true })
    const running = exp('exp2', 9)
    expect(run('echo abc123').out).toContain('a step is running')
    expect(existsSync(running)).toBe(false)

    const silent = exp('exp3', 9)
    expect(run('exit 1').out).toContain('docker did not answer')
    expect(existsSync(silent)).toBe(false)
  })

  test('what rm cannot remove (root-owned files from a container) is removed by a container', () => {
    const dir = exp('exp7', 9)
    const locked = join(dir, 'repo', 'target')
    mkdirSync(locked, { recursive: true })
    writeFileSync(join(locked, 'lib.rlib'), 'x')
    for (const path of [join(locked, 'lib.rlib'), locked, join(dir, 'repo'), dir]) touch(path, 9)
    chmodSync(locked, 0o555)
    // the stub is the container: it unlocks the directory and removes what is in the mounted one
    const docker = [
      'case "$1" in',
      '  images) echo img1 ;;',
      `  run) chmod -R u+w "${home}/exp7" && rm -rf "${home}/exp7"/* ;;`,
      'esac',
    ].join('\n')
    const result = run(docker)
    expect(existsSync(dir)).toBe(false)
    expect(result.out).toContain('trim: removed 1 idle exp dirs')
  })

  test('a host with no step directory is left alone', () => {
    rmSync(join(home, 'factory-steps'), { recursive: true, force: true })
    expect(run('exit 0').code).toBe(0)
  })
})
