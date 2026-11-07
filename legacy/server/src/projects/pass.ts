import type { SQL } from 'bun'
import { releaseClosed } from './claims.ts'
import { planPass } from './plan.ts'
import type { ProjectSync } from './sync.ts'

/**
 * The tick's share of projects, before it claims spawns: the claims of closed Issues are given back (so the next Issue
 * is promoted in this very pass), then the projects are synced if a sync is due, then each project's plan files the rows whose
 * dependencies are closed (`plan.ts`; every tick, so a closing Issue files the next row at once). Returns the errors the pass had and the spawns it failed, for the tick's result.
 */
export async function projectPass(sql: SQL, sync?: ProjectSync): Promise<{ errors: string[]; failed: string[] }> {
  const errors: string[] = []
  let failed: string[] = []
  try {
    failed = (await releaseClosed(sql)).failed
    for (const key of failed) console.error('spawn failed', { key, reason: 'its Issue closed' })
  } catch (error) {
    errors.push(`claims: ${error instanceof Error ? error.message : String(error)}`)
  }
  try {
    const result = await sync?.syncIfDue()
    for (const message of result?.errors ?? []) errors.push(`projects: ${message}`)
  } catch (error) {
    errors.push(`projects: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (sync) {
    try {
      errors.push(...(await planPass(sql, { repoRoots: sync.roots, now: sync.now() })))
    } catch (error) {
      errors.push(`plan: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  return { errors, failed }
}
