import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { z } from 'zod'
import { ROLE_NAME } from './spool.ts'

/** Tier names, never model ids: the ids live in agw's and dotfiles' route tables, the launcher maps a tier to one. */
export const TIERS = ['haiku', 'sonnet', 'opus'] as const
export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const

export const Tier = z.enum(TIERS)
export type Tier = z.infer<typeof Tier>
export const Effort = z.enum(EFFORTS)
export type Effort = z.infer<typeof Effort>

/** A role is a word: it ends up in a file name, a CLI argument and a column. */
export const RoleName = z.string().regex(ROLE_NAME, 'not a valid role name')

/** What `factory role get <role> --format json` prints; `rd --role` reads exactly this. */
export const RoleEntry = z.object({ role: RoleName, tier: Tier, effort: Effort })
export type RoleEntry = z.infer<typeof RoleEntry>

export const RoleList = z.object({ roles: z.array(RoleEntry) })
export type RoleList = z.infer<typeof RoleList>

/** `config/roles.json`: role name → tier and effort. */
const RoleFile = z.object({ roles: z.record(RoleName, z.object({ tier: Tier, effort: Effort })) })

export type RoleTable = ReadonlyMap<string, RoleEntry>

export function parseRoleTable(text: string): RoleTable {
  const file = RoleFile.parse(JSON.parse(text))
  return new Map(Object.entries(file.roles).map(([role, v]) => [role, { role, ...v }]))
}

/** The tracked table of this checkout (or release): the one file both the server and the CLI read. */
export const DEFAULT_ROLES_FILE = fileURLToPath(new URL('../../../config/roles.json', import.meta.url))

export async function loadRoleTable(path: string = DEFAULT_ROLES_FILE): Promise<RoleTable> {
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
