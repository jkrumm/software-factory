import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { EXIT_TIMEOUT } from '../../hc/process.ts'
import { exec, gitOut, type Tools } from '../git.ts'
import type { ProbeFinding } from '../../../domains/loops/hygiene-model.ts'
import { type Outcome, clean, failed, finding, found, skipped, unjudging } from './finding.ts'

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

// ---- the other ecosystems: package files are read here, the registry look-ups are one injectable function ----

export type Ecosystem = 'cargo' | 'python' | 'swift' | 'docker' | 'actions'

/** One declared dependency. `name` is the registry name, a git url (Swift), `owner/repo` (Actions) or an image; `current` its lower bound. */
export interface Dependency {
  name: string
  current: string
}

/** The newest version of a dependency, or undefined / a throw when it cannot be looked up (soft: counted, never a finding). */
export type Lookup = (query: { ecosystem: Ecosystem; name: string; current: string }) => Promise<string | undefined>

const ECOSYSTEMS: { ecosystem: Ecosystem; label: string; title: string }[] = [
  { ecosystem: 'cargo', label: 'Cargo', title: 'Hygiene: outdated Cargo dependencies' },
  { ecosystem: 'python', label: 'Python', title: 'Hygiene: outdated Python dependencies' },
  { ecosystem: 'swift', label: 'Swift', title: 'Hygiene: outdated Swift dependencies' },
  { ecosystem: 'docker', label: 'Docker', title: 'Hygiene: outdated Docker base images' },
  { ecosystem: 'actions', label: 'GitHub Actions', title: 'Hygiene: outdated GitHub Actions' },
]

const MAX_LOOKUPS = 40
const CONCURRENCY = 8
const LOOKUP_TIMEOUT_MS = 15_000
const USER_AGENT = 'software-factory-hygiene'

/** The numeric lower bound of a version requirement (`^1.2`, `1.2`, `>=1.2,<2`, `~=1.2`); undefined for `*`, `<2` or no digits. */
export function lowerBound(requirement: string): string | undefined {
  for (const part of requirement.split(',')) {
    const bit = part.trim()
    if (bit.startsWith('<') || bit.startsWith('!=')) continue
    const match = /^[~^=>\s]*v?(\d+(?:\.\d+)*)/.exec(bit)
    if (match?.[1]) return match[1]
  }
  return undefined
}

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined

function parseToml(text: string): Record<string, unknown> | undefined {
  try {
    return asRecord(Bun.TOML.parse(text))
  } catch {
    return undefined
  }
}

const CARGO_SECTIONS = ['dependencies', 'dev-dependencies', 'build-dependencies']

/** The versioned crates.io dependencies of a `Cargo.toml`; path and git dependencies and ones without a version are left out. */
export function cargoDependencies(text: string): Dependency[] {
  const toml = parseToml(text)
  if (!toml) return []
  const tables = [
    ...CARGO_SECTIONS.map((section) => toml[section]),
    asRecord(toml.workspace)?.dependencies,
    ...Object.values(asRecord(toml.target) ?? {}).flatMap((target) =>
      CARGO_SECTIONS.map((section) => asRecord(target)?.[section]),
    ),
  ]
  const out: Dependency[] = []
  for (const table of tables) {
    for (const [key, value] of Object.entries(asRecord(table) ?? {})) {
      const spec = asRecord(value)
      const requirement = typeof value === 'string' ? value : spec?.version
      if (typeof requirement !== 'string' || spec?.path !== undefined || spec?.git !== undefined) continue
      const current = lowerBound(requirement)
      const name = typeof spec?.package === 'string' ? spec.package : key
      if (current) out.push({ name, current })
    }
  }
  return out
}

/** `name[extra]>=1.2; marker` -> the name and lower bound; a direct reference (`@ url`) or an unversioned line is left out. */
function pythonRequirement(raw: string): Dependency | undefined {
  const line = raw.split(';')[0]?.split(' #')[0]?.trim() ?? ''
  const match = /^([A-Za-z0-9][A-Za-z0-9._-]*)\s*(?:\[[^\]]*\])?\s*([<>=!~^][^@]*)$/.exec(line)
  const current = match?.[2] ? lowerBound(match[2]) : undefined
  return match?.[1] && current ? { name: match[1], current } : undefined
}

/** The dependencies of a `pyproject.toml` (PEP 621, dependency groups, Poetry) or, for a `requirements*.txt`, its pins. */
export function pythonDependencies(text: string, file = 'pyproject.toml'): Dependency[] {
  if (!file.endsWith('.toml')) {
    return text
      .split('\n')
      .filter((line) => !line.trim().startsWith('-') && !line.includes('://'))
      .flatMap((line) => pythonRequirement(line) ?? [])
  }
  const toml = parseToml(text)
  if (!toml) return []
  const project = asRecord(toml.project)
  const poetry = asRecord(asRecord(toml.tool)?.poetry)
  const lists: unknown[] = [
    project?.dependencies,
    ...Object.values(asRecord(project?.['optional-dependencies']) ?? {}),
    ...Object.values(asRecord(toml['dependency-groups']) ?? {}),
  ]
  const out = lists.flatMap((list) =>
    (Array.isArray(list) ? list : []).flatMap((item) =>
      typeof item === 'string' ? (pythonRequirement(item) ?? []) : [],
    ),
  )
  const poetryTables = [
    poetry?.dependencies,
    ...Object.values(asRecord(poetry?.group) ?? {}).map((group) => asRecord(group)?.dependencies),
  ]
  for (const table of poetryTables) {
    for (const [name, value] of Object.entries(asRecord(table) ?? {})) {
      const requirement = typeof value === 'string' ? value : asRecord(value)?.version
      const current = typeof requirement === 'string' ? lowerBound(requirement) : undefined
      if (name !== 'python' && current) out.push({ name, current })
    }
  }
  return out
}

const SWIFT_FROM =
  /\.package\(\s*(?:name:\s*"[^"]*"\s*,\s*)?url:\s*"([^"]+)"\s*,\s*(?:from:|exact:|\.upToNext(?:Major|Minor)\(\s*from:|\.exact\()\s*"([^"]+)"/g
const SWIFT_RANGE = /\.package\(\s*(?:name:\s*"[^"]*"\s*,\s*)?url:\s*"([^"]+)"\s*,\s*"([^"]+)"\s*\.\.[.<]/g

/** The `.package(url:, from:)` dependencies of a `Package.swift` (`from`, `exact`, `upToNext...`, a range's lower end); `name` is the url. */
export function swiftPackages(text: string): Dependency[] {
  const out: Dependency[] = []
  for (const match of [...text.matchAll(SWIFT_FROM), ...text.matchAll(SWIFT_RANGE)]) {
    const current = lowerBound(match[2] ?? '')
    if (match[1] && current) out.push({ name: match[1], current })
  }
  return out
}

/** `registry/name:tag` -> `{ name, current: tag }`; `latest`, no tag, a variable or a digest-only reference is not judged. */
function imageReference(reference: string): Dependency | undefined {
  if (reference.includes('$')) return undefined
  const withoutDigest = reference.split('@')[0] ?? ''
  const slash = withoutDigest.lastIndexOf('/')
  const colon = withoutDigest.indexOf(':', slash + 1)
  if (colon < 0) return undefined
  const name = withoutDigest.slice(0, colon)
  const tag = withoutDigest.slice(colon + 1)
  return name && tag && tag !== 'latest' ? { name, current: tag } : undefined
}

/** The base images of a Dockerfile (`FROM`, stage aliases and `scratch` skipped) or a compose file (`image:`). */
export function dockerImages(text: string, file = 'Dockerfile'): Dependency[] {
  const isCompose = /\.ya?ml$/.test(file)
  const stages = new Set<string>()
  const out: Dependency[] = []
  for (const line of text.split('\n')) {
    if (isCompose) {
      const image = /^\s*image:\s*["']?([^\s"'#]+)/.exec(line)?.[1]
      const dependency = image ? imageReference(image) : undefined
      if (dependency) out.push(dependency)
      continue
    }
    const from = /^\s*FROM\s+(?:--\S+\s+)*(\S+)(?:\s+AS\s+(\S+))?/i.exec(line)
    if (!from?.[1]) continue
    const reference = from[1]
    if (reference.toLowerCase() !== 'scratch' && !stages.has(reference.toLowerCase())) {
      const dependency = imageReference(reference)
      if (dependency) out.push(dependency)
    }
    if (from[2]) stages.add(from[2].toLowerCase())
  }
  return out
}

/** The `uses: owner/repo@vN` references of a workflow whose ref is a version tag; branches, shas, local and docker actions are not judged. */
export function actionUses(text: string): Dependency[] {
  const out: Dependency[] = []
  for (const match of text.matchAll(
    /^\s*(?:-\s+)?uses:\s*["']?([\w.-]+\/[\w.-]+)(?:\/[^@\s"']*)?@v?(\d+(?:\.\d+)*)["']?\s*(?:#.*)?$/gm,
  )) {
    if (match[1] && match[2]) out.push({ name: match[1], current: match[2] })
  }
  return out
}

const numbers = (version: string): number[] => version.split('.').map((part) => Number.parseInt(part, 10) || 0)

/** The gap between `current` and `latest` judged only down to the precision `current` states (`v4` is current at `4.2.1`); patch gaps are none. */
export function gap(current: string, latest: string): 'major' | 'minor' | undefined {
  const [a = [], b = []] = [numbers(current), numbers(latest)]
  if ((b[0] ?? 0) > (a[0] ?? 0)) return 'major'
  if ((b[0] ?? 0) === (a[0] ?? 0) && a.length > 1 && (b[1] ?? 0) > (a[1] ?? 0)) return 'minor'
  return undefined
}

const compareVersions = (x: string, y: string): number => {
  const [a = [], b = []] = [numbers(x), numbers(y)]
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0)
    if (d) return d
  }
  return 0
}

/** The newest plain release in a list of tag names (`v1.2.3`, `1.2`); pre-releases are left out. */
export function newestRelease(tags: string[]): string | undefined {
  return tags
    .map((tag) => /^v?(\d+(?:\.\d+)*)$/.exec(tag)?.[1])
    .filter((tag): tag is string => tag !== undefined)
    .sort(compareVersions)
    .at(-1)
}

const IMAGE_TAG = /^(v?)(\d+(?:\.\d+)*)(-[A-Za-z][\w.-]*)?$/

/** The newest tag of the same shape (prefix, number of version parts, variant suffix) as `current`. */
export function newestSameShape(current: string, tags: string[]): string | undefined {
  const own = IMAGE_TAG.exec(current)
  if (!own) return undefined
  const [, prefix = '', digits = '', suffix = ''] = own
  const parts = digits.split('.').length
  return tags
    .map((tag) => IMAGE_TAG.exec(tag))
    .filter(
      (m): m is RegExpExecArray =>
        m !== null && (m[1] ?? '') === prefix && (m[3] ?? '') === suffix && (m[2] ?? '').split('.').length === parts,
    )
    .map((m) => `${m[2]}${suffix}`)
    .sort((x, y) => compareVersions(x.replace(/-.*$/, ''), y.replace(/-.*$/, '')))
    .at(-1)
}

async function fetchJson(url: string): Promise<Record<string, unknown>> {
  const response = await fetch(url, {
    headers: { 'user-agent': USER_AGENT, accept: 'application/json' },
    signal: AbortSignal.timeout(LOOKUP_TIMEOUT_MS),
  })
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`)
  return asRecord(await response.json()) ?? {}
}

async function gitTags(tools: Tools, url: string): Promise<string[]> {
  const result = await exec([tools.git, 'ls-remote', '--tags', '--refs', '--', url], LOOKUP_TIMEOUT_MS)
  if (result.exitCode !== 0) throw new Error(`git ls-remote ${url} failed (exit ${result.exitCode})`)
  return result.stdout.split('\n').flatMap((line) => line.split('\trefs/tags/')[1]?.trim() ?? [])
}

/** Docker Hub only (the registries behind other hosts are not looked up); at most 3 pages of the most recently updated tags. */
async function hubTags(image: string, suffix: string): Promise<string[]> {
  const repo = image.replace(/^(?:docker\.io|registry-1\.docker\.io)\//, '')
  if (repo.split('/')[0]?.includes('.')) throw new Error(`${image}: not a Docker Hub image`)
  const path = repo.includes('/') ? repo : `library/${repo}`
  const filter = suffix ? `&name=${encodeURIComponent(suffix.slice(1))}` : ''
  let url: string | undefined =
    `https://hub.docker.com/v2/repositories/${path}/tags?page_size=100&ordering=last_updated${filter}`
  const names: string[] = []
  for (let page = 0; url && page < 3; page++) {
    const body = await fetchJson(url)
    const results = Array.isArray(body.results) ? body.results : []
    names.push(
      ...results.flatMap((row) => (typeof asRecord(row)?.name === 'string' ? [asRecord(row)?.name as string] : [])),
    )
    url = typeof body.next === 'string' ? body.next : undefined
  }
  return names
}

/** The real registries: crates.io, PyPI, `git ls-remote --tags` (Swift, Actions) and Docker Hub. */
export const registryLookup =
  (tools: Tools): Lookup =>
  async ({ ecosystem, name, current }) => {
    switch (ecosystem) {
      case 'cargo': {
        const crate = asRecord((await fetchJson(`https://crates.io/api/v1/crates/${encodeURIComponent(name)}`)).crate)
        const latest = crate?.max_stable_version ?? crate?.max_version
        return typeof latest === 'string' ? latest : undefined
      }
      case 'python': {
        const latest = asRecord(
          (await fetchJson(`https://pypi.org/pypi/${encodeURIComponent(name)}/json`)).info,
        )?.version
        return typeof latest === 'string' ? latest : undefined
      }
      case 'swift':
        return newestRelease(await gitTags(tools, name))
      case 'actions':
        return newestRelease(await gitTags(tools, `https://github.com/${name}`))
      case 'docker': {
        const suffix = IMAGE_TAG.exec(current)?.[3] ?? ''
        return newestSameShape(current, await hubTags(name, suffix))
      }
    }
  }

async function pool<T, R>(items: T[], work: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length)
  let next = 0
  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, items.length) }, async () => {
      while (next < items.length) {
        const index = next++
        results[index] = await work(items[index] as T)
      }
    }),
  )
  return results
}

const DOCKERFILE = /(?:^|\/)(?:Dockerfile[^/]*|[^/]*\.dockerfile)$/
const COMPOSE = /(?:^|\/)(?:docker-)?compose[^/]*\.ya?ml$/
const WORKFLOW = /^\.github\/workflows\/[^/]+\.ya?ml$/
const REQUIREMENTS = /(?:^|\/)requirements[^/]*\.txt$/
const SKIPPED_DIRS = new Set(['node_modules', 'vendor', 'target', 'Pods', '.build'])

const readTracked = (path: string, file: string): string => {
  try {
    return readFileSync(join(path, file), 'utf8')
  } catch {
    return ''
  }
}

/** What each ecosystem declares in the tracked files; an empty list is an ecosystem the repo does not use. */
async function declared(tools: Tools, path: string): Promise<Record<Ecosystem, Dependency[]>> {
  const tracked = (await gitOut(tools, path, ['ls-files', '-z']).catch(() => ''))
    .split('\0')
    .filter((file) => file && !file.split('/').some((part) => SKIPPED_DIRS.has(part)))
  const of = (match: (file: string) => boolean, parse: (text: string, file: string) => Dependency[]): Dependency[] =>
    tracked.filter(match).flatMap((file) => parse(readTracked(path, file), file))
  const base = (file: string): string => file.split('/').at(-1) ?? file
  return {
    cargo: of((file) => base(file) === 'Cargo.toml', cargoDependencies),
    python: lockedPython(
      of((file) => base(file) === 'pyproject.toml' || REQUIREMENTS.test(file), pythonDependencies),
      of((file) => base(file) === 'uv.lock', uvLocked),
    ),
    swift: of((file) => base(file) === 'Package.swift', swiftPackages),
    docker: of((file) => DOCKERFILE.test(file) || COMPOSE.test(file), dockerImages),
    actions: of((file) => WORKFLOW.test(file), actionUses),
  }
}

/** The locked `[[package]]` versions of a `uv.lock`, as dependencies. */
function uvLocked(text: string): Dependency[] {
  const packages = parseToml(text)?.package
  return (Array.isArray(packages) ? packages : []).flatMap((entry) => {
    const row = asRecord(entry)
    return typeof row?.name === 'string' && typeof row.version === 'string'
      ? [{ name: row.name, current: row.version }]
      : []
  })
}

/** A declared Python dependency is judged at its locked version when a `uv.lock` has one. */
function lockedPython(declaredDeps: Dependency[], locked: Dependency[]): Dependency[] {
  const normal = (name: string): string => name.toLowerCase().replace(/[-_.]+/g, '-')
  const versions = new Map(locked.map((dep) => [normal(dep.name), dep.current]))
  return declaredDeps.map((dep) => ({ name: dep.name, current: versions.get(normal(dep.name)) ?? dep.current }))
}

interface EcosystemRun {
  outcome: 'found' | 'clean' | 'failed'
  detail: string
  findings: ProbeFinding[]
  /** the finding key the run could not judge: its part failed, or some of its look-ups did */
  unjudged?: string[]
}

async function judgeEcosystem(
  entry: (typeof ECOSYSTEMS)[number],
  dependencies: Dependency[],
  lookup: Lookup,
): Promise<EcosystemRun> {
  const unique = [...new Map(dependencies.map((dep) => [`${dep.name}@${dep.current}`, dep])).values()].sort((a, b) =>
    a.name.localeCompare(b.name),
  )
  const batch = unique.slice(0, MAX_LOOKUPS)
  const answers = await pool(batch, (dep) =>
    lookup({ ecosystem: entry.ecosystem, name: dep.name, current: dep.current }).then(
      (latest) => latest,
      () => undefined,
    ),
  )
  const notLooked = unique.length - batch.length + answers.filter((latest) => latest === undefined).length
  if (answers.length > 0 && answers.every((latest) => latest === undefined)) {
    return {
      outcome: 'failed',
      detail: `${entry.label}: no look-up worked (${notLooked} not looked up)`,
      findings: [],
      unjudged: [`deps:${entry.ecosystem}`],
    }
  }
  const rows = batch.flatMap((dep, index) => {
    const latest = answers[index]
    const size = latest === undefined ? undefined : gap(dep.current, latest)
    return latest !== undefined && size ? [{ name: dep.name, current: dep.current, latest, size }] : []
  })
  rows.sort((a, b) => a.size.localeCompare(b.size) || a.name.localeCompare(b.name))
  const note = notLooked ? `, ${notLooked} not looked up` : ''
  if (!rows.length)
    return {
      outcome: 'clean',
      detail: `${entry.label}: nothing a minor or major behind${note}`,
      findings: [],
      ...(notLooked ? { unjudged: [`deps:${entry.ecosystem}`] } : {}),
    }
  const lines = rows.map((row) => `${row.name} ${row.current} -> ${row.latest} (${row.size})`)
  return {
    outcome: 'found',
    detail: `${entry.label}, ${rows.length} outdated${note}`,
    findings: [finding('deps', `deps:${entry.ecosystem}`, entry.title, lines, rows.length)],
  }
}

async function bunRun(tools: Tools, path: string): Promise<EcosystemRun | undefined> {
  if (!existsSync(join(path, 'package.json'))) return undefined
  if (!existsSync(join(path, 'node_modules'))) {
    const install = await exec([tools.bun, 'install', '--frozen-lockfile'], INSTALL_TIMEOUT_MS, path)
    if (install.exitCode !== 0) {
      return {
        outcome: 'failed',
        detail:
          install.exitCode === EXIT_TIMEOUT
            ? `bun install did not finish in ${INSTALL_TIMEOUT_MS / 60_000} min`
            : `bun install --frozen-lockfile failed (exit ${install.exitCode})`,
        findings: [],
        unjudged: ['deps'],
      }
    }
  }
  const result = await exec([tools.bun, 'outdated'], OUTDATED_TIMEOUT_MS, path)
  if (result.exitCode === EXIT_TIMEOUT) {
    return {
      outcome: 'failed',
      detail: `bun outdated did not finish in ${OUTDATED_TIMEOUT_MS / 1000} s`,
      findings: [],
      unjudged: ['deps'],
    }
  }
  if (result.exitCode !== 0) {
    return {
      outcome: 'failed',
      detail: `bun outdated failed (exit ${result.exitCode})`,
      findings: [],
      unjudged: ['deps'],
    }
  }
  const outdated = parseOutdated(result.stdout)
    .filter((row) => row.current !== row.latest)
    .map((row) => ({ ...row, severity: severity(row.current, row.latest) }))
    .sort((a, b) => SEVERITIES.indexOf(a.severity) - SEVERITIES.indexOf(b.severity) || a.name.localeCompare(b.name))
  if (!outdated.length) return { outcome: 'clean', detail: 'bun outdated: everything is at its latest', findings: [] }
  const lines = outdated.map(
    (row) =>
      `${row.name} ${row.current} -> ${row.latest} (${row.severity})${row.heldBack ? ', held back by the release-age cooldown' : ''}`,
  )
  return {
    outcome: 'found',
    detail: `bun outdated, ${outdated.length} packages`,
    findings: [finding('deps', 'deps', 'Hygiene: outdated dependencies', lines, outdated.length)],
  }
}

/** Outdated dependencies: `bun outdated` for a package.json, registry look-ups (`lookup`) for Cargo, Python, Swift, Docker and Actions. */
export async function depsProbe(tools: Tools, path: string, lookup: Lookup = registryLookup(tools)): Promise<Outcome> {
  const lists = await declared(tools, path)
  const runs = [
    await bunRun(tools, path),
    ...(await Promise.all(
      ECOSYSTEMS.map(async (entry) =>
        lists[entry.ecosystem].length ? judgeEcosystem(entry, lists[entry.ecosystem], lookup) : undefined,
      ),
    )),
  ].filter((run): run is EcosystemRun => run !== undefined)
  if (!runs.length) return skipped('no package file')
  const findings = runs.flatMap((run) => run.findings)
  const detail = runs.map((run) => run.detail).join('; ')
  const unjudged = runs.flatMap((run) => run.unjudged ?? [])
  if (findings.length) return unjudging(found(detail, findings), unjudged)
  if (runs.some((run) => run.outcome === 'clean')) return unjudging(clean(detail), unjudged)
  return failed(detail)
}
