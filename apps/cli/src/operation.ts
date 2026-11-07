import { send } from '@software-factory/client'
import { ErrorBody } from '@software-factory/contract'
import type * as z from 'zod'
import { FactoryError, kindForStatus, usage } from './exit.ts'
import { type Format, plain, render } from './output.ts'

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
  /** whether it takes a JSON body (`--body <json>`) */
  body: boolean
  /** the contract schema of every answer it declares, by status */
  responses: Readonly<Record<number, z.ZodType>>
}

export const DEFAULT_URL = 'http://127.0.0.1:7793'

export interface Io {
  env: Record<string, string | undefined>
  out(text: string): void
  err(text: string): void
}

export interface Invocation {
  args: readonly string[]
  flags: Readonly<Record<string, string | boolean | undefined>>
  format: Format
}

const commandOf = (op: Operation) => `${op.command[0]} ${op.command[1]}`

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
  if (op.body && typeof raw !== 'string') throw usage(`${commandOf(op)} needs --body <json>`)
  let body: unknown
  if (typeof raw === 'string') {
    try {
      body = JSON.parse(raw)
    } catch {
      throw usage('--body is not JSON')
    }
  }
  return { path, query, body }
}

/**
 * Runs one generated command. A 2xx answer must parse with the contract's schema for its status, else exit 9; any other
 * status is its error kind, with the body printed first when it is one the operation declares (a 503 health).
 */
export async function runOperation(op: Operation, invocation: Invocation, io: Io): Promise<void> {
  const base = io.env.FACTORY_URL || DEFAULT_URL
  const { path, query, body } = request(op, invocation)
  const answer = await send({ base, method: op.method, path, query, body })
  if (!answer.reached) {
    throw new FactoryError('network', `server unreachable at ${base}: ${answer.reason}`, {
      hint: 'is the server up? make verify checks the deployment; factory version works offline',
    })
  }
  const schema = op.responses[answer.status]
  const parsed = schema?.safeParse(answer.json)
  const success = answer.status >= 200 && answer.status < 300
  if (success) {
    if (!parsed?.success) {
      const detail = parsed ? (parsed.error.issues[0]?.message ?? 'unparseable body') : `undeclared ${answer.status}`
      throw new FactoryError('contract_mismatch', `${path} did not answer the shape this CLI expects: ${detail}`, {
        hint: 'the server and the CLI are from different releases',
      })
    }
    io.out(render(invocation.format, parsed.data, plain(parsed.data)))
    return
  }
  if (parsed?.success) {
    io.out(render(invocation.format, parsed.data, plain(parsed.data)))
    throw new FactoryError(kindForStatus(answer.status), `${path} answered ${answer.status}`, {
      details: { status: answer.status },
    })
  }
  const error = ErrorBody.safeParse(answer.json)
  throw new FactoryError(
    kindForStatus(answer.status),
    error.success ? error.data.error : `HTTP ${answer.status}${answer.text ? `: ${answer.text.slice(0, 200)}` : ''}`,
    { code: error.success ? error.data.code : null, details: { status: answer.status } },
  )
}
