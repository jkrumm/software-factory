import { expect, test } from 'bun:test'
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'

const ROOT = join(import.meta.dir, '..', '..')

/** A release is an export of the tree (`git archive`): a template a launcher reads must be tracked, or no release holds it. */
test('every .env template a script or a plist names is tracked in git', async () => {
  const scripts = (await readdir(join(ROOT, 'scripts')))
    .filter((name) => name.endsWith('.sh'))
    .map((name) => join(ROOT, 'scripts', name))
  const deploy = (await readdir(join(ROOT, 'deploy'))).map((name) => join(ROOT, 'deploy', name))
  const named = new Set<string>()
  for (const file of [...scripts, ...deploy]) {
    for (const match of (await readFile(file, 'utf8')).matchAll(/\.env(?:\.[a-z]+)?\.tpl/g)) named.add(match[0])
  }
  expect([...named].sort()).toContain('.env.door.tpl')
  const tracked = Bun.spawn(['git', 'ls-files', '--', ...named], { cwd: ROOT, stdout: 'pipe' })
  const listed = (await new Response(tracked.stdout).text()).split('\n').filter(Boolean)
  expect([...named].filter((name) => !listed.includes(name))).toEqual([])
})
