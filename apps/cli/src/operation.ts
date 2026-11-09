import { send } from '@software-factory/client'
import { ErrorBody, Health } from '@software-factory/contract'
import type * as z from 'zod'
import { FactoryError, kindForStatus, usage } from './exit.ts'
import { OPERATION_EXTENSIONS } from './filing.ts'
import { type Format, plain, render } from './output.ts'

export type FieldKind = 'string' | 'number' | 'integer' | 'boolean' | 'json'

/** One property of a request body, as a flag: `--<flag> <value>`. */
export interface BodyField {
  /** the property's name in the body */
  name: string
  /** the flag, without the dashes: the name in kebab-case */
  flag: string
  kind: FieldKind
  /** an array of scalars: the flag may repeat (`--commit a --commit b`) */
  repeatable: boolean
  /** the contract requires it (the server answers 422 when it is missing; the CLI does not check) */
  required: boolean
  /** a property with no type in the contract (`z.unknown()`): a value that is JSON for an object or array, else the text */
  untyped: boolean
}

/** A query parameter that is a bare flag: a boolean (`--live`, `--live false`) or an enum of one value (`--live` sends it). */
export interface QueryFlag {
  name: string
  /** a boolean also takes `true` and `false` after it; an enum of one value takes nothing */
  boolean: boolean
  /** what a bare flag sends: `true` for a boolean, the enum's value otherwise */
  value: string
}

/** One operation of the OpenAPI document as the generator writes it: `factory <group> <verb>`. */
export interface Operation {
  operationId: string
  command: readonly [string, string]
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
  /** the OpenAPI path, `{name}` for a path parameter */
  path: string
  summary: string
  /** path parameters in order: the command's positional arguments */
  pathParams: readonly string[]
  /** query parameters: one `--<name> <value>` flag each */
  queryParams: readonly string[]
  /** the query parameters (a subset of `queryParams`) that are bare flags */
  queryFlags: readonly QueryFlag[]
  /** whether it takes a JSON body (`--body <json>` and one flag per property) */
  body: boolean
  /** the properties of the body object, one flag each */
  bodyFields: readonly BodyField[]
  /** body fields (names) that follow the path parameters as positional arguments, in order: `x-cli.args` of the route */
  args: readonly string[]
  /** the contract schema of every answer it declares, by status */
  responses: Readonly<Record<number, z.ZodType>>
}

/** What one command says beyond its generated contract (the table is `OPERATION_EXTENSIONS`). */
export interface OperationExtension {
  /** appended to `<command> --help` */
  help?: string
  /** json body fields that must be an object, by name, with the hint a value that is not one gets */
  jsonObjectFields?: Readonly<Record<string, string>>
  /** the hint of a failing answer, by status; wins over the default */
  statusHints?: Readonly<Record<number, string>>
}

export const extensionOf = (op: Operation): OperationExtension | undefined => OPERATION_EXTENSIONS[op.operationId]

export const DEFAULT_URL = 'http://127.0.0.1:7793'

/**
 * Operations whose server side waits on git, agw or a running pass for up to the server's idle timeout (255 s,
 * apps/server/src/main.ts). The transport's 10 s default would report "unreachable" while the server finishes and
 * records the call; these wait a little longer than the server does, so the server's answer is the one that comes back.
 */
export const LONG_OPERATION_TIMEOUT_MS = 300_000
const LONG_OPERATIONS: ReadonlySet<string> = new Set(['issue.ship', 'loop.run'])

export const timeoutOf = (op: Operation): number | undefined =>
  LONG_OPERATIONS.has(op.operationId) ? LONG_OPERATION_TIMEOUT_MS : undefined

export interface Io {
  env: Record<string, string | undefined>
  out(text: string): void
  err(text: string): void
  /** the whole of stdin: the value `-` of a string or json flag */
  stdin(): Promise<string>
  /** a file as UTF-8 text: the value `@path` of a string or json flag; rejects when it cannot be read */
  readFile(path: string): Promise<string>
}

export type FlagValue = string | boolean | string[] | undefined

export interface Invocation {
  args: readonly string[]
  flags: Readonly<Record<string, FlagValue>>
  format: Format
}

/** The bearer token of this process: the owner's, else the read token. None, nothing is sent and the server answers 401. */
export const tokenOf = (env: Io['env']): string | undefined => env.FACTORY_TOKEN || env.FACTORY_READ_TOKEN || undefined

const commandOf = (op: Operation) => `${op.command[0]} ${op.command[1]}`

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** What a flag or positional is called in a message: `--text`, or `<text>` for a positional argument. */
type Label = string

function scalarOf(op: Operation, field: BodyField, label: Label, text: string): unknown {
  const bad = (what: string) => usage(`${commandOf(op)}: ${label} must be ${what}, got: ${text}`)
  switch (field.kind) {
    case 'string':
      return text
    case 'number':
    case 'integer': {
      const n = Number(text)
      if (text.trim() === '' || !Number.isFinite(n)) throw bad('a number')
      if (field.kind === 'integer' && !Number.isInteger(n)) throw bad('an integer')
      return n
    }
    case 'boolean':
      if (text === 'true' || text === 'false') return text === 'true'
      throw bad('true or false')
    case 'json': {
      const objectHint = extensionOf(op)?.jsonObjectFields?.[field.name]
      try {
        const value: unknown = JSON.parse(text)
        if (objectHint !== undefined && !isObject(value)) {
          const got = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value
          throw usage(`${commandOf(op)}: ${label} must be a JSON object, got ${got}`, objectHint)
        }
        // An untyped property keeps plain text as text (`--title 123` is "123"); only an object or array is JSON.
        return field.untyped && !(isObject(value) || Array.isArray(value)) ? text : value
      } catch (error) {
        if (error instanceof FactoryError) throw error
        if (field.untyped) return text
        throw usage(`${commandOf(op)}: ${label} is not JSON`, objectHint)
      }
    }
  }
}

/**
 * The text of a string or json value: `-` is the whole of stdin, `@path` that file, `@@text` the literal `@text`. Any
 * other kind (a number, a boolean) is the text as given.
 */
async function sourceOf(op: Operation, field: BodyField, label: Label, text: string, io: Io): Promise<string> {
  if (field.kind !== 'string' && field.kind !== 'json') return text
  if (text === '-') return io.stdin()
  if (text.startsWith('@@')) return text.slice(1)
  if (!text.startsWith('@')) return text
  const path = text.slice(1)
  try {
    return await io.readFile(path)
  } catch {
    throw usage(`${commandOf(op)}: ${label}: cannot read ${path}`)
  }
}

async function fieldValue(op: Operation, field: BodyField, label: Label, given: FlagValue, io: Io): Promise<unknown> {
  const texts = Array.isArray(given) ? given : [given]
  const values: unknown[] = []
  for (const text of texts) {
    const raw = typeof text === 'string' ? text : String(text)
    values.push(scalarOf(op, field, label, await sourceOf(op, field, label, raw, io)))
  }
  return field.repeatable ? values : values[values.length - 1]
}

const queryValue = (op: Operation, flag: QueryFlag, text: string): string => {
  const allowed = flag.boolean ? ['true', 'false'] : [flag.value]
  if (allowed.includes(text)) return text
  throw usage(`${commandOf(op)}: --${flag.name} takes ${allowed.map((a) => `"${a}"`).join(' or ')}, got: ${text}`)
}

async function request(op: Operation, invocation: Invocation, ioOf: Io) {
  const want = op.pathParams.length + op.args.length
  if (invocation.args.length !== want) {
    const names = [...op.pathParams, ...op.args].map((name) => `<${name}>`).join(' ')
    throw usage(`usage: ${commandOf(op)}${names ? ` ${names}` : ''}`)
  }
  let path = op.path
  op.pathParams.forEach((name, i) => {
    path = path.replace(`{${name}}`, encodeURIComponent(invocation.args[i] ?? ''))
  })
  const query: Record<string, string> = {}
  for (const name of op.queryParams) {
    const value = invocation.flags[name]
    if (typeof value !== 'string') continue
    const bare = op.queryFlags.find((flag) => flag.name === name)
    query[name] = bare ? queryValue(op, bare, value) : value
  }
  const raw = invocation.flags.body
  if (raw !== undefined && !op.body) throw usage(`${commandOf(op)} takes no --body`)
  let body: unknown
  if (typeof raw === 'string') {
    try {
      body = JSON.parse(raw)
    } catch {
      throw usage('--body is not JSON')
    }
  }
  // One read of stdin serves every `-` of the invocation.
  let stdinText: Promise<string> | undefined
  const io: Io = {
    ...ioOf,
    stdin: () => {
      stdinText ??= ioOf.stdin()
      return stdinText
    },
  }
  const entries: [BodyField, Label, FlagValue][] = []
  op.args.forEach((name, i) => {
    const field = op.bodyFields.find((f) => f.name === name)
    if (!field) throw new FactoryError('general', `${commandOf(op)}: positional ${name} is not a body property`)
    if (invocation.flags[field.flag] !== undefined) {
      throw usage(`${commandOf(op)}: ${name} is the positional <${name}>, not a flag`)
    }
    entries.push([field, `<${name}>`, invocation.args[op.pathParams.length + i]])
  })
  for (const field of op.bodyFields) {
    const given = invocation.flags[field.flag]
    if (given !== undefined) entries.push([field, `--${field.flag}`, given])
  }
  if (entries.length) {
    if (body !== undefined && !isObject(body))
      throw usage(`${commandOf(op)}: --body must be a JSON object to take flags`)
    const fields: Record<string, unknown> = {}
    for (const [field, label, given] of entries) {
      fields[field.name] = await fieldValue(op, field, label, given, io)
    }
    // The flags and positionals win over the keys of --body.
    body = { ...(isObject(body) ? body : {}), ...fields }
  }
  // A missing required field is the server's to refuse (422 with the fields named), not the CLI's.
  if (op.body && body === undefined) body = {}
  return { path, query, body }
}

/**
 * Runs one generated command. Data goes to stdout for a 2xx only and must parse with the contract's schema for its
 * status, else exit 9. Every other answer is a failure: one JSON error line on stderr (the body's `code` and `error`,
 * `details` = `{status, ...body.details}`) and the exit code of its status.
 */
export async function runOperation(op: Operation, invocation: Invocation, io: Io): Promise<void> {
  const base = io.env.FACTORY_URL || DEFAULT_URL
  const { path, query, body } = await request(op, invocation, io)
  const answer = await send({
    base,
    method: op.method,
    path,
    query,
    body,
    token: tokenOf(io.env),
    timeoutMs: timeoutOf(op),
  })
  if (!answer.reached) {
    throw new FactoryError('network', `server unreachable at ${base}: ${answer.reason}`, {
      hint: 'is the server up? make verify checks the deployment; factory version works offline',
    })
  }
  const schema = op.responses[answer.status]
  const parsed = schema?.safeParse(answer.json)
  if (answer.status >= 200 && answer.status < 300) {
    if (!parsed?.success) {
      const detail = parsed ? (parsed.error.issues[0]?.message ?? 'unparseable body') : `undeclared ${answer.status}`
      throw new FactoryError('contract_mismatch', `${path} did not answer the shape this CLI expects: ${detail}`, {
        hint: 'the server and the CLI are from different releases',
      })
    }
    io.out(render(invocation.format, parsed.data, plain(parsed.data)))
    return
  }
  const kind = kindForStatus(answer.status)
  // The one failure that also puts data on stdout: `health get` on a 503 prints its Health body, because the Uptime
  // pusher and verify.sh read stdout; the error line below goes to stderr like every other failure.
  if (schema === Health && parsed?.success) {
    io.out(render(invocation.format, parsed.data, plain(parsed.data)))
    throw new FactoryError(kind, `${path} answered ${answer.status}`, { details: { status: answer.status } })
  }
  const error = ErrorBody.safeParse(answer.json)
  const hint =
    extensionOf(op)?.statusHints?.[answer.status] ??
    (answer.status === 401 ? 'set FACTORY_TOKEN (FACTORY_READ_TOKEN reads only)' : undefined)
  throw new FactoryError(
    kind,
    error.success ? error.data.error : `HTTP ${answer.status}${answer.text ? `: ${answer.text.slice(0, 200)}` : ''}`,
    {
      code: error.success ? error.data.code : null,
      ...(hint ? { hint } : {}),
      details: { status: answer.status, ...(error.success ? error.data.details : {}) },
    },
  )
}
