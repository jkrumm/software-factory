import { type ParseArgsOptionsConfig, parseArgs } from 'node:util'
import type { RoleEntry } from '@software-factory/contract'
import pkg from '../package.json' with { type: 'json' }
import { EXIT, FactoryError, usage } from './exit.ts'
import { OPERATIONS } from './generated/operations.ts'
import { type BodyField, type FlagValue, type Io, type Operation, runOperation } from './operation.ts'
import { type Format, render } from './output.ts'
import { DEFAULT_ROLES_FILE, loadRoleTable } from './roles.ts'
import { slotVerb } from './slot.ts'

const BIN = 'factory'

const commandWidth = Math.max(24, ...OPERATIONS.map((op) => usageOf(op).length + 2))

function usageOf(op: Operation): string {
  return [...op.command, ...op.pathParams.map((name) => `<${name}>`)].join(' ')
}

const help = (): string =>
  [
    `usage: ${BIN} [--format json|plain] <command>`,
    '',
    'commands:',
    `  ${'version'.padEnd(commandWidth)}the CLI's version`,
    `  ${'role list'.padEnd(commandWidth)}the role table: role, tier, effort (the tracked file, no server)`,
    `  ${'role get <role>'.padEnd(commandWidth)}one role: {"role", "tier", "effort"}; unknown is exit 4`,
    `  ${'slot run [--name <label>] -- <cmd>'.padEnd(commandWidth)}run <cmd> in one of the host's test slots (exit 75: no slot in time; open if the server is down)`,
    ...OPERATIONS.map((op) => `  ${usageOf(op).padEnd(commandWidth)}${op.summary}`),
    '',
    `${BIN} <group> <verb> --help lists a command's flags; a request body is one flag per property, or --body '<json>'.`,
    '',
    'environment:',
    '  FACTORY_URL         the server (default http://127.0.0.1:7793)',
    '  FACTORY_TOKEN       the bearer token (FACTORY_READ_TOKEN when only that is set; reads only)',
    '  FACTORY_ROLES_FILE  the role table (default: config/roles.json of this checkout or release)',
    '',
    "Data goes to stdout, every failure to stderr as one JSON line; exit codes are agw's (0 ok, 1 general, 2 usage,",
    '3 auth, 4 not found, 5 conflict, 7 network, 8 rate limited, 9 contract mismatch).',
    '',
  ].join('\n')

function formatOf(value: string | undefined): Format {
  const format = value ?? 'json'
  if (format !== 'json' && format !== 'plain') throw usage(`--format must be json or plain, got: ${format}`)
  return format
}

const roleLine = (r: RoleEntry) => [r.role, r.tier, r.effort].join('\t')

async function roleVerb(words: string[], format: Format, io: Io): Promise<void> {
  const table = await loadRoleTable(io.env.FACTORY_ROLES_FILE || DEFAULT_ROLES_FILE).catch((error: unknown) => {
    throw new FactoryError('general', error instanceof Error ? error.message : String(error))
  })
  if (words.length === 2 && words[1] === 'list') {
    const roles = [...table.values()]
    return io.out(render(format, { roles }, roles.map(roleLine).join('\n')))
  }
  if (words.length === 3 && words[1] === 'get') {
    const entry = table.get(words[2] ?? '')
    if (!entry) {
      throw new FactoryError('not_found', `unknown role ${words[2]}`, {
        hint: `one of ${[...table.keys()].join(', ')}`,
      })
    }
    return io.out(render(format, entry, roleLine(entry)))
  }
  throw usage('usage: role list | role get <role>')
}

/** The words that name a command: stage 1 only has to find them, so every flag but `--format` is left alone. */
const FIRST_STAGE = {
  format: { type: 'string' },
  help: { type: 'boolean', short: 'h' },
} as const satisfies ParseArgsOptionsConfig

const KIND_HINT = {
  string: '<text>',
  number: '<number>',
  integer: '<integer>',
  boolean: '[true|false]',
  json: '<json>',
} as const

const flagHelp = (field: BodyField): string =>
  [
    `--${field.flag} ${field.untyped ? '<text|json>' : KIND_HINT[field.kind]}`,
    field.required ? 'required' : '',
    field.repeatable ? 'repeatable' : '',
  ]
    .filter(Boolean)
    .join('  ')

/** `factory issue close --help`: the usage line, the summary and every flag with its marks. */
function commandHelp(op: Operation): string {
  const flags = [
    ...op.queryParams.map((name) => `--${name} <text>`),
    ...op.bodyFields.map(flagHelp),
    ...(op.body ? ['--body <json>  the whole body as JSON; a flag overrides its key'] : []),
    '--format json|plain',
  ]
  return [`usage: ${BIN} ${usageOf(op)} [flags]`, '', op.summary, '', 'flags:', ...flags.map((f) => `  ${f}`), ''].join(
    '\n',
  )
}

/** What parseArgs knows about one operation: its query flags, its body fields, and the flags every command has. */
function optionsOf(op: Operation): ParseArgsOptionsConfig {
  return {
    format: { type: 'string' },
    help: { type: 'boolean', short: 'h' },
    body: { type: 'string' },
    ...Object.fromEntries(op.queryParams.map((name) => [name, { type: 'string' }])),
    // A boolean takes `--flag`, `--flag true` and `--flag false`, which parseArgs' boolean type cannot: see `booleansIn`.
    ...Object.fromEntries(
      op.bodyFields.map((field) => [field.flag, { type: 'string', ...(field.repeatable ? { multiple: true } : {}) }]),
    ),
  }
}

/** Rewrites `--flag`, `--flag true` and `--flag false` of the boolean body fields into `--flag=true|false`. */
function booleansIn(op: Operation, argv: readonly string[]): string[] {
  const booleans = new Set(op.bodyFields.filter((field) => field.kind === 'boolean').map((field) => `--${field.flag}`))
  const out: string[] = []
  for (let i = 0; i < argv.length; i++) {
    const word = argv[i] ?? ''
    if (word === '--') {
      out.push(...argv.slice(i))
      break
    }
    if (!booleans.has(word)) {
      out.push(word)
      continue
    }
    const next = argv[i + 1]
    if (next === 'true' || next === 'false') {
      out.push(`${word}=${next}`)
      i++
    } else {
      out.push(`${word}=true`)
    }
  }
  return out
}

/** Stage 2: this operation's own flags, strictly. An unknown flag is a usage error naming the command. */
function parseOperation(op: Operation, argv: readonly string[]) {
  try {
    return parseArgs({ args: booleansIn(op, argv), options: optionsOf(op), allowPositionals: true, strict: true })
  } catch (error) {
    throw usage(
      `${op.command.join(' ')}: ${error instanceof Error ? error.message : String(error)}`,
      `${BIN} ${op.command.join(' ')} --help lists its flags`,
    )
  }
}

/** Runs one invocation and returns its exit code. Nothing asks anything. */
export async function run(argv: string[], io: Io): Promise<number> {
  try {
    // `slot run` passes everything after `--` to its command, so it reads its own arguments.
    if (argv[0] === 'slot') return await slotVerb(argv.slice(1), io)
    // Stage 1 finds the command; flags it does not know are left for stage 2, which knows the command's own.
    const found = parseArgs({ args: argv, options: FIRST_STAGE, allowPositionals: true, strict: false }).positionals
    const op = OPERATIONS.find((o) => o.command[0] === found[0] && o.command[1] === found[1])
    if (op) {
      const parsed = parseOperation(op, argv)
      if (parsed.values.help) {
        io.out(commandHelp(op))
        return EXIT.ok
      }
      const given = parsed.values.format
      const format = formatOf(typeof given === 'string' ? given : undefined)
      await runOperation(
        op,
        { args: parsed.positionals.slice(2), flags: parsed.values as Record<string, FlagValue>, format },
        io,
      )
      return EXIT.ok
    }
    let parsed: ReturnType<typeof parseArgs<{ options: typeof FIRST_STAGE; allowPositionals: true }>>
    try {
      parsed = parseArgs({ args: argv, options: FIRST_STAGE, allowPositionals: true, strict: true })
    } catch (error) {
      throw usage(error instanceof Error ? error.message : String(error), `${BIN} --help lists the flags`)
    }
    const words = parsed.positionals
    if (parsed.values.help || !words.length) {
      io.out(help())
      return EXIT.ok
    }
    const format = formatOf(parsed.values.format)

    if (words.length === 1 && words[0] === 'version') {
      io.out(render(format, { version: pkg.version }, pkg.version))
      return EXIT.ok
    }
    if (words[0] === 'role') {
      await roleVerb(words, format, io)
      return EXIT.ok
    }
    throw usage(`unknown command: ${words.join(' ')}`, `${BIN} --help lists the commands`)
  } catch (error) {
    const failure =
      error instanceof FactoryError
        ? error
        : new FactoryError('general', error instanceof Error ? error.message : String(error))
    io.err(`${failure.toErrorLine()}\n`)
    return failure.exitCode
  }
}
