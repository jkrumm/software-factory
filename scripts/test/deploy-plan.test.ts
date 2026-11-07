import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const ROOT = join(import.meta.dir, '..', '..')
const DEPLOY = join(ROOT, 'scripts', 'deploy.sh')
const NEW_SHA = 'a'.repeat(40)
const OLD_SHA = 'b'.repeat(40)

/** The dry run needs macOS's launchd tools and the secrets shim; elsewhere (CI) it cannot run. */
const canRun = Bun.which('launchctl') !== null && Bun.which('plutil') !== null && Bun.which('secrets-run') !== null

let work = ''

beforeAll(async () => {
  work = await mkdtemp('/tmp/factory-deploy-plan-')
  // the live release is the new core; the one before it is the old core's
  const live = join(work, 'releases', NEW_SHA)
  const old = join(work, 'releases', OLD_SHA)
  for (const [dir, files] of [
    [live, ['apps/server/src/main.ts', 'apps/cli/bin/factory.ts', 'apps/door/src/main.ts']],
    [old, ['packages/server/src/main.ts', 'packages/cli/bin/factory.ts', 'packages/door/src/main.ts']],
  ] as const) {
    for (const file of files) {
      await mkdir(join(dir, file, '..'), { recursive: true })
      await writeFile(join(dir, file), '')
    }
    await cp(join(ROOT, 'deploy'), join(dir, 'deploy'), { recursive: true })
    await mkdir(join(dir, 'scripts'), { recursive: true })
    await cp(join(ROOT, 'scripts', 'env-file.sh'), join(dir, 'scripts', 'env-file.sh'))
    await writeFile(join(dir, '.complete'), '')
  }
  await mkdir(join(work, 'data'), { recursive: true })
  await writeFile(join(work, 'data', 'deployed-sha'), `${NEW_SHA}\n`)
  await writeFile(join(work, 'data', 'previous-sha'), `${OLD_SHA}\n`)
})

afterAll(async () => {
  await rm(work, { recursive: true, force: true })
})

async function dry(args: string[], env: Record<string, string> = {}): Promise<{ code: number; out: string }> {
  const proc = Bun.spawn(['bash', DEPLOY, ...args], {
    cwd: ROOT,
    env: { ...process.env, DRY_RUN: '1', FACTORY_ROOT: work, FACTORY_ENV_FILE: join(work, 'no-such-env'), ...env },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  return { code, out: `${out}\n${err}` }
}

describe.skipIf(!canRun)('the plans', () => {
  test('DRY_RUN=1 FACTORY_REF=rewrite make deploy: starts the new core, its CLI and its door', async () => {
    const { code, out } = await dry([], { FACTORY_REF: 'rewrite' })
    expect(code).toBe(0)
    expect(out).toContain('new core (apps/server)')
    expect(out).toContain('apps/cli/bin/factory.ts')
    expect(out).toContain('scripts/launch.sh')
    expect(out).toContain('scripts/launch-door.sh')
    expect(out).toContain('the settings file is accepted')
    expect(out).not.toContain('packages/cli')
  })

  test('DRY_RUN=1 make rollback: returns from the new core to the old one, its CLI and its door', async () => {
    const { code, out } = await dry(['rollback'])
    expect(code).toBe(0)
    expect(out).toContain(
      `would roll back ${NEW_SHA} (new core (apps/server)) -> ${OLD_SHA.slice(0, 12)} (old core (packages/server))`,
    )
    expect(out).toContain('packages/cli/bin/factory.ts')
    expect(out).toContain('the door of the old core (packages/server)')
    expect(out).toContain('the two trade places')
  })

  test('a rollback refuses, before stopping anything, a settings file the old launcher would refuse', async () => {
    const env = join(work, 'env')
    await writeFile(env, 'FACTORY_NOT_A_SETTING=1\n', { mode: 0o600 })
    const refused = await dry(['rollback'], { FACTORY_ENV_FILE: env })
    expect(refused.code).not.toBe(0)
    expect(refused.out).toContain('FACTORY_NOT_A_SETTING')
    expect(refused.out).toContain('nothing was changed')
  })
})
