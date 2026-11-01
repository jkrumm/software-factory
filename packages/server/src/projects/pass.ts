import type { SQL } from 'bun'
import { releaseClosed } from './claims.ts'
import type { ProjectSync } from './sync.ts'

/**
 * The tick's share of projects, before it claims spawns: the claims of closed Issues are given back (so the next Issue
 * is promoted in this very pass), then the projects are synced if a sync is due. Returns the errors the pass had, for the tick's result.
 */
export async function projectPass(sql: SQL, sync?: ProjectSync): Promise<string[]> {
  const errors: string[] = []
  try {
    for (const key of (await releaseClosed(sql)).failed)
      console.error('spawn failed', { key, reason: 'its Issue closed' })
  } catch (error) {
    errors.push(`claims: ${error instanceof Error ? error.message : String(error)}`)
  }
  try {
    const result = await sync?.syncIfDue()
    for (const message of result?.errors ?? []) errors.push(`projects: ${message}`)
  } catch (error) {
    errors.push(`projects: ${error instanceof Error ? error.message : String(error)}`)
  }
  return errors
}
