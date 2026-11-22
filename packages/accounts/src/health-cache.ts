// The last health rows of both machines, kept in the cache directory so a reader that must not shell out to the peer (the
// factory server's `GET /v1/accounts`, `claude-account status`) can show them. `claude-account health` writes it and so does each
// keepalive run (hourly); nothing here grades a row (health.ts does).
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { HealthRow } from './health.ts'
import { cacheDir } from './paths.ts'
import { writeAtomic } from './store.ts'

export interface HealthSnapshot {
  /** when the rows were read (ISO time) */
  at: string
  rows: HealthRow[]
}

const cachePath = (dir: string) => join(dir, 'health.json')

export function writeHealthCache(rows: HealthRow[], nowMs: number, dir = cacheDir()): void {
  const snapshot: HealthSnapshot = { at: new Date(nowMs).toISOString(), rows }
  writeAtomic(cachePath(dir), JSON.stringify(snapshot))
}

const isRow = (r: unknown): r is HealthRow => {
  if (typeof r !== 'object' || r === null) return false
  const x = r as Record<string, unknown>
  return (
    typeof x.machine === 'string' &&
    typeof x.id === 'string' &&
    typeof x.check === 'string' &&
    (x.state === 'ok' || x.state === 'warn' || x.state === 'fail') &&
    typeof x.detail === 'string'
  )
}

/** The cached rows; null when there is no cache or it is not one (a half-written or foreign file proves nothing). */
export function readHealthCache(dir = cacheDir()): HealthSnapshot | null {
  try {
    const raw = JSON.parse(readFileSync(cachePath(dir), 'utf8')) as { at?: unknown; rows?: unknown }
    if (typeof raw.at !== 'string' || !Array.isArray(raw.rows) || !raw.rows.every(isRow)) return null
    return { at: raw.at, rows: raw.rows }
  } catch {
    return null
  }
}
