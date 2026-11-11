import { afterAll, beforeAll, expect, test } from 'bun:test'
import { join } from 'node:path'
import { bearer, type ServerProcess, startWorld, TOKENS, type World } from '../harness.ts'
import { type Estate, makeEstate, startIntakeServer } from '../intake/support.ts'
import { patient } from '../patience.ts'

/** `factory follow` as a process against the real server: a frame arrives, SIGTERM ends it with exit 0 and nothing on stderr. */
const CLI = join(import.meta.dir, '..', '..', '..', 'apps', 'cli', 'bin', 'factory.ts')

let world: World
let estate: Estate
let server: ServerProcess

beforeAll(async () => {
  world = await startWorld()
  estate = await makeEstate(world, [{ repo: 'argo' }])
  server = await startIntakeServer(world, estate, { FACTORY_STREAM_POLL_MS: '50' })
})

afterAll(async () => {
  await server.stop()
  await estate.stop()
  await world.stop()
})

test('follow prints the hello and a filed Issue, and SIGTERM ends it with exit 0', async () => {
  const proc = Bun.spawn([process.execPath, CLI, 'follow'], {
    env: {
      PATH: process.env.PATH ?? '',
      HOME: process.env.HOME ?? '/tmp',
      FACTORY_URL: server.url,
      FACTORY_TOKEN: TOKENS.owner,
    },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const stderr = new Response(proc.stderr).text()
  const lines: string[] = []
  const reader = proc.stdout.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  const next = async (match: (event: string) => boolean): Promise<void> => {
    const deadline = Date.now() + patient(15_000)
    for (;;) {
      const end = buffer.indexOf('\n')
      if (end >= 0) {
        const line = buffer.slice(0, end)
        buffer = buffer.slice(end + 1)
        lines.push(line)
        if (match((JSON.parse(line) as { event: string }).event)) return
        continue
      }
      if (Date.now() > deadline) throw new Error(`no matching line; got ${JSON.stringify(lines)}`)
      const chunk = await Promise.race([reader.read(), Bun.sleep(500).then(() => null)])
      if (chunk === null) continue
      if (chunk.done) throw new Error(`follow ended early; got ${JSON.stringify(lines)}`)
      buffer += decoder.decode(chunk.value, { stream: true })
    }
  }

  try {
    await next((event) => event === 'hello')
    const filed = await fetch(`${server.url}/signals`, {
      method: 'POST',
      headers: { ...bearer(), 'content-type': 'application/json' },
      body: JSON.stringify({ from: 'owner:hermes', repo: 'argo', title: 'Follow shows this one' }),
    })
    expect(filed.status).toBe(200)
    await next((event) => event === 'issue')
    const frame = JSON.parse(lines.at(-1) ?? '{}') as { id: string; data: { kind: string; subject: string } }
    expect(frame.id).toMatch(/^\d+\.\d+$/)
    expect(frame.data).toMatchObject({ kind: 'issue', subject: 'filed' })
  } finally {
    proc.kill('SIGTERM')
  }
  expect(await proc.exited).toBe(0)
  expect(await stderr).toBe('')
}, 40_000)
