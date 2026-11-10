import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { run } from '../src/run.ts'

// A plain shell on the host: no FACTORY_* variables, a deployed release with a template, and a fake `secrets-run` that
// answers like the real one (`read <ref>` prints the secret; `run` would mask it).
const OWNER = 'owner-token-resolved-0001'

let server: ReturnType<typeof Bun.serve>
let dir: string
let home: string
let shim: string
let calls: string
let bearers: (string | null)[] = []

beforeAll(async () => {
  dir = await mkdtemp('/tmp/factory-cli-credentials-')
  home = join(dir, 'home')
  shim = join(dir, 'shim')
  calls = join(dir, 'calls.log')
  await mkdir(join(home, '.software-factory', 'current'), { recursive: true })
  await writeFile(
    join(home, '.software-factory', 'current', '.env.tpl'),
    'FACTORY_TOKEN=op://mini/software-factory/FACTORY_TOKEN\n',
  )
  await mkdir(shim)
  server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: (request) => {
      const url = new URL(request.url)
      bearers.push(request.headers.get('authorization'))
      if (request.headers.get('authorization') !== `Bearer ${OWNER}`) {
        return Response.json({ error: 'a bearer token is required', code: 'unauthorized' }, { status: 401 })
      }
      if (url.pathname === '/v1/issues') return Response.json({ issues: [] })
      return Response.json({ issue: 'issue_1', state: 'open', filed: true })
    },
  })
})

afterAll(async () => {
  await server.stop(true)
  await rm(dir, { recursive: true, force: true })
})

beforeEach(async () => {
  bearers = []
  await rm(calls, { force: true })
})

async function fakeSecretsRun(script: string) {
  const file = join(shim, 'secrets-run')
  await writeFile(file, `#!/bin/sh\necho "$*" >> "${calls}"\n${script}\n`)
  await chmod(file, 0o755)
}

const resolving = `
[ "$1" = read ] || exit 2
case "$2" in op://mini/software-factory/FACTORY_TOKEN) printf '%s\\n' ${OWNER} ;; *) exit 3 ;; esac
`

const called = async () => (await readFile(calls, 'utf8').catch(() => '')).trim()

/** A plain shell: only PATH, HOME and the server's URL. */
async function plainShell(argv: string[], env: Record<string, string> = {}, path = `${shim}:/usr/bin:/bin`) {
  let out = ''
  let err = ''
  const code = await run(argv, {
    env: { PATH: path, HOME: home, FACTORY_URL: server.url.href, ...env },
    out: (text) => {
      out += text
    },
    err: (text) => {
      err += text
    },
    stdin: () => Promise.resolve(''),
    readFile: (file) => Bun.file(file).text(),
  })
  return { code, out, err }
}

describe('the owner token on the host', () => {
  test('issue list and issue new resolve it from the release template through secrets-run', async () => {
    await fakeSecretsRun(resolving)
    const list = await plainShell(['issue', 'list'])
    expect(list.code).toBe(0)
    const created = await plainShell(['issue', 'new', '--repo', 'scratch', '--title', 't'])
    expect(created.code).toBe(0)
    expect(bearers).toEqual([`Bearer ${OWNER}`, `Bearer ${OWNER}`])
    const lines = (await called()).split('\n')
    expect(lines).toHaveLength(2)
    expect(lines[0]).toBe('read op://mini/software-factory/FACTORY_TOKEN')
  })

  test('FACTORY_ROOT moves the release', async () => {
    await fakeSecretsRun(resolving)
    const root = join(dir, 'elsewhere')
    await mkdir(join(root, 'current'), { recursive: true })
    await writeFile(join(root, 'current', '.env.tpl'), 'FACTORY_TOKEN=op://mini/software-factory/FACTORY_TOKEN\n')
    expect((await plainShell(['issue', 'list'], { FACTORY_ROOT: root })).code).toBe(0)
    expect(await called()).toBe('read op://mini/software-factory/FACTORY_TOKEN')
  })

  test('a set FACTORY_TOKEN wins and the resolver is not called', async () => {
    await fakeSecretsRun(resolving)
    const result = await plainShell(['issue', 'list'], { FACTORY_TOKEN: 'lead-agent-token' })
    expect(result.code).toBe(3)
    expect(bearers).toEqual(['Bearer lead-agent-token'])
    expect(await called()).toBe('')
  })

  test('a set FACTORY_READ_TOKEN is not replaced either', async () => {
    await fakeSecretsRun(resolving)
    await plainShell(['issue', 'list'], { FACTORY_READ_TOKEN: 'read-token' })
    expect(bearers).toEqual(['Bearer read-token'])
    expect(await called()).toBe('')
  })

  test('offline commands and health resolve nothing, and run with no secrets-run on PATH', async () => {
    await fakeSecretsRun(resolving)
    for (const argv of [['role', 'get', 'lead'], ['issue', 'schema'], ['version'], ['--help']]) {
      const withShim = await plainShell(argv)
      expect(withShim.err).not.toContain('secrets-run')
      expect(await called()).toBe('')
      const without = await plainShell(argv, {}, '/usr/bin:/bin')
      expect(without.code).toBe(withShim.code)
    }
    expect((await plainShell(['role', 'get', 'lead'], {}, '/usr/bin:/bin')).code).toBe(0)
    expect((await plainShell(['issue', 'schema'], {}, '/usr/bin:/bin')).code).toBe(0)
  })

  test('health resolves nothing', async () => {
    await fakeSecretsRun(resolving)
    await plainShell(['health', 'get'])
    expect(await called()).toBe('')
  })

  test('a resolver that fails leaves the call tokenless and the 401 hint says why', async () => {
    await fakeSecretsRun('echo "no cached value for op://mini/software-factory/FACTORY_TOKEN" >&2; exit 1')
    const result = await plainShell(['issue', 'list'])
    expect(result.code).toBe(3)
    const { hint } = JSON.parse(result.err).error as { hint: string }
    expect(hint).toContain('secrets-run exited 1')
    expect(hint).toContain('no cached value')
    expect(bearers).toEqual([null])
  })

  test('no deployed release, or no secrets-run, is a plain 401 with nothing spawned', async () => {
    await fakeSecretsRun(resolving)
    const stranger = await plainShell(['issue', 'list'], { HOME: join(dir, 'nobody') })
    expect(stranger.code).toBe(3)
    expect(await called()).toBe('')
    const bare = await plainShell(['issue', 'list'], {}, '/usr/bin:/bin')
    expect(bare.code).toBe(3)
    expect(JSON.parse(bare.err).error.hint).toContain('set FACTORY_TOKEN')
  })
})
