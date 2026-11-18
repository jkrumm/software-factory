import { execFile } from 'node:child_process'
import { basename, dirname, join } from 'node:path'
import { YAML_OPTIONS } from '@software-factory/contract/plan'
import {
  MAX_PROJECT_BYTES,
  type ProjectFile,
  capReasonOf,
  DEFAULT_LEADS,
  projectJsonSchema,
  readProject,
} from '@software-factory/contract/project'
import { type Document, LineCounter, parseDocument } from 'yaml'
import { type Problem, positionOf, schemaProblems, yamlProblems } from './yaml-problems.ts'

export { type Problem, problemLines } from './yaml-problems.ts'

/** What the lint needs of its caller: a file as UTF-8 text, rejecting when it cannot be read. */
export interface LintIo {
  readFile(path: string): Promise<string>
}

type Json = Record<string, unknown>
type Path = (string | number)[]

const isJson = (value: unknown): value is Json => typeof value === 'object' && value !== null && !Array.isArray(value)

/** `deploy.targets[0].host`: a path as an author reads it. */
export const pathText = (path: Path): string =>
  path.map((part, i) => (typeof part === 'number' ? `[${part}]` : i === 0 ? part : `.${part}`)).join('')

/** The paths of the retired keys (`deprecated` in the JSON Schema) a document sets, wherever they sit. */
export function retiredPaths(value: unknown, root: Json = projectJsonSchema()): Path[] {
  const found = new Map<string, Path>()
  const definitions = isJson(root.definitions) ? root.definitions : {}
  const walk = (raw: Json, node: unknown, path: Path) => {
    const ref = typeof raw.$ref === 'string' ? definitions[raw.$ref.replace(/^#\/definitions\//, '')] : undefined
    const schema = isJson(ref) ? ref : raw
    if (Array.isArray(schema.anyOf)) for (const branch of schema.anyOf) if (isJson(branch)) walk(branch, node, path)
    if (Array.isArray(node) && isJson(schema.items)) {
      const items = schema.items
      node.forEach((item, index) => walk(items, item, [...path, index]))
      return
    }
    if (!isJson(node)) return
    const properties = isJson(schema.properties) ? schema.properties : {}
    for (const [key, child] of Object.entries(node)) {
      const property = properties[key]
      if (isJson(property)) {
        if (property.deprecated === true) found.set([...path, key].join('.'), [...path, key])
        else walk(property, child, [...path, key])
      } else if (isJson(schema.additionalProperties)) walk(schema.additionalProperties, child, [...path, key])
    }
  }
  walk(root, value, [])
  return [...found.values()]
}

/** The Makefile targets a file names as `make <target>` (or a bare hygiene probe target), each with where it is set. */
function namedTargets(project: ProjectFile): { target: string; path: Path }[] {
  const make = (command: string | null | undefined, path: Path) => {
    const target = command ? /^make (\S+)$/.exec(command)?.[1] : undefined
    return target ? [{ target, path }] : []
  }
  return [
    ...(project.deploy.mode === 'make' ? [{ target: 'deploy', path: ['deploy', 'mode'] }] : []),
    ...project.deploy.targets.flatMap((target, i) => make(target.verify, ['deploy', 'targets', i, 'verify'])),
    ...make(project.checks?.fast, ['checks', 'fast']),
    ...make(project.checks?.full, ['checks', 'full']),
    ...make(project.doctor, ['doctor']),
    ...project.hygiene.probes.map((probe, i) => ({ target: probe.target, path: ['hygiene', 'probes', i, 'target'] })),
    ...project.heal.flatMap((rule, i) => make(rule.runbook, ['heal', i, 'runbook'])),
    ...Object.entries(project.steps).flatMap(([name, step]) =>
      step.make === undefined ? [] : [{ target: step.make, path: ['steps', name, 'make'] }],
    ),
  ]
}

/** A Makefile that includes another file defines targets this reader does not follow, so no target of it is judged missing. */
const includesFiles = (makefile: string): boolean => /^-?s?include[ \t]/m.test(makefile)

/** The targets a Makefile defines at the start of a line, every one of a `verify deploy:` line too; `include`d files are not read. */
const makefileTargets = (makefile: string): Set<string> =>
  new Set(
    [...makefile.matchAll(/^([A-Za-z][A-Za-z0-9_.-]*(?:[ \t]+[A-Za-z][A-Za-z0-9_.-]*)*)[ \t]*:(?!=)/gm)].flatMap(
      (match) => (match[1] ?? '').split(/[ \t]+/),
    ),
  )

/** A document a comment cites: `docs/plan.md`, `config/infra.json`, or `<sibling repo> <path>`. */
const CITATION =
  /(?:([A-Za-z0-9._-]+)\s+)?((?:[A-Za-z0-9._-]+\/)*[A-Za-z0-9_-][A-Za-z0-9._-]*\.(?:md|json|ya?ml))(?![\w/])/g

/** The cited documents of the file's comments that do not exist, at the line that cites them. */
async function missingCitations(text: string, repo: string, siblings: string, io: LintIo): Promise<Problem[]> {
  const exists = (path: string) =>
    io.readFile(path).then(
      () => true,
      () => false,
    )
  const problems: Problem[] = []
  const lines = text.split('\n')
  for (const [index, line] of lines.entries()) {
    const hash = line.search(/(^|\s)#/)
    if (hash === -1) continue
    const comment = line.slice(hash)
    for (const match of comment.matchAll(CITATION)) {
      const [, word, path] = match
      if (!path || comment.slice(Math.max(0, (match.index ?? 0) - 3), match.index).includes('://')) continue
      // `<repo> <path>` cites another repo's file when <repo> is a sibling the factory knows (it has a project.yaml)
      const sibling = word ? join(siblings, word) : null
      const other = sibling !== null && (await exists(join(sibling, 'project.yaml'))) ? sibling : null
      // a bare name (`deploy.yml`, `AGENTS.md`) is a workflow or a file named in passing; only a path or `<repo> <file>` cites
      if (!path.includes('/') && other === null) continue
      const candidates = [join(repo, path), ...(other ? [join(other, path)] : [])]
      const found = await Promise.all(candidates.map(exists))
      if (found.some(Boolean)) continue
      const offset = (match.index ?? 0) + (other ? 0 : match[0].length - path.length)
      problems.push({
        line: index + 1,
        column: hash + offset + 1,
        path: [],
        message: `a comment cites ${other ? `${word} ${path}` : path}, which does not exist: point it at the document that holds the reason`,
      })
    }
  }
  return problems
}

/**
 * The main checkout a directory belongs to: itself, or for a linked worktree (the hygiene pass's throwaway one) the repo it
 * was made from. A worktree of a bare `<name>.git` (a step host's copy of the repo, issue 1793) belongs to `<name>`.
 */
async function mainCheckout(directory: string): Promise<string> {
  // asynchronous: the server's hygiene pass lints from its event loop, which a stuck git must not hold
  const path = await new Promise<string>((resolve) => {
    execFile(
      'git',
      ['-C', directory, '--no-optional-locks', 'rev-parse', '--path-format=absolute', '--git-common-dir'],
      { encoding: 'utf8', timeout: 5000 },
      (error, stdout) => resolve(error ? '' : stdout.trim()),
    )
  })
  if (path.endsWith('/.git')) return dirname(path)
  return path.endsWith('.git') ? path.slice(0, -'.git'.length) : directory
}

/** The comment at the end of a line, if the line has one before no quote opens (the values this reads are plain scalars). */
const hasComment = (line: string): boolean => /(^|\s)#/.test(line)

/** A constant a file sets with no reason beside it: a comment on its line, the line above, or (for a key of a block) its parent's. */
const REASONED: { path: Path; isDefault: (value: unknown) => boolean }[] = [
  { path: ['leads'], isDefault: (value) => value === DEFAULT_LEADS },
  { path: ['slots', 'run'], isDefault: () => false },
  { path: ['budgets', 'fast'], isDefault: () => false },
  { path: ['budgets', 'peak'], isDefault: () => false },
  { path: ['budgets', 'fail'], isDefault: () => false },
]

const valueAt = (root: unknown, path: Path): unknown =>
  path.reduce<unknown>((node, key) => (isJson(node) ? node[key] : undefined), root)

/** The comment of a line (from its `#`) and the comment line above it, joined; empty when neither has one. */
function commentsAround(lines: readonly string[], line: number): string {
  const own = lines[line - 1] ?? ''
  const hash = own.search(/(^|\s)#/)
  const above = (lines[line - 2] ?? '').trimStart()
  return [above.startsWith('#') ? above : '', hash === -1 ? '' : own.slice(hash)].join(' ')
}

/** The warnings for a `leads` below the default whose comment records no reason, or names a resource the factory already models (`capReasonOf`). */
function leadsReasons(
  text: string,
  value: unknown,
  locate: (path: Path) => { line: number; column: number },
): Problem[] {
  const set = valueAt(value, ['leads'])
  if (set === undefined || set === DEFAULT_LEADS) return []
  const at = locate(['leads'])
  const { reason, hint } = capReasonOf(commentsAround(text.split('\n'), at.line))
  if (hint === null) return []
  const message =
    reason === 'unrecorded'
      ? `leads is ${String(set)} and its comment records no reason: ${hint}`
      : `leads is ${String(set)} for a resource the factory already models: ${hint}; a cap is for a resource the factory does not model`
  return [{ ...at, path: ['leads'], message }]
}

/**
 * The comment beside a top-level `leads:` or a lane's `leads` (the lane's line, the `lanes:` line for a flow-style lane, or the line above), from a project file's
 * text: what the throughput loop quotes when the cap binds while seats idle. Null: no such line, or it has no comment.
 */
export function capComment(text: string, cap: { lane: string | null }): string | null {
  const lines = text.split('\n')
  const lanes = lines.findIndex((l) => /^lanes\s*:/.test(l))
  const laneLine = (line: string, i: number) =>
    lanes !== -1 && i > lanes && /^\s/.test(line) && line.trimStart().startsWith(`${cap.lane}:`)
  // a lane declared in flow style (`lanes: { apple: 1 } # reason`) sits on the `lanes:` line itself
  const inFlow = lanes !== -1 && new RegExp(`[{,]\\s*${cap.lane}\\s*:`).test(lines[lanes] ?? '')
  const index =
    cap.lane === null ? lines.findIndex((l) => /^leads\s*:/.test(l)) : inFlow ? lanes : lines.findIndex(laneLine)
  if (index === -1) return null
  const comment = commentsAround(lines, index + 1).trim()
  return comment === '' ? null : comment
}

/** The warnings for constants set without a stated reason (docs/project.md: "Add a key when the repo differs, with the reason in a comment beside it"). */
function unreasoned(text: string, value: unknown, locate: (path: Path) => { line: number; column: number }): Problem[] {
  const lines = text.split('\n')
  const commented = (line: number) =>
    hasComment(lines[line - 1] ?? '') || (lines[line - 2] ?? '').trimStart().startsWith('#')
  const problems: Problem[] = []
  for (const { path, isDefault } of REASONED) {
    const set = valueAt(value, path)
    if (set === undefined || isDefault(set)) continue
    const at = locate(path)
    const parent = path.length > 1 ? locate(path.slice(0, -1)) : null
    if (commented(at.line) || (parent !== null && commented(parent.line))) continue
    problems.push({
      ...at,
      path,
      message: `${pathText(path)} is set to ${String(set)} with no reason beside it: add a comment on its line or the line above saying why this repo differs from the default`,
    })
  }
  return problems
}

/** What the file leaves unsaid that the Makefile beside it defines or the deploy settings contradict. */
function undeclared(
  project: ProjectFile,
  targets: Set<string> | null,
  at: (path: Path, message: string) => Problem,
): Problem[] {
  const problems: Problem[] = []
  if (targets?.has('doctor') && !project.doctor) {
    problems.push(
      at(
        ['doctor'],
        'the Makefile defines `doctor` but the file does not name it: add `doctor: make doctor`, or the factory admits leads on a host that cannot run the repo',
      ),
    )
  }
  const verified = project.deploy.targets.some((target) => target.verify === 'make verify')
  if (targets?.has('verify') && project.deploy.mode !== 'none' && !verified) {
    problems.push(
      at(
        ['deploy', 'targets'],
        'the Makefile defines `verify` but no deploy target names `verify: make verify`: name it so the file says how a deploy is proved',
      ),
    )
  }
  if (project.deploy.mode === 'none' && project.deploy.targets.length > 0) {
    problems.push(
      at(
        ['deploy', 'mode'],
        'deploy.mode is none (the default) but deploy.targets lists targets: nothing deploys, so they are never verified; set the mode that deploys, or remove the targets',
      ),
    )
  }
  return problems
}

export interface CheckResult {
  problems: Problem[]
  warnings: Problem[]
}

/** Every problem and warning of a project file's text. Never throws. `repo` is the directory it sits in; null for stdin. */
export async function checkProject(text: string, repo: string | null, io: LintIo): Promise<CheckResult> {
  if (Buffer.byteLength(text) > MAX_PROJECT_BYTES) {
    const message = `the file is larger than ${MAX_PROJECT_BYTES} bytes (${Buffer.byteLength(text)}); the factory refuses it`
    return { problems: [{ line: 1, column: 1, path: [], message }], warnings: [] }
  }
  const lineCounter = new LineCounter()
  const doc: Document = parseDocument(text, { ...YAML_OPTIONS, lineCounter })
  if (doc.errors.length > 0) return { problems: yamlProblems(doc), warnings: [] }
  let raw: unknown
  try {
    raw = doc.toJS()
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { problems: [{ line: 1, column: 1, path: [], message }], warnings: [] }
  }
  const { parsed, warnings: clamped, clamped: value } = readProject(raw)
  if (!parsed.success) return { problems: schemaProblems(doc, lineCounter, parsed.error), warnings: [] }
  const at = (path: Path, message: string): Problem => ({ ...positionOf(doc, lineCounter, path), path, message })
  const warnings: Problem[] = [
    ...clamped.map((message) => at((message.split(' ')[0] ?? '').split('.'), message)),
    ...retiredPaths(value).map((path) =>
      at(path, `${pathText(path)} is retired: the factory accepts it and reads nothing from it; remove it`),
    ),
  ]
  warnings.push(...unreasoned(text, value, (path) => positionOf(doc, lineCounter, path)))
  warnings.push(...leadsReasons(text, value, (path) => positionOf(doc, lineCounter, path)))
  if (repo !== null) {
    // asked once: the repo's own name, and the directory its sibling repos sit in, are both the main checkout's
    const main = await mainCheckout(repo)
    const name = basename(main)
    if (parsed.data.name !== name) {
      warnings.push(at(['name'], `name is "${parsed.data.name}", the repo is "${name}": the factory refuses the file`))
    }
    const makefile = await io.readFile(join(repo, 'Makefile')).catch(() => null)
    const unknown = makefile !== null && includesFiles(makefile)
    const targets = makefile === null || unknown ? null : makefileTargets(makefile)
    for (const { target, path } of namedTargets(parsed.data)) {
      if (unknown || targets?.has(target)) continue
      warnings.push(
        at(
          path,
          targets === null
            ? `make ${target}: there is no Makefile beside the file`
            : `make ${target}: the Makefile has no target ${target}`,
        ),
      )
    }
    warnings.push(...undeclared(parsed.data, targets, at))
    warnings.push(...(await missingCitations(text, repo, dirname(main), io)))
  }
  return { problems: [], warnings: warnings.sort((a, b) => a.line - b.line || a.column - b.column) }
}
