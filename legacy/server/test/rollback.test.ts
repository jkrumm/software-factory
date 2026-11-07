import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const SCRIPT = join(import.meta.dir, '../../../scripts/deploy.sh')
const TEMPLATE = join(import.meta.dir, '../../../deploy/com.jkrumm.software-factory.plist.template')
const LIVE = 'a'.repeat(40)
const PREV = 'b'.repeat(40)

let home: string
let root: string

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'rollback-'))
  root = join(home, '.software-factory')
  mkdirSync(join(root, 'data'), { recursive: true })
})
afterEach(() => rmSync(home, { recursive: true, force: true }))

/** A release on disk the way build_release leaves it: the plist template and the `.complete` marker. */
function release(sha: string, complete = true): void {
  const dir = join(root, 'releases', sha)
  mkdirSync(join(dir, 'deploy'), { recursive: true })
  writeFileSync(join(dir, 'deploy/com.jkrumm.software-factory.plist.template'), readFileSync(TEMPLATE))
  if (complete) writeFileSync(join(dir, '.complete'), '')
}

function rollback(extra: Record<string, string> = {}) {
  const run = Bun.spawnSync(['/bin/bash', SCRIPT, 'rollback'], {
    env: { ...process.env, HOME: home, FACTORY_ROOT: root, DRY_RUN: '1', ...extra },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  return { code: run.exitCode, out: run.stdout.toString(), err: run.stderr.toString() }
}

const tree = (dir: string): string[] =>
  readdirSync(dir, { recursive: true, withFileTypes: true }).map((e) => join(e.parentPath, e.name))

describe('make rollback (DRY_RUN=1)', () => {
  test('prints the plan from the previous release and changes nothing', () => {
    release(LIVE)
    release(PREV)
    writeFileSync(join(root, 'data/deployed-sha'), `${LIVE}\n`)
    writeFileSync(join(root, 'data/previous-sha'), `${PREV}\n`)
    const before = tree(home).sort()
    const { code, out, err } = rollback()
    expect(err).toBe('')
    expect(code).toBe(0)
    expect(out).toContain(`would roll back ${LIVE} -> ${PREV.slice(0, 12)}`)
    expect(out).toContain(`${root}/releases/${PREV}`)
    expect(out).toContain(`wait up to`)
    expect(out).toContain(`version ${PREV}`)
    expect(out).toContain(`write ${root}/data/deployed-sha (${PREV}) and ${root}/data/previous-sha (${LIVE})`)
    expect(tree(home).sort()).toEqual(before)
    expect(readFileSync(join(root, 'data/deployed-sha'), 'utf8')).toBe(`${LIVE}\n`)
    expect(existsSync(join(root, 'current'))).toBe(false)
  })

  test('refuses with one line and exit 1 when no previous release is recorded', () => {
    release(LIVE)
    writeFileSync(join(root, 'data/deployed-sha'), `${LIVE}\n`)
    const { code, err } = rollback()
    expect(code).toBe(1)
    expect(err.trim().split('\n')).toHaveLength(1)
    expect(err).toContain('no previous release recorded')
  })

  test('refuses when the previous release is not on disk, or half built', () => {
    release(LIVE)
    writeFileSync(join(root, 'data/deployed-sha'), `${LIVE}\n`)
    writeFileSync(join(root, 'data/previous-sha'), `${PREV}\n`)
    expect(rollback()).toMatchObject({ code: 1, err: expect.stringContaining('not on disk') })
    release(PREV, false)
    expect(rollback()).toMatchObject({ code: 1, err: expect.stringContaining('not on disk') })
  })

  test('refuses a previous-sha that is no sha, and one that is the live release', () => {
    release(LIVE)
    writeFileSync(join(root, 'data/deployed-sha'), `${LIVE}\n`)
    writeFileSync(join(root, 'data/previous-sha'), '../../etc\n')
    expect(rollback()).toMatchObject({ code: 1, err: expect.stringContaining('40-hex') })
    writeFileSync(join(root, 'data/previous-sha'), `${LIVE}\n`)
    expect(rollback()).toMatchObject({ code: 1, err: expect.stringContaining('is the live one') })
  })
})
