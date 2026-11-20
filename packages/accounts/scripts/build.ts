#!/usr/bin/env bun
// The self-contained build: one file that runs with bun and nothing else (no node_modules, no checkout), for a machine
// that has no factory (packages/accounts/docs/accounts.md §Installing). `bun packages/accounts/scripts/build.ts [outfile]`, default
// packages/accounts/dist/claude-account. The commit it prints for --version is HEAD, or $BUILD_COMMIT.
import { chmodSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

const root = resolve(import.meta.dir, '..')
const outfile = resolve(process.argv[2] ?? join(root, 'dist', 'claude-account'))

const gitHead = () => {
  const r = Bun.spawnSync(['git', '-C', root, 'rev-parse', '--short=12', 'HEAD'], { stdout: 'pipe', stderr: 'ignore' })
  return r.exitCode === 0 ? r.stdout.toString().trim() : 'unknown'
}
const commit = process.env.BUILD_COMMIT || gitHead()

const built = await Bun.build({
  entrypoints: [join(root, 'bin', 'claude-account.ts')],
  target: 'bun',
  outdir: dirname(outfile),
  naming: '[name].tmp.js',
  define: { BUILD_COMMIT: JSON.stringify(commit) },
})
if (!built.success) {
  for (const m of built.logs) console.error(String(m))
  process.exit(1)
}
const tmp = built.outputs[0]?.path
if (!tmp) throw new Error('the build produced no file')
await Bun.write(outfile, Bun.file(tmp))
await Bun.file(tmp).delete()
chmodSync(outfile, 0o755)
console.log(`${outfile} (${commit})`)
