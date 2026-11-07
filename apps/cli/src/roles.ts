import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { parseRoleTable, type RoleTable } from '@software-factory/contract'

/** The tracked table of this checkout or release: `config/roles.json`. */
export const DEFAULT_ROLES_FILE = fileURLToPath(new URL('../../../config/roles.json', import.meta.url))

export async function loadRoleTable(path: string): Promise<RoleTable> {
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch (cause) {
    throw new Error(`the role table ${path} cannot be read: ${String(cause)}`)
  }
  try {
    return parseRoleTable(text)
  } catch (cause) {
    throw new Error(`the role table ${path} is unusable: ${cause instanceof Error ? cause.message : String(cause)}`)
  }
}
