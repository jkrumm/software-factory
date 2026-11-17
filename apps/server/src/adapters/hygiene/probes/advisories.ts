import { readFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { EXIT_TIMEOUT } from '../../hc/process.ts'
import { gitOut, type Tools } from '../git.ts'
import { type Outcome, clean, failed, finding, found, skipped } from './finding.ts'
import { execKeepingStderr, firstLine, installed } from './toolrun.ts'

// Verified against bun 1.4.2 / 1.4.4 (`bun audit --json`) and osv-scanner 2.7.1 (`scan source -L <lockfile> --format json`).

const AUDIT_TIMEOUT_MS = 120_000
const MAX_BUN_LOCKS = 5
const MAX_OSV_LOCKS = 20
const OSV_NAMES = new Set(['Cargo.lock', 'uv.lock', 'poetry.lock', 'Package.resolved'])
/** A requirements line that pins a version: `name==1.2.3`, extras allowed. */
const PINNED = /^[A-Za-z0-9][A-Za-z0-9._-]*(\[[^\]]*\])?\s*==/m

export interface Advisory {
  pkg: string
  /** the installed version (osv), or the vulnerable range (`bun audit --json` names no installed version) */
  version: string
  id: string
  severity: 'critical' | 'high'
  fixedIn?: string
}

const RANK = { critical: 0, high: 1 }

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/**
 * `bun audit --json`: an object `{ <package>: [{ id, url, title, severity, vulnerable_versions, ... }] }`; `{}` when clean.
 * `--audit-level` only changes the exit code, never the JSON, so the filter to high and critical is made here. The fixed version
 * is the exclusive upper bound of a `<x.y.z` range; any other range names none. Undefined: not that document.
 */
export function parseBunAudit(stdout: string): Advisory[] | undefined {
  let json: unknown
  try {
    json = JSON.parse(stdout)
  } catch {
    return undefined
  }
  if (!isRecord(json)) return undefined
  const advisories: Advisory[] = []
  for (const [pkg, list] of Object.entries(json)) {
    if (!Array.isArray(list)) continue
    for (const entry of list) {
      if (!isRecord(entry)) continue
      const severity = entry.severity
      if (severity !== 'high' && severity !== 'critical') continue
      const range = typeof entry.vulnerable_versions === 'string' ? entry.vulnerable_versions : ''
      const url = typeof entry.url === 'string' ? entry.url : ''
      advisories.push({
        pkg,
        version: range || '(any version)',
        id: url.split('/').pop() || String(entry.id ?? 'unknown'),
        severity,
        fixedIn: /(?:^|\s)<([0-9][^\s]*)$/.exec(range)?.[1],
      })
    }
  }
  return sorted(advisories)
}

const sorted = (advisories: Advisory[]): Advisory[] =>
  advisories.sort(
    (a, b) => RANK[a.severity] - RANK[b.severity] || a.pkg.localeCompare(b.pkg) || a.id.localeCompare(b.id),
  )

const numericParts = (version: string): number[] =>
  version
    .split(/[.+-]/)
    .map((part) => Number.parseInt(part, 10))
    .filter((n) => !Number.isNaN(n))

function compareVersions(a: string, b: string): number {
  const [x, y] = [numericParts(a), numericParts(b)]
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const diff = (x[i] ?? 0) - (y[i] ?? 0)
    if (diff) return diff
  }
  return 0
}

/** The lowest fixed version above the installed one (osv lists one per affected branch), else the first listed. */
function fixedAbove(installedVersion: string, fixes: string[]): string | undefined {
  const above = fixes.filter((fix) => compareVersions(fix, installedVersion) > 0).sort(compareVersions)
  return above[0] ?? fixes[0]
}

function severityOf(score: string, labels: string[]): Advisory['severity'] | undefined {
  const cvss = Number.parseFloat(score)
  if (cvss >= 9 || labels.includes('CRITICAL')) return 'critical'
  if (cvss >= 7 || labels.includes('HIGH')) return 'high'
  return undefined
}

/**
 * `osv-scanner scan source -L <lockfile> --format json`: `results[].packages[]` with the package, its `vulnerabilities[]` (OSV
 * records) and `groups[]` (advisories that are aliases of one another, with `ids` and `max_severity`, the highest CVSS base score as
 * a string, `""` when none is known). Severity is the group's score (7.0 high, 9.0 critical) or a GitHub label (`HIGH`,
 * `CRITICAL`) in `database_specific.severity` of one of its records; a group with neither is unscored and not counted. Undefined:
 * not that document.
 */
export function parseOsv(stdout: string): Advisory[] | undefined {
  let json: unknown
  try {
    json = JSON.parse(stdout)
  } catch {
    return undefined
  }
  if (!isRecord(json) || !Array.isArray(json.results)) return undefined
  const advisories: Advisory[] = []
  for (const result of json.results) {
    for (const entry of isRecord(result) && Array.isArray(result.packages) ? result.packages : []) {
      if (!isRecord(entry) || !isRecord(entry.package)) continue
      const { name, version } = entry.package
      if (typeof name !== 'string' || typeof version !== 'string') continue
      const records = (Array.isArray(entry.vulnerabilities) ? entry.vulnerabilities : []).filter(isRecord)
      for (const group of Array.isArray(entry.groups) ? entry.groups : []) {
        if (!isRecord(group) || !Array.isArray(group.ids)) continue
        const ids = group.ids.filter((id): id is string => typeof id === 'string')
        const own = records.filter((record) => typeof record.id === 'string' && ids.includes(record.id))
        const labels = own.map((record) =>
          isRecord(record.database_specific) && typeof record.database_specific.severity === 'string'
            ? record.database_specific.severity.toUpperCase()
            : '',
        )
        const severity = severityOf(typeof group.max_severity === 'string' ? group.max_severity : '', labels)
        if (!severity || !ids[0]) continue
        const fixes = own.flatMap((record) =>
          (Array.isArray(record.affected) ? record.affected : []).flatMap((affected: unknown) =>
            isRecord(affected) && Array.isArray(affected.ranges)
              ? affected.ranges.flatMap((range: unknown) =>
                  isRecord(range) && Array.isArray(range.events)
                    ? range.events.flatMap((event: unknown) =>
                        isRecord(event) && typeof event.fixed === 'string' ? [event.fixed] : [],
                      )
                    : [],
                )
              : [],
          ),
        )
        advisories.push({ pkg: name, version, id: ids[0], severity, fixedIn: fixedAbove(version, fixes) })
      }
    }
  }
  return sorted(advisories)
}

export const evidence = (advisory: Advisory): string =>
  `${advisory.pkg} ${advisory.version}: ${advisory.id} ${advisory.severity} (${advisory.fixedIn ? `fixed in ${advisory.fixedIn}` : 'no fixed version'})`

type Part = { kind: 'ran'; advisories: Advisory[]; note?: string } | { kind: 'failed' | 'skipped'; reason: string }

async function bunPart(tools: Tools, path: string, locks: string[]): Promise<Part> {
  const advisories: Advisory[] = []
  for (const lock of locks.slice(0, MAX_BUN_LOCKS)) {
    const result = await execKeepingStderr(
      [tools.bun, 'audit', '--json', '--audit-level=high'],
      AUDIT_TIMEOUT_MS,
      join(path, dirname(lock)),
    )
    if (result.exitCode === EXIT_TIMEOUT)
      return { kind: 'failed', reason: `bun audit did not finish in ${AUDIT_TIMEOUT_MS / 1000} s` }
    // exit 1 is both "advisories found" and "could not reach the registry": only a JSON document tells them apart
    const parsed = parseBunAudit(result.stdout)
    if (!parsed) {
      return {
        kind: 'failed',
        reason: `bun audit failed (exit ${result.exitCode}): ${firstLine(result.stderr) || 'no JSON on stdout'}`,
      }
    }
    advisories.push(...parsed)
  }
  return { kind: 'ran', advisories: sorted(advisories) }
}

async function osvPart(tools: Tools, path: string, lockfiles: string[]): Promise<Part> {
  if (!installed(tools.osv)) return { kind: 'skipped', reason: 'osv-scanner is not installed on this host' }
  const args = lockfiles.slice(0, MAX_OSV_LOCKS).flatMap((lock) => ['-L', lock])
  const result = await execKeepingStderr(
    [tools.osv, 'scan', 'source', ...args, '--format', 'json'],
    AUDIT_TIMEOUT_MS,
    path,
  )
  if (result.exitCode === EXIT_TIMEOUT)
    return { kind: 'failed', reason: `osv-scanner did not finish in ${AUDIT_TIMEOUT_MS / 1000} s` }
  // 0: nothing found, 1: vulnerabilities found, 128: no packages in the files; 127 and the rest are usage or network errors
  if (result.exitCode === 128) return { kind: 'ran', advisories: [] }
  const parsed = result.exitCode === 0 || result.exitCode === 1 ? parseOsv(result.stdout) : undefined
  if (!parsed) {
    const why = firstLine(
      result.stderr
        .split('\n')
        .filter((line) => /error|failed/i.test(line))
        .join('\n'),
    )
    return { kind: 'failed', reason: `osv-scanner failed (exit ${result.exitCode})${why ? `: ${why}` : ''}` }
  }
  return { kind: 'ran', advisories: parsed }
}

/** The tracked files the osv part scans: the lockfile kinds it reads, and requirements files that pin a version with `==`. */
function osvLockfiles(path: string, files: string[]): string[] {
  return files.filter((file) => {
    const name = basename(file)
    if (OSV_NAMES.has(name)) return true
    if (!/^requirements.*\.txt$/.test(name)) return false
    try {
      return PINNED.test(readFileSync(join(path, file), 'utf8'))
    } catch {
      return false
    }
  })
}

export async function advisoriesProbe(tools: Tools, path: string): Promise<Outcome> {
  const files = (await gitOut(tools, path, ['ls-files', '-z'])).split('\0').filter(Boolean)
  const bunLocks = files.filter((file) => basename(file) === 'bun.lock')
  const osvLocks = osvLockfiles(path, files)
  if (!bunLocks.length && !osvLocks.length) return skipped('no supported lockfile is tracked')

  const parts: Array<{ name: string; part: Part }> = []
  if (bunLocks.length) parts.push({ name: 'bun', part: await bunPart(tools, path, bunLocks) })
  if (osvLocks.length) parts.push({ name: 'osv', part: await osvPart(tools, path, osvLocks) })

  const ran = parts.flatMap(({ name, part }) => (part.kind === 'ran' ? [{ name, advisories: part.advisories }] : []))
  const notes = parts.flatMap(({ name, part }) => (part.kind === 'ran' ? [] : [`${name}: ${part.reason}`]))
  const suffix = notes.length ? ` (${notes.join('; ')})` : ''
  if (!ran.length) {
    const anyFailed = parts.some(({ part }) => part.kind === 'failed')
    return anyFailed
      ? failed(notes.join('; '))
      : skipped(parts.flatMap(({ part }) => (part.kind === 'skipped' ? [part.reason] : [])).join('; '))
  }

  const findings = ran.flatMap(({ name, advisories }) => {
    if (!advisories.length) return []
    return name === 'bun'
      ? [
          {
            ...finding(
              'advisories',
              'advisories:bun',
              'Hygiene: security advisories in Bun dependencies',
              advisories.map(evidence),
              advisories.length,
            ),
            reproduce: 'bun audit --audit-level=high',
          },
        ]
      : [
          {
            ...finding(
              'advisories',
              'advisories:osv',
              'Hygiene: security advisories in the lockfiles',
              advisories.map(evidence),
              advisories.length,
            ),
            reproduce: `osv-scanner scan source ${osvLocks.map((lock) => `-L ${lock}`).join(' ')}`,
          },
        ]
  })
  const checked = ran.map(({ name }) => name).join(' and ')
  if (!findings.length) return clean(`no high or critical advisories (${checked})${suffix}`)
  const total = findings.reduce((sum, item) => sum + item.count, 0)
  return found(`${total} high or critical advisories (${checked})${suffix}`, findings)
}
