import { isMap, isNode, isScalar, type Document, type LineCounter } from 'yaml'
import type * as z from 'zod'

/** One problem of a checked YAML file, at the line and column it sits at. */
export interface Problem {
  line: number
  column: number
  path: (string | number)[]
  message: string
  hint?: string
}

/** The offset of the node a path names: a map's key where the path ends in one, else the value; undefined if unresolved. */
function offsetOf(doc: Document, path: (string | number)[]): number | undefined {
  if (path.length === 0) return doc.contents?.range?.[0]
  const last = path[path.length - 1]
  if (typeof last === 'string') {
    const parent = path.length === 1 ? doc.contents : doc.getIn(path.slice(0, -1), true)
    if (isMap(parent)) {
      const pair = parent.items.find((item) => isScalar(item.key) && item.key.value === last)
      if (pair && isScalar(pair.key)) return pair.key.range?.[0]
    }
  }
  const node = doc.getIn(path, true)
  return isNode(node) ? node.range?.[0] : undefined
}

/** The nearest part of the path that resolves, else the start of the file. */
function offsetNear(doc: Document, path: (string | number)[]): number {
  for (let length = path.length; length >= 0; length--) {
    const offset = offsetOf(doc, path.slice(0, length))
    if (offset !== undefined) return offset
  }
  return 0
}

/** Where a path sits in the file: its line and column, or the nearest part of it that resolves. */
export function positionOf(
  doc: Document,
  lineCounter: LineCounter,
  path: (string | number)[],
): { line: number; column: number } {
  const at = lineCounter.linePos(offsetNear(doc, path))
  return { line: at.line, column: at.col }
}

/** The YAML parser's errors as problems; `hint` names the fix of a known shape. */
export function yamlProblems(doc: Document, hint?: (message: string) => string | undefined): Problem[] {
  return doc.errors.map((error): Problem => {
    const at = error.linePos?.[0]
    const message = `${error.code}: ${(error.message.split('\n')[0] ?? error.message).replace(/ at line \d+, column \d+:?$/, '')}`
    const found = hint?.(error.message)
    return { line: at?.line ?? 1, column: at?.col ?? 1, path: [], message, ...(found ? { hint: found } : {}) }
  })
}

/** A schema's issues as problems, each at the node it names; an unknown key at the key itself. */
export function schemaProblems(doc: Document, lineCounter: LineCounter, error: z.ZodError): Problem[] {
  const problems: Problem[] = []
  for (const issue of error.issues) {
    const path = issue.path.filter((part): part is string | number => typeof part !== 'symbol')
    const named = path.length > 0 ? `${path.join('.')}: ` : ''
    if (issue.code === 'unrecognized_keys') {
      const map = path.length === 0 ? doc.contents : doc.getIn(path, true)
      for (const key of issue.keys) {
        const pair = isMap(map) ? map.items.find((item) => isScalar(item.key) && item.key.value === key) : undefined
        const offset = pair && isScalar(pair.key) ? (pair.key.range?.[0] ?? 0) : offsetNear(doc, path)
        const position = lineCounter.linePos(offset)
        problems.push({
          line: position.line,
          column: position.col,
          path: [...path, key],
          message: `${named}unknown key ${key}`,
        })
      }
      continue
    }
    problems.push({ ...positionOf(doc, lineCounter, path), path, message: `${named}${issue.message}` })
  }
  return problems
}

/** `file:line:col: message` lines, a hint line after its problem; `warning: ` before a warning's message. */
export function problemLines(
  label: string,
  problems: readonly Problem[],
  kind: 'error' | 'warning' = 'error',
): string[] {
  return problems.flatMap((p) => [
    `${label}:${p.line}:${p.column}: ${kind === 'warning' ? 'warning: ' : ''}${p.message}`,
    ...(p.hint ? [`${label}:${p.line}:${p.column}: hint: ${p.hint}`] : []),
  ])
}
