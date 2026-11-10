import { readFile } from 'node:fs/promises'
import { parseRoleTable } from '@software-factory/contract'
import type { Roles } from '../../domains/leads/ports.ts'
import { err, ok, portError } from '../../kernel/result.ts'

/** The role table, read from the tracked file each time it is asked: a change takes effect at the next start or filing. */
export function fileRoles(path: string): Roles {
  async function role(name: string) {
    try {
      const entry = parseRoleTable(await readFile(path, 'utf8')).get(name)
      return entry
        ? ok({ tier: entry.tier, effort: entry.effort })
        : err(portError('refused', `${path} has no role "${name}"`))
    } catch (cause) {
      return err(portError('unreadable', `the role table ${path} is unusable: ${String(cause)}`))
    }
  }
  return { lead: () => role('lead'), role }
}
