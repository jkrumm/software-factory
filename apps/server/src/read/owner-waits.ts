import type { SQL } from 'bun'
import type { OwnerWaitRow } from '../domains/planning/ports.ts'
import type { OwnerWaitKind } from '../domains/planning/replan.ts'
import { readChain } from './chain.ts'
import { holdsOf } from './holds.ts'
import { readNeeds } from './needs.ts'

/** The Needs you kinds that are a wait on the owner's answer (`OwnerWaitKind` of the planning domain; read/ imports only its types). */
const OWNER_KINDS: readonly OwnerWaitKind[] = ['decision', 'review', 'errand']
const isOwnerKind = (kind: string): kind is OwnerWaitKind => (OWNER_KINDS as readonly string[]).includes(kind)

/**
 * The chain heads that have waited on the owner for at least `thresholdMs` with open Issues or plan rows behind them: what
 * Needs you shows him (a Decision that reached him, a Spec or Concept under his review, an Errand), per Issue its oldest
 * wait. The chain is read once for both. Read-only SQL.
 */
export async function readOwnerWaits(sql: SQL, thresholdMs: number, now: Date): Promise<OwnerWaitRow[]> {
  const chain = await readChain(sql, now)
  const needs = await readNeeds(sql, now, { chain })
  const holds = holdsOf(chain)
  const titles = new Map(chain.nodes.map((node) => [node.id, node.title]))
  const oldest = new Map<string, Wait>()
  for (const item of needs.items) {
    if (!item.issue || !item.repo || !isOwnerKind(item.kind) || item.ageMs < thresholdMs) continue
    const wait: Wait = { ...item, issue: item.issue, repo: item.repo, kind: item.kind }
    const seen = oldest.get(wait.issue)
    if (!seen || Date.parse(wait.since) < Date.parse(seen.since)) oldest.set(wait.issue, wait)
  }
  return [...oldest.values()]
    .sort((a, b) => Date.parse(a.since) - Date.parse(b.since) || a.id.localeCompare(b.id))
    .flatMap((wait): OwnerWaitRow[] => {
      const held = holds(wait.issue)
      if (held.issues.length === 0 && held.rows.length === 0) return []
      return [
        {
          issue: wait.issue,
          repo: wait.repo,
          title: titles.get(wait.issue) ?? wait.issue,
          since: new Date(wait.since),
          owner: { kind: wait.kind, id: wait.id, title: wait.title },
          heldIssues: held.issues,
          heldRows: held.rows,
        },
      ]
    })
}

interface Wait {
  issue: string
  repo: string
  kind: OwnerWaitKind
  id: string
  title: string
  since: string
}
