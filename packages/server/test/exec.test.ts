import { describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { EXIT_STOPPED, EXIT_TIMEOUT, runProcess } from '../src/exec.ts'

const alive = (pid: number) => Bun.spawnSync(['kill', '-0', String(pid)]).exitCode === 0

/** A shell that starts a child, says its pid, and waits. */
const WITH_CHILD = (file: string) => ['sh', '-c', `sleep 30 & echo $! > ${file}; wait`]

async function pidIn(file: string): Promise<number> {
  for (let i = 0; i < 100; i++) {
    const text = await Bun.file(file)
      .text()
      .catch(() => '')
    if (text.trim()) return Number(text)
    await Bun.sleep(20)
  }
  throw new Error('the child never said its pid')
}

describe('runProcess with a process group', () => {
  test('a stop kills what the command started, and a timeout does too', async () => {
    const dir = mkdtempSync('/tmp/factory-exec-')
    const controller = new AbortController()
    const stopped = runProcess(WITH_CHILD(join(dir, 'a')), 20_000, undefined, undefined, {
      group: true,
      signal: controller.signal,
    })
    const child = await pidIn(join(dir, 'a'))
    expect(alive(child)).toBe(true)
    controller.abort()
    expect((await stopped).exitCode).toBe(EXIT_STOPPED)
    await Bun.sleep(100)
    expect(alive(child)).toBe(false)

    const timedOut = runProcess(WITH_CHILD(join(dir, 'b')), 300, undefined, undefined, { group: true })
    const second = await pidIn(join(dir, 'b'))
    expect((await timedOut).exitCode).toBe(EXIT_TIMEOUT)
    await Bun.sleep(100)
    expect(alive(second)).toBe(false)
    rmSync(dir, { recursive: true, force: true })
  })

  test('a signal already aborted starts nothing', async () => {
    const dir = mkdtempSync('/tmp/factory-exec-')
    const made = join(dir, 'ran')
    const done = await runProcess(['sh', '-c', `touch ${made}`], 5_000, undefined, undefined, {
      signal: AbortSignal.abort(),
    })
    expect(done.exitCode).toBe(EXIT_STOPPED)
    expect(await Bun.file(made).exists()).toBe(false)
    rmSync(dir, { recursive: true, force: true })
  })

  test('a process.exit takes the group along, as a lost database lock does', async () => {
    const dir = mkdtempSync('/tmp/factory-exec-')
    const file = join(dir, 'pid')
    const script = join(dir, 'exits.ts')
    const exec = join(import.meta.dir, '..', 'src', 'exec.ts')
    writeFileSync(
      script,
      `import { runProcess } from '${exec}'
void runProcess(['sh', '-c', 'sleep 30 & echo $! > ${file}; wait'], 20_000, undefined, undefined, { group: true })
setTimeout(() => process.exit(1), 300)
`,
    )
    const run = Bun.spawn(['bun', script], { stdout: 'ignore', stderr: 'ignore' })
    await run.exited
    const child = Number(readFileSync(file, 'utf8'))
    await Bun.sleep(100)
    expect(alive(child)).toBe(false)
    rmSync(dir, { recursive: true, force: true })
  })
})
