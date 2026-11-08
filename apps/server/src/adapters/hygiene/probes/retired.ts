import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { EXIT_TIMEOUT } from '../../hc/process.ts'
import { exec, type Tools, withStderr } from '../git.ts'
import { type Outcome, clean, failed, finding, found, skipped } from './finding.ts'

const RETIRED_TIMEOUT_MS = 120_000
const SCRIPT = 'scripts/retired-words.ts'
const ROOT_DOCS = ['AGENTS.md', 'README.md', 'REVIEW.md']
/** They discuss the retired words and the history on purpose. */
const EXCLUDED = new Set(['docs/language.md', 'docs/decisions.md', 'docs/program.md'])

/** AGENTS.md, README.md, REVIEW.md and the top level of docs/, tracked, minus the ones about the words themselves. */
export function retiredScope(markdown: string[]): string[] {
  const tracked = new Set(markdown)
  const top = markdown.filter((file) => /^docs\/[^/]+\.md$/.test(file))
  return [...ROOT_DOCS.filter((file) => tracked.has(file)), ...top].filter((file) => !EXCLUDED.has(file))
}

const FINDING = /^(.+?):(\d+): "/

/** The repo's own retired-words check, over the living documents `make check` does not scan. */
export async function retiredProbe(tools: Tools, path: string, markdown: string[]): Promise<Outcome> {
  if (!existsSync(join(path, SCRIPT))) return skipped(`no ${SCRIPT}`)
  const files = retiredScope(markdown)
  if (!files.length) return skipped('no living documents in scope')
  const result = await exec(withStderr([tools.bun, SCRIPT, '--files', ...files]), RETIRED_TIMEOUT_MS, path)
  if (result.exitCode === EXIT_TIMEOUT) return failed(`${SCRIPT} did not finish in ${RETIRED_TIMEOUT_MS / 1000} s`)
  const detail = `${SCRIPT} --files, ${files.length} documents`
  if (result.exitCode === 0) return clean(detail)
  const byFile = new Map<string, string[]>()
  for (const line of result.stdout.split('\n')) {
    const file = FINDING.exec(line)?.[1]
    if (file) byFile.set(file, [...(byFile.get(file) ?? []), line.trim()])
  }
  if (result.exitCode !== 1 || !byFile.size) return failed(`${detail}: exit ${result.exitCode}, no findings to read`)
  return found(
    detail,
    [...byFile].map(([file, lines]) =>
      finding('retired', `retired:${file}`, `Hygiene: retired words in ${file}`, lines, lines.length),
    ),
  )
}
