import { type ParseArgsOptionsConfig, parseArgs } from 'node:util'
import type { RoleEntry } from '@software-factory/contract'
import pkg from '../package.json' with { type: 'json' }
import { EXIT, FactoryError, usage } from './exit.ts'
import { OPERATIONS } from './generated/operations.ts'
import { type Io, type Operation, runOperation } from './operation.ts'
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
    'environment:',
    '  FACTORY_URL         the server (default http://127.0.0.1:7793)',
    '  FACTORY_ROLES_FILE  the role table (default: config/roles.json of this checkout or release)',
    '',
    "Data goes to stdout, every failure to stderr as one JSON line; exit codes are agw's (0 ok, 1 general, 2 usage,",
    '3 auth, 4 not found, 5 conflict, 7 network, 8 rate limited, 9 contract mismatch).',
    '',
  ].join('\n')

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

/** Every query parameter of a generated command is a string flag; `--body` carries a JSON body. */
const OPTIONS = {
  format: { type: 'string' },
  help: { type: 'boolean', short: 'h' },
  body: { type: 'string' },
  ...Object.fromEntries(OPERATIONS.flatMap((op) => op.queryParams.map((name) => [name, { type: 'string' }]))),
} as const satisfies ParseArgsOptionsConfig

/** Runs one invocation and returns its exit code. Nothing asks anything. */
export async function run(argv: string[], io: Io): Promise<number> {
  try {
    // `slot run` passes everything after `--` to its command, so it reads its own arguments.
    if (argv[0] === 'slot') return await slotVerb(argv.slice(1), io)
    let parsed: ReturnType<typeof parseArgs<{ options: typeof OPTIONS; allowPositionals: true }>>
    try {
      parsed = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true, strict: true })
    } catch (error) {
      throw usage(error instanceof Error ? error.message : String(error), `${BIN} --help lists the flags`)
    }
    const words = parsed.positionals
    if (parsed.values.help || !words.length) {
      io.out(help())
      return EXIT.ok
    }
    const format = parsed.values.format ?? 'json'
    if (format !== 'json' && format !== 'plain') throw usage(`--format must be json or plain, got: ${format}`)

    if (words.length === 1 && words[0] === 'version') {
      io.out(render(format, { version: pkg.version }, pkg.version))
      return EXIT.ok
    }
    if (words[0] === 'role') {
      await roleVerb(words, format, io)
      return EXIT.ok
    }
    const op = OPERATIONS.find((o) => o.command[0] === words[0] && o.command[1] === words[1])
    if (!op) {
      throw usage(`unknown command: ${words.join(' ')}`, `${BIN} --help lists the commands`)
    }
    await runOperation(op, { args: words.slice(2), flags: parsed.values, format }, io)
    return EXIT.ok
  } catch (error) {
    const failure =
      error instanceof FactoryError
        ? error
        : new FactoryError('general', error instanceof Error ? error.message : String(error))
    io.err(`${failure.toErrorLine()}\n`)
    return failure.exitCode
  }
}
