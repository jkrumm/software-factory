import { expect, test } from 'bun:test'
import { join } from 'node:path'
import { childEnv as hcChildEnv } from '../src/adapters/hc/process.ts'
import { childEnv as qualityChildEnv } from '../src/adapters/quality/process.ts'
import { SECRET_ENV, withoutSecrets } from '../src/adapters/secret-env.ts'

/** Every setting of `settings.ts` whose name says it is a token or a password. */
async function secretSettings(): Promise<string[]> {
  const source = await Bun.file(join(import.meta.dir, '..', 'src', 'settings.ts')).text()
  const schema = source.slice(
    source.indexOf('const Env = z.object({'),
    source.indexOf('})\n', source.indexOf('const Env')),
  )
  return [...schema.matchAll(/^\s+([A-Z][A-Z0-9_]*(?:TOKEN|PASSWORD|DATABASE_URL))\b/gm)].map(
    (match) => match[1] as string,
  )
}

test('every token setting of settings.ts is on the one list of secrets a child never inherits', async () => {
  const settings = await secretSettings()
  expect(settings).toEqual(
    expect.arrayContaining([
      'FACTORY_TOKEN',
      'FACTORY_AGENT_TOKEN',
      'FACTORY_DOOR_TOKEN',
      'FACTORY_SIGNAL_TOKEN',
      'FACTORY_READ_TOKEN',
    ]),
  )
  expect(settings.filter((name) => !SECRET_ENV.includes(name))).toEqual([])
})

test('both process adapters strip every secret from a child and keep the rest', () => {
  const base = Object.fromEntries(SECRET_ENV.map((name) => [name, `secret-${name}`]))
  const before = { ...process.env }
  Object.assign(process.env, base, { FACTORY_TEST_KEEP: 'kept' })
  try {
    for (const env of [hcChildEnv(), qualityChildEnv()]) {
      expect(SECRET_ENV.filter((name) => env[name] !== undefined)).toEqual([])
      expect(env.FACTORY_TEST_KEEP).toBe('kept')
    }
  } finally {
    for (const name of [...SECRET_ENV, 'FACTORY_TEST_KEEP']) {
      if (before[name] === undefined) delete process.env[name]
      else process.env[name] = before[name]
    }
  }
})

test('a secret the caller names in extra reaches the child (a lead is handed its token on purpose); the base one never does', () => {
  const env = withoutSecrets(
    { FACTORY_TOKEN: 'handed-over', HC_SESSION: 's' },
    { FACTORY_TOKEN: 'owner', FACTORY_AGENT_TOKEN: 'agent', FACTORY_DOOR_TOKEN: 'door', PATH: '/bin' },
  )
  expect(env).toEqual({ FACTORY_TOKEN: 'handed-over', HC_SESSION: 's', PATH: '/bin' })
})
