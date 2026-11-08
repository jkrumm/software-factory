import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { ALLOW_FILE, checkPublicScan, findingsIn, parseExceptions, ROOT, RULES } from '../public-scan.ts'

// Fixtures are assembled from parts, so this file does not trip the scan it tests.
const join2 = (...parts: string[]) => parts.join('')

/** Each rule: text it must catch and the nearest text it must let through. */
const FIXTURES: Record<string, { failing: string; passing: string }> = {
  ipv4: { failing: 'host 10.1.2.3 up', passing: 'host 192.0.2.5 and 127.0.0.1 and version 1.2.3' },
  tailnet: {
    failing: join2('ssh box.tail', 'a1b2c3.ts.net'),
    passing: 'the tailnet and a tailscale ip placeholder <tailscale-ip>',
  },
  email: { failing: 'mail someone@corp.org', passing: 'mail someone@example.com or 1+2@users.noreply.github.com' },
  secret: {
    failing: join2('token ghp', '_', 'a'.repeat(30)),
    passing: 'token op://vault/item/field and FACTORY_TOKEN=<see-1password>',
  },
  'home-path': {
    failing: join2('/Users', '/alice/code'),
    passing: join2('/Users', '/me/code and ~/code and /home', '/x/y'),
  },
  host: { failing: join2('run ssh ', 'iumac ls'), passing: 'run on the mini, a macbook or the homelab' },
  account: { failing: join2('login as ', 'careerpart', 'ner'), passing: 'the work account, <see-1password>' },
  'work-repo': {
    failing: join2('cd ~/Iu', 'Root/x'),
    passing: join2('cd ~/WorkRoot/x, a work repo, the forge'),
  },
}

describe('public scan', () => {
  test('every rule has a fixture', () => {
    expect(Object.keys(FIXTURES).sort()).toEqual(RULES.map((r) => r.rule).sort())
  })

  for (const [rule, { failing, passing }] of Object.entries(FIXTURES)) {
    test(`${rule} catches its failing text and passes its passing text`, () => {
      expect(findingsIn('f.md', failing).map((f) => f.rule)).toContain(rule)
      expect(findingsIn('f.md', passing).filter((f) => f.rule === rule)).toEqual([])
    })
  }

  test('a snake_case identifier is caught too', () => {
    expect(findingsIn('f.json', join2('"iu', 'root_jobs": 1')).map((f) => f.rule)).toContain('work-repo')
  })

  test('an op:// reference is a reference, not a value', () => {
    expect(findingsIn('.env.tpl', 'TOKEN=op://mini/software-factory/FACTORY_TOKEN')).toEqual([])
  })

  test('exceptions need a reason and a known rule', () => {
    const { exceptions, problems } = parseExceptions('a.ts ipv4  # a fixture\nb.ts ipv4\nc.ts nonsense  # why\n')
    expect(exceptions).toHaveLength(1)
    expect(problems).toHaveLength(2)
  })

  let root: string | undefined
  afterEach(async () => {
    if (root) await rm(root, { recursive: true, force: true })
    root = undefined
  })

  test('--files mode reports a finding and honours an exception', async () => {
    root = await mkdtemp('/tmp/factory-scan-')
    await writeFile(join(root, 'a.md'), 'host 10.1.2.3\n')
    expect(await checkPublicScan(root, '', ['a.md'])).toHaveLength(1)
    expect(await checkPublicScan(root, 'a.md ipv4  # a fixture\n', ['a.md'])).toEqual([])
  })

  test('the repo itself is clean, and no exception is stale', async () => {
    expect(await checkPublicScan(ROOT, await Bun.file(ALLOW_FILE).text())).toEqual([])
  })
})
