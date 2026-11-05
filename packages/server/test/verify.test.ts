import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const SCRIPT = join(import.meta.dir, '../../../scripts/verify.sh')

let home: string
let root: string
let origin: string
let clone: string

const git = (cwd: string, ...args: string[]) => {
  const run = Bun.spawnSync(['git', '-C', cwd, ...args], { stdout: 'pipe', stderr: 'pipe' })
  if (run.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${run.stderr.toString()}`)
  return run.stdout.toString().trim()
}

/** A commit on master in the working clone, pushed to origin: the files are path -> content. */
function commit(files: Record<string, string>): string {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(clone, path, '..'), { recursive: true })
    writeFileSync(join(clone, path), content)
  }
  git(clone, 'add', '-A')
  git(clone, '-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-q', '-m', 'c')
  git(clone, 'push', '-q', 'origin', 'master')
  return git(clone, 'rev-parse', 'HEAD')
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'verify-'))
  root = join(home, '.software-factory')
  origin = join(home, 'origin.git')
  clone = join(root, 'repo')
  mkdirSync(join(root, 'data'), { recursive: true })
  mkdirSync(join(home, '.local/bin'), { recursive: true })
  git(home, 'init', '-q', '--bare', '-b', 'master', origin)
  git(home, 'clone', '-q', origin, clone)
  // First on verify.sh's PATH: curl answers /health with the deployed version, and 401 for the two unauthenticated probes.
  const stub = (name: string, body: string) => {
    const path = join(home, '.local/bin', name)
    writeFileSync(path, `#!/bin/bash\n${body}\n`)
    chmodSync(path, 0o755)
  }
  stub(
    'curl',
    'if [[ "$*" == *"-w"* ]]; then printf 401; else echo "{\\"status\\":\\"ok\\",\\"version\\":\\"$(cat "$FACTORY_ROOT/data/deployed-sha")\\"}"; fi',
  )
  stub('factory', 'exit 0')
  stub('secrets-run', 'exit 0')
})
afterEach(() => rmSync(home, { recursive: true, force: true }))

function deployed(sha: string): void {
  writeFileSync(join(root, 'data/deployed-sha'), `${sha}\n`)
}

function verify() {
  const run = Bun.spawnSync(['/bin/bash', SCRIPT], {
    env: { ...process.env, HOME: home, FACTORY_ROOT: root },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  return { code: run.exitCode, out: run.stdout.toString(), err: run.stderr.toString() }
}

describe('make verify: deployed sha against origin/master', () => {
  test('equal passes', () => {
    deployed(commit({ 'src/a.ts': 'a' }))
    const { code, out } = verify()
    expect(code).toBe(0)
    expect(out).toContain('deployed sha is origin/master')
  })

  test('behind by docs, markdown and tests only passes, and says so', () => {
    deployed(commit({ 'src/a.ts': 'a' }))
    commit({ 'docs/x.md': 'x', 'README.md': 'r', 'packages/server/test/a.test.ts': 't' })
    commit({ 'docs/deep/y.txt': 'y' })
    const { code, out } = verify()
    expect(code).toBe(0)
    expect(out).toContain('only by changes that need no deploy')
    expect(out).toContain('all checks passed')
  })

  test('behind by a deployable path fails and names it', () => {
    deployed(commit({ 'src/a.ts': 'a' }))
    commit({ 'docs/x.md': 'x' })
    commit({ 'src/a.ts': 'b' })
    const { code, err } = verify()
    expect(code).toBe(1)
    expect(err).toContain('src/a.ts changed and needs a deploy')
  })

  test('a script or a migration is deployable', () => {
    deployed(commit({ 'src/a.ts': 'a' }))
    commit({ 'scripts/x.sh': 'x' })
    expect(verify().code).toBe(1)
  })

  test('a deployed sha that is not an ancestor of origin fails', () => {
    commit({ 'src/a.ts': 'a' })
    deployed('c'.repeat(40))
    commit({ 'docs/x.md': 'x' })
    const { code, err } = verify()
    expect(code).toBe(1)
    expect(err).toContain('is not an ancestor of origin/master')
  })
})
