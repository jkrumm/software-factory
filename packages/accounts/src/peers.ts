// The health verb's reads of a machine: this one in process, the peer through the transports the user configured.
import { type HealthRow, type PendingAsk, gradeMachine, healthSignature, worst } from './health.ts'
import { boundedSpawnSync } from './spawn.ts'
import type { Integrations } from './integrations.ts'
import { fill } from './integrations.ts'

export const parseJson = (t: string) => {
  try {
    return JSON.parse(t)
  } catch {
    return null
  }
}

export type Snapshot = {
  usage: unknown
  expiry: unknown
  pending: PendingAsk[] | null
  via?: string
  note?: string
}

/** `<id> <epoch s>` lines of a pending-asks listing. */
export function pendingFrom(text: string, nowMs: number): PendingAsk[] {
  return text.split('\n').flatMap((l) => {
    const m = /^([0-9T-]+) (\d+)$/.exec(l.trim())
    return m ? [{ id: m[1], ageMs: nowMs - Number(m[2]) * 1000 }] : []
  })
}

/** `usage @@ expiry @@ pending`, the text a peer snapshot prints. */
export function parseSnapshot(stdout: string, nowMs: number): Snapshot {
  const [u = '', e = '', q = ''] = stdout.split('@@\n')
  return { usage: parseJson(u), expiry: parseJson(e), pending: pendingFrom(q, nowMs) }
}

const SNAPSHOT_TIMEOUT_MS = 40_000

/** The first configured transport that answers; when none does, `usage` is null (unreachable) and the last transport's name and note stay. */
export function peerSnapshot(peer: NonNullable<NonNullable<Integrations['health']>['peer']>, nowMs: number): Snapshot {
  for (const s of peer.snapshots) {
    const r = boundedSpawnSync(s.argv[0], s.argv.slice(1), { timeoutMs: SNAPSHOT_TIMEOUT_MS })
    if (!r.error && r.stdout.includes('@@\n'))
      return { ...parseSnapshot(r.stdout, nowMs), via: s.via, ...(s.note ? { note: s.note } : {}) }
  }
  const last = peer.snapshots[peer.snapshots.length - 1]
  return { usage: null, expiry: null, pending: null, via: last.via, ...(last.note ? { note: last.note } : {}) }
}

/** This machine's pending asks from the configured listing; none without one. */
export function localPending(cmd: string[] | undefined, nowMs: number): PendingAsk[] {
  if (!cmd) return []
  const r = boundedSpawnSync(cmd[0], cmd.slice(1), { timeoutMs: 30_000 })
  return r.error ? [] : pendingFrom(r.stdout, nowMs)
}

export { fill, gradeMachine, healthSignature, worst }
export type { HealthRow, PendingAsk }
