import { spawnSync } from 'node:child_process'
import { basename, dirname, join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { YAML_OPTIONS } from '@software-factory/contract/plan'
import {
  MAX_PROJECT_BYTES,
  PROJECT_SCHEMA_URL,
  type ProjectFile,
  projectJsonSchema,
  readProject,
} from '@software-factory/contract/project'
import { type Document, LineCounter, parseDocument } from 'yaml'
import projectDoc from '../../../docs/project.md' with { type: 'text' }
import { EXIT, usage } from './exit.ts'
import type { Io } from './operation.ts'
import { type Format, render } from './output.ts'
import { type Problem, positionOf, problemLines, schemaProblems, yamlProblems } from './yaml-problems.ts'

const DEFAULT_FILE = 'project.yaml'

type Json = Record<string, unknown>
type Path = (string | number)[]

const isJson = (value: unknown): value is Json => typeof value === 'object' && value !== null && !Array.isArray(value)

const formatOf = (value: string | undefined): Format => {
  const format = value ?? 'plain'
  if (format !== 'json' && format !== 'plain') throw usage(`--format must be json or plain, got: ${format}`)
  return format
}

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
  ]
}

/** A Makefile target at the start of a line, as the server reads them (`adapters/quality/projects.ts`). */
const makefileTargets = (makefile: string): Set<string> =>
  new Set(
    [...makefile.matchAll(/^([A-Za-z][A-Za-z0-9_.-]*(?:\s+[A-Za-z][A-Za-z0-9_.-]*)*)\s*:(?!=)/gm)].flatMap((match) =>
      (match[1] ?? '').split(/\s+/),
    ),
  )

/** A document a comment cites: `docs/plan.md`, `config/infra.json`, or `<sibling repo> <path>`. */
const CITATION =
  /(?:([A-Za-z0-9._-]+)\s+)?((?:[A-Za-z0-9._-]+\/)*[A-Za-z0-9_-][A-Za-z0-9._-]*\.(?:md|json|ya?ml))(?![\w/])/g

/** The cited documents of the file's comments that do not exist, at the line that cites them. */
async function missingCitations(text: string, repo: string, io: Io): Promise<Problem[]> {
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
      const sibling = word ? join(dirname(repo), word) : null
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

/** The repo's own name: the main checkout's directory, also from a linked worktree (as the server stores it). */
function repoName(directory: string): string {
  const common = spawnSync('git', ['-C', directory, 'rev-parse', '--path-format=absolute', '--git-common-dir'], {
    encoding: 'utf8',
    timeout: 5000,
  })
  const path = common.status === 0 ? common.stdout.trim() : ''
  return path.endsWith('/.git') ? basename(dirname(path)) : basename(directory)
}

interface CheckResult {
  problems: Problem[]
  warnings: Problem[]
}

/** Every problem and warning of a project file's text. Never throws. `repo` is the directory it sits in; null for stdin. */
export async function checkProject(text: string, repo: string | null, io: Io): Promise<CheckResult> {
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
  if (repo !== null) {
    const name = repoName(repo)
    if (parsed.data.name !== name) {
      warnings.push(at(['name'], `name is "${parsed.data.name}", the repo is "${name}": the factory refuses the file`))
    }
    const makefile = await io.readFile(join(repo, 'Makefile')).catch(() => null)
    const targets = makefile === null ? null : makefileTargets(makefile)
    for (const { target, path } of namedTargets(parsed.data)) {
      if (targets?.has(target)) continue
      warnings.push(
        at(
          path,
          targets === null
            ? `make ${target}: there is no Makefile beside the file`
            : `make ${target}: the Makefile has no target ${target}`,
        ),
      )
    }
    warnings.push(...(await missingCitations(text, repo, io)))
  }
  return { problems: [], warnings: warnings.sort((a, b) => a.line - b.line || a.column - b.column) }
}

async function checkVerb(argv: readonly string[], io: Io): Promise<number> {
  let parsed: ReturnType<typeof parseArgs<{ options: { format: { type: 'string' } }; allowPositionals: true }>>
  try {
    parsed = parseArgs({ args: [...argv], options: { format: { type: 'string' } }, allowPositionals: true })
  } catch (error) {
    throw usage(
      error instanceof Error ? error.message : String(error),
      'factory project check [file] [--format json|plain]',
    )
  }
  if (parsed.positionals.length > 1) throw usage('usage: project check [file]', 'factory project check project.yaml')
  const format = formatOf(parsed.values.format)
  const file = parsed.positionals[0] ?? DEFAULT_FILE
  let text: string
  try {
    text = file === '-' ? await io.stdin() : await io.readFile(file)
  } catch (error) {
    throw usage(`cannot read ${file}: ${error instanceof Error ? error.message : String(error)}`)
  }
  const label = file === '-' ? '<stdin>' : file
  const { problems, warnings } = await checkProject(text, file === '-' ? null : dirname(resolve(file)), io)
  const ok = problems.length === 0
  const lines = [
    ...problemLines(label, problems),
    ...problemLines(label, warnings, 'warning'),
    ...(ok ? [`ok: ${label}${warnings.length > 0 ? `, ${warnings.length} warning(s)` : ''}`] : []),
  ]
  io.out(render(format, { ok, file: label, errors: problems, warnings }, lines.join('\n')))
  if (!ok) throw usage(`${label}: ${problems.length} problem(s)`)
  return EXIT.ok
}

function schemaVerb(argv: readonly string[], io: Io): number {
  let values: { format?: string }
  try {
    values = parseArgs({ args: [...argv], options: { format: { type: 'string' } }, allowPositionals: false }).values
  } catch (error) {
    throw usage(error instanceof Error ? error.message : String(error), 'factory project schema [--format json|plain]')
  }
  const format = formatOf(values.format)
  if (format === 'json') {
    io.out(render(format, { format: projectDoc, url: PROJECT_SCHEMA_URL, jsonSchema: projectJsonSchema() }, ''))
    return EXIT.ok
  }
  io.out(projectDoc.endsWith('\n') ? projectDoc : `${projectDoc}\n`)
  return EXIT.ok
}

/** `factory project schema | check [file]`: the project file's author page and an offline check of a file; no server, no token. */
export async function projectVerb(argv: readonly string[], io: Io): Promise<number> {
  if (argv[0] === 'schema') return schemaVerb(argv.slice(1), io)
  if (argv[0] === 'check') return await checkVerb(argv.slice(1), io)
  throw usage(
    'usage: project schema | project check [file]',
    'factory project schema; factory project check project.yaml',
  )
}
