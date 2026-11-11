import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { chmod, mkdir, mkdtemp, readFile, readlink, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const BIN = join(import.meta.dir, '..', 'bin', 'factory.ts')

let dir = ''
let locks = ''
let marks = ''
const sleepers: ReturnType<typeof Bun.spawn>[] = []

beforeEach(async () => {
  dir = await mkdtemp('/tmp/factory-deploy-lock-')
  locks = join(dir, 'locks')
  marks = join(dir, 'marks')
})

afterEach(async () => {
  for (const proc of sleepers.splice(0)) proc.kill()
  await chmod(dir, 0o755)
  await rm(dir, { recursive: true, force: true })
})

/** Starts `factory deploy-lock --project <project> -- <cmd>` as its own process. */
function start(project: string, cmd: string[], env: Record<string, string> = {}) {
  const proc = Bun.spawn(['bun', BIN, 'deploy-lock', '--project', project, '--', ...cmd], {
    env: {
      ...process.env,
      FACTORY_DEPLOY_LOCK_DIR: locks,
      FACTORY_DEPLOY_LOCK_POLL_MS: '20',
      ...env,
    },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  return {
    proc,
    done: (async () => ({
      code: await proc.exited,
      out: await new Response(proc.stdout).text(),
      err: await new Response(proc.stderr).text(),
    }))(),
  }
}

/** A command that appends `<tag> start`, sleeps, appends `<tag> end`. */
const marker = (tag: string, seconds = '0.2') => [
  'sh',
  '-c',
  `echo "${tag} start" >> "${marks}"; sleep ${seconds}; echo "${tag} end" >> "${marks}"`,
]

const marksOf = async (): Promise<string[]> => {
  try {
    return (await readFile(marks, 'utf8')).trim().split('\n').filter(Boolean)
  } catch {
    return []
  }
}

async function deadPid(): Promise<number> {
  const proc = Bun.spawn(['true'])
  await proc.exited
  return proc.pid
}

describe('factory deploy-lock', () => {
  test('runs the command and passes its exit code and output through', async () => {
    const ok = await start('app', ['sh', '-c', 'echo hello']).done
    expect(ok).toMatchObject({ code: 0, out: 'hello\n' })
    const failed = await start('app', ['sh', '-c', 'exit 7']).done
    expect(failed.code).toBe(7)
  })

  test('a name that is not a plain name is a usage error and the command does not run', async () => {
    const result = await start('../x', marker('a', '0')).done
    expect(result.code).toBe(2)
    expect(await marksOf()).toEqual([])
  })

  test('releases the lock when the command ends', async () => {
    await start('app', ['true']).done
    expect(await Bun.file(join(locks, 'app.lock')).exists()).toBe(false)
    expect((await start('app', ['true']).done).code).toBe(0)
  })

  test('a second call waits for the first, then runs', async () => {
    const first = start('app', marker('a', '0.5'))
    while ((await marksOf()).length === 0) await Bun.sleep(10)
    const second = start('app', marker('b', '0'))
    expect((await first.done).code).toBe(0)
    expect((await second.done).code).toBe(0)
    expect(await marksOf()).toEqual(['a start', 'a end', 'b start', 'b end'])
  })

  test('a live holder and a tiny wait: exit 75 and the command did not run', async () => {
    const holder = Bun.spawn(['sleep', '60'])
    sleepers.push(holder)
    await mkdir(locks, { recursive: true })
    await symlink(String(holder.pid), join(locks, 'app.lock'))
    const result = await start('app', marker('b', '0'), { FACTORY_DEPLOY_LOCK_WAIT_MS: '100' }).done
    expect(result.code).toBe(75)
    expect(result.err).toContain(`pid ${holder.pid}`)
    expect(await marksOf()).toEqual([])
    expect(await readlink(join(locks, 'app.lock'))).toBe(String(holder.pid))
  })

  test('a stale lock of a dead pid is reclaimed', async () => {
    await mkdir(locks, { recursive: true })
    await symlink(String(await deadPid()), join(locks, 'app.lock'))
    const result = await start('app', marker('a', '0')).done
    expect(result.code).toBe(0)
    expect(await marksOf()).toEqual(['a start', 'a end'])
    expect(await Bun.file(join(locks, 'app.lock.reclaim')).exists()).toBe(false)
  })

  test('a lock whose target is not a pid: exit 75, the command did not run, the lock is kept', async () => {
    await mkdir(locks, { recursive: true })
    await symlink('garbage', join(locks, 'app.lock'))
    const result = await start('app', marker('a', '0')).done
    expect(result.code).toBe(75)
    expect(result.err).toContain('app.lock')
    expect(await marksOf()).toEqual([])
    expect(await readlink(join(locks, 'app.lock'))).toBe('garbage')
  })

  test('a held reclaim lock: exit 75, the command did not run', async () => {
    await mkdir(join(locks, 'app.lock.reclaim'), { recursive: true })
    await symlink(String(await deadPid()), join(locks, 'app.lock'))
    const result = await start('app', marker('a', '0')).done
    expect(result.code).toBe(75)
    expect(result.err).toContain('app.lock.reclaim')
    expect(await marksOf()).toEqual([])
  })

  test('a state dir that cannot be created: exit 75, the command did not run', async () => {
    await writeFile(join(dir, 'file'), '')
    const result = await start('app', marker('a', '0'), { FACTORY_DEPLOY_LOCK_DIR: join(dir, 'file', 'locks') }).done
    expect(result.code).toBe(75)
    expect(await marksOf()).toEqual([])
  })

  test('an unwritable state dir: exit 75, the command did not run', async () => {
    await mkdir(locks, { recursive: true })
    await chmod(locks, 0o500)
    const result = await start('app', marker('a', '0')).done
    await chmod(locks, 0o755)
    // root ignores the mode; elsewhere the lock cannot be created
    if (process.getuid?.() === 0) return
    expect(result.code).toBe(75)
    expect(await marksOf()).toEqual([])
  })

  test('different projects do not wait for each other', async () => {
    const first = start('one', marker('a', '0.4'))
    while ((await marksOf()).length === 0) await Bun.sleep(10)
    const second = await start('two', marker('b', '0')).done
    expect(second.code).toBe(0)
    expect((await marksOf()).slice(0, 3)).toEqual(['a start', 'b start', 'b end'])
    await first.done
  })

  test('parallel calls never overlap', async () => {
    const runs = ['a', 'b', 'c', 'd'].map((tag) => start('app', marker(tag, '0.1')))
    for (const run of runs) expect((await run.done).code).toBe(0)
    const lines = await marksOf()
    expect(lines).toHaveLength(8)
    for (let i = 0; i < lines.length; i += 2) {
      const tag = lines[i]?.split(' ')[0]
      expect(lines[i]).toBe(`${tag} start`)
      expect(lines[i + 1]).toBe(`${tag} end`)
    }
  })

  test('a lock released while a waiter looks at it is taken again, never exit 75 (#833)', async () => {
    for (let round = 0; round < 4; round++) {
      const runs = Array.from({ length: 12 }, () => start('app', ['true'], { FACTORY_DEPLOY_LOCK_POLL_MS: '5' }))
      for (const run of runs) {
        const result = await run.done
        expect({ code: result.code, err: result.err }).toEqual({ code: 0, err: '' })
      }
    }
  })
})

describe('factory merge-lock', () => {
  const startMerge = (project: string, cmd: string[], env: Record<string, string> = {}) =>
    Bun.spawn(['bun', BIN, 'merge-lock', '--project', project, '--', ...cmd], {
      env: { ...process.env, FACTORY_DEPLOY_LOCK_DIR: locks, FACTORY_DEPLOY_LOCK_POLL_MS: '20', ...env },
      stdout: 'pipe',
      stderr: 'pipe',
    })
  const finish = async (proc: ReturnType<typeof startMerge>) => ({
    code: await proc.exited,
    err: await new Response(proc.stderr).text(),
  })

  test('serialises two merge windows of one project, and a deploy lock does not block it', async () => {
    const deploy = start('app', marker('d', '0.6'))
    while ((await marksOf()).length === 0) await Bun.sleep(10)
    const first = startMerge('app', marker('a', '0.4'))
    while ((await marksOf()).length < 2) await Bun.sleep(10)
    const second = startMerge('app', marker('b', '0'))
    expect((await finish(first)).code).toBe(0)
    expect((await finish(second)).code).toBe(0)
    await deploy.done
    const lines = await marksOf()
    expect(lines.indexOf('a end')).toBeLessThan(lines.indexOf('b start'))
    expect(lines.indexOf('a start')).toBeLessThan(lines.indexOf('d end'))
    expect(await Bun.file(join(locks, 'app.merge.lock')).exists()).toBe(false)
  })

  test('a live holder and a tiny wait: exit 75 naming the merge lock', async () => {
    const holder = Bun.spawn(['sleep', '60'])
    sleepers.push(holder)
    await mkdir(locks, { recursive: true })
    await symlink(String(holder.pid), join(locks, 'app.merge.lock'))
    const result = await finish(startMerge('app', marker('b', '0'), { FACTORY_MERGE_LOCK_WAIT_MS: '100' }))
    expect(result.code).toBe(75)
    expect(result.err).toContain('merge lock for app')
    expect(await marksOf()).toEqual([])
  })

  test('a missing --project is a usage error naming merge-lock', async () => {
    const result = await finish(startMerge('../x', ['true']))
    expect(result.code).toBe(2)
    expect(result.err).toContain('merge-lock')
  })
})
