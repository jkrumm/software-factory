import * as z from 'zod'

/** Tier names, never model ids: the ids live in agw's and dotfiles' route tables, the launcher maps a tier to one. */
export const TIERS = ['haiku', 'sonnet', 'opus'] as const
export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const

export const Tier = z.enum(TIERS)
export type Tier = z.infer<typeof Tier>
export const Effort = z.enum(EFFORTS)
export type Effort = z.infer<typeof Effort>

/** A role is a word: it ends up in a file name, a CLI argument and a column. */
export const ROLE_NAME = /^[A-Za-z][A-Za-z0-9_-]{0,31}$/
export const RoleName = z.string().regex(ROLE_NAME, 'not a valid role name')

/** What `factory role get <role> --format json` prints; `rd --role` reads exactly this. */
export const RoleEntry = z.object({ role: RoleName, tier: Tier, effort: Effort }).meta({ id: 'RoleEntry' })
export type RoleEntry = z.infer<typeof RoleEntry>

export const RoleList = z.object({ roles: z.array(RoleEntry) }).meta({ id: 'RoleList' })
export type RoleList = z.infer<typeof RoleList>

/** `config/roles.json`: role name to tier and effort. */
const RoleFile = z.object({ roles: z.record(RoleName, z.object({ tier: Tier, effort: Effort })) })

export type RoleTable = ReadonlyMap<string, RoleEntry>

/** Parses the role table's text; throws with zod's message when it is not one. */
export function parseRoleTable(text: string): RoleTable {
  const file = RoleFile.parse(JSON.parse(text))
  return new Map(Object.entries(file.roles).map(([role, entry]) => [role, { role, ...entry }]))
}
