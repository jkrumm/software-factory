import { describe, expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { RemoteGrant } from '@software-factory/contract'
import {
  bunOfPackage,
  disagreementOf,
  imageOf,
  isHostFailure,
  isHostPath,
  isStepId,
  parseStats,
  remoteScript,
  shq,
  snapshot,
} from '../src/remote-step.ts'

const grant = (over: Partial<RemoteGrant> = {}): RemoteGrant => ({
  target: 'step-host',
  repo: 'factory-steps/p.git',
  dir: 'factory-steps/p/1',
  bun: '1.4.3',
  dockerfile: null,
  carry: [],
  memoryMib: 3072,
  cores: 10,
  network: false,
  ...over,
})

const script = (over: Partial<RemoteGrant> = {}) =>
  remoteScript({
    id: '123-abc',
    grant: grant(over),
    sha: 'a'.repeat(40),
    image: 'factory-step:bun-1.4.3',
    root: '/src/p/.claude/worktrees/factory-1-1',
    cwd: '/src/p/.claude/worktrees/factory-1-1/apps/x',
    command: ['bun', 'test', "it's"],
    env: { TERM: 'xterm-256color', FACTORY_TOKEN: 'secret' },
  })

describe('the step on the step host', () => {
  test('runs capped, at the lowest priority, in the steps slice, with no network and no capabilities', () => {
    const line = script()
    for (const flag of [
      '--cgroup-parent factory-steps.slice',
      '--cpu-shares 2 --oom-score-adj 1000',
      '--memory 3072m --memory-swap 3072m',
      '--cap-drop ALL --security-opt no-new-privileges',
      '--network none',
      '-e FACTORY_STEP_CORES=10 -e FACTORY_STEP_MEM_MIB=3072',
    ])
      expect(line).toContain(flag)
    // the install has the network, the step does not
    const [install = '', step = ''] = line.split('\n').filter((l) => l.startsWith('docker run'))
    expect(install).not.toContain('--network none')
    expect(step).toContain('--network none')
  })

  test('a step that needs the network keeps it', () => {
    expect(script({ network: true })).not.toContain('--network none')
  })

  test('is mounted at the caller own path and passes printing settings, never a token', () => {
    const line = script()
    expect(line).toContain(`:'/src/p/.claude/worktrees/factory-1-1'`)
    expect(line).toContain(`-e 'TERM=xterm-256color'`)
    expect(line).not.toContain('secret')
    expect(line).toContain(`'it'\\''s'`)
  })

  test('the host failures are ssh, docker and the setup, never a test exit', () => {
    expect([255, 125, 126, 127].every(isHostFailure)).toBe(true)
    expect([0, 1, 2, 124, 137].some(isHostFailure)).toBe(false)
  })

  test('only the CLI own ids and the server own paths reach a shell line', () => {
    expect(isStepId(`${process.pid}-${crypto.randomUUID()}`)).toBe(true)
    expect(isStepId('a;rm -rf ~')).toBe(false)
    expect(isHostPath('factory-steps/basalt-ui~1a2b/2')).toBe(true)
    expect(isHostPath('factory-steps/../.ssh')).toBe(false)
    expect(isHostPath("factory-steps/p'x")).toBe(false)
  })
})

describe('the image', () => {
  test("the factory's by bun version, a repo's by its content", () => {
    expect(imageOf({ bun: '1.4.3', dockerfile: null }).tag).toBe('factory-step:bun-1.4.3')
    const own = imageOf({ bun: '1.4.3', dockerfile: 'FROM ubuntu:24.04\n' })
    expect(own.tag).toMatch(/^factory-step:repo-[0-9a-f]{16}$/)
    expect(imageOf({ bun: '1.4.3', dockerfile: 'FROM ubuntu:24.04\nRUN true\n' }).tag).not.toBe(own.tag)
  })

  test("the bun of the repo's packageManager", () => {
    expect(bunOfPackage('{"packageManager":"bun@1.4.3"}')).toBe('1.4.3')
    expect(bunOfPackage('{"packageManager":"pnpm@9.0.0"}')).toBeNull()
    expect(bunOfPackage('not json')).toBeNull()
  })

  test('the stats the container left', () => {
    expect(parseStats('2147483648', '990652248')).toEqual({ peakRssMib: 2048, cpuSeconds: 990.652 })
    expect(parseStats('', '')).toEqual({ peakRssMib: null, cpuSeconds: null })
  })

  test('shq quotes one word', () => {
    expect(shq("a'b")).toBe(`'a'\\''b'`)
  })
})

describe('the snapshot', () => {
  const git = (cwd: string, ...args: string[]) => {
    const result = Bun.spawnSync(['git', '-C', cwd, ...args], {
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 't',
        GIT_AUTHOR_EMAIL: 't@example.com',
        GIT_COMMITTER_NAME: 't',
        GIT_COMMITTER_EMAIL: 't@example.com',
      },
    })
    return result.stdout.toString().trim()
  }

  test('carries every change and untracked file and the carried build output, and leaves the index alone', async () => {
    const root = mkdtempSync(join(tmpdir(), 'snapshot-'))
    try {
      git(root, 'init', '-q')
      writeFileSync(join(root, '.gitignore'), 'dist/\nlog.txt\n')
      writeFileSync(join(root, 'a.txt'), 'one\n')
      git(root, 'add', '.')
      git(root, 'commit', '-q', '-m', 'base')
      writeFileSync(join(root, 'a.txt'), 'two\n')
      writeFileSync(join(root, 'new.txt'), 'new\n')
      writeFileSync(join(root, 'log.txt'), 'ignored\n')
      mkdirSync(join(root, 'pkg', 'dist'), { recursive: true })
      writeFileSync(join(root, 'pkg', 'dist', 'out.js'), 'built\n')
      const env = {
        ...process.env,
        GIT_AUTHOR_NAME: 't',
        GIT_AUTHOR_EMAIL: 't@example.com',
        GIT_COMMITTER_NAME: 't',
        GIT_COMMITTER_EMAIL: 't@example.com',
      }
      const snap = await snapshot({ root, carry: ['pkg/dist', 'missing/dist'], env })
      if ('failed' in snap) throw new Error(snap.failed)
      const files = git(root, 'ls-tree', '-r', '--name-only', snap.sha).split('\n')
      expect(files).toEqual(['.gitignore', 'a.txt', 'new.txt', 'pkg/dist/out.js'])
      expect(git(root, 'show', `${snap.sha}:a.txt`)).toBe('two')
      expect(git(root, 'rev-parse', `${snap.sha}^{tree}`)).toBe(snap.tree)
      // the worktree's own index and HEAD are untouched
      // (the helper trims the leading space of ` M`)
      expect(git(root, 'status', '--porcelain')).toBe('M a.txt\n?? new.txt')
      expect(git(root, 'rev-parse', `${snap.sha}^`)).toBe(git(root, 'rev-parse', 'HEAD'))
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('what a red run off the mini failed on', () => {
  const test_ = (suite: string, name: string, status: 'pass' | 'fail' | 'skip', durationMs = 10) => ({
    suite,
    name,
    status,
    durationMs,
  })

  test('the failing test names with their remote duration, and the timeout the output names', () => {
    const found = disagreementOf({
      tests: [
        test_('a.test.ts', 'fine', 'pass'),
        test_('a.test.ts', 'slow one', 'fail', 5210),
        test_('', 'bare', 'fail', 3),
      ],
      output: ['(fail) slow one [5210.00ms]', 'error: this test "slow one" timed out after 5000ms', 'Ran 3 tests'],
    })
    expect(found).toEqual({
      tests: [
        { name: 'a.test.ts > slow one', durationMs: 5210, timeoutMs: 5000 },
        { name: 'bare', durationMs: 3, timeoutMs: null },
      ],
      tail: null,
    })
  })

  test('with no failing test parsed, the last 40 lines of the output', () => {
    const output = Array.from({ length: 100 }, (_, i) => `line ${i}`)
    const found = disagreementOf({ tests: [test_('s', 't', 'pass')], output })
    expect(found.tests).toEqual([])
    expect(found.tail?.split('\n')).toEqual(output.slice(-40))
  })
})
