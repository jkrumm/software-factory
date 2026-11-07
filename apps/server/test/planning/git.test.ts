import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { gitProjectSource } from '../../src/adapters/planning/git-projects.ts'
import { MAX_PROJECT_BYTES } from '../../src/domains/planning/project.ts'
import { value } from './support.ts'

let root: string
let realRoot: string

const git = async (cwd: string, ...args: string[]) => {
  const proc = Bun.spawn(['git', '-C', cwd, '-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], {
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' },
  })
  const [out, err, code] = await Promise.all([proc.stdout.text(), proc.stderr.text(), proc.exited])
  if (code !== 0) throw new Error(`git ${args.join(' ')}: ${err}`)
  return out
}

/** A repo with its files committed on `main`. */
async function repo(name: string, files: Record<string, string>, branch = 'main'): Promise<string> {
  const path = join(root, name)
  await mkdir(path, { recursive: true })
  await git(path, 'init', '-q', '-b', branch)
  for (const [file, text] of Object.entries(files)) {
    await mkdir(join(path, file, '..'), { recursive: true })
    await writeFile(join(path, file), text)
  }
  await git(path, 'add', '-A')
  await git(path, 'commit', '-q', '-m', 'init')
  return path
}

beforeAll(async () => {
  root = await mkdtemp('/tmp/factory-roots-')
  realRoot = await realpath(root)
})
afterAll(async () => {
  await rm(root, { recursive: true, force: true })
})

const source = () => gitProjectSource({ roots: [root], timeoutMs: 20_000 })

describe('the git source', () => {
  test('reads project.yaml and docs/plan.yaml from the default branch, not from the working tree', async () => {
    const path = await repo('app', {
      'project.yaml': 'apiVersion: factory/v2\nname: app\nleads: 2\n',
      'docs/plan.yaml': 'version: 1\nrows:\n  - { key: a, title: A, facts: { why: y } }\n',
    })
    await writeFile(join(path, 'project.yaml'), 'apiVersion: factory/v2\nname: app\nleads: 5\n')
    await git(path, 'checkout', '-q', '-b', 'feature')
    const read = value(await source().read({ directory: 'app', path }, { fetch: false }))
    expect(read.branch).toBe('main')
    expect(read.project).toMatchObject({ state: 'text', value: { name: 'app', leads: 2 } })
    expect(read.plan).toMatchObject({ state: 'text', value: { version: 1 } })
  })

  test('no files is absent; a file that is not YAML, is a symlink or is too large is unreadable with the reason', async () => {
    const empty = await repo('empty', { 'README.md': 'hi' })
    expect(value(await source().read({ directory: 'empty', path: empty }, { fetch: false }))).toMatchObject({
      project: { state: 'absent' },
      plan: { state: 'absent' },
    })
    const bad = await repo('bad', {
      'project.yaml': 'a: 1\na: 2\n',
      'docs/plan.yaml': 'x'.repeat(10),
    })
    const read = value(await source().read({ directory: 'bad', path: bad }, { fetch: false }))
    expect(read.project).toMatchObject({ state: 'unreadable', message: expect.stringContaining('DUPLICATE_KEY') })
    const big = await repo('big', { 'project.yaml': `# ${'x'.repeat(MAX_PROJECT_BYTES)}\n` })
    expect(value(await source().read({ directory: 'big', path: big }, { fetch: false })).project).toMatchObject({
      state: 'unreadable',
      message: expect.stringContaining('larger than'),
    })
    const linked = await repo('linked', { 'real.yaml': 'apiVersion: factory/v2\nname: linked\n' })
    await symlink('real.yaml', join(linked, 'project.yaml'))
    await git(linked, 'add', '-A')
    await git(linked, 'commit', '-q', '-m', 'link')
    expect(value(await source().read({ directory: 'linked', path: linked }, { fetch: false })).project).toMatchObject({
      state: 'unreadable',
      message: 'project.yaml is not a regular file',
    })
  })

  test('the default branch is master when there is no main; a repo with neither cannot be read', async () => {
    const old = await repo('old', { 'project.yaml': 'apiVersion: factory/v2\nname: old\n' }, 'master')
    expect(value(await source().read({ directory: 'old', path: old }, { fetch: false })).branch).toBe('master')
    const odd = await repo('odd', { x: '1' }, 'trunk')
    expect(await source().read({ directory: 'odd', path: odd }, { fetch: false })).toMatchObject({
      ok: false,
      error: { kind: 'gone', detail: expect.stringContaining('no default branch') },
    })
  })

  test('discover finds the repos under the roots that carry a project.yaml; resolve maps a name, a path or a worktree to its repo', async () => {
    const found = value(await source().discover())
    expect(found.map((r) => r.directory).sort()).toEqual(['app', 'bad', 'big', 'linked', 'old'])
    expect(found.find((r) => r.directory === 'app')?.path).toBe(join(realRoot, 'app'))
    expect(value(await source().resolve('app'))).toEqual({ directory: 'app', path: join(realRoot, 'app') })
    expect(value(await source().resolve(join(root, 'app', '.claude', 'worktrees', 'x')))).toBeNull()
    await mkdir(join(root, 'app', '.claude', 'worktrees', 'x'), { recursive: true })
    expect(value(await source().resolve(join(root, 'app', '.claude', 'worktrees', 'x')))).toEqual({
      directory: 'app',
      path: join(realRoot, 'app'),
    })
    expect(value(await source().resolve('nothing'))).toBeNull()
    expect(value(await source().resolve('/etc'))).toBeNull()
  })
})
