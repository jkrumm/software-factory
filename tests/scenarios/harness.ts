import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { join } from 'node:path'
import * as z from 'zod'
import { startTestCluster, type TestCluster } from '../support/pg.ts'

const ROOT = join(import.meta.dir, '..', '..')
const SERVER_MAIN = join(ROOT, 'apps', 'server', 'src', 'main.ts')
const CLI = join(ROOT, 'apps', 'cli', 'bin', 'factory.ts')
const FAKES = join(import.meta.dir, 'fakes')
const BOOT_TIMEOUT_MS = 20_000

const FakeCall = z.object({ tool: z.string(), args: z.array(z.string()) })

/** A private database and a bin directory whose `hc` and `agw` are the fakes. */
export interface World {
  db: TestCluster
  bin: string
  /** every call a fake received, in order */
  calls(): Promise<{ tool: string; args: string[] }[]>
  stop(): Promise<void>
}

export interface ServerProcess {
  url: string
  port: number
  proc: ReturnType<typeof Bun.spawn>
  /** what the process wrote so far, for a failure message */
  output(): string
  /** the exit code, once the process has ended and everything it wrote is in `output()` */
  exited(): Promise<number>
  stop(): Promise<number>
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer()
    probe.once('error', reject)
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address()
      const port = typeof address === 'object' && address ? address.port : 0
      probe.close(() => resolve(port))
    })
  })
}

export async function startWorld(): Promise<World> {
  const db = await startTestCluster()
  const bin = await mkdtemp('/tmp/factory-world-')
  const log = join(bin, 'calls.jsonl')
  for (const tool of ['hc', 'agw']) {
    const shim = join(bin, tool)
    await writeFile(shim, `#!/bin/sh\nexec "${process.execPath}" "${join(FAKES, `${tool}.ts`)}" "$@"\n`)
    await chmod(shim, 0o755)
  }
  await writeFile(log, '')
  return {
    db,
    bin,
    calls: async () =>
      (await readFile(log, 'utf8'))
        .split('\n')
        .filter(Boolean)
        .map((line) => FakeCall.parse(JSON.parse(line))),
    stop: async () => {
      await db.stop()
      await rm(bin, { recursive: true, force: true })
    },
  }
}

/** The environment of a process in the world: the fakes first on PATH, nothing of the host's factory settings. */
function worldEnv(world: World, extra: Record<string, string>): Record<string, string> {
  return {
    PATH: `${world.bin}:${process.env.PATH ?? ''}`,
    HOME: process.env.HOME ?? '/tmp',
    LC_ALL: 'C',
    HC_BIN: join(world.bin, 'hc'),
    // The world's own hook socket, spool and archive, never the host's; and no tick unless a scenario asks for one.
    FACTORY_SOCKET: join(world.bin, 'hook.sock'),
    FACTORY_SPOOL_DIR: join(world.bin, 'spool'),
    FACTORY_ARCHIVE_DIR: join(world.bin, 'archive'),
    FACTORY_PRETRUST_BIN: '/usr/bin/true',
    FACTORY_TICK_MS: '0',
    FACTORY_AGW_BIN: join(world.bin, 'agw'),
    FACTORY_FAKE_LOG: join(world.bin, 'calls.jsonl'),
    ...extra,
  }
}

async function drain(stream: ReadableStream<Uint8Array>, sink: (text: string) => void): Promise<void> {
  const decoder = new TextDecoder()
  for await (const chunk of stream) sink(decoder.decode(chunk, { stream: true }))
}

/** Starts the real server process on the world's database; `ready: false` returns at once instead of waiting for /health. */
export async function startServer(
  world: World,
  options: { env?: Record<string, string>; ready?: boolean } = {},
): Promise<ServerProcess> {
  const port = await freePort()
  const proc = Bun.spawn([process.execPath, SERVER_MAIN], {
    cwd: ROOT,
    env: worldEnv(world, {
      DATABASE_URL: world.db.url,
      PORT: String(port),
      FACTORY_VERSION: 'scenario',
      ...options.env,
    }),
    stdout: 'pipe',
    stderr: 'pipe',
  })
  let output = ''
  const append = (text: string) => {
    output += text
  }
  const drained = Promise.all([drain(proc.stdout, append), drain(proc.stderr, append)])
  const url = `http://127.0.0.1:${port}`
  const server: ServerProcess = {
    url,
    port,
    proc,
    output: () => output,
    exited: async () => {
      const code = await proc.exited
      await drained
      return code
    },
    stop: async () => {
      if (proc.exitCode === null) proc.kill('SIGTERM')
      return server.exited()
    },
  }
  if (options.ready === false) return server

  const deadline = Date.now() + BOOT_TIMEOUT_MS
  while (Date.now() < deadline) {
    if (proc.exitCode !== null) throw new Error(`the server exited ${proc.exitCode} before it answered:\n${output}`)
    const answered = await fetch(`${url}/health`).then(
      (response) => response.status === 200,
      () => false,
    )
    if (answered) return server
    await Bun.sleep(100)
  }
  proc.kill('SIGKILL')
  throw new Error(`the server did not answer /health within ${BOOT_TIMEOUT_MS} ms:\n${output}`)
}

/** Runs the generated CLI against a server, as a separate process. */
export async function factory(
  world: World,
  args: string[],
  env: Record<string, string> = {},
): Promise<{ code: number; out: string; err: string }> {
  const proc = Bun.spawn([process.execPath, CLI, ...args], {
    cwd: ROOT,
    env: worldEnv(world, env),
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [out, err, code] = await Promise.all([proc.stdout.text(), proc.stderr.text(), proc.exited])
  return { code, out, err }
}
