import { expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const run = (cmd: string[], env: Record<string, string>, cwd: string) => {
  const r = Bun.spawnSync(cmd, { env, cwd, stdout: 'pipe', stderr: 'pipe' })
  return { rc: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() }
}

test('the single-file build runs on its own: no checkout, no node_modules, the commit it was built from', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ca-bundle-'))
  try {
    const out = join(dir, 'dist', 'claude-account')
    const built = run(
      ['bun', join(import.meta.dir, '..', 'scripts', 'build.ts'), out],
      { ...(process.env as Record<string, string>), BUILD_COMMIT: 'abc123def456' },
      dir,
    )
    expect(built.rc, built.err).toBe(0)
    // a directory that holds nothing of the repo, and an environment that only knows where bun is
    const work = join(dir, 'elsewhere')
    mkdirSync(work)
    const registry = join(dir, 'registry.json')
    writeFileSync(
      registry,
      JSON.stringify({ accounts: { solo: { dir: null, plan: 'max', homeLanes: ['interactive'], enabled: true } } }),
    )
    const env = {
      PATH: process.env.PATH ?? '',
      HOME: join(dir, 'home'),
      CLAUDE_ACCOUNTS_REGISTRY: registry,
      CLAUDE_ACCOUNTS_CACHE_DIR: join(dir, 'cache'),
    }
    const v = run([out, '--version'], env, work)
    expect(v).toMatchObject({ rc: 0, out: '@software-factory/accounts 0.1.0 (abc123def456)\n' })
    const u = run([out, 'usage', '--json'], env, work)
    expect(u.rc).toBe(0)
    expect(JSON.parse(u.out)).toMatchObject({ default_account: 'solo', accounts: [{ id: 'solo', plan: 'max' }] })
    expect(run([out, 'pick', '--lane', 'interactive', '--dry'], env, work)).toMatchObject({ rc: 0 })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}, 60_000)

test('--version names the package and a commit also from the checkout', () => {
  const r = run(
    ['bun', join(import.meta.dir, '..', 'bin', 'claude-account.ts'), '--version'],
    process.env as Record<string, string>,
    tmpdir(),
  )
  expect(r.rc).toBe(0)
  expect(r.out).toMatch(/^@software-factory\/accounts \d+\.\d+\.\d+ \(([0-9a-f]{7,40}|unknown)\)\n$/)
})
