import { expect, test } from 'bun:test'
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'

const ROOT = join(import.meta.dir, '..', '..')

/** Settings the server reads that the settings file must not set, and why. */
const NEVER: Record<string, string> = {
  FACTORY_TOKEN: 'secret (.env.tpl)',
  FACTORY_AGENT_TOKEN: 'secret (.env.tpl)',
  FACTORY_DOOR_TOKEN: 'secret (.env.tpl)',
  FACTORY_SIGNAL_TOKEN: 'secret (.env.server.tpl)',
  FACTORY_ORCHESTRATOR_TOKEN: 'secret (.env.server.tpl)',
  FACTORY_READ_TOKEN: 'secret (.env.tpl)',
  FACTORY_GITHUB_TOKEN: 'secret (.env.tpl)',
  FACTORY_DB_PASSWORD: 'secret (.env.tpl); launch.sh builds DATABASE_URL from it',
  FACTORY_BESZEL_EMAIL: 'secret (needs an .env.tpl ref before the Beszel source can run)',
  FACTORY_BESZEL_PASSWORD: 'secret (needs an .env.tpl ref before the Beszel source can run)',
  FACTORY_VERSION: "the plist's: the deployed sha",
  FACTORY_TEST_MODE: 'scenarios only; the server refuses the test settings outside a test',
  FACTORY_TEST_CLOCK_OFFSET_MS: 'scenarios only',
  FACTORY_URL: "the leads' terminals and the CLI read it; the server's own URL follows its port",
  FACTORY_SESSION: "the lead's terminal sets it",
  FACTORY_ROLE: "the lead's terminal sets it",
}

async function sources(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true })
  const found = await Promise.all(
    entries.map(async (entry) => {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) return sources(path)
      return entry.name.endsWith('.ts') ? [path] : []
    }),
  )
  return found.flat()
}

async function allowed(): Promise<string[]> {
  const proc = Bun.spawn(
    ['bash', '-c', `source ${join(ROOT, 'scripts', 'env-file.sh')} && printf '%s' "$EF_ALLOWED"`],
    { stdout: 'pipe' },
  )
  return (await new Response(proc.stdout).text()).split(/\s+/).filter(Boolean)
}

test('every setting the server reads is either on the settings file allow-list or named as never settable', async () => {
  const read = new Set<string>()
  for (const file of await sources(join(ROOT, 'apps', 'server', 'src'))) {
    for (const match of (await readFile(file, 'utf8')).matchAll(/FACTORY_[A-Z0-9_]+/g)) read.add(match[0])
  }
  const list = new Set(await allowed())
  const unplaced = [...read].filter((name) => !list.has(name) && !(name in NEVER)).sort()
  expect(unplaced).toEqual([])
})

test('nothing is both allowed and never settable, and the secrets are not on the allow-list', async () => {
  const list = await allowed()
  expect(list.filter((name) => name in NEVER)).toEqual([])
  expect(list.filter((name) => /TOKEN|PASSWORD|SECRET/.test(name))).toEqual([])
})

test('the allow-list is sorted words of FACTORY_ names, each once', async () => {
  const list = await allowed()
  expect(new Set(list).size).toBe(list.length)
  expect(list.every((name) => /^FACTORY_[A-Z0-9_]+$/.test(name))).toBe(true)
})
