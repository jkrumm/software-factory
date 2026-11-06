import { MAX_PLAN_BYTES, PlanFile } from '@software-factory/contract'
import { parseYaml, schemaMessage } from './manifest.ts'

export type PlanParse = { ok: true; plan: PlanFile } | { ok: false; message: string }

/** The content of a `docs/plan.yaml`: the same hardened YAML read as the manifest, then the contract's schema. Never throws. */
export function parsePlan(text: string): PlanParse {
  if (Buffer.byteLength(text) > MAX_PLAN_BYTES) {
    return { ok: false, message: `docs/plan.yaml is larger than ${MAX_PLAN_BYTES} bytes` }
  }
  const raw = parseYaml(text)
  if (!raw.ok) return raw
  const parsed = PlanFile.safeParse(raw.value)
  if (!parsed.success) return { ok: false, message: schemaMessage(parsed.error) }
  const unstorable = unstorableReason(parsed.data)
  if (unstorable) return { ok: false, message: unstorable }
  return { ok: true, plan: parsed.data }
}

/** Nesting deeper than this is refused: Postgres' limit differs per host (create.ts `UNSTORABLE_JSON`). */
const MAX_DEPTH = 32

/** Why the plan cannot be stored as jsonb (a NUL, half a surrogate pair, too deep), or `undefined`: free-form `facts` pass the schema and would make the row's write throw. */
function unstorableReason(value: unknown): string | undefined {
  const walk = (node: unknown, depth: number): string | undefined => {
    if (depth > MAX_DEPTH) return `nested deeper than ${MAX_DEPTH} levels`
    if (typeof node === 'string') {
      return node.includes('\u0000') || !node.isWellFormed()
        ? 'a string with a NUL or half a surrogate pair'
        : undefined
    }
    if (node === null || typeof node !== 'object') return undefined
    for (const [key, child] of Object.entries(node)) {
      const found = walk(key, depth + 1) ?? walk(child, depth + 1)
      if (found) return found
    }
    return undefined
  }
  const reason = walk(value, 0)
  return reason && `docs/plan.yaml cannot be stored: ${reason}`
}
