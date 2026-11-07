import { readFile } from 'node:fs/promises'
import { parseRoleTable } from '@software-factory/contract'
import type { Roles } from '../../domains/leads/ports.ts'
import { err, ok, portError } from '../../kernel/result.ts'

/** The role table's `lead` row, read from the tracked file each time a lead starts: a change takes effect at the next start. */
export function fileRoles(path: string): Roles {
  return {
    async lead() {
      try {
        const entry = parseRoleTable(await readFile(path, 'utf8')).get('lead')
        return entry
          ? ok({ tier: entry.tier, effort: entry.effort })
          : err(portError('refused', `${path} has no role "lead"`))
      } catch (cause) {
        return err(portError('unreadable', `the role table ${path} is unusable: ${String(cause)}`))
      }
    },
  }
}
