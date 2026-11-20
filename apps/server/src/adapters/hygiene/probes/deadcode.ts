import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { EXIT_TIMEOUT } from '../../process.ts'
import { exec, gitOut, type Tools } from '../git.ts'
import { type Outcome, clean, failed, finding, found, skipped, unjudging } from './finding.ts'
import { execKeepingStderr, firstLine, installed } from './toolrun.ts'

// Verified against fallow 3.38.1 (`fallow dead-code --format json`, JSON schema_version 10) and bun 1.4.2.
// Exit codes: 0 no error-severity issue, 1 issues found (the report is on stdout), 2 an error (`{"error":true,"message":...}`
// on stdout). Without node_modules fallow still runs but says its analysis is degraded (dependencies can be misreported).

const INSTALL_TIMEOUT_MS = 10 * 60_000
const FALLOW_TIMEOUT_MS = 10 * 60_000

export interface DeadCode {
  files: string[]
  /** `path:line name` */
  exports: string[]
  /** package names, from dependencies, devDependencies and optionalDependencies */
  deps: string[]
}

/** The report of `fallow dead-code --format json`, or an `error` string for fallow's own error document or anything else. */
export function parseFallow(stdout: string): DeadCode | { error: string } {
  let json: unknown
  try {
    json = JSON.parse(stdout)
  } catch {
    return { error: 'no JSON on stdout' }
  }
  if (typeof json !== 'object' || json === null) return { error: 'no JSON object on stdout' }
  const doc = json as Record<string, unknown>
  if (doc.error === true) return { error: typeof doc.message === 'string' ? doc.message : 'fallow reported an error' }
  if (doc.kind !== 'dead-code') return { error: 'not a fallow dead-code report' }
  const list = (key: string): Record<string, unknown>[] =>
    Array.isArray(doc[key])
      ? (doc[key] as unknown[]).filter((x): x is Record<string, unknown> => typeof x === 'object' && x !== null)
      : []
  const text = (value: unknown): string => (typeof value === 'string' ? value : '')
  const exportRows = list('unused_exports')
    .map((row) => ({
      path: text(row.path),
      line: typeof row.line === 'number' ? row.line : 0,
      name: text(row.export_name),
    }))
    .sort((a, b) => a.path.localeCompare(b.path) || a.line - b.line || a.name.localeCompare(b.name))
  const deps = [
    ...list('unused_dependencies'),
    ...list('unused_dev_dependencies'),
    ...list('unused_optional_dependencies'),
  ]
    .map((row) => text(row.package_name))
    .filter(Boolean)
  return {
    files: list('unused_files')
      .map((row) => text(row.path))
      .filter(Boolean)
      .sort(),
    exports: exportRows.map((row) => `${row.path}:${row.line} ${row.name}`),
    deps: [...new Set(deps)].sort(),
  }
}

/** Every directory of the checkout with a package.json ('.' is the root), vendored copies left out. */
function packageDirs(tracked: string[]): string[] {
  const dirs = tracked
    .filter(
      (file) =>
        (file === 'package.json' || file.endsWith('/package.json')) && !file.split('/').includes('node_modules'),
    )
    .map((file) => dirname(file))
  return [...new Set(dirs)].sort()
}

/** A lockfile at this directory or any ancestor: a workspace member is installed by the root's install. */
function lockfileAbove(tracked: string[], dir: string): boolean {
  for (let at = dir; ; at = dirname(at)) {
    if (tracked.includes(at === '.' ? 'bun.lock' : `${at}/bun.lock`)) return true
    if (at === '.') return false
  }
}

export async function deadcodeProbe(tools: Tools, path: string): Promise<Outcome> {
  const tracked = (await gitOut(tools, path, ['ls-files', '-z'])).split('\0')
  if (!tracked.includes('package.json')) return skipped('no package.json')
  if (!installed(tools.fallow)) return skipped('fallow is not installed on this host')

  const notes: string[] = []
  let depsAreReliable = true
  // fallow misreports the dependencies of a package whose node_modules is missing, so every package directory is installed
  for (const dir of packageDirs(tracked)) {
    if (existsSync(join(path, dir, 'node_modules'))) continue
    const at = dir === '.' ? '' : ` in ${dir}`
    if (!tracked.includes(dir === '.' ? 'bun.lock' : `${dir}/bun.lock`)) {
      if (lockfileAbove(tracked, dir)) continue
      depsAreReliable = false
      notes.push(`no bun.lock and no node_modules${at}: unused dependencies are not reported`)
      continue
    }
    const install = await exec([tools.bun, 'install', '--frozen-lockfile'], INSTALL_TIMEOUT_MS, join(path, dir))
    if (install.exitCode === EXIT_TIMEOUT)
      return failed(`bun install did not finish in ${INSTALL_TIMEOUT_MS / 60_000} min`)
    if (install.exitCode !== 0) return failed(`bun install --frozen-lockfile failed${at} (exit ${install.exitCode})`)
    notes.push(`ran bun install --frozen-lockfile${at}`)
  }

  const result = await execKeepingStderr(
    [tools.fallow, 'dead-code', '--format', 'json', '--quiet', '--no-cache'],
    FALLOW_TIMEOUT_MS,
    path,
  )
  if (result.exitCode === EXIT_TIMEOUT) return failed(`fallow did not finish in ${FALLOW_TIMEOUT_MS / 60_000} min`)
  // 1 means issues were found and the report is on stdout: the JSON decides, not the exit code
  const report = parseFallow(result.stdout)
  if ('error' in report || (result.exitCode !== 0 && result.exitCode !== 1)) {
    const reason = firstLine(result.stderr) || ('error' in report ? report.error : `exit ${result.exitCode}`)
    return failed(`fallow failed (exit ${result.exitCode}): ${reason}`)
  }

  const reproduce = 'fallow dead-code --format json'
  const kinds = [
    { key: 'files', title: 'Hygiene: unused files', all: report.files, lines: report.files },
    { key: 'exports', title: 'Hygiene: unused exports', all: report.exports, lines: report.exports },
    ...(depsAreReliable
      ? [{ key: 'deps', title: 'Hygiene: unused dependencies', all: report.deps, lines: report.deps }]
      : []),
  ]
  const findings = kinds
    .filter((kind) => kind.all.length)
    .map((kind) => ({
      ...finding('deadcode', `deadcode:${kind.key}`, kind.title, kind.lines.slice(0, 8), kind.all.length),
      reproduce,
    }))
  const detail = notes.length ? ` (${notes.join('; ')})` : ''
  // without installed packages the unused-dependency kind is not judged: it is not green for want of a finding
  const unjudged = depsAreReliable ? [] : ['deadcode:deps']
  if (!findings.length) return unjudging(clean(`fallow dead-code: nothing unused${detail}`), unjudged)
  return unjudging(
    found(
      `fallow dead-code: ${findings.map((f) => `${f.count} unused ${f.key.replace('deadcode:', '')}`).join(', ')}${detail}`,
      findings,
    ),
    unjudged,
  )
}
