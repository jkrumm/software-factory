// `claude-account --version`: the package and the commit it was built from.
import { spawnSync } from 'node:child_process'
import { dirname } from 'node:path'
import pkg from '../package.json' with { type: 'json' }

/** Set by `bun build --define BUILD_COMMIT=...` in the single-file build (scripts/build.ts). */
declare const BUILD_COMMIT: string | undefined

const SHA = /^[0-9a-f]{40}$/

/** Build constant, else the release directory the file runs from (`releases/<sha>/…`, how the deploy installs it), else the checkout's HEAD, else "unknown". */
export function commit(entry = import.meta.path): string {
  if (typeof BUILD_COMMIT === 'string' && BUILD_COMMIT) return BUILD_COMMIT
  const release = /\/releases\/([0-9a-f]{40})\//.exec(entry)?.[1]
  if (release) return release.slice(0, 12)
  const r = spawnSync('git', ['-C', dirname(entry), 'rev-parse', '--short=12', 'HEAD'], {
    encoding: 'utf8',
    timeout: 5_000,
  })
  const sha = r.status === 0 ? r.stdout.trim() : ''
  return SHA.test(sha) || /^[0-9a-f]{7,40}$/.test(sha) ? sha : 'unknown'
}

export const versionLine = (entry?: string) => `${pkg.name} ${pkg.version} (${commit(entry)})`
