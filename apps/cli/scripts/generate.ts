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

export const OUTPUT = join(import.meta.dir, '..', 'src', 'generated', 'operations.ts')

/** Words the hand-written verbs own; a generated group may not take one. */
export const RESERVED_GROUPS = ['version', 'role', 'help', 'hook', 'slot']

/** Flags the CLI itself owns (`run.ts`); a query parameter may not take one. */
export const RESERVED_FLAGS = ['format', 'help', 'body']

const OPERATION_ID = /^([a-z][a-z0-9-]*)\.([a-z][a-z0-9-]*)$/
const METHODS = ['get', 'post', 'put', 'patch', 'delete'] as const
const SCHEMA_REF = /^#\/\$defs\/([A-Za-z][A-Za-z0-9]*)$/

const Parameter = z.object({ name: z.string(), in: z.string() })
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
  body: boolean
  responses: [number, string][]
}

/** The contract export whose zod schema carries this id, or nothing. */
const contractSchema = (id: string): boolean => {
  const value: unknown = (contract as Record<string, unknown>)[id]
  return value instanceof z.ZodType && z.globalRegistry.get(value)?.id === id
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
      const queryParams = (op.parameters ?? []).filter((p) => p.in === 'query').map((p) => p.name)
      for (const name of queryParams.filter((q) => RESERVED_FLAGS.includes(q))) {
        problems.push(`${where}: query parameter "${name}" is a flag the CLI owns`)
      }
      out.push({
        operationId: id,
        command: [match[1], match[2]],
        method: method.toUpperCase(),
        path,
        summary: op.summary ?? '',
        pathParams: [...path.matchAll(/\{([^}]+)\}/g)].flatMap((m) => (m[1] ? [m[1]] : [])),
        queryParams,
        body: op.requestBody !== undefined,
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

/** The file's text: deterministic, so a rerun on the same document writes the same bytes. */
export function render(operations: Generated[]): string {
  const schemas = [...new Set(operations.flatMap((op) => op.responses.map(([, name]) => name)))].sort()
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
  const app = createApp({
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
