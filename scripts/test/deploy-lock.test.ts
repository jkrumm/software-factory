import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, readlink, rm, symlink, writeFile } from 'node:fs/promises'
import { existsSync, lstatSync } from 'node:fs'
import { join } from 'node:path'

const DEPLOY = join(import.meta.dir, '..', 'deploy.sh')

let root = ''
let lock = ''
const sleepers: ReturnType<typeof Bun.spawn>[] = []

beforeEach(async () => {
  root = await mkdtemp('/tmp/factory-deploy-lock-')
  await mkdir(join(root, 'data'), { recursive: true })
  lock = join(root, 'data', 'deploy.lock')
})

afterEach(async () => {
  for (const proc of sleepers.splice(0)) proc.kill()
  await rm(root, { recursive: true, force: true })
})

/** Sources deploy.sh (which runs nothing then) and calls `take_lock`; prints the lock's target and this shell's pid. */
async function takeLock(): Promise<{ code: number; out: string; err: string }> {
  const proc = Bun.spawn(['bash', '-c', `source "${DEPLOY}"; take_lock; echo "$(readlink "$LOCK") $$"`], {
    env: { ...process.env, FACTORY_ROOT: root, HOME: root },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  return { code, out: out.trim(), err }
}

/** True when the path exists, a dangling symlink included. */
function present(path: string): boolean {
  try {
    lstatSync(path)
    return true
  } catch {
    return false
  }
}

/** A pid that is alive until the test ends. */
function livePid(): number {
  const proc = Bun.spawn(['sleep', '60'])
  sleepers.push(proc)
  return proc.pid
}

/** A pid that is certainly dead. */
async function deadPid(): Promise<number> {
  const proc = Bun.spawn(['true'])
  await proc.exited
  return proc.pid
}

describe('deploy.sh take_lock', () => {
  test('a free lock is taken as a symlink to the holder pid and released on exit', async () => {
    const { code, out } = await takeLock()
    expect(code).toBe(0)
    const [target, pid] = out.split(' ')
    expect(target).toBe(pid)
    expect(present(lock)).toBe(false)
  })

  test('a live holder is refused and the lock is left alone', async () => {
    const holder = livePid()
    await symlink(String(holder), lock)
    const { code, err } = await takeLock()
    expect(code).toBe(1)
    expect(err).toContain(`another deploy is running (pid ${holder})`)
    expect(await readlink(lock)).toBe(String(holder))
  })

  test('a dead holder is reclaimed', async () => {
    await symlink(String(await deadPid()), lock)
    const { code, out } = await takeLock()
    expect(code).toBe(0)
    const [target, pid] = out.split(' ')
    expect(target).toBe(pid)
    expect(existsSync(`${lock}.reclaim`)).toBe(false)
  })

  test('a legacy directory lock with a dead pid is reclaimed, a live one refused', async () => {
    await mkdir(lock)
    await writeFile(join(lock, 'pid'), `${await deadPid()}\n`)
    expect((await takeLock()).code).toBe(0)
    const holder = livePid()
    await mkdir(lock)
    await writeFile(join(lock, 'pid'), `${holder}\n`)
    const refused = await takeLock()
    expect(refused.code).toBe(1)
    expect(refused.err).toContain(`pid ${holder}`)
    expect(existsSync(join(lock, String(holder)))).toBe(false)
  })

  test('an empty or garbage legacy pid is refused, never reclaimed', async () => {
    for (const content of ['', 'garbage\n']) {
      await rm(lock, { recursive: true, force: true })
      await mkdir(lock)
      await writeFile(join(lock, 'pid'), content)
      const { code, err } = await takeLock()
      expect(code).toBe(1)
      expect(err).toContain(lock)
      expect(existsSync(join(lock, 'pid'))).toBe(true)
    }
  })

  test('a garbage symlink target is refused', async () => {
    await symlink('not-a-pid', lock)
    const { code, err } = await takeLock()
    expect(code).toBe(1)
    expect(err).toContain(lock)
    expect(await readlink(lock)).toBe('not-a-pid')
  })

  test('a held reclaim lock refuses a dead holder reclaim', async () => {
    await symlink(String(await deadPid()), lock)
    await mkdir(`${lock}.reclaim`)
    const { code, err } = await takeLock()
    expect(code).toBe(1)
    expect(err).toContain(`${lock}.reclaim`)
  })
})
