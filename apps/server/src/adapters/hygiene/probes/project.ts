import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { checkProject } from '@software-factory/project-lint'
import type { Tools } from '../git.ts'
import { type Outcome, clean, finding, found, skipped } from './finding.ts'

const FILE = 'project.yaml'

/** The repo's `project.yaml` through the lint `factory project check` runs, so the two never disagree: a broken file and every warning are one finding. */
export async function projectProbe(_tools: Tools, path: string): Promise<Outcome> {
  if (!existsSync(join(path, FILE))) return skipped(`no ${FILE}`)
  const text = await readFile(join(path, FILE), 'utf8')
  const { problems, warnings } = await checkProject(text, path, { readFile: (file) => readFile(file, 'utf8') })
  const all = [...problems, ...warnings]
  if (!all.length) return clean(`${FILE} passes factory project check`)
  const lines = all.map((problem) => `${FILE}:${problem.line}: ${problem.message}`)
  return found(`${FILE}: ${problems.length} problem(s), ${warnings.length} warning(s)`, [
    {
      ...finding('project', `project:${FILE}`, `Hygiene: ${FILE} has problems`, lines, all.length),
      reproduce: 'factory project check project.yaml',
    },
  ])
}
