import type { ProjectSetupField, ProjectSetupModel } from '@software-factory/contract'
import type { SQL } from 'bun'
import { stringify } from 'yaml'
import * as z from 'zod'
import { projectOf } from '../kernel/project-of.ts'
import { loadProjects } from './project-page.ts'

/**
 * One project's `project.yaml` in force as a form: each key in the schema's order with the schema's description and the
 * value the factory reads (defaults filled in), and the same file as YAML. The schema comes in as JSON Schema from the
 * caller (`projectJsonSchema()` of the contract): `read/` holds no code of a domain. Read-only SQL.
 */

interface Node {
  description?: string
  /** a retired key: accepted and dropped, read by nothing */
  deprecated?: boolean
  default?: unknown
  properties?: Record<string, Node>
  anyOf?: Node[]
}

const JsonNode: z.ZodType<Node> = z.lazy(() =>
  z.looseObject({
    description: z.string().optional(),
    deprecated: z.boolean().optional(),
    default: z.unknown().optional(),
    properties: z.record(z.string(), JsonNode).optional(),
    anyOf: z.array(JsonNode).optional(),
  }),
)

/** The object a node describes: itself, or the object branch of `object | null`. */
const objectOf = (node: Node): Node | null => {
  if (node.properties) return node
  for (const branch of node.anyOf ?? []) {
    const found = objectOf(branch)
    if (found) return found
  }
  return null
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** A scalar as text, a list or a map as YAML, an unset key as nothing. */
function render(value: unknown): string {
  if (value === undefined || value === null) return ''
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (Array.isArray(value) ? value.length === 0 : isRecord(value) && Object.keys(value).length === 0) return ''
  return stringify(value, { indent: 2 }).trimEnd()
}

/** An empty list or map is as good as a default of none. */
const same = (value: unknown, fallback: unknown): boolean => {
  const empty = (v: unknown) =>
    v === undefined ||
    v === null ||
    (Array.isArray(v) && v.length === 0) ||
    (isRecord(v) && Object.keys(v).length === 0)
  return (empty(value) && empty(fallback)) || Bun.deepEquals(value, fallback)
}

/** A schema description as the form shows it: plain text (no code marks), a capital first letter. */
const plainText = (text: string): string => {
  const plain = text.replaceAll('`', '')
  return `${plain.charAt(0).toUpperCase()}${plain.slice(1)}`
}

function fieldsOf(node: Node, value: unknown, prefix: string): ProjectSetupField[] {
  const properties = objectOf(node)?.properties ?? {}
  const values = isRecord(value) ? value : {}
  const rows: ProjectSetupField[] = []
  for (const [key, child] of Object.entries(properties)) {
    // a key with no description, or a retired one (accepted and dropped, read by nothing), is not part of the form
    if (child.description === undefined || child.deprecated === true) continue
    const path = `${prefix}${key}`
    const own = values[key]
    const isDefault = same(own, child.default)
    const nested = objectOf(child) && isRecord(own) ? fieldsOf(child, own, `${path}.`) : []
    rows.push({
      path,
      description: plainText(child.description),
      value: nested.length > 0 ? '' : render(own),
      isDefault,
    })
    rows.push(...nested)
  }
  return rows
}

export async function readProjectSetup(
  sql: SQL,
  options: {
    now: Date
    name: string
    /** `projectJsonSchema()`: the file's JSON Schema as an author writes it */
    schema: unknown
    /** the read token: a work project is not found */
    redact?: boolean
  },
): Promise<ProjectSetupModel | null> {
  const project = projectOf(await loadProjects(sql), options.name)
  if (!project || (options.redact && project.work)) return null
  const root = JsonNode.parse(options.schema)
  return {
    at: options.now.toISOString(),
    project: project.name,
    source: project.source,
    projectError: project.error,
    fields: fieldsOf(root, project.raw, ''),
    yaml: stringify(project.raw, { indent: 2 }).trimEnd(),
  }
}
