import { dirname, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { PROJECT_SCHEMA_URL, projectJsonSchema } from '@software-factory/contract/project'
import { checkProject, problemLines } from '@software-factory/project-lint'
import projectDoc from '../../../docs/project.md' with { type: 'text' }
import { EXIT, usage } from './exit.ts'
import type { Io } from './operation.ts'
import { type Format, render } from './output.ts'

const DEFAULT_FILE = 'project.yaml'

const formatOf = (value: string | undefined): Format => {
  const format = value ?? 'plain'
  if (format !== 'json' && format !== 'plain') throw usage(`--format must be json or plain, got: ${format}`)
  return format
}

async function checkVerb(argv: readonly string[], io: Io): Promise<number> {
  let parsed: ReturnType<
    typeof parseArgs<{ options: { format: { type: 'string' }; repo: { type: 'string' } }; allowPositionals: true }>
  >
  try {
    parsed = parseArgs({
      args: [...argv],
      options: { format: { type: 'string' }, repo: { type: 'string' } },
      allowPositionals: true,
    })
  } catch (error) {
    throw usage(
      error instanceof Error ? error.message : String(error),
      'factory project check [file] [--repo <dir>] [--format json|plain]',
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
  // a host-local file lives outside its repo: `--repo` names the checkout whose Makefile and name it is judged against
  const repo =
    parsed.values.repo !== undefined ? resolve(parsed.values.repo) : file === '-' ? null : dirname(resolve(file))
  const { problems, warnings } = await checkProject(text, repo, io)
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
    'usage: project schema | project check [file] [--repo <dir>]',
    'factory project schema; factory project check project.yaml; factory project check ~/.config/software-factory/projects/my-repo.yaml --repo ~/SourceRoot/my-repo',
  )
}
