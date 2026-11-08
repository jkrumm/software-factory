import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { EXIT_TIMEOUT } from '../../hc/process.ts'
import { exec, type Tools } from '../git.ts'
import { type Outcome, clean, failed, finding, found, skipped } from './finding.ts'

const INSTALL_TIMEOUT_MS = 10 * 60_000
const OUTDATED_TIMEOUT_MS = 120_000

export interface OutdatedRow {
  name: string
  current: string
  latest: string
  /** the latest is not the true latest: the release-age cooldown holds it back */
  heldBack: boolean
}

/** Rows of the `| Package | Current | Update | Latest |` table of `bun outdated`; separators and the header are skipped. */
export function parseOutdated(output: string): OutdatedRow[] {
  const rows: OutdatedRow[] = []
  for (const line of output.split('\n')) {
    if (!line.startsWith('|') || line.startsWith('|-')) continue
    const cells = line
      .split('|')
      .slice(1, -1)
      .map((cell) => cell.trim())
    const [name, current, , latest] = cells
    if (cells.length < 4 || !name || !current || !latest || name === 'Package') continue
    rows.push({
      name: name.replace(/\s*\(dev\)$/, ''),
      current: current.replace(/\s*\*$/, ''),
      latest: latest.replace(/\s*\*$/, ''),
      heldBack: latest.endsWith('*'),
    })
  }
  return rows
}

type Severity = 'major' | 'minor' | 'patch'
const SEVERITIES: Severity[] = ['major', 'minor', 'patch']

export function severity(current: string, latest: string): Severity {
  const [a = [], b = []] = [current, latest].map((v) => v.split(/[.+-]/).map((part) => Number.parseInt(part, 10)))
  if (a[0] !== b[0]) return 'major'
  return a[1] !== b[1] ? 'minor' : 'patch'
}

export async function depsProbe(tools: Tools, path: string): Promise<Outcome> {
  if (!existsSync(join(path, 'package.json'))) return skipped('no package.json')
  if (!existsSync(join(path, 'node_modules'))) {
    const install = await exec([tools.bun, 'install', '--frozen-lockfile'], INSTALL_TIMEOUT_MS, path)
    if (install.exitCode !== 0) {
      return failed(
        install.exitCode === EXIT_TIMEOUT
          ? `bun install did not finish in ${INSTALL_TIMEOUT_MS / 60_000} min`
          : `bun install --frozen-lockfile failed (exit ${install.exitCode})`,
      )
    }
  }
  const result = await exec([tools.bun, 'outdated'], OUTDATED_TIMEOUT_MS, path)
  if (result.exitCode === EXIT_TIMEOUT) return failed(`bun outdated did not finish in ${OUTDATED_TIMEOUT_MS / 1000} s`)
  if (result.exitCode !== 0) return failed(`bun outdated failed (exit ${result.exitCode})`)
  const outdated = parseOutdated(result.stdout)
    .filter((row) => row.current !== row.latest)
    .map((row) => ({ ...row, severity: severity(row.current, row.latest) }))
    .sort((a, b) => SEVERITIES.indexOf(a.severity) - SEVERITIES.indexOf(b.severity) || a.name.localeCompare(b.name))
  if (!outdated.length) return clean('bun outdated: everything is at its latest')
  const lines = outdated.map(
    (row) =>
      `${row.name} ${row.current} -> ${row.latest} (${row.severity})${row.heldBack ? ', held back by the release-age cooldown' : ''}`,
  )
  return found(`bun outdated, ${outdated.length} packages`, [
    finding('deps', 'deps', 'Hygiene: outdated dependencies', lines, outdated.length),
  ])
}
