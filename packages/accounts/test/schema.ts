// A validator for the subset of JSON Schema the status schema uses: type (one or a list), enum, required, properties,
// additionalProperties (a schema) and items. Returns the list of violations, empty when the value fits.
type Schema = {
  type?: string | readonly string[]
  enum?: readonly unknown[]
  required?: readonly string[]
  properties?: Record<string, Schema>
  additionalProperties?: Schema
  items?: Schema
}

const kindOf = (v: unknown) => (v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v)

export function validate(value: unknown, schema: Schema, path = '$'): string[] {
  const kind = kindOf(value)
  const types = schema.type === undefined ? null : typeof schema.type === 'string' ? [schema.type] : schema.type
  if (types && !types.includes(kind)) return [`${path}: ${kind} is not ${types.join('|')}`]
  if (schema.enum && !schema.enum.includes(value))
    return [`${path}: ${JSON.stringify(value)} is not one of ${JSON.stringify(schema.enum)}`]
  const out: string[] = []
  if (kind === 'object') {
    const o = value as Record<string, unknown>
    for (const k of schema.required ?? []) if (!(k in o)) out.push(`${path}: missing ${k}`)
    for (const [k, v] of Object.entries(o)) {
      const sub = schema.properties?.[k] ?? schema.additionalProperties
      if (sub) out.push(...validate(v, sub, `${path}.${k}`))
    }
  }
  if (kind === 'array' && schema.items)
    (value as unknown[]).forEach((v, i) => out.push(...validate(v, schema.items!, `${path}[${i}]`)))
  return out
}
