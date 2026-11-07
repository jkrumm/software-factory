import { expect, test } from 'bun:test'
import { readdir, readFile } from 'node:fs/promises'
import { join, relative } from 'node:path'

/**
 * Every recurring job of the server is a loop on the runner: no module outside the runner schedules a pass of its own. The
 * lines listed are not loops of this package: intake's pollers and settle keep their own schedule (`adapters/intake/schedule.ts`),
 * and the lease and heartbeat timers of the process lock, the hook socket and the slot lease are not passes.
 */
const SRC = join(import.meta.dir, '..', '..', 'src')
const ALLOWED = new Set([
  'app/loops/runner.ts',
  'adapters/intake/schedule.ts',
  'adapters/postgres/process-lock.ts',
  // the pipe grace after a helper process is killed at its timeout: a poll inside one call, not a pass
  'adapters/planning/process.ts',
  'adapters/agw/port.ts',
])

async function files(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true })
  const nested = await Promise.all(
    entries.map((entry) =>
      entry.isDirectory() ? files(join(dir, entry.name)) : Promise.resolve([join(dir, entry.name)]),
    ),
  )
  return nested.flat().filter((file) => file.endsWith('.ts'))
}

test('no module but the runner starts an interval of its own', async () => {
  const found: string[] = []
  for (const file of await files(SRC)) {
    const name = relative(SRC, file)
    if (ALLOWED.has(name)) continue
    if (/\bsetInterval\s*\(/.test((await readFile(file, 'utf8')).replace(/\/\/.*$/gm, ''))) found.push(name)
  }
  expect(found).toEqual([])
})
