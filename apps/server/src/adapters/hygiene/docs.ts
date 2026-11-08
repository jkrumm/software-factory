import { ARCHIVE_DIRS } from '../../domains/loops/hygiene-model.ts'
import { gitOut, type Tools } from './git.ts'

/** Every tracked markdown file, relative to the checkout, forward slashes. */
export async function trackedMarkdown(tools: Tools, path: string): Promise<string[]> {
  const out = await gitOut(tools, path, ['ls-files', '-z', '*.md'])
  return out.split('\0').filter(Boolean)
}

const underNodeModules = (file: string): boolean => file.split('/').includes('node_modules')

const archived = (file: string): boolean => ARCHIVE_DIRS.some((dir) => file.startsWith(`${dir}/`))

/** The documents that describe the code as it is: not a record (`ARCHIVE_DIRS`), not a dependency. */
export const livingDocs = (markdown: string[]): string[] =>
  markdown.filter((file) => !archived(file) && !underNodeModules(file))
