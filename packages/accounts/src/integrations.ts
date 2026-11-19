// The owner-specific adapters, as commands the user configures instead of code: the peer import, the re-login ask and
// the health peer (docs/accounts.md §Integrations). A user without a peer or a dialog omits them and loses only that feature.
//
// Where they are read from: the registry's `integrations` object, overlaid key by key with the per-machine file
// $CLAUDE_ACCOUNTS_INTEGRATIONS, else ~/.config/claude-accounts/integrations.json when it exists (the registry is shared
// by machines, the commands that reach a peer are not). A command is an argv, never a shell string; `{id}`, `{reason}`,
// `{machine}` and `{message}` in an element are replaced.
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'
import { boundedSpawnSync } from './spawn.ts'
import type { PeerUsage } from './ports.ts'

const argv = z.array(z.string().min(1)).min(1)

const HealthPeer = z.strictObject({
  name: z.string().min(1),
  /** Transports tried in order; the first whose stdout is `<usage --json> @@ <expiry --json> @@ <pending asks>` wins. `note` is printed when it was the last resort. */
  snapshots: z.array(z.strictObject({ via: z.string().min(1), argv, note: z.string().optional() })).min(1),
  /** Run by `health --wake` for each of the peer's pending asks younger than 24 h; `{id}` is the ask. */
  repush: argv.optional(),
})

export const IntegrationsSchema = z.strictObject({
  /** Prints the peer machine's `usage --json`; its samples are imported once per `refresh`. */
  peerUsage: argv.optional(),
  /** Started detached for a dialog asking for a re-login; `{id}` and `{reason}`. */
  reloginAsk: argv.optional(),
  health: z
    .strictObject({
      /** This machine's name in the rows (default: the host name). */
      local: z.string().min(1).optional(),
      /** Prints this machine's pending re-login asks, one `<id> <epoch s>` per line. */
      pending: argv.optional(),
      /** The repair command shown on a row; `{id}` and `{machine}`. */
      fix: z.string().min(1).optional(),
      /** Started on `health --wake` when the picture changed; `{message}`. */
      notify: argv.optional(),
      peer: HealthPeer.optional(),
    })
    .optional(),
})
export type Integrations = z.infer<typeof IntegrationsSchema>

const readObject = (path: string): Record<string, unknown> => {
  const j: unknown = JSON.parse(readFileSync(path, 'utf8'))
  if (!j || typeof j !== 'object' || Array.isArray(j)) throw new Error(`${path}: not an object`)
  return j as Record<string, unknown>
}

const overlayPath = () =>
  process.env.CLAUDE_ACCOUNTS_INTEGRATIONS ?? join(homedir(), '.config', 'claude-accounts', 'integrations.json')

/** The registry's `integrations` over the per-machine overlay file; {} when neither names any. Throws on a malformed one. */
export function loadIntegrations(registryFile: string): Integrations {
  let fromRegistry: unknown = {}
  try {
    fromRegistry = readObject(registryFile).integrations ?? {}
  } catch {
    // an unreadable registry is the registry loader's error, not this one's
  }
  const overlay = overlayPath()
  const fromFile = existsSync(overlay) ? readObject(overlay) : {}
  const parsed = IntegrationsSchema.safeParse({ ...(fromRegistry as object), ...fromFile })
  if (!parsed.success)
    throw new Error(
      `integrations: ${parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ')}`,
    )
  return parsed.data
}

/** Replaces `{name}` in every element. */
export const fill = (cmd: string[], vars: Record<string, string>): string[] =>
  cmd.map((a) => a.replace(/\{(\w+)\}/g, (m, k: string) => vars[k] ?? m))

const PEER_USAGE_TIMEOUT_MS = 20_000

/** The peer's `usage --json` (a pure file read there: it never refreshes, so no loop). Throws when unreachable or garbled. */
export const peerUsageFrom =
  (cmd: string[]): PeerUsage =>
  () => {
    const r = boundedSpawnSync(cmd[0], cmd.slice(1), { timeoutMs: PEER_USAGE_TIMEOUT_MS })
    if (r.error || r.status !== 0) throw new Error(`${cmd[0]} failed (${r.error?.message ?? `rc=${r.status}`})`)
    return JSON.parse(r.stdout)
  }
