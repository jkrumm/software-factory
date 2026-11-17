import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { defaultTools } from '../../src/adapters/hygiene/git.ts'

const ID = {
  GIT_AUTHOR_NAME: 'T',
  GIT_AUTHOR_EMAIL: 't@example.com',
  GIT_COMMITTER_NAME: 'T',
  GIT_COMMITTER_EMAIL: 't@example.com',
}
const tools = defaultTools()
let base: string
let counter = 0

function git(cwd: string, args: string[], env: Record<string, string> = {}): string {
  const result = Bun.spawnSync(['git', ...args], { cwd, env: { ...process.env, ...ID, ...env } })
  if (result.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr.toString()}`)
  return result.stdout.toString()
}

/** A committed repo with `files`; the probe reads the tracked files of this directory. */
function repo(files: Record<string, string>): string {
  const dir = join(base, `repo-${++counter}`)
  mkdirSync(dir, { recursive: true })
  git(dir, ['init', '-q', '-b', 'master'])
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, file)), { recursive: true })
    writeFileSync(join(dir, file), text)
  }
  git(dir, ['add', '-A'])
  git(dir, ['commit', '-q', '-m', 'init'])
  return dir
}

beforeAll(() => {
  base = mkdtempSync(join(tmpdir(), 'factory-hygiene-probe-'))
})
afterAll(() => rmSync(base, { recursive: true, force: true }))

import {
  commandClaims,
  makeTargets,
  pathClaim,
  readmeClaims,
  readmeProbe,
  siblingNames,
} from '../../src/adapters/hygiene/probes/readme.ts'

describe('claims', () => {
  test('commands: make, scripts, files; builtins and flags are not claims', () => {
    expect(commandClaims('make check && bun run lint', 1).map((c) => `${c.kind}:${c.value}`)).toEqual([
      'make:check',
      'script:lint',
    ])
    expect(commandClaims('FOO=1 bun scripts/x.ts --flag', 1).map((c) => `${c.kind}:${c.value}`)).toEqual([
      'file:scripts/x.ts',
    ])
    expect(commandClaims('bun install', 1)).toEqual([])
    expect(commandClaims('make -C sub build', 1)).toEqual([])
    expect(commandClaims('bun run --filter x build', 1)).toEqual([])
  })

  test('paths: only clear repo paths', () => {
    expect(pathClaim('apps/x/src/y.ts')).toBe('apps/x/src/y.ts')
    expect(pathClaim('docs/')).toBe('docs/')
    for (const no of [
      'src/*.ts',
      'apps/<name>/x.ts',
      '$HOME/x.ts',
      '~/x.ts',
      '/etc/x.conf',
      'https://example.com/a.md',
      'text/plain',
      'a/b',
      'example.com/x.js',
    ]) {
      expect(pathClaim(no)).toBeUndefined()
    }
  })

  test('code blocks: shell fences count, output fences and prose paragraphs about other repos do not', () => {
    const text = [
      '```sh',
      'make one',
      '```',
      '```text output',
      'make two',
      '```',
      'Other repo `make three`.',
      '',
      'Run `make four`.',
    ].join('\n')
    expect(readmeClaims(text).map((c) => c.value)).toEqual(['one', 'four'])
  })
})

describe('makeTargets', () => {
  test('multi-target lines count; .PHONY, assignments, recipes and patterns do not', () => {
    const { targets } = makeTargets('.PHONY: ghost\nVAR := a:b\nbuild test: dep\n\techo lint: x\n%.o: %.c\ncheck:\n')
    expect([...targets].sort()).toEqual(['build', 'check', 'test'])
  })
})

describe('readmeProbe', () => {
  const files = {
    Makefile: 'check:\n\ttrue\n',
    'package.json': '{"scripts":{"lint":"x"}}',
    'docs/a.md': 'a',
    'scripts/run.ts': '',
    '.gitignore': 'dist/\n',
  }

  test('red: missing target, script and path are one finding for the README', async () => {
    const dir = repo({
      ...files,
      'README.md': 'Use `make check`, `make ship`, `bun run lint`, `bun run nope`, `docs/a.md`, `docs/gone.md`.\n',
    })
    const out = await readmeProbe(tools, dir)
    expect(out.outcome).toBe('found')
    expect(out.findings.map((f) => [f.key, f.title])).toEqual([
      ['readme:README.md', 'Hygiene: README names things that do not exist in README.md'],
    ])
    expect(out.findings[0]?.lines).toEqual([
      '1: make ship (no such target)',
      '1: script nope (not in package.json)',
      '1: docs/gone.md (not in the repo)',
    ])
  })

  test('green: everything exists, ignored and unanchored paths are left alone', async () => {
    const dir = repo({
      ...files,
      'README.md': '`make check` `bun scripts/run.ts` `docs/a.md` `dist/out.js` `lib/unknown.ts`\n',
    })
    expect((await readmeProbe(tools, dir)).outcome).toBe('clean')
  })

  test('skipped: no README.md', async () => {
    expect((await readmeProbe(tools, repo({ 'a.txt': 'x' }))).outcome).toBe('skipped')
  })

  test('a nested README resolves beside itself, then the root', async () => {
    const dir = repo({
      ...files,
      'apps/x/README.md': '`make check` `make deep` `bun run build`\n',
      'apps/x/Makefile': 'deep:\n',
      'apps/x/package.json': '{"scripts":{"build":"x"}}',
    })
    expect((await readmeProbe(tools, dir)).outcome).toBe('clean')
  })

  test('a paragraph naming a directory beside the repo is about another repo', async () => {
    const parent = join(base, `pair-${++counter}`)
    const mk = (name: string, readme: string) => {
      const dir = join(parent, name)
      mkdirSync(dir, { recursive: true })
      git(dir, ['init', '-q', '-b', 'master'])
      writeFileSync(join(dir, 'README.md'), readme)
      writeFileSync(join(dir, 'Makefile'), 'check:\n')
      git(dir, ['add', '-A'])
      git(dir, ['commit', '-q', '-m', 'init'])
      return dir
    }
    const own = mk('repo-a', 'The sibling-tools repo runs `make gone` for this.\n\nSeparate: `make missing`.\n')
    mk('sibling-tools', 'x')
    expect(await siblingNames(tools, own)).toEqual(['sibling-tools'])
    const out = await readmeProbe(tools, own)
    expect(out.findings[0]?.lines).toEqual(['3: make missing (no such target)'])
  })
})
