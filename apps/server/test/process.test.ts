import { expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CannotExecute, EXIT_STOPPED, EXIT_TIMEOUT, gitIn, GitTimeout, runProcess } from '../src/adapters/process.ts'

test('stdout comes back, stderr only when asked for', async () => {
  const cmd = ['sh', '-c', 'echo out; echo err >&2; exit 3']
  expect(await runProcess(cmd, 5_000)).toMatchObject({ exitCode: 3, stdout: 'out\n', stderr: '', timedOut: false })
  expect(await runProcess(cmd, 5_000, { stderr: 'capture' })).toMatchObject({ stdout: 'out\n', stderr: 'err\n' })
})

test('input reaches stdin and cwd is the working directory', async () => {
  expect((await runProcess(['cat'], 5_000, { input: 'hello' })).stdout).toBe('hello')
  expect((await runProcess(['pwd'], 5_000, { cwd: '/' })).stdout).toBe('/\n')
})

test('a program past its time limit is killed: EXIT_TIMEOUT and timedOut', async () => {
  const done = await runProcess(['sleep', '30'], 100)
  expect(done).toMatchObject({ exitCode: EXIT_TIMEOUT, timedOut: true, stdout: '' })
})

test('a program that cannot start throws CannotExecute', async () => {
  expect(await runProcess(['/no/such/binary'], 1_000).catch((error: unknown) => error)).toBeInstanceOf(CannotExecute)
})

test("the caller's signal stops it with EXIT_STOPPED, and an aborted signal never starts it", async () => {
  const controller = new AbortController()
  const pending = runProcess(['sleep', '30'], 30_000, { group: true, signal: controller.signal })
  controller.abort()
  expect(await pending).toMatchObject({ exitCode: EXIT_STOPPED, timedOut: true })
  expect(await runProcess(['sleep', '30'], 30_000, { signal: controller.signal })).toMatchObject({
    exitCode: EXIT_STOPPED,
  })
})

test('a group kill reaches what the program started', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'process-test-'))
  try {
    const pidFile = join(dir, 'pid')
    await runProcess(['sh', '-c', `sleep 30 & echo $! > "${pidFile}"; wait`], 300, { group: true })
    const grandchild = Number(readFileSync(pidFile, 'utf8').trim())
    await Bun.sleep(100)
    expect(() => process.kill(grandchild, 0)).toThrow()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('git in a repo throws GitTimeout when the limit is hit and returns the exit code otherwise', async () => {
  const slow = (async () => ({ exitCode: EXIT_TIMEOUT, stdout: '' })) as never
  expect(await gitIn('/', ['status'], { run: slow }).catch((error: unknown) => error)).toBeInstanceOf(GitTimeout)
  const done = await gitIn('/', ['rev-parse', '--is-inside-work-tree'], { timeoutMs: 5_000 })
  expect(typeof done.exitCode).toBe('number')
})
