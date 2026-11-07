import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const ROOT = join(import.meta.dir, '..', '..')
const DEPLOY = join(ROOT, 'scripts', 'deploy.sh')
const NEW_SHA = 'a'.repeat(40)
const OLD_SHA = 'b'.repeat(40)

/** The dry run needs macOS's launchd tools and the secrets shim; elsewhere (CI) it cannot run. */
const canRun = Bun.which('launchctl') !== null && Bun.which('plutil') !== null && Bun.which('secrets-run') !== null

const NEW_DOOR_LAUNCHER = await Bun.file(join(ROOT, 'scripts', 'launch-door.sh')).text()
/** The old core's launcher as `master` ships it: no template, no secret, no `.env.door.tpl`. */
const OLD_DOOR_LAUNCHER = `#!/bin/bash
# factory door launcher (old core): holds no secret; the tokens file is the door's own.
set -u
DIR="$(cd "$(dirname "\${BASH_SOURCE[0]}")/.." && pwd)"
cd "$DIR" || exit 78
exec bun src/main.ts
`

let work = ''

beforeAll(async () => {
  work = await mkdtemp('/tmp/factory-deploy-plan-')
  // the live release is the new core; the one before it is the old core's
  const live = join(work, 'releases', NEW_SHA)
  const old = join(work, 'releases', OLD_SHA)
  for (const [dir, files] of [
    [live, ['apps/server/src/main.ts', 'apps/cli/bin/factory.ts', 'apps/door/src/main.ts']],
    [old, ['src/main.ts']],
  ] as const) {
    for (const file of files) {
      await mkdir(join(dir, file, '..'), { recursive: true })
      await writeFile(join(dir, file), '')
    }
    await cp(join(ROOT, 'deploy'), join(dir, 'deploy'), { recursive: true })
    await mkdir(join(dir, 'scripts'), { recursive: true })
    await cp(join(ROOT, 'scripts', 'env-file.sh'), join(dir, 'scripts', 'env-file.sh'))
    // the door's launcher is the release's own: the new core's resolves .env.door.tpl, the old core's holds no secret and has none
    await writeFile(join(dir, 'scripts', 'launch-door.sh'), dir === live ? NEW_DOOR_LAUNCHER : OLD_DOOR_LAUNCHER)
    if (dir === live) await cp(join(ROOT, '.env.door.tpl'), join(dir, '.env.door.tpl'))
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
    expect(out).toMatch(
      /door: new door \(apps\/door\) from [0-9a-f<>a-z]+, launcher .*launch-door\.sh, credentials: FACTORY_DOOR_TOKEN from its \.env\.door\.tpl/,
    )
    expect(out).not.toContain('old door')
    expect(out).toContain('the settings file is accepted')
    expect(out).not.toContain('packages/cli')
  })

  test('DRY_RUN=1 make rollback: returns from the new core to the old one, its CLI and its door', async () => {
    const { code, out } = await dry(['rollback'])
    expect(code).toBe(0)
    expect(out).toContain(`would roll back ${NEW_SHA} (new core (apps/server)) -> ${OLD_SHA.slice(0, 12)} (old core)`)
    expect(out).toContain('packages/cli/bin/factory.ts')
    expect(out).toContain('the door of the old core')
    expect(out).toContain(
      `door: old door from ${OLD_SHA.slice(0, 12)}, launcher ${join(work, 'releases', OLD_SHA)}/scripts/launch-door.sh, credentials: none (the tokens file only)`,
    )
    expect(out).toContain(`${join(work, 'releases', OLD_SHA)}/scripts/launch-door.sh`)
    expect(out).not.toContain('new door (apps/door)')
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

/**
 * `deploy_door` itself, against a fake launchctl, curl and secrets-run: it renders the release's own plist, starts that door and
 * says which door it started. The old release has no `.env.door.tpl` and needs none: no warning.
 */
describe.skipIf(!canRun)('starting the door of a release', () => {
  async function startDoor(sha: string): Promise<{ out: string; plist: string; calls: string[] }> {
    const home = await mkdtemp('/tmp/factory-door-plan-')
    const bin = join(home, 'bin')
    await mkdir(bin, { recursive: true })
    await mkdir(join(home, 'Library', 'LaunchAgents'), { recursive: true })
    const calls = join(home, 'calls.log')
    // launchctl: `print` shows the launcher of the plist last bootstrapped (and is "not loaded" before any); the rest is logged
    await writeFile(
      join(bin, 'launchctl'),
      `#!/bin/bash
echo "$*" >> ${calls}
case "$1" in
  bootstrap) cp "$3" ${home}/loaded.plist ;;
  bootout) rm -f ${home}/loaded.plist ;;
  print) [[ -f ${home}/loaded.plist ]] || exit 113
    echo "	arguments = {"; echo "		/bin/bash"; echo "		$(grep -o '[^<>]*launch-door.sh' ${home}/loaded.plist)"; echo "	}" ;;
esac
`,
      { mode: 0o755 },
    )
    await writeFile(join(bin, 'curl'), '#!/bin/bash\necho 401\n', { mode: 0o755 })
    await writeFile(join(bin, 'secrets-run'), '#!/bin/bash\nexit 0\n', { mode: 0o755 })
    const proc = Bun.spawn(
      ['bash', '-c', `source ${DEPLOY} && DOOR_WAIT_SECS=2 && deploy_door ${join(work, 'releases', sha)} ${sha}`],
      {
        cwd: ROOT,
        env: { ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH ?? ''}`, FACTORY_ROOT: work },
        stdout: 'pipe',
        stderr: 'pipe',
      },
    )
    const [out, err] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ])
    const plist = await Bun.file(join(home, 'loaded.plist')).text()
    const log = await Bun.file(calls).text()
    await rm(home, { recursive: true, force: true })
    return { out: `${out}\n${err}`, plist, calls: log.split('\n').filter(Boolean) }
  }

  test('the new core is deployed: the door of the new release starts with its secret, and is confirmed', async () => {
    const run = await startDoor(NEW_SHA)
    expect(run.plist).toContain(`${join(work, 'releases', NEW_SHA)}/scripts/launch-door.sh`)
    expect(run.out).toContain('door: new door (apps/door)')
    expect(run.out).toContain(`door OK: the new door (apps/door) of ${NEW_SHA.slice(0, 12)}`)
    expect(run.out).not.toContain('WARNING')
  })

  test('the way back: the door of the old release starts with no secret, no .env.door.tpl warning, and is confirmed', async () => {
    const run = await startDoor(OLD_SHA)
    expect(run.plist).toContain(`${join(work, 'releases', OLD_SHA)}/scripts/launch-door.sh`)
    expect(run.plist).not.toContain(NEW_SHA)
    expect(run.out).toContain('door: old door')
    expect(run.out).toContain(`door OK: the old door of ${OLD_SHA.slice(0, 12)}`)
    expect(run.out).not.toContain('WARNING')
    expect(run.out).not.toContain('.env.door.tpl')
  })
})

/** `check_refs` refuses a deploy for an unresolved ref, except the optional ones, which the server starts without. */
describe.skipIf(!canRun)('the refs a deploy checks', () => {
  async function check(unresolved: string): Promise<{ code: number; out: string }> {
    const home = await mkdtemp('/tmp/factory-refs-')
    const bin = join(home, 'bin')
    const release = join(home, 'release')
    await mkdir(bin, { recursive: true })
    await mkdir(join(release, 'scripts'), { recursive: true })
    await cp(join(ROOT, '.env.tpl'), join(release, '.env.tpl'))
    await cp(join(ROOT, '.env.server.tpl'), join(release, '.env.server.tpl'))
    await writeFile(
      join(bin, 'secrets-run'),
      `#!/bin/bash\n[[ "$1" == read && "$2" == */${unresolved} ]] && exit 1\nexit 0\n`,
      { mode: 0o755 },
    )
    const proc = Bun.spawn(['bash', '-c', `source ${DEPLOY} && check_refs ${release}`], {
      env: { ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH ?? ''}` },
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const [out, err, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ])
    await rm(home, { recursive: true, force: true })
    return { code, out: `${out}\n${err}` }
  }

  test('an unresolved signal token is a warning, not a refused deploy', async () => {
    const run = await check('FACTORY_SIGNAL_TOKEN')
    expect(run.code).toBe(0)
    expect(run.out).toContain('optional FACTORY_SIGNAL_TOKEN')
  })

  test('any other unresolved ref still refuses the deploy before anything is stopped', async () => {
    const run = await check('FACTORY_AGENT_TOKEN')
    expect(run.code).toBe(1)
    expect(run.out).toContain('FACTORY_AGENT_TOKEN')
    expect(run.out).toContain('nothing was changed')
  })
})
