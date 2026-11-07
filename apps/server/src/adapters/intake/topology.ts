import { readFile } from 'node:fs/promises'
import { parseInfra } from '../../domains/intake/infra.ts'
import type { Infra } from '../../domains/intake/infra.ts'
import type { IntakeTopology } from '../../domains/intake/ports.ts'
import { err, ok, portError } from '../../kernel/result.ts'

/** `config/infra.json` (or the owner's copy), read and checked; a missing or bad file is a startup error, never a fallback. */
export async function loadInfra(path: string): Promise<Infra> {
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch (cause) {
    throw new Error(`the infra table ${path} cannot be read: ${String(cause)}`)
  }
  try {
    return parseInfra(text)
  } catch (cause) {
    throw new Error(`the infra table ${path} is unusable: ${cause instanceof Error ? cause.message : String(cause)}`)
  }
}

/**
 * Which host each repo's alerts sit on, from `config/infra.json`'s hosts: an alert routed to a host's repo is on that
 * host. A project that names its own host or dependency in `project.yaml` would add to this map.
 */
export function infraTopology(infra: Infra): IntakeTopology {
  const hostOfRepo = new Map<string, string>()
  for (const [name, host] of infra.hosts) hostOfRepo.set(host.repo, name)
  const topology = { hostOfRepo, hosts: new Set(infra.hosts.keys()) }
  return { load: () => Promise.resolve(ok(topology)) }
}

export const unreachableTopology = (detail: string): IntakeTopology => ({
  load: () => Promise.resolve(err(portError('unreadable', detail))),
})
