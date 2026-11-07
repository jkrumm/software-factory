import { send } from '@software-factory/client'
import { ErrorBody, Health } from '@software-factory/contract'
import type * as z from 'zod'
import { FactoryError, kindForStatus, usage } from './exit.ts'
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
  /** whether it takes a JSON body (`--body <json>` and one flag per property) */
  body: boolean
  /** the properties of the body object, one flag each */
  bodyFields: readonly BodyField[]
  /** the contract schema of every answer it declares, by status */
  responses: Readonly<Record<number, z.ZodType>>
}

export const DEFAULT_URL = 'http://127.0.0.1:7793'

export interface Io {
  env: Record<string, string | undefined>
  out(text: string): void
  err(text: string): void
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

function scalarOf(op: Operation, field: BodyField, text: string): unknown {
  const bad = (what: string) => usage(`${commandOf(op)}: --${field.flag} must be ${what}, got: ${text}`)
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
      try {
        const value: unknown = JSON.parse(text)
        // An untyped property keeps plain text as text (`--title 123` is "123"); only an object or array is JSON.
        return field.untyped && !(isObject(value) || Array.isArray(value)) ? text : value
      } catch {
        if (field.untyped) return text
        throw usage(`${commandOf(op)}: --${field.flag} is not JSON`)
      }
    }
  }
}

function fieldValue(op: Operation, field: BodyField, flag: FlagValue): unknown {
  const texts = Array.isArray(flag) ? flag : [flag]
  const values = texts.map((text) => scalarOf(op, field, typeof text === 'string' ? text : String(text)))
  return field.repeatable ? values : values[values.length - 1]
}

function request(op: Operation, invocation: Invocation) {
  if (invocation.args.length !== op.pathParams.length) {
    const want = op.pathParams.map((name) => `<${name}>`).join(' ')
    throw usage(`usage: ${commandOf(op)}${want ? ` ${want}` : ''}`)
  }
  let path = op.path
  op.pathParams.forEach((name, i) => {
    path = path.replace(`{${name}}`, encodeURIComponent(invocation.args[i] ?? ''))
  })
  const query: Record<string, string> = {}
  for (const name of op.queryParams) {
    const value = invocation.flags[name]
    if (typeof value === 'string') query[name] = value
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
  const given = op.bodyFields.filter((field) => invocation.flags[field.flag] !== undefined)
  if (given.length) {
    if (body !== undefined && !isObject(body))
      throw usage(`${commandOf(op)}: --body must be a JSON object to take flags`)
    // The flags win over the keys of --body.
    body = {
      ...(isObject(body) ? body : {}),
      ...Object.fromEntries(given.map((field) => [field.name, fieldValue(op, field, invocation.flags[field.flag])])),
    }
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
  const { path, query, body } = request(op, invocation)
  const answer = await send({ base, method: op.method, path, query, body, token: tokenOf(io.env) })
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
  throw new FactoryError(
    kind,
    error.success ? error.data.error : `HTTP ${answer.status}${answer.text ? `: ${answer.text.slice(0, 200)}` : ''}`,
    {
      code: error.success ? error.data.code : null,
      ...(answer.status === 401 ? { hint: 'set FACTORY_TOKEN (FACTORY_READ_TOKEN reads only)' } : {}),
      details: { status: answer.status, ...(error.success ? error.data.details : {}) },
    },
  )
}
