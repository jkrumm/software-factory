import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { RepoRefused, resolveRepo } from '../src/repos.ts'
import { FakeClock } from './support/clock.ts'
import { startApp, type TestApp } from './support/app.ts'
import { startTestDb, type TestDb } from './support/pg.ts'

let base: string
let root: string
let outside: string
let db: TestDb
let app: TestApp

beforeAll(async () => {
  base = await realpath(await mkdtemp('/tmp/factory-repos-'))
  root = join(base, 'root')
  outside = join(base, 'outside')
  await mkdir(join(root, 'proj'), { recursive: true })
  await mkdir(join(root, 'group', 'deep'), { recursive: true })
  await mkdir(join(base, 'root-evil', 'proj'), { recursive: true })
  await mkdir(join(outside, 'secret'), { recursive: true })
  await writeFile(join(root, 'a-file'), '')
  await symlink(join(outside, 'secret'), join(root, 'link-out'))
  await symlink(join(root, 'proj'), join(root, 'link-in'))
  await symlink(root, join(base, 'root-link'))
  db = await startTestDb()
  app = startApp({ sql: db.sql, clock: new FakeClock(), repoRoots: [root] })
})
afterAll(async () => {
  await app.stop()
  await db.stop()
  await rm(base, { recursive: true, force: true })
})
beforeEach(() => db.reset())

const refused = async (repo: string, roots: string[] = [root]): Promise<string> => {
  const error = await resolveRepo(repo, roots).catch((e: unknown) => e)
  expect(error).toBeInstanceOf(RepoRefused)
  return (error as RepoRefused).message
}

describe('resolveRepo', () => {
  test('a directory inside a root is allowed and comes back as its real path', async () => {
    expect(await resolveRepo(join(root, 'proj'), [root])).toBe(join(root, 'proj'))
    expect(await resolveRepo(join(root, 'group', 'deep'), [root])).toBe(join(root, 'group', 'deep'))
  })

  test('any of several roots will do', async () => {
    expect(await resolveRepo(join(outside, 'secret'), [root, outside])).toBe(join(outside, 'secret'))
  })

  test('.. cannot leave the root', async () => {
    expect(await refused(join(root, 'proj', '..', '..', 'outside', 'secret'))).toContain('outside the allowed roots')
    expect(await refused(join(root, '..'))).toContain('outside the allowed roots')
  })

  test('.. that stays inside is fine and resolved', async () => {
    expect(await resolveRepo(join(root, 'group', '..', 'proj'), [root])).toBe(join(root, 'proj'))
  })

  test('a symlink inside the root that points out is refused, with the real path in the message', async () => {
    const message = await refused(join(root, 'link-out'))
    expect(message).toContain(join(outside, 'secret'))
    expect(message).toContain('FACTORY_REPO_ROOTS')
  })

  test('a symlink that stays inside is stored as its target', async () => {
    expect(await resolveRepo(join(root, 'link-in'), [root])).toBe(join(root, 'proj'))
  })

  test('a root that is itself a symlink works', async () => {
    expect(await resolveRepo(join(base, 'root-link', 'proj'), [join(base, 'root-link')])).toBe(join(root, 'proj'))
    expect(await resolveRepo(join(root, 'proj'), [join(base, 'root-link')])).toBe(join(root, 'proj'))
  })

  test('a sibling that merely starts with the root name is outside', async () => {
    await refused(join(base, 'root-evil', 'proj'))
  })

  test('the root itself is not a repo', async () => {
    await refused(root)
    await refused(join(base, 'root-link'))
  })

  test('a path that does not exist, or is a file, is refused', async () => {
    expect(await refused(join(root, 'nope'))).toContain('does not exist')
    expect(await refused(join(root, 'a-file'))).toContain('does not exist or is not a directory')
  })

  test('a root that does not exist allows nothing', async () => {
    await refused(join(root, 'proj'), [join(base, 'missing')])
  })

  test('no roots allow nothing', async () => {
    await refused(join(root, 'proj'), [])
  })
})

describe('POST /spawns and the roots', () => {
  const post = (repo: string, key = 'k1') => app.send('POST', '/spawns', { key, repo, prompt: 'do it' })
  const count = async () => (await db.sql`SELECT count(*)::int AS n FROM factory.spawns`)[0].n as number

  test('a repo inside a root is stored under its real path', async () => {
    const res = await post(join(root, 'link-in'))
    expect(res.status).toBe(201)
    const [row] = await db.sql`SELECT repo FROM factory.spawns WHERE key = 'k1'`
    expect(row.repo).toBe(join(root, 'proj'))
  })

  test.each([
    ['..', () => join(root, 'proj', '..', '..', 'outside', 'secret')],
    ['a symlink', () => join(root, 'link-out')],
    ['a sibling prefix', () => join(base, 'root-evil', 'proj')],
    ['/etc', () => '/etc'],
  ])('%s out of the roots is 422 with a clear error, and nothing is stored', async (_name, repo) => {
    const res = await post(repo())
    expect(res.status).toBe(422)
    const body = (await res.json()) as { error: string }
    expect(body.error).toContain('is outside the allowed roots (FACTORY_REPO_ROOTS)')
    expect(body.error).toContain(root)
    expect(await count()).toBe(0)
  })

  test('a missing directory is 422 too', async () => {
    const res = await post(join(root, 'nope'))
    expect(res.status).toBe(422)
    expect(((await res.json()) as { error: string }).error).toContain('does not exist')
    expect(await count()).toBe(0)
  })

  test('a malformed repo is still 400, before the policy', async () => {
    expect((await post('relative/path')).status).toBe(400)
  })
})
