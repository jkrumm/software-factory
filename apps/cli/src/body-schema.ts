import * as z from 'zod'
import { usage } from './exit.ts'
import { OPERATION_EXTENSIONS } from './filing.ts'
import type { BodyField, Operation } from './operation.ts'

/**
 * What the CLI derives from an operation's contract schema (`Operation.bodySchema`): the help of a flag, the Issue-id
 * normalisation, the client-side validation and the JSON Schema `--schema` prints. An operation without a `bodySchema`
 * derives nothing and the server stays the only validator.
 */

type Json = Record<string, unknown>
const isJson = (value: unknown): value is Json => typeof value === 'object' && value !== null && !Array.isArray(value)
const jsonList = (value: unknown): Json[] => (Array.isArray(value) ? value.filter(isJson) : [])

export const KIND_HINT = {
  string: '<text>',
  number: '<number>',
  integer: '<integer>',
  boolean: '[true|false]',
  json: '<json>',
} as const

const BARE_ISSUE = /^[1-9][0-9]*$/

/** A bare Issue number as the id the API names (`12` is `issue_12`); anything else as given. */
export const issueIdOf = (text: string): string => (BARE_ISSUE.test(text) ? `issue_${text}` : text)
const MAX_REPORTED = 8

const documents = new WeakMap<z.ZodType, Json>()

/** The input-side JSON Schema of the body, `$ref`s kept, computed once per schema. */
function documentOf(schema: z.ZodType): Json {
  const known = documents.get(schema)
  if (known) return known
  const made = z.toJSONSchema(schema, { io: 'input', target: 'draft-2020-12' }) as Json
  documents.set(schema, made)
  return made
}

/** Follows `#/$defs/<Name>` references until a schema with a body. */
function deref(node: Json, root: Json): Json {
  let current = node
  for (let depth = 0; depth < 20 && typeof current.$ref === 'string'; depth++) {
    const name = /^#\/\$defs\/(.+)$/.exec(current.$ref)?.[1]
    const target = name && isJson(root.$defs) ? root.$defs[name] : undefined
    if (!isJson(target)) return current
    const { $ref: _ref, ...own } = current
    current = { ...target, ...own }
  }
  return current
}

/** A schema with references followed and a nullable/optional wrapper (`anyOf` with one non-null member) merged in. */
function flat(node: Json, root: Json): Json {
  const self = deref(node, root)
  for (const key of ['anyOf', 'oneOf', 'allOf'] as const) {
    const members = jsonList(self[key]).filter((member) => member.type !== 'null')
    if (members.length !== 1 || !members[0]) continue
    const { [key]: _members, ...own } = self
    return { ...flat(members[0], root), ...own }
  }
  return self
}

/** The body's top-level schema: the root with its reference followed. */
function rootOf(op: Operation): { root: Json; body: Json } | null {
  if (!op.bodySchema) return null
  const root = documentOf(op.bodySchema)
  return { root, body: deref(root, root) }
}

function propertyOf(op: Operation, name: string): { node: Json; root: Json } | null {
  const found = rootOf(op)
  if (!found || !isJson(found.body.properties)) return null
  const node = found.body.properties[name]
  return isJson(node) ? { node: flat(node, found.root), root: found.root } : null
}

const itemsOf = (node: Json, root: Json): Json | null => (isJson(node.items) ? flat(node.items, root) : null)

const isIssueId = (node: Json, root: Json): boolean =>
  node['x-id'] === 'issue' || itemsOf(node, root)?.['x-id'] === 'issue'

const typeName = (node: Json): string | null => {
  const types = (Array.isArray(node.type) ? node.type : [node.type]).filter(
    (t) => typeof t === 'string' && t !== 'null',
  )
  return types.length === 1 ? String(types[0]) : null
}

function hintOf(node: Json, root: Json, field: BodyField): string {
  const scalar = typeName(node) === 'array' ? (itemsOf(node, root) ?? {}) : node
  if (isIssueId(node, root)) return '<issue-id>'
  if (Array.isArray(scalar.enum) && scalar.enum.length > 0) return `<${scalar.enum.map(String).join('|')}>`
  const type = typeName(scalar)
  if (type === 'string') return scalar.format === 'date-time' ? '<date-time>' : '<text>'
  if (type === 'integer') return '<integer>'
  if (type === 'number') return '<number>'
  if (type === 'boolean') return '[true|false]'
  if (type === 'object' && !field.repeatable) return '<json object>'
  return field.untyped ? '<text|json>' : KIND_HINT[field.kind]
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`

function boundNotes(node: Json, unit: 'items' | 'characters' | 'number'): string[] {
  const [min, max] =
    unit === 'items'
      ? [node.minItems, node.maxItems]
      : unit === 'characters'
        ? [node.minLength, node.maxLength]
        : [node.minimum, node.maximum]
  // zod's integer type carries the safe-integer range as bounds; that is the type, not a limit worth showing
  const bound = (n: unknown) => (typeof n === 'number' && Math.abs(n) < Number.MAX_SAFE_INTEGER ? n : undefined)
  const lo = bound(min)
  const hi = bound(max)
  if (lo === undefined && hi === undefined) return []
  if (unit === 'number') {
    if (lo !== undefined && hi !== undefined) return [`${lo} to ${hi}`]
    return [lo !== undefined ? `at least ${lo}` : `at most ${hi}`]
  }
  if (unit === 'characters') {
    if (lo !== undefined && hi !== undefined) return [`${lo}-${hi} characters`]
    return [lo !== undefined ? `at least ${plural(lo, 'character')}` : `at most ${plural(hi ?? 0, 'character')}`]
  }
  return [...(lo !== undefined ? [`at least ${lo}`] : []), ...(hi !== undefined ? [`at most ${hi}`] : [])]
}

/** The hint and the notes of one flag, from the contract; the generated field's own kind when the contract has nothing. */
export function fieldNotes(op: Operation, field: BodyField): { hint: string; notes: string[] } {
  const found = propertyOf(op, field.name)
  const fallback = {
    hint: field.untyped ? '<text|json>' : KIND_HINT[field.kind],
    notes: field.repeatable ? ['repeatable'] : [],
  }
  if (!found) return fallback
  const { node, root } = found
  const item = typeName(node) === 'array' ? (itemsOf(node, root) ?? {}) : node
  const notes = [
    ...(field.repeatable ? ['repeatable'] : []),
    ...boundNotes(node, 'items'),
    ...boundNotes(item, 'characters'),
    ...boundNotes(item, 'number'),
    ...(isIssueId(node, root) ? ['issue_<n> or a bare <n>'] : []),
    ...('default' in node && node.default !== undefined && !Array.isArray(node.default)
      ? [`default ${typeof node.default === 'string' ? node.default : JSON.stringify(node.default)}`]
      : []),
  ]
  return { hint: hintOf(node, root, field), notes }
}

/** The body with every bare Issue number (`559`) written as the id the server names (`issue_559`); nothing else changes. */
export function normalizeBody(op: Operation, body: unknown): unknown {
  const found = rootOf(op)
  if (!found || !isJson(body) || !isJson(found.body.properties)) return body
  const out: Json = { ...body }
  for (const [name, schema] of Object.entries(found.body.properties)) {
    const value = out[name]
    if (!isJson(schema) || !isIssueId(flat(schema, found.root), found.root)) continue
    const fix = (item: unknown) => (typeof item === 'string' ? issueIdOf(item) : item)
    out[name] = Array.isArray(value) ? value.map(fix) : fix(value)
  }
  return out
}

const valueAt = (body: unknown, path: readonly PropertyKey[]): unknown =>
  path.reduce<unknown>(
    (value, key) => (isJson(value) || Array.isArray(value) ? (value as Json)[String(key)] : undefined),
    body,
  )

function describe(issue: z.core.$ZodIssue, body: unknown): string {
  const value = valueAt(body, issue.path)
  if (value === undefined && (issue.code === 'invalid_type' || issue.code === 'invalid_value')) return 'required'
  if (issue.code === 'invalid_type') return `expected ${issue.expected}`
  if (issue.code === 'invalid_value') return `must be one of ${issue.values.map(String).join(', ')}`
  if (issue.code === 'unrecognized_keys')
    return `unknown key${issue.keys.length === 1 ? '' : 's'} ${issue.keys.join(', ')}`
  if (issue.code === 'too_big' || issue.code === 'too_small') {
    const big = issue.code === 'too_big'
    const limit = Number(big ? issue.maximum : issue.minimum)
    const bound = big ? 'at most' : 'at least'
    if (issue.origin === 'array') {
      const got = big && Array.isArray(value) ? ` (got ${value.length})` : ''
      return `${bound} ${plural(limit, 'item')}${got}`
    }
    if (issue.origin === 'string') return `${bound} ${plural(limit, 'character')}`
    if (issue.origin === 'number' || issue.origin === 'int') return `${bound} ${limit}`
  }
  return issue.message
}

/** Throws a usage error (exit 2) naming every field the contract refuses, up to eight; nothing is sent. */
export function validateBody(op: Operation, body: unknown): void {
  if (!op.bodySchema) return
  const parsed = op.bodySchema.safeParse(body)
  if (parsed.success) return
  const lines = parsed.error.issues.map((issue) => `${issue.path.join('.') || 'body'}: ${describe(issue, body)}`)
  const shown = lines.slice(0, MAX_REPORTED)
  if (lines.length > shown.length) shown.push(`and ${lines.length - shown.length} more`)
  const fieldHints = OPERATION_EXTENSIONS[op.operationId]?.fieldHints ?? {}
  const named = [...new Set(parsed.error.issues.map((issue) => String(issue.path[0] ?? '')))]
  const advice = named.flatMap((name) => (fieldHints[name] ? [`${name}: ${fieldHints[name]}`] : []))
  throw usage(
    `${op.command.join(' ')}: ${shown.join('; ')}`,
    [...advice, `factory ${op.command.join(' ')} --schema prints the body's JSON Schema`].join('. '),
  )
}

/** The JSON Schema of the body as the server reads it, the root reference followed. */
export function bodyJsonSchema(op: Operation): Json {
  const found = rootOf(op)
  if (!found) return {}
  const { $ref: _ref, $defs, $schema, ...rest } = found.root
  return {
    ...(typeof $schema === 'string' ? { $schema } : {}),
    ...found.body,
    ...rest,
    ...(isJson($defs) ? { $defs } : {}),
  }
}
