#!/usr/bin/env bun
/**
 * The loops table of docs/architecture.md (between its two loops-table markers), generated from the code: every loop of
 * `LOOP_NAMES`, its default interval (`loadLoopSettings` with an empty environment), and the agw workflows its code
 * asks (the `WORKFLOWS.<entry>` uses in the loop's own file and in the files it calls them through, `LOOP_FILES`).
 * --write regenerates the block; --check (a step of make docs-check) fails when the block is not what the code says.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { LOOP_NAMES, type LoopName } from '../packages/contract/src/loops.ts'
import { loadLoopSettings } from '../apps/server/src/app/loops/settings.ts'
import { WORKFLOWS, type WorkflowName } from '../apps/server/src/kernel/workflows.ts'

const ROOT = join(import.meta.dir, '..')
const DOC = join(ROOT, 'docs', 'architecture.md')
const BEGIN = '<!-- loops-table:begin (scripts/loops-table.ts) -->'
const END = '<!-- loops-table:end -->'
const BT = String.fromCharCode(96)
const SRC = 'apps/server/src/'

/** Loops whose workflow calls sit outside `app/loops/<name>.ts`: the files they go through. */
export const LOOP_FILES: Partial<Record<LoopName, string[]>> = {
  settle: ['app/checkpoints-*.ts'],
  triage: ['adapters/agw/amend.ts'],
  desk: ['app/checkpoints-errands.ts'],
}

const code = (text: string): string => `${BT}${text}${BT}`

export function intervalText(ms: number): string {
  if (ms === 0) return 'off'
  if (ms % 3_600_000 === 0) return `${ms / 3_600_000} h`
  if (ms % 60_000 === 0) return `${ms / 60_000} min`
  return `${ms / 1000} s`
}

/** The workflows (agw names) a source text asks: every `WORKFLOWS.<entry>` it names. */
export function asked(src: string): string[] {
  const names = [...src.matchAll(/WORKFLOWS\.([a-zA-Z]+)/g)].map((m) => m[1] ?? '')
  return names.filter((n): n is WorkflowName => n in WORKFLOWS).map((n) => WORKFLOWS[n].agw)
}

function filesOf(name: LoopName): string[] {
  const own = `${SRC}app/loops/${name}.ts`
  const globs = (LOOP_FILES[name] ?? []).map((p) => SRC + p)
  const files = existsSync(join(ROOT, own)) ? [own] : []
  for (const pattern of globs) {
    for (const path of new Bun.Glob(pattern).scanSync({ cwd: ROOT })) files.push(path)
  }
  return files.sort()
}

/** The table, one row per loop in `LOOP_NAMES` order. */
export function render(): string {
  const { intervalMs } = loadLoopSettings({})
  const rows = LOOP_NAMES.map((name) => {
    const agw = new Set(filesOf(name).flatMap((f) => asked(readFileSync(join(ROOT, f), 'utf8'))))
    const asks = agw.size === 0 ? 'none' : [...agw].sort().map(code).join(', ')
    return ['| ', code(name), ' | ', intervalText(intervalMs[name]), ' | ', asks, ' |'].join('')
  })
  return ['| Loop | Interval | Asks agw |', '|-|-|-|', ...rows].join('\n')
}

/** Every reason the block of the document is not what the code says; empty when it is. */
export function problemsIn(doc: string): string[] {
  const from = doc.indexOf(BEGIN)
  const to = doc.indexOf(END)
  if (from === -1 || to < from) return ['docs/architecture.md lacks the loops-table markers']
  const block = doc.slice(from + BEGIN.length, to).trim()
  if (block === render()) return []
  return ['docs/architecture.md loops table is stale: run bun scripts/loops-table.ts --write']
}

function main(): number {
  const mode = process.argv[2]
  const doc = readFileSync(DOC, 'utf8')
  if (mode === '--write') {
    const from = doc.indexOf(BEGIN)
    const to = doc.indexOf(END)
    if (from === -1 || to < from) {
      console.error('docs/architecture.md lacks the loops-table markers')
      return 1
    }
    writeFileSync(DOC, [doc.slice(0, from + BEGIN.length), '', render(), '', doc.slice(to)].join('\n'))
    console.log(
      ['wrote the loops table into ', relative(ROOT, DOC), ': ', String(LOOP_NAMES.length), ' loops'].join(''),
    )
    return 0
  }
  if (mode !== '--check') {
    console.error('usage: bun scripts/loops-table.ts --write | --check')
    return 2
  }
  const problems = problemsIn(doc)
  for (const problem of problems) console.error(problem)
  if (problems.length) return 1
  console.log(['loops table: ', String(LOOP_NAMES.length), ' loops, as the code says'].join(''))
  return 0
}

if (import.meta.main) process.exit(main())
