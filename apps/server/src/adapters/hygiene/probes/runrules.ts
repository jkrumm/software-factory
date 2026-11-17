import { readFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { isMap, isScalar, isSeq, LineCounter, parse, parseDocument, type Node } from 'yaml'
import { gitOut, type Tools } from '../git.ts'
import { type Outcome, clean, finding, found, skipped } from './finding.ts'
import type { ProbeFinding } from '../../../domains/loops/hygiene-model.ts'

/**
 * The owner's rules for what runs on the Mac mini (dotfiles `rules/run-on-mini.md`), read from a repo before its change reaches the
 * host. The host's own check (`make mini-ps`) judges containers and loaded jobs once they exist; this reads the files. Which
 * services the repo runs on the mini is the `mini-services.yaml` at its root: a compose service is judged only when an entry
 * of that file names it, so a compose file of a repo that deploys to the VPS or the HomeLab is never touched.
 */

const SERVICES_FILE = 'mini-services.yaml'

/** The rule names of the registry (`debt: { <rule>: … }`, `exception: { <rule>: … }`); `no-healthcheck` is this probe's own. */
export type Rule =
  | 'restart-policy'
  | 'no-memory-limit'
  | 'port-binding'
  | 'no-healthcheck'
  | 'shared-infrastructure'
  | 'no-budget'
  | 'unregistered-job'
  | 'keepalive-poll'

/** One thing a file breaks: the rule, where, the service it is about and why. */
export interface Breach {
  rule: Rule
  file: string
  line: number
  subject: string
  detail: string
}

/** One entry of a services file: only what the rules read. */
export interface Entry {
  name: string
  line: number
  kind: string
  tier: string
  label?: string
  container?: string
  memoryMib: number | undefined
  oneshot: boolean
  excused: ReadonlySet<string>
}

const SHARED_IMAGE = /(^|\/)(postgres(ql)?|redis|valkey|keydb|memcached)(:|@|$)/
const LOOPBACK = new Set(['127.0.0.1', '::1'])
const COMPOSE_FILE = /(^|\/)(compose(\.[^/]+)?|docker-compose[^/]*)\.ya?ml$/
const PLIST_FILE = /\.plist(\.(template|tpl|tmpl))?$/

const asRecord = (value: unknown): Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
const asText = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined)

/** A project that runs something on the mini: a deploy target with host `mini`, or its own services file. */
function runsOnMini(projectYaml: string | undefined, hasServices: boolean): boolean {
  if (hasServices) return true
  if (projectYaml === undefined) return false
  try {
    const targets = asRecord(asRecord(parse(projectYaml)).deploy).targets
    return Array.isArray(targets) && targets.some((target) => asRecord(target).host === 'mini')
  } catch {
    return false
  }
}

const lineAt = (counter: LineCounter, node: unknown): number => {
  const range = (node as Node | null | undefined)?.range
  return range ? counter.linePos(range[0]).line : 1
}

/** The entries of a services file. A file that does not parse has none. */
function parseEntries(text: string): Entry[] {
  const counter = new LineCounter()
  const doc = parseDocument(text, { lineCounter: counter })
  const list = doc.get('services', true)
  if (doc.errors.length || !isSeq(list)) return []
  const entries: Entry[] = []
  for (const item of list.items) {
    if (!isMap(item)) continue
    const raw = asRecord(item.toJS(doc))
    const name = asText(raw.name)
    if (!name) continue
    const memory = typeof raw.memory_mib === 'number' ? raw.memory_mib : undefined
    entries.push({
      name,
      line: lineAt(counter, item),
      kind: asText(raw.kind) ?? '',
      tier: asText(raw.tier) ?? '',
      label: asText(raw.label),
      container: asText(raw.container),
      memoryMib: memory,
      oneshot: raw.oneshot === true,
      excused: new Set([...Object.keys(asRecord(raw.debt)), ...Object.keys(asRecord(raw.exception))]),
    })
  }
  return entries
}

/** `no-budget`: an entry with no `memory_mib`, or 0, unless it is a static site or a oneshot. */
function budgetBreaches(entries: Entry[], file: string): Breach[] {
  return entries
    .filter((entry) => !(entry.memoryMib && entry.memoryMib > 0) && entry.kind !== 'static' && !entry.oneshot)
    .filter((entry) => !entry.excused.has('no-budget'))
    .map((entry) => ({
      rule: 'no-budget',
      file,
      line: entry.line,
      subject: entry.name,
      detail: 'no memory_mib (set 1.5 times the footprint after an hour of use)',
    }))
}

/** The host address of one published port, `undefined` when it is not published, `null` when it cannot be told (interpolated). */
export function publishedHost(port: unknown): string | null | undefined {
  if (typeof port === 'object' && port !== null) {
    const long = asRecord(port)
    if (long.published === undefined) return undefined
    return typeof long.host_ip === 'string' ? long.host_ip : ''
  }
  if (typeof port !== 'string' && typeof port !== 'number') return undefined
  const spec = String(port)
    .replace(/\$\{[^}]*\}/g, '\0')
    .replace(/\/\w+$/, '')
  const host = spec.startsWith('[') ? spec.slice(1, spec.indexOf(']')) : undefined
  if (host !== undefined) return host
  const parts = spec.split(':')
  if (parts.length >= 3) return parts[0]?.includes('\0') ? null : (parts[0] ?? '')
  return parts[0]?.includes('\0') && parts.length === 1 ? null : ''
}

const noHealthcheck = (value: unknown): boolean => {
  if (value === undefined) return true
  const check = asRecord(value)
  const test = Array.isArray(check.test) ? check.test[0] : check.test
  return check.disable === true || test === 'NONE'
}

const memoryLimited = (service: Record<string, unknown>): boolean => {
  if (service.mem_limit !== undefined) return true
  const limits = asRecord(asRecord(asRecord(service.deploy).resources).limits)
  return limits.memory !== undefined
}

/** A compose service an entry of the services file names: by `container`, then by the entry's name. */
const entryFor = (entries: Entry[], key: string, container: string | undefined): Entry | undefined =>
  entries.find(
    (entry) => entry.kind === 'compose' && entry.container !== undefined && entry.container === (container ?? key),
  ) ?? entries.find((entry) => entry.kind === 'compose' && entry.name === key)

/** The breaches of the compose services a services entry names. A compose file that does not parse has none. */
function composeBreaches(text: string, file: string, entries: Entry[]): Breach[] {
  const counter = new LineCounter()
  const doc = parseDocument(text, { lineCounter: counter })
  const services = doc.get('services', true)
  if (doc.errors.length || !isMap(services)) return []
  const out: Breach[] = []
  for (const pair of services.items) {
    if (!isScalar(pair.key) || !isMap(pair.value)) continue
    const key = String(pair.key.value)
    const service = asRecord(pair.value.toJS(doc))
    const entry = entryFor(entries, key, asText(service.container_name))
    if (!entry) continue
    const at = lineAt(counter, pair.key)
    const add = (rule: Rule, detail: string, line = at): void => {
      if (!entry.excused.has(rule)) out.push({ rule, file, line, subject: key, detail })
    }
    const restart = asText(service.restart)
    if (restart && /^(always|unless-stopped)$/.test(restart) && entry.tier !== 'core') {
      add(
        'restart-policy',
        `restart ${restart} on a ${entry.tier || 'non-core'} service: only a core service restarts itself`,
        lineAt(counter, pair.value.get('restart', true)),
      )
    }
    if (!memoryLimited(service)) add('no-memory-limit', 'no mem_limit')
    const ports = pair.value.get('ports', true)
    if (isSeq(ports)) {
      for (const port of ports.items) {
        const host = publishedHost(
          isScalar(port) ? port.value : (port as { toJS?: (d: unknown) => unknown }).toJS?.(doc),
        )
        if (host === undefined || host === null || LOOPBACK.has(host)) continue
        add('port-binding', `published on ${host || '0.0.0.0'}, not 127.0.0.1`, lineAt(counter, port))
      }
    }
    if (noHealthcheck(service.healthcheck)) add('no-healthcheck', 'no healthcheck')
    const image = asText(service.image)
    if (image && SHARED_IMAGE.test(image)) {
      add(
        'shared-infrastructure',
        `image ${image}: Postgres and a cache are one native instance under launchd, not a container per app`,
        lineAt(counter, pair.value.get('image', true)),
      )
    }
  }
  return out
}

interface Plist {
  label: string | undefined
  keepAlive: boolean
  /** every string of ProgramArguments and Program, with its line */
  program: { text: string; line: number }[]
}

const KEY = (name: string): RegExp => new RegExp(`<key>${name}</key>\\s*`, 'g')

/** A launchd job in a plist (or a template of one): its label, whether KeepAlive is on, and the program strings. Not one: `undefined`. */
function parsePlist(text: string): Plist | undefined {
  const label = /<key>Label<\/key>\s*<string>([^<]*)<\/string>/.exec(text)?.[1]
  const lineOf = (index: number): number => text.slice(0, index).split('\n').length
  const program: Plist['program'] = []
  const single = KEY('Program')
  for (let m = single.exec(text); m; m = single.exec(text)) {
    const value = /^<string>([^<]*)<\/string>/.exec(text.slice(m.index + m[0].length))
    if (value?.[1] !== undefined) program.push({ text: value[1], line: lineOf(m.index + m[0].length) })
  }
  const args = KEY('ProgramArguments')
  for (let m = args.exec(text); m; m = args.exec(text)) {
    const start = m.index + m[0].length
    const block = /^<array>([\s\S]*?)<\/array>/.exec(text.slice(start))
    if (!block) continue
    const strings = /<string>([^<]*)<\/string>/g
    for (let s = strings.exec(block[1] ?? ''); s; s = strings.exec(block[1] ?? '')) {
      const offset = start + block[0].indexOf(block[1] ?? '') + s.index
      program.push({ text: s[1] ?? '', line: lineOf(offset) })
    }
  }
  if (label === undefined && program.length === 0) return undefined
  if (program.length === 0) return undefined
  return { label, keepAlive: /<key>KeepAlive<\/key>\s*(<true\s*\/>|<dict>)/.test(text), program }
}

const SHELL_LOOP = /\bwhile\s+(true|:)(\s|;|$)|\bsleep\s+\d|^sleep$/

/** The label a plist file stands for: its `Label`, else its file name without the plist suffix. */
const labelOf = (plist: Plist, file: string): string[] => [
  ...(plist.label ? [plist.label] : []),
  basename(file).replace(PLIST_FILE, ''),
]

/**
 * The breaches of one plist or template: no entry names it (only judged when the repo has a services file), or it keeps a
 * shell polling loop alive instead of a server or a `jobrun` schedule.
 */
function plistBreaches(text: string, file: string, entries: Entry[] | undefined): Breach[] {
  const plist = parsePlist(text)
  if (!plist) return []
  const out: Breach[] = []
  const names = labelOf(plist, file)
  const entry = entries?.find((e) => e.label !== undefined && names.includes(e.label))
  const subject = plist.label ?? names[1] ?? file
  const firstLine = plist.program[0]?.line ?? 1
  if (entries && !entry) {
    out.push({
      rule: 'unregistered-job',
      file,
      line: firstLine,
      subject,
      detail: `no entry of ${SERVICES_FILE} names this job`,
    })
  }
  const loop = plist.keepAlive ? plist.program.find((p) => SHELL_LOOP.test(p.text)) : undefined
  if (loop && !entry?.excused.has('keepalive-poll')) {
    out.push({
      rule: 'keepalive-poll',
      file,
      line: loop.line,
      subject,
      detail: `KeepAlive on a shell loop (${loop.text.slice(0, 80)}): a schedule is a jobrun, a server is a server`,
    })
  }
  return out
}

/** One finding per rule and file: the title is the rule and the path, so intake's fingerprint is one Issue per pattern. */
function toFindings(breaches: Breach[]): ProbeFinding[] {
  const groups = new Map<string, Breach[]>()
  for (const breach of breaches) {
    const key = `runrules:${breach.rule}:${breach.file}`
    groups.set(key, [...(groups.get(key) ?? []), breach])
  }
  return [...groups].map(([key, list]) =>
    finding(
      'runrules',
      key,
      `Hygiene: run rule ${list[0]?.rule} in ${list[0]?.file}`,
      list.map((b) => `${b.file}:${b.line}: ${b.subject}: ${b.detail}`),
      list.length,
    ),
  )
}

const read = (path: string, file: string): string | undefined => {
  try {
    return readFileSync(join(path, file), 'utf8')
  } catch {
    return undefined
  }
}

/** The run rules for the mini over a checkout. Skipped for a project that runs nothing on the mini. */
export async function runrulesProbe(tools: Tools, path: string): Promise<Outcome> {
  const servicesText = read(path, SERVICES_FILE)
  if (!runsOnMini(read(path, 'project.yaml'), servicesText !== undefined))
    return skipped('the project runs nothing on the mini')
  const entries = servicesText === undefined ? undefined : parseEntries(servicesText)
  const tracked = (await gitOut(tools, path, ['ls-files', '-z'])).split('\0').filter(Boolean)
  const files = tracked.filter((file) => !file.split('/').includes('node_modules'))
  const composeFiles = entries ? files.filter((file) => COMPOSE_FILE.test(file)) : []
  const plistFiles = files.filter((file) => PLIST_FILE.test(file))
  const breaches: Breach[] = [
    ...(entries ? budgetBreaches(entries, SERVICES_FILE) : []),
    ...composeFiles.flatMap((file) => composeBreaches(read(path, file) ?? '', file, entries ?? [])),
    ...plistFiles.flatMap((file) => plistBreaches(read(path, file) ?? '', file, entries)),
  ]
  const detail = `${entries ? `${SERVICES_FILE}, ` : 'no services file, '}${composeFiles.length} compose files, ${plistFiles.length} plists`
  return breaches.length ? found(detail, toFindings(breaches)) : clean(detail)
}
