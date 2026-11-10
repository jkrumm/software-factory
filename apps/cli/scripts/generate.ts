#!/usr/bin/env bun
/**
 * Writes `apps/cli/src/generated/operations.ts`: one `factory <group> <verb>` command per operation of the server's
 * OpenAPI document, built in-process (no port, no database). `--check` compares instead of writing and exits 1 when the
 * committed file is stale; `make check` runs it that way.
 */
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import * as contract from '@software-factory/contract'
import { createApp, OPENAPI_PATH } from '@software-factory/server/app'
import * as z from 'zod'
import type { BodyField, QueryFlag } from '../src/operation.ts'

export const OUTPUT = join(import.meta.dir, '..', 'src', 'generated', 'operations.ts')

/** Words the hand-written verbs own; a generated group may not take one. */
export const RESERVED_GROUPS = ['version', 'role', 'help', 'hook', 'slot', 'follow']

/** Flags the CLI itself owns (`run.ts`); a query parameter or a body property may not take one. */
export const RESERVED_FLAGS = ['format', 'help', 'body', 'schema']

const OPERATION_ID = /^([a-z][a-z0-9-]*)\.([a-z][a-z0-9-]*)$/
const METHODS = ['get', 'post', 'put', 'patch', 'delete'] as const
const SCHEMA_REF = /^#\/\$defs\/([A-Za-z][A-Za-z0-9]*)$/

const Parameter = z.object({ name: z.string(), in: z.string(), schema: z.unknown().optional() })
const namesIssue = (schema: unknown): boolean => isJson(schema) && schema['x-id'] === 'issue'
/** `detail['x-cli']` of a route: the body fields that are positional arguments after the path parameters. */
const CliExtension = z.object({ args: z.array(z.string()) })
const Response = z.object({
  content: z.record(z.string(), z.object({ schema: z.object({ $ref: z.string().optional() }).loose() })).optional(),
})
const Op = z
  .object({
    operationId: z.string().optional(),
    summary: z.string().optional(),
    parameters: z.array(Parameter).optional(),
    requestBody: z.unknown().optional(),
    responses: z.record(z.string(), Response),
  })
  .loose()
const Document = z.object({ paths: z.record(z.string(), z.record(z.string(), z.unknown())) }).loose()

interface Generated {
  operationId: string
  command: [string, string]
  method: string
  path: string
  summary: string
  pathParams: string[]
  queryParams: string[]
  queryFlags: QueryFlag[]
  /** the query parameters (names) that name an Issue: `x-id: issue` in the contract */
  issueParams: string[]
  body: boolean
  bodyFields: BodyField[]
  args: string[]
  /** the contract schema of the request body */
  bodySchema: string | null
  responses: [number, string][]
}

type Json = Record<string, unknown>
const isJson = (value: unknown): value is Json => typeof value === 'object' && value !== null && !Array.isArray(value)
const jsonList = (value: unknown): Json[] => (Array.isArray(value) ? value.filter(isJson) : [])

/** Follows `$ref` (`#/$defs/Name`, relative to the schema the document nests it in) until a schema with a body. */
function resolve(schema: Json, root: Json): Json {
  let current = schema
  for (let depth = 0; depth < 20 && typeof current.$ref === 'string'; depth++) {
    const name = SCHEMA_REF.exec(current.$ref)?.[1]
    const target = name && isJson(root.$defs) ? root.$defs[name] : undefined
    if (!isJson(target)) return current
    current = target
  }
  return current
}

/** The properties of an object schema; `allOf` merges its members, `anyOf`/`oneOf` take every member's (required: only what all require). */
function objectOf(schema: Json, root: Json): { properties: Json; required: Set<string> } {
  const self = resolve(schema, root)
  const properties: Json = isJson(self.properties) ? { ...self.properties } : {}
  const required = new Set<string>(
    Array.isArray(self.required) ? self.required.filter((r) => typeof r === 'string') : [],
  )
  for (const member of jsonList(self.allOf)) {
    const inner = objectOf(member, root)
    Object.assign(properties, inner.properties)
    for (const name of inner.required) required.add(name)
  }
  for (const key of ['anyOf', 'oneOf'] as const) {
    const members = jsonList(self[key]).map((member) => objectOf(member, root))
    if (!members.length) continue
    for (const member of members) Object.assign(properties, member.properties)
    for (const name of members[0]?.required ?? []) {
      if (members.every((member) => member.required.has(name))) required.add(name)
    }
  }
  return { properties, required }
}

const SCALARS = ['string', 'number', 'integer', 'boolean'] as const
type Scalar = (typeof SCALARS)[number]

/** The one non-null type of a schema, or nothing when it is untyped, mixed or not a single scalar/array/object. */
function typeOf(schema: Json, root: Json): { type: Scalar | 'array' | 'object'; schema: Json } | null {
  const self = resolve(schema, root)
  const alternatives = [...jsonList(self.anyOf), ...jsonList(self.oneOf)].filter((member) => member.type !== 'null')
  if (alternatives.length === 1 && alternatives[0]) return typeOf(alternatives[0], root)
  if (alternatives.length > 1) return null
  const members = jsonList(self.allOf)
  if (members.length === 1 && members[0] && self.type === undefined) return typeOf(members[0], root)
  const types = (Array.isArray(self.type) ? self.type : [self.type]).filter(
    (t) => typeof t === 'string' && t !== 'null',
  )
  const type = types[0]
  if (types.length !== 1 || typeof type !== 'string')
    return types.length === 0 && Array.isArray(self.enum) ? { type: 'string', schema: self } : null
  if (type === 'array' || type === 'object' || (SCALARS as readonly string[]).includes(type)) {
    return { type: type as Scalar | 'array' | 'object', schema: self }
  }
  return null
}

export const kebab = (name: string): string =>
  name
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replaceAll('_', '-')
    .toLowerCase()

/** A query parameter that is a boolean or an enum of one value: a bare flag. */
function queryFlagOf(name: string, schema: unknown): QueryFlag | null {
  if (!isJson(schema)) return null
  const typed = typeOf(schema, schema)
  if (typed?.type === 'boolean') return { name, boolean: true, value: 'true' }
  const only =
    typed && Array.isArray(typed.schema.enum) && typed.schema.enum.length === 1
      ? typed.schema.enum[0]
      : typed?.schema.const
  return typeof only === 'string' ? { name, boolean: false, value: only } : null
}

/** One property of the body as a flag. */
function fieldOf(name: string, schema: Json, required: boolean, root: Json): BodyField {
  const flag = kebab(name)
  const typed = typeOf(schema, root)
  const base = { name, flag, required: required && !('default' in resolve(schema, root)) }
  if (!typed) return { ...base, kind: 'json', repeatable: false, untyped: true }
  if (typed.type === 'object') return { ...base, kind: 'json', repeatable: false, untyped: false }
  if (typed.type === 'array') {
    const item = isJson(typed.schema.items) ? typeOf(typed.schema.items, root) : null
    if (item && item.type !== 'array' && item.type !== 'object') {
      return { ...base, kind: item.type, repeatable: true, untyped: false }
    }
    return { ...base, kind: 'json', repeatable: false, untyped: false }
  }
  return { ...base, kind: typed.type, repeatable: false, untyped: false }
}

/** The flags of a request body: one per property of its object; none when the body is not an object. */
export function bodyFieldsOf(requestBody: unknown): BodyField[] {
  if (!isJson(requestBody) || !isJson(requestBody.content)) return []
  const media = requestBody.content['application/json']
  const root = isJson(media) && isJson(media.schema) ? media.schema : null
  if (!root) return []
  const { properties, required } = objectOf(root, root)
  return Object.entries(properties).map(([name, schema]) =>
    fieldOf(name, isJson(schema) ? schema : {}, required.has(name), root),
  )
}

/** The contract export whose zod schema carries this id, or nothing. */
const contractSchema = (id: string): boolean => {
  const value: unknown = (contract as Record<string, unknown>)[id]
  return value instanceof z.ZodType && z.globalRegistry.get(value)?.id === id
}

/** The `$ref` of the JSON request body's schema, or nothing. */
function bodyRefOf(requestBody: unknown): string | undefined {
  if (!isJson(requestBody) || !isJson(requestBody.content)) return undefined
  const media = requestBody.content['application/json']
  return isJson(media) && isJson(media.schema) && typeof media.schema.$ref === 'string' ? media.schema.$ref : undefined
}

/** Every operation of the document, checked; throws one message per broken operation. */
export function operationsOf(document: unknown): Generated[] {
  const doc = Document.parse(document)
  const problems: string[] = []
  const out: Generated[] = []
  for (const path of Object.keys(doc.paths).sort()) {
    const item = doc.paths[path] ?? {}
    for (const method of METHODS) {
      if (!(method in item)) continue
      const where = `${method.toUpperCase()} ${path}`
      const op = Op.parse(item[method])
      const id = op.operationId ?? ''
      const match = OPERATION_ID.exec(id)
      if (!match?.[1] || !match[2]) {
        problems.push(`${where}: operationId "${id}" is not <group>.<verb>`)
        continue
      }
      if (RESERVED_GROUPS.includes(match[1])) problems.push(`${where}: group "${match[1]}" is a hand-written verb`)
      const responses: [number, string][] = []
      for (const [status, response] of Object.entries(op.responses)) {
        const ref = response.content?.['application/json']?.schema.$ref ?? ''
        const name = SCHEMA_REF.exec(ref)?.[1]
        if (!name || !contractSchema(name)) {
          problems.push(
            `${where}: the ${status} answer is not a contract schema with .meta({ id }) (${ref || 'no body'})`,
          )
          continue
        }
        responses.push([Number(status), name])
      }
      const bodyRef = bodyRefOf(op.requestBody)
      const bodyName = bodyRef ? SCHEMA_REF.exec(bodyRef)?.[1] : undefined
      if (op.requestBody !== undefined && (!bodyName || !contractSchema(bodyName))) {
        problems.push(
          `${where}: the request body is not a contract schema with .meta({ id }) (${bodyRef || 'no $ref'})`,
        )
      }
      const queries = (op.parameters ?? []).filter((p) => p.in === 'query')
      const queryParams = queries.map((p) => p.name)
      const issueParams = queries.filter((p) => namesIssue(p.schema)).map((p) => p.name)
      const queryFlags = queries.flatMap((p) => queryFlagOf(p.name, p.schema) ?? [])
      for (const name of queryParams.filter((q) => RESERVED_FLAGS.includes(q))) {
        problems.push(`${where}: query parameter "${name}" is a flag the CLI owns`)
      }
      const pathParams = [...path.matchAll(/\{([^}]+)\}/g)].flatMap((m) => (m[1] ? [m[1]] : []))
      const bodyFields = bodyFieldsOf(op.requestBody)
      const taken = new Map<string, string>([
        ...RESERVED_FLAGS.map((flag): [string, string] => [flag, 'a flag the CLI owns']),
        ...pathParams.map((name): [string, string] => [name, 'a path parameter']),
        ...queryParams.map((name): [string, string] => [name, 'a query parameter']),
      ])
      for (const field of bodyFields) {
        const clash = taken.get(field.flag)
        if (clash) {
          problems.push(
            `${where}: body property "${field.name}" becomes --${field.flag}, which is ${clash}: rename it in the contract`,
          )
        }
        taken.set(field.flag, `the flag of body property "${field.name}"`)
      }
      const extension = CliExtension.safeParse(op['x-cli'])
      if (op['x-cli'] !== undefined && !extension.success) problems.push(`${where}: x-cli must be { args: string[] }`)
      const args = extension.success ? extension.data.args : []
      for (const name of args) {
        if (!bodyFields.some((field) => field.name === name)) {
          problems.push(`${where}: x-cli arg "${name}" is not a property of the body`)
        }
        if (args.indexOf(name) !== args.lastIndexOf(name))
          problems.push(`${where}: x-cli arg "${name}" is listed twice`)
      }
      out.push({
        operationId: id,
        command: [match[1], match[2]],
        method: method.toUpperCase(),
        path,
        summary: op.summary ?? '',
        pathParams,
        queryParams,
        queryFlags,
        issueParams,
        body: op.requestBody !== undefined,
        bodyFields,
        args,
        bodySchema: bodyName && contractSchema(bodyName) ? bodyName : null,
        responses,
      })
    }
  }
  const commands = out.map((op) => op.command.join(' '))
  const twice = commands.find((command, i) => commands.indexOf(command) !== i)
  if (twice) problems.push(`two operations are "factory ${twice}"`)
  if (problems.length) throw new Error(problems.join('\n'))
  return out
}

const quote = (value: string): string => `'${value.replaceAll('\\', '\\\\').replaceAll("'", "\\'")}'`
const list = (values: string[]): string => `[${values.map(quote).join(', ')}]`

const flagText = (flag: QueryFlag): string =>
  `{ name: ${quote(flag.name)}, boolean: ${String(flag.boolean)}, value: ${quote(flag.value)} }`

const fieldText = (field: BodyField): string =>
  `{ name: ${quote(field.name)}, flag: ${quote(field.flag)}, kind: ${quote(field.kind)}, repeatable: ${String(field.repeatable)}, required: ${String(field.required)}, untyped: ${String(field.untyped)} }`

/** The file's text: deterministic, so a rerun on the same document writes the same bytes. */
export function render(operations: Generated[]): string {
  const schemas = [
    ...new Set(
      operations.flatMap((op) => [...op.responses.map(([, name]) => name), ...(op.bodySchema ? [op.bodySchema] : [])]),
    ),
  ].sort()
  const entries = operations.map((op) =>
    [
      '  {',
      `    operationId: ${quote(op.operationId)},`,
      `    command: ${list(op.command)},`,
      `    method: ${quote(op.method)},`,
      `    path: ${quote(op.path)},`,
      `    summary: ${quote(op.summary)},`,
      `    pathParams: ${list(op.pathParams)},`,
      `    queryParams: ${list(op.queryParams)},`,
      `    body: ${String(op.body)},`,
      ...(op.issueParams.length ? [`    issueParams: ${list(op.issueParams)},`] : []),
      `    queryFlags: [${op.queryFlags.map(flagText).join(', ')}],`,
      `    bodyFields: [${op.bodyFields.map(fieldText).join(', ')}],`,
      `    args: ${list(op.args)},`,
      ...(op.bodySchema ? [`    bodySchema: ${op.bodySchema},`] : []),
      `    responses: { ${op.responses.map(([status, name]) => `${status}: ${name}`).join(', ')} },`,
      '  },',
    ].join('\n'),
  )
  return [
    "// Generated by apps/cli/scripts/generate.ts from the server's OpenAPI document. Do not edit:",
    '// `bun apps/cli/scripts/generate.ts` rewrites it, and `make check` fails while it is stale.',
    ...(schemas.length ? [`import { ${schemas.join(', ')} } from '@software-factory/contract'`] : []),
    "import type { Operation } from '../operation.ts'",
    '',
    'export const OPERATIONS: readonly Operation[] = [',
    ...entries,
    ']',
    '',
  ].join('\n')
}

const ROOT = join(import.meta.dir, '..', '..', '..')

/** Formats the file with the repo's oxfmt, so `oxfmt --check` and the staleness check never disagree. */
export async function format(text: string): Promise<string> {
  const proc = Bun.spawn([join(ROOT, 'node_modules', '.bin', 'oxfmt'), `--stdin-filepath=${OUTPUT}`], {
    cwd: ROOT,
    stdin: new Blob([text]),
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [out, err, code] = await Promise.all([proc.stdout.text(), proc.stderr.text(), proc.exited])
  if (code !== 0) throw new Error(`oxfmt exited ${code}: ${err}`)
  return out
}

/** The OpenAPI document of the app as built, read through `app.handle`. */
export async function openapiDocument(): Promise<unknown> {
  // The one place the document is served outside a test: public, and read in-process, never over a socket.
  const app = createApp({
    docs: true,
    health: {
      read: () => Promise.reject(new Error('the generator reads the document only')),
    },
  })
  const response = await app.handle(new Request(`http://localhost${OPENAPI_PATH}`))
  if (!response.ok) throw new Error(`${OPENAPI_PATH} answered ${response.status}`)
  return response.json()
}

if (import.meta.main) {
  const text = await format(render(operationsOf(await openapiDocument())))
  if (process.argv.includes('--check')) {
    const committed = await readFile(OUTPUT, 'utf8').catch(() => '')
    if (committed !== text) {
      console.error(`${OUTPUT} is stale: run bun apps/cli/scripts/generate.ts and commit it`)
      process.exit(1)
    }
  } else {
    await writeFile(OUTPUT, text)
    console.log(`wrote ${OUTPUT}`)
  }
}
