import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { gitOut, type Tools } from '../git.ts'
import { type Outcome, clean, finding, found, skipped } from './finding.ts'
import type { ProbeFinding } from '../../../domains/loops/hygiene-model.ts'

/**
 * The owner's byte budgets for the files an agent loads on every turn (dotfiles `rules/writing-for-agents.md`, 2026-11-16,
 * table "Where a fact goes" and section Budgets; the measurements are in dotfiles `docs/writing-for-agents.md`): a root
 * `AGENTS.md` is loaded by every task in its repo, a nested one by the work in its directory. Over is strictly more.
 */
export const ROOT_BUDGET_BYTES = 12_000
export const NESTED_BUDGET_BYTES = 8_000
export const SECTIONS_SHOWN = 5

const MAX_LINES = 8
const HEADING_CHARS = 40

const RULE =
  `Budgets: ${ROOT_BUDGET_BYTES} bytes for the root AGENTS.md, ${NESTED_BUDGET_BYTES} for a nested one ` +
  "(dotfiles rules/writing-for-agents.md, table 'Where a fact goes'). The work is a split with a ledger and a marker proof, not a shortening by deletion."

/** One `## ` section of a file and what it weighs. */
export interface Section {
  heading: string
  bytes: number
}

/** One tracked AGENTS.md and its size. */
export interface ContextFile {
  file: string
  bytes: number
  nested: boolean
}

const FENCE = /^\s*(?:```|~~~)/

/** The `## ` sections of a Markdown text, largest first: bytes from the heading line to the next `## ` line, fenced code ignored. */
export function sections(text: string): Section[] {
  const out: Section[] = []
  let fenced = false
  let current: Section | undefined
  const lines = text.split('\n')
  if (lines.at(-1) === '') lines.pop()
  for (const line of lines) {
    if (FENCE.test(line)) fenced = !fenced
    const size = Buffer.byteLength(line) + 1
    if (!fenced && line.startsWith('## ')) {
      current = { heading: line.slice(3).trim(), bytes: size }
      out.push(current)
    } else if (current) current.bytes += size
  }
  return out.sort((a, b) => b.bytes - a.bytes || a.heading.localeCompare(b.heading))
}

const bytesOf = (value: number): string => `${value} bytes`

const cut = (heading: string): string =>
  heading.length > HEADING_CHARS ? `${heading.slice(0, HEADING_CHARS - 1)}…` : heading

/** The one finding of a repo: the files over budget, the root's largest sections, the rule. Empty when none is over. */
export function toFindings(over: ContextFile[], rootText: string | undefined): ProbeFinding[] {
  if (!over.length) return []
  const root = over.find((file) => !file.nested)
  const nested = over.filter((file) => file.nested).sort((a, b) => b.bytes - a.bytes || a.file.localeCompare(b.file))
  const lines: string[] = [RULE]
  if (root) {
    lines.push(
      `${root.file}: ${bytesOf(root.bytes)}, over the root budget of ${ROOT_BUDGET_BYTES} by ${root.bytes - ROOT_BUDGET_BYTES}`,
    )
    for (const section of sections(rootText ?? '').slice(0, SECTIONS_SHOWN))
      lines.push(`  ${root.file} ## ${cut(section.heading)}: ${bytesOf(section.bytes)}`)
  }
  const room = MAX_LINES - lines.length
  const shown = nested.length > room ? nested.slice(0, Math.max(room - 1, 0)) : nested
  for (const file of shown)
    lines.push(`${file.file}: ${bytesOf(file.bytes)}, over the nested budget of ${NESTED_BUDGET_BYTES}`)
  if (shown.length < nested.length)
    lines.push(`and ${nested.length - shown.length} more nested AGENTS.md over ${NESTED_BUDGET_BYTES} bytes`)
  const title = root
    ? 'Hygiene: the root AGENTS.md is over its byte budget'
    : 'Hygiene: a nested AGENTS.md is over its byte budget'
  return [finding('context', 'context', title, lines, over.length)]
}

const isContextFile = (file: string): boolean => file === 'AGENTS.md' || file.endsWith('/AGENTS.md')

const readText = (path: string, file: string): string | undefined => {
  try {
    return readFileSync(join(path, file), 'utf8')
  } catch {
    return undefined
  }
}

/**
 * The size rule for the files agents load on every turn, read from the checkout: the root `AGENTS.md` over 12,000 bytes or a
 * nested one git tracks over 8,000 is one finding for the repo, key `context`, so next week's pass dedups. `skipped` when the
 * repo tracks no AGENTS.md.
 */
export async function contextProbe(tools: Tools, path: string): Promise<Outcome> {
  const tracked = (await gitOut(tools, path, ['ls-files', '-z'])).split('\0').filter(isContextFile)
  const files: ContextFile[] = []
  let rootText: string | undefined
  for (const file of tracked) {
    const text = readText(path, file)
    if (text === undefined) continue
    const nested = file !== 'AGENTS.md'
    if (!nested) rootText = text
    files.push({ file, bytes: Buffer.byteLength(text), nested })
  }
  if (!files.length) return skipped('no AGENTS.md in the repo')
  const over = files.filter((file) => file.bytes > (file.nested ? NESTED_BUDGET_BYTES : ROOT_BUDGET_BYTES))
  const detail = `${files.length} AGENTS.md files, ${over.length} over budget`
  return over.length ? found(detail, toFindings(over, rootText)) : clean(detail)
}
