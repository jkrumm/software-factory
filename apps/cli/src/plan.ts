import { dirname, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { PLAN_LIMITS } from '@software-factory/contract'
import { PlanFile, parsePlan, YAML_OPTIONS } from '@software-factory/contract/plan'
import { LineCounter, parse, parseDocument } from 'yaml'
import planDoc from '../../../docs/plan.md' with { type: 'text' }
import { EXIT, usage } from './exit.ts'
import { type Format, render } from './output.ts'
import type { Io } from './operation.ts'
import { type Problem, problemLines, schemaProblems, yamlProblems } from './yaml-problems.ts'

const DEFAULT_FILE = 'docs/plan.yaml'

const NESTED_HINT =
  'a one-line fact containing ": " must be quoted or written as a block scalar (`why: |` and the text indented below)'

const formatOf = (value: string | undefined, fallback: Format): Format => {
  const format = value ?? fallback
  if (format !== 'json' && format !== 'plain') throw usage(`--format must be json or plain, got: ${format}`)
  return format
}

/** The lanes `project.yaml` declares, read from the parent of the plan file's directory; null when unknown. */
async function declaredLanes(file: string, io: Io): Promise<string[] | null> {
  if (file === '-') return null
  try {
    const text = await io.readFile(resolve(dirname(dirname(resolve(file))), 'project.yaml'))
    const project: unknown = parse(text)
    if (project === null || typeof project !== 'object') return null
    const lanes = (project as { lanes?: unknown }).lanes
    return lanes !== null && typeof lanes === 'object' ? Object.keys(lanes) : []
  } catch {
    return null
  }
}

/** Every problem of a plan file's text, each with the line and column it sits at, and the warnings. Never throws. */
async function check(
  text: string,
  lanes: () => Promise<string[] | null>,
): Promise<{ rows: number; problems: Problem[]; warnings: string[] }> {
  if (Buffer.byteLength(text) > PLAN_LIMITS.maxBytes) {
    const message = `the file is larger than ${PLAN_LIMITS.maxBytes} bytes (${Buffer.byteLength(text)}); a plan over the limit is a broken plan`
    return { rows: 0, problems: [{ line: 1, column: 1, path: [], message }], warnings: [] }
  }
  const lineCounter = new LineCounter()
  const doc = parseDocument(text, { ...YAML_OPTIONS, lineCounter })
  if (doc.errors.length > 0) {
    const hint = (message: string) => (/nested mappings/i.test(message) ? NESTED_HINT : undefined)
    return { rows: 0, problems: yamlProblems(doc, hint), warnings: [] }
  }
  let raw: unknown
  try {
    raw = doc.toJS()
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { rows: 0, problems: [{ line: 1, column: 1, path: [], message }], warnings: [] }
  }
  const parsed = PlanFile.safeParse(raw)
  if (parsed.success) {
    const result = parsePlan(raw, await lanes())
    return { rows: parsed.data.rows.length, problems: [], warnings: result.ok ? result.warnings : [] }
  }
  const problems = schemaProblems(doc, lineCounter, parsed.error)
  return { rows: 0, problems, warnings: [] }
}

async function checkVerb(argv: readonly string[], io: Io): Promise<number> {
  let parsed: ReturnType<typeof parseArgs<{ options: { format: { type: 'string' } }; allowPositionals: true }>>
  try {
    parsed = parseArgs({ args: [...argv], options: { format: { type: 'string' } }, allowPositionals: true })
  } catch (error) {
    throw usage(
      error instanceof Error ? error.message : String(error),
      'factory plan check [file] [--format json|plain]',
    )
  }
  if (parsed.positionals.length > 1) throw usage('usage: plan check [file]', 'factory plan check docs/plan.yaml')
  const format = formatOf(parsed.values.format, 'plain')
  const file = parsed.positionals[0] ?? DEFAULT_FILE
  let text: string
  try {
    text = file === '-' ? await io.stdin() : await io.readFile(file)
  } catch (error) {
    throw usage(`cannot read ${file}: ${error instanceof Error ? error.message : String(error)}`)
  }
  const label = file === '-' ? '<stdin>' : file
  const { rows, problems, warnings } = await check(text, () => declaredLanes(file, io))
  const ok = problems.length === 0
  const lines = [
    ...problemLines(label, problems),
    ...warnings.map((w) => `${label}: warning: ${w}`),
    ...(ok ? [`ok: ${label}, ${rows} rows`] : []),
  ]
  const errors = problems.map(({ line, column, path, message, hint }) => ({
    line,
    column,
    path,
    message,
    ...(hint ? { hint } : {}),
  }))
  io.out(render(format, { ok, file: label, rows, errors, warnings }, lines.join('\n')))
  if (!ok) throw usage(`${label}: ${problems.length} problem(s)`)
  return EXIT.ok
}

function schemaVerb(argv: readonly string[], io: Io): number {
  let values: { format?: string }
  try {
    values = parseArgs({ args: [...argv], options: { format: { type: 'string' } }, allowPositionals: false }).values
  } catch (error) {
    throw usage(error instanceof Error ? error.message : String(error), 'factory plan schema [--format json|plain]')
  }
  const format = formatOf(values.format, 'plain')
  io.out(
    format === 'json' ? render(format, { format: planDoc }, '') : planDoc.endsWith('\n') ? planDoc : `${planDoc}\n`,
  )
  return EXIT.ok
}

/** `factory plan schema | check [file]`: the plan file's format page and an offline check of a file; no server, no token. */
export async function planVerb(argv: readonly string[], io: Io): Promise<number> {
  if (argv[0] === 'schema') return schemaVerb(argv.slice(1), io)
  if (argv[0] === 'check') return await checkVerb(argv.slice(1), io)
  throw usage('usage: plan schema | plan check [file]', 'factory plan schema; factory plan check docs/plan.yaml')
}
