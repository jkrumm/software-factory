import { type ParseArgsOptionsConfig, parseArgs } from 'node:util'
import type { RoleEntry } from '@software-factory/contract'
import pkg from '../package.json' with { type: 'json' }
import { bodyJsonSchema, fieldNotes, KIND_HINT } from './body-schema.ts'
import { deployLockVerb } from './deploy-lock.ts'
import { doorTokenVerb } from './door.ts'
import { EXIT, FactoryError, usage } from './exit.ts'
import { filingContract, filingGuide } from './filing.ts'
import { followVerb } from './follow.ts'
import { OPERATIONS } from './generated/operations.ts'
import { type BodyField, extensionOf, type FlagValue, type Io, type Operation, runOperation } from './operation.ts'
import { type Format, render } from './output.ts'
import { retiredHint } from './retired.ts'
import { DEFAULT_ROLES_FILE, loadRoleTable } from './roles.ts'
import { slotVerb } from './slot.ts'

const BIN = 'factory'

/** Words that stand for a generated command: `factory health` is `health get`. Checked only when no command has the words. */
const ALIASES: Readonly<Record<string, readonly [string, string]>> = {
  health: ['health', 'get'],
  // The old read verbs: the Herdr board, Hermes and agw call `factory read issue(s)`.
  'read issue': ['issue', 'show'],
  'read issues': ['issue', 'list'],
}

const ALIAS_HELP: readonly [string, string][] = [
  ['health', 'health get; prints the Health body, exit 1 when the server is not ok'],
  ['read issue <id>', 'issue show <id>'],
  ['read issues', 'issue list'],
]

function usageOf(op: Operation): string {
  return [...op.command, ...[...op.pathParams, ...op.args].map((name) => `<${name}>`)].join(' ')
}

const firstSentence = (text: string): string => text.split(/\.(?:\s|$)/)[0] ?? text

const HAND_WRITTEN: readonly [string, string][] = [
  ['version', "the CLI's version"],
  ['role list', 'the role table: role, tier, effort (the tracked file, no server)'],
  ['role get <role>', 'one role: {"role", "tier", "effort"}; unknown is exit 4'],
  [
    'slot run [--name <label>] -- <cmd>',
    "run <cmd> in one of the host's test slots (exit 75: no slot in time; open if the server is down)",
  ],
  [
    'deploy-lock --project <name> -- <cmd>',
    'run <cmd> holding the host-local deploy lock of <name> (waits for a live holder; exit 75: no lock in time or unreadable, closed)',
  ],
  [
    'follow [--issue <id>] [--since <cursor>] [--until-closed]',
    'the change stream, one line per change; Ctrl-C exits 0; --until-closed ends when --issue closes',
  ],
  [
    'door token new <source> [--rotate]',
    "a fresh token for a source in the door's tokens file, printed once (offline)",
  ],
  ['issue schema', 'the Issue-filing contract: facts keys, example, flags, which path to use (offline)'],
  ['hook <event>', 'the Claude Code hook (reads FACTORY_SESSION; never fails the session)'],
]

const help = (operations: readonly Operation[]): string => {
  const rows: [string, string][] = [
    ...HAND_WRITTEN,
    ...operations.map((op): [string, string] => [usageOf(op), firstSentence(op.summary)]),
  ]
  const width = Math.max(24, ...rows.map(([command]) => command.length + 2))
  const line = ([command, text]: [string, string]) => `  ${command.padEnd(width)}${text}`
  return [
    `usage: ${BIN} [--format json|plain] <command>`,
    '',
    'commands:',
    ...rows.map(line),
    '',
    'aliases:',
    ...ALIAS_HELP.map(line),
    '',
    `${BIN} <group> <verb> --help lists a command's flags. A request body is one flag per property, or --body '<json>';`,
    'a body field can be a positional argument after the ids (shown as <text>); a negative number goes after --.',
    "A string or JSON flag or argument takes '-' for all of stdin and '@path' for a file ('@@x' is the text '@x').",
    '',
    'environment:',
    '  FACTORY_URL         the server (default http://127.0.0.1:7793)',
    "  FACTORY_TOKEN       the bearer token (a lead's agent token, the orchestrator's); always wins",
    '  FACTORY_READ_TOKEN  used when FACTORY_TOKEN is not set; reads only',
    "                      with neither set, on the host the owner token is resolved from the deployed release's",
    '                      .env.tpl through secrets-run (offline commands never resolve one)',
    '  FACTORY_ROOT        the deployed releases (default ~/.software-factory)',
    '  FACTORY_ROLES_FILE  the role table (default: config/roles.json of this checkout or release)',
    '',
    "Data goes to stdout, every failure to stderr as one JSON line; exit codes are agw's (0 ok, 1 general, 2 usage,",
    '3 auth, 4 not found, 5 conflict, 7 network, 8 rate limited, 9 contract mismatch).',
    '',
  ].join('\n')
}

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

const flagHelp = (op: Operation, field: BodyField): string => {
  if (op.bodySchema) {
    const { hint, notes } = fieldNotes(op, field)
    return [`--${field.flag} ${hint}`, field.required ? 'required' : '', ...notes].filter(Boolean).join('  ')
  }
  return [
    `--${field.flag} ${field.untyped ? '<text|json>' : KIND_HINT[field.kind]}`,
    field.required ? 'required' : '',
    field.repeatable ? 'repeatable' : '',
  ]
    .filter(Boolean)
    .join('  ')
}

/** `factory issue close --help`: the usage line, the summary and every flag with its marks. */
function commandHelp(op: Operation): string {
  const flags = [
    ...op.queryParams.map((name) => {
      const bare = op.queryFlags.find((flag) => flag.name === name)
      if (op.issueParams?.includes(name)) return `--${name} <issue-id>  issue_<n> or a bare <n>`
      return bare?.boolean ? `--${name} [true|false]` : bare ? `--${name}` : `--${name} <text>`
    }),
    ...op.bodyFields.filter((field) => !op.args.includes(field.name)).map((field) => flagHelp(op, field)),
    ...(op.body ? ['--body <json>  the whole body as JSON; a flag overrides its key'] : []),
    ...(op.body && op.bodySchema ? ["--schema  print the body's JSON Schema and exit"] : []),
    '--format json|plain',
  ]
  const extra = extensionOf(op)?.help
  const notes = op.bodyFields.some((field) => field.kind === 'string' || field.kind === 'json')
    ? ["A string or JSON value: '-' reads stdin, '@path' a file ('@@x' is the text '@x').", '']
    : []
  return [
    `usage: ${BIN} ${usageOf(op)} [flags]`,
    '',
    op.summary,
    '',
    'flags:',
    ...flags.map((f) => `  ${f}`),
    '',
    ...notes,
    ...(extra ? [extra, ''] : []),
  ].join('\n')
}

/** What parseArgs knows about one operation: its query flags, its body fields, and the flags every command has. */
function optionsOf(op: Operation): ParseArgsOptionsConfig {
  return {
    format: { type: 'string' },
    help: { type: 'boolean', short: 'h' },
    body: { type: 'string' },
    schema: { type: 'boolean' },
    ...Object.fromEntries(op.queryParams.map((name) => [name, { type: 'string' }])),
    // A boolean takes `--flag`, `--flag true` and `--flag false`, which parseArgs' boolean type cannot: see `bareFlagsIn`.
    ...Object.fromEntries(
      op.bodyFields.map((field) => [field.flag, { type: 'string', ...(field.repeatable ? { multiple: true } : {}) }]),
    ),
  }
}

/**
 * Rewrites the bare flags into `--flag=value`: `--flag`, `--flag true` and `--flag false` of a boolean (body field or
 * query parameter), and `--flag` of a query enum of one value (which sends that value).
 */
function bareFlagsIn(op: Operation, argv: readonly string[]): string[] {
  const booleans = new Set([
    ...op.bodyFields.filter((field) => field.kind === 'boolean').map((field) => `--${field.flag}`),
    ...op.queryFlags.filter((flag) => flag.boolean).map((flag) => `--${flag.name}`),
  ])
  const switches = new Map(op.queryFlags.filter((flag) => !flag.boolean).map((flag) => [`--${flag.name}`, flag.value]))
  const out: string[] = []
  for (let i = 0; i < argv.length; i++) {
    const word = argv[i] ?? ''
    if (word === '--') {
      out.push(...argv.slice(i))
      break
    }
    const sends = switches.get(word)
    if (sends !== undefined) {
      out.push(`${word}=${sends}`)
      continue
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
    return parseArgs({ args: bareFlagsIn(op, argv), options: optionsOf(op), allowPositionals: true, strict: true })
  } catch (error) {
    throw usage(
      `${op.command.join(' ')}: ${error instanceof Error ? error.message : String(error)}`,
      `${BIN} ${op.command.join(' ')} --help lists its flags`,
    )
  }
}

/** `argv` with the leading words of an alias replaced by the command they stand for; unchanged when none is. */
function expandAlias(argv: readonly string[], words: readonly { value: string; index: number }[]): string[] {
  for (const length of [2, 1]) {
    const leading = words.slice(0, length)
    const target = ALIASES[leading.map((word) => word.value).join(' ')]
    const first = leading[0]
    if (!target || !first || leading.length < length) continue
    const dropped = new Set(leading.map((word) => word.index))
    return argv.flatMap((word, i) => (i === first.index ? target : dropped.has(i) ? [] : [word]))
  }
  return [...argv]
}

/** `factory issue schema`: the filing contract, plain by default (it is read by people), JSON with `--format json`. */
function issueSchemaVerb(argv: readonly string[], io: Io): number {
  let values: { format?: string }
  try {
    values = parseArgs({
      args: [...argv],
      options: { format: { type: 'string' }, help: { type: 'boolean', short: 'h' } },
      allowPositionals: false,
    }).values
  } catch (error) {
    throw usage(error instanceof Error ? error.message : String(error), `${BIN} issue schema [--format json|plain]`)
  }
  const format = formatOf(values.format ?? 'plain')
  io.out(render(format, filingContract(), filingGuide()))
  return EXIT.ok
}

/** Runs one invocation and returns its exit code. Nothing asks anything. `operations` is the generated table (a test passes its own). */
export async function run(argv: string[], io: Io, operations: readonly Operation[] = OPERATIONS): Promise<number> {
  try {
    // `slot run` passes everything after `--` to its command, so it reads its own arguments.
    if (argv[0] === 'slot') return await slotVerb(argv.slice(1), io)
    if (argv[0] === 'deploy-lock') return await deployLockVerb(argv.slice(1), io)
    if (argv[0] === 'follow') return await followVerb(argv.slice(1), io)
    if (argv[0] === 'issue' && argv[1] === 'schema') return issueSchemaVerb(argv.slice(2), io)
    if (argv[0] === 'door' && argv[1] === 'token') return doorTokenVerb(argv.slice(2), io)
    // Stage 1 finds the command; flags it does not know are left for stage 2, which knows the command's own.
    const tokens = parseArgs({ args: argv, options: FIRST_STAGE, allowPositionals: true, strict: false, tokens: true })
    const positionals = tokens.tokens.flatMap((token) =>
      token.kind === 'positional' ? [{ value: token.value, index: token.index }] : [],
    )
    const found = positionals.map((word) => word.value)
    const op = operations.find((o) => o.command[0] === found[0] && o.command[1] === found[1])
    if (op) {
      const parsed = parseOperation(op, argv)
      if (parsed.values.help) {
        io.out(commandHelp(op))
        return EXIT.ok
      }
      if (parsed.values.schema) {
        if (!op.body || !op.bodySchema) throw usage(`${op.command.join(' ')} takes no body`)
        io.out(JSON.stringify(bodyJsonSchema(op), null, 2))
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
    const expanded = expandAlias(argv, positionals)
    if (expanded.join('\0') !== argv.join('\0')) return await run(expanded, io, operations)
    const replacement = retiredHint(found)
    if (replacement) throw usage(`${BIN} ${found.slice(0, 3).join(' ')} is retired`, `use: ${replacement}`)
    let parsed: ReturnType<typeof parseArgs<{ options: typeof FIRST_STAGE; allowPositionals: true }>>
    try {
      parsed = parseArgs({ args: argv, options: FIRST_STAGE, allowPositionals: true, strict: true })
    } catch (error) {
      throw usage(error instanceof Error ? error.message : String(error), `${BIN} --help lists the flags`)
    }
    const words = parsed.positionals
    if (parsed.values.help || !words.length) {
      io.out(help(operations))
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
