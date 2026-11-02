import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const SCRIPT = join(import.meta.dir, '..', '..', '..', 'scripts', 'env-file.sh')
let dir: string
let marker: string

beforeAll(() => {
  dir = mkdtempSync('/tmp/factory-envfile-')
  marker = join(dir, 'ran')
})
afterAll(() => rmSync(dir, { recursive: true, force: true }))

/** load_env_file in a fresh bash, then print what it left in the environment. */
function load(content: string | undefined, mode = 0o600) {
  const file = join(dir, 'env')
  rmSync(file, { force: true })
  if (content !== undefined) {
    writeFileSync(file, content)
    chmodSync(file, mode)
  }
  return loadPath(file)
}

function loadPath(file: string) {
  const run = Bun.spawnSync(
    [
      'bash',
      '-c',
      `source "${SCRIPT}"; load_env_file "${file}"; code=$?; echo "code=$code probe=\${FACTORY_PROBE_HOSTS-} every=\${FACTORY_DIGEST_EVERY-}"`,
    ],
    { env: { PATH: process.env.PATH ?? '', HOME: dir }, stdout: 'pipe', stderr: 'pipe' },
  )
  return { out: run.stdout.toString().trim(), err: run.stderr.toString().trim() }
}

describe('scripts/env-file.sh', () => {
  test('no file is no settings', () => {
    expect(load(undefined).out).toBe('code=0 probe= every=')
  })

  test('KEY=VALUE lines, comments and blank lines are applied as they are, nothing evaluated', () => {
    const { out } = load(
      `# the machines a probe may look at\n\nFACTORY_PROBE_HOSTS=box-a=alias-a,box-b=local\nFACTORY_DIGEST_EVERY=$(touch ${marker}) \`touch ${marker}\` $HOME\n`,
    )
    expect(out).toBe(`code=0 probe=box-a=alias-a,box-b=local every=$(touch ${marker}) \`touch ${marker}\` $HOME`)
    expect(existsSync(marker)).toBe(false)
  })

  test('a file of comments only, or an empty one, is valid under set -u (macOS bash 3.2)', () => {
    for (const content of ['# nothing yet\n', '', '\n\n']) {
      const file = join(dir, 'env')
      writeFileSync(file, content)
      chmodSync(file, 0o600)
      const run = Bun.spawnSync(['bash', '-c', `set -u; source "${SCRIPT}"; load_env_file "${file}"; echo "code=$?"`], {
        stdout: 'pipe',
        stderr: 'pipe',
      })
      expect(run.stdout.toString().trim()).toBe('code=0')
    }
  })

  test('a mode other than 0600 refuses', () => {
    const { out, err } = load('FACTORY_PROBE_HOSTS=a=b\n', 0o644)
    expect(out).toStartWith('code=78 probe=')
    expect(err).toContain('mode 0600')
  })

  test('a line that is not KEY=VALUE, or ends in a carriage return, refuses, naming the line and not its text', () => {
    for (const bad of ['FACTORY_PROBE_HOSTS=a=b\nexport OTHER=1\n', 'FACTORY_PROBE_HOSTS=a=b\r\n']) {
      const { out, err } = load(bad)
      expect(out).toStartWith('code=78 probe= ') // nothing of the file was exported
      expect(err).toMatch(/line [12] (is not KEY=VALUE|has a carriage return)/)
      expect(err).not.toContain('export OTHER')
    }
  })

  test('only the listed keys: a secret, the launcher’s own, a loader variable and a name that collides with the parser are refused', () => {
    for (const key of [
      'FACTORY_TOKEN',
      'FACTORY_DB_PASSWORD',
      'DATABASE_URL',
      'PORT',
      'PATH',
      'BASH_ENV',
      'FACTORY_VERSION',
      'reserved',
      'lineno',
      'ef_n',
    ]) {
      const { out, err } = load(`FACTORY_PROBE_HOSTS=ok\n${key}=x\n`)
      expect(out).toStartWith('code=78 probe= ')
      expect(err).toContain(key)
    }
    // A key that is a name of the parser's own is refused as unlisted, before anything is evaluated.
    const { out } = load(`lineno=a[$(touch ${marker})0]\nFACTORY_PROBE_HOSTS=a=b\n`)
    expect(out).toStartWith('code=78')
    expect(existsSync(marker)).toBe(false)
  })

  test('a symlink, a dangling one included, is not the file', () => {
    const real = join(dir, 'real')
    writeFileSync(real, 'FACTORY_PROBE_HOSTS=a=b\n')
    chmodSync(real, 0o600)
    rmSync(join(dir, 'link'), { force: true })
    symlinkSync(real, join(dir, 'link'))
    expect(loadPath(join(dir, 'link')).out).toStartWith('code=78')
    rmSync(join(dir, 'dangling'), { force: true })
    symlinkSync(join(dir, 'nowhere'), join(dir, 'dangling'))
    expect(loadPath(join(dir, 'dangling')).out).toStartWith('code=78')
  })

  test('launch.sh refuses the start with exit 78 on a bad file, before it asks for any secret', () => {
    const bin = join(dir, '.local', 'bin')
    mkdirSync(bin, { recursive: true })
    const asked = join(dir, 'asked')
    // A secrets-run that records it was called: it must not be.
    writeFileSync(join(bin, 'secrets-run'), `#!/bin/sh\ntouch ${asked}\nexit 0\n`)
    chmodSync(join(bin, 'secrets-run'), 0o755)
    const file = join(dir, 'launch-env')
    writeFileSync(file, 'FACTORY_TOKEN=x\n')
    chmodSync(file, 0o600)
    const run = Bun.spawnSync(['bash', join(SCRIPT, '..', 'launch.sh')], {
      env: { PATH: process.env.PATH ?? '', HOME: dir, FACTORY_ENV_FILE: file },
      stdout: 'pipe',
      stderr: 'pipe',
    })
    expect(run.exitCode).toBe(78)
    expect(run.stderr.toString()).toContain('sets FACTORY_TOKEN, which this file does not take')
    expect(existsSync(asked)).toBe(false)
    // A path set on purpose that is not there refuses too.
    const typo = Bun.spawnSync(['bash', join(SCRIPT, '..', 'launch.sh')], {
      env: { PATH: process.env.PATH ?? '', HOME: dir, FACTORY_ENV_FILE: join(dir, 'nowhere') },
      stdout: 'pipe',
      stderr: 'pipe',
    })
    expect(typo.exitCode).toBe(78)
    expect(typo.stderr.toString()).toContain('does not exist')
  })
})
