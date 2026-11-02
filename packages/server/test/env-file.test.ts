import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { chmodSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const SCRIPT = join(import.meta.dir, '..', '..', '..', 'scripts', 'env-file.sh')
let dir: string
let tpl: string

beforeAll(() => {
  dir = mkdtempSync('/tmp/factory-envfile-')
  tpl = join(dir, '.env.tpl')
  writeFileSync(tpl, 'FACTORY_TOKEN=op://x/y/z\nFACTORY_DB_PASSWORD=op://x/y/w\n')
})
afterAll(() => rmSync(dir, { recursive: true, force: true }))

/** load_env_file in a fresh bash, then print what it left in the environment. */
function load(content: string | undefined, mode = 0o600, name = 'env') {
  const file = join(dir, name)
  rmSync(file, { force: true })
  if (content !== undefined) {
    writeFileSync(file, content)
    chmodSync(file, mode)
  }
  const run = Bun.spawnSync(
    [
      'bash',
      '-c',
      `source "${SCRIPT}"; load_env_file "${file}" "${tpl}"; code=$?; echo "code=$code probe=\${FACTORY_PROBE_HOSTS-} other=\${OTHER-}"`,
    ],
    { env: { PATH: process.env.PATH ?? '', HOME: dir }, stdout: 'pipe', stderr: 'pipe' },
  )
  return { out: run.stdout.toString().trim(), err: run.stderr.toString().trim() }
}

describe('scripts/env-file.sh', () => {
  test('no file is no settings', () => {
    expect(load(undefined).out).toBe('code=0 probe= other=')
  })

  test('KEY=VALUE lines, comments and blank lines are applied as they are, nothing evaluated', () => {
    const { out } = load(
      '# the machines a probe may look at\n\nFACTORY_PROBE_HOSTS=macbook=mac,mini=local\nOTHER=$(touch /tmp/never) `x` $HOME\n',
    )
    expect(out).toBe('code=0 probe=macbook=mac,mini=local other=$(touch /tmp/never) `x` $HOME')
  })

  test('a mode other than 0600 refuses', () => {
    const { out, err } = load('FACTORY_PROBE_HOSTS=a=b\n', 0o644)
    expect(out).toStartWith('code=78 probe=')
    expect(err).toContain('mode 0600')
  })

  test('a line that is not KEY=VALUE refuses, naming the line and not its text', () => {
    const { out, err } = load('FACTORY_PROBE_HOSTS=a=b\nexport OTHER=1\n')
    expect(out).toStartWith('code=78')
    expect(err).toContain('line 2')
    expect(err).not.toContain('export OTHER')
  })

  test('a secret or a key .env.tpl owns refuses', () => {
    for (const key of ['FACTORY_TOKEN', 'FACTORY_DB_PASSWORD', 'DATABASE_URL']) {
      const { out, err } = load(`${key}=x\n`)
      expect(out).toStartWith('code=78')
      expect(err).toContain(key)
    }
  })

  test('a symlink is not the file', () => {
    const real = join(dir, 'real')
    writeFileSync(real, 'OTHER=1\n')
    chmodSync(real, 0o600)
    rmSync(join(dir, 'link'), { force: true })
    symlinkSync(real, join(dir, 'link'))
    const run = Bun.spawnSync(
      ['bash', '-c', `source "${SCRIPT}"; load_env_file "${join(dir, 'link')}" "${tpl}"; echo "code=$?"`],
      {
        stdout: 'pipe',
        stderr: 'pipe',
      },
    )
    expect(run.stdout.toString().trim()).toBe('code=78')
  })
})
