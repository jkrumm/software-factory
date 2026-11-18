import * as z from 'zod'

/** `config/infra.json`: where each host's Issues go. A host is a key; its repo is the one its alerts are routed to. */
const REPO_NAME = /^(?!\.+$)[A-Za-z0-9._-]+$/

const InfraFile = z.strictObject({
  hosts: z.record(
    z.string().regex(/^[a-z0-9._-]+$/, 'a host name is lower-case'),
    z.strictObject({
      repo: z.string().regex(REPO_NAME, 'a directory name under SourceRoot'),
    }),
  ),
})

export interface HostRule {
  repo: string
}

export interface Infra {
  /** by lower-case host name */
  hosts: ReadonlyMap<string, HostRule>
}

export function parseInfra(text: string): Infra {
  const file = InfraFile.safeParse(JSON.parse(text))
  if (!file.success) {
    throw new Error(file.error.issues.map((i) => `${i.path.join('.') || '(file)'}: ${i.message}`).join('; '))
  }
  const hosts = new Map<string, HostRule>()
  for (const [name, host] of Object.entries(file.data.hosts)) hosts.set(name, { repo: host.repo })
  return { hosts }
}
