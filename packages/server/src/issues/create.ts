import { realpath } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Issue } from '@software-factory/contract'
import type { SQL } from 'bun'
import { RepoRefused, resolveRepo } from '../repos.ts'
import { blockerRefusal } from './deps.ts'
import { findIssue, type IssueRow, toIssue } from './read.ts'
import { logEvent } from './shared.ts'

/** The sources the intake files for: none of them reaches IuRoot (decision 3). */
export const INTAKE_SOURCES = new Set(['alert', 'github', 'checks', 'launchd'])

/** A create the policy refuses; the message is the 422 body. */
class IssueRefused extends RepoRefused {}

export interface NewIssue {
  /** `request` or `alert` through the API; open for what the server files itself (`upkeep`) */
  source: string
  sourceKey: string
  repo: string
  title: string
  facts: unknown
  /** Issues this one waits for (`--after`); each must exist and be open. Written with the row, or nothing is. */
  after?: readonly number[]
}

const namesIuRoot = (path: string): boolean => path.split('/').some((part) => part.toLowerCase() === 'iuroot')

/**
 * An alert never reaches the IuRoot workspace (decision 3). By name, on the path as given and as resolved, and by place: inside the
 * resolved `$HOME/IuRoot`, configured or not, or a configured root that names IuRoot, so a link of any name is caught.
 */
async function inIuRoot(submitted: string, roots: readonly string[]): Promise<boolean> {
  const repo = await realpath(submitted).catch(() => submitted)
  if (namesIuRoot(repo) || namesIuRoot(submitted)) return true
  for (const root of [join(process.env.HOME ?? homedir(), 'IuRoot'), ...roots.filter(namesIuRoot)]) {
    const real = await realpath(root).catch(() => undefined)
    if (real && (repo === real || repo.startsWith(`${real}/`))) return true
  }
  return false
}

/**
 * The real path of a repo an Issue of `source` may be filed in: inside the roots, and for an intake source never IuRoot. Throws
 * `RepoRefused`. The IuRoot look comes first, and with no path in the answer (the roots' refusal names the resolved path); then
 * the stored path answers for itself: a link can be pointed elsewhere between the two looks.
 */
export async function vetIntakeRepo(source: string, path: string, repoRoots: readonly string[]): Promise<string> {
  const refuse = async (candidate: string): Promise<void> => {
    if (!INTAKE_SOURCES.has(source) || !(await inIuRoot(candidate, repoRoots))) return
    throw new IssueRefused('an alert files no Issue in IuRoot')
  }
  await refuse(path)
  const repo = await resolveRepo(path, repoRoots)
  await refuse(repo)
  return repo
}

/** Postgres refuses this JSON: half a surrogate pair, a NUL, or nesting past its stack, whose depth differs per host. */
const UNSTORABLE_JSON = new Set(['22P02', '22P05', '54001'])

/**
 * Stores a new Issue, always `queued`, with its first `issue_events` row. A repeated `(source, sourceKey)` answers the stored
 * row whatever it became, a closed one too: this wave reopens nothing, and the policy has nothing to add to a row it let in. A
 * repeat is a read: its `after` is neither checked nor written, so the stored deps stand whatever the repeat says.
 * Refused: a repo outside `repoRoots` (as a spawn's), an alert in IuRoot, and an `after` that names an unknown or closed Issue.
 * All throw `RepoRefused`, and nothing is stored. A cycle cannot happen: no Issue waits for one that does not exist yet.
 */
export async function createIssueIn(
  tx: SQL,
  input: NewIssue,
  context: { repoRoots: readonly string[]; now: Date },
): Promise<{ issue: Issue; created: boolean }> {
  const { now } = context
  const known = await findIssue(tx, input.source, input.sourceKey)
  if (known) return { issue: known, created: false }

  const repo = await vetIntakeRepo(input.source, input.repo, context.repoRoots)

  const after = [...new Set(input.after ?? [])].sort((a, b) => a - b)
  for (const on of after) {
    const refusal = await blockerRefusal(tx, on)
    if (refusal) throw new IssueRefused(refusal)
  }

  const facts = JSON.stringify(input.facts)
  const rows: IssueRow[] = await tx`
    INSERT INTO factory.issues (state, source, source_key, repo, title, facts, created_at, updated_at)
    VALUES ('queued', ${input.source}, ${input.sourceKey}, ${repo}, ${input.title}, ${facts}::text::jsonb, ${now}, ${now})
    ON CONFLICT (source, source_key) DO NOTHING
    RETURNING *`.catch((error: unknown) => {
    if (UNSTORABLE_JSON.has((error as { errno?: string }).errno ?? '')) {
      throw new IssueRefused('facts cannot be stored as JSON')
    }
    throw error
  })
  const [row] = rows
  if (!row) {
    // Lost the race for the key: the winner has committed, or this statement would have waited for it.
    const winner = await findIssue(tx, input.source, input.sourceKey)
    if (!winner) throw new Error(`issue ${input.source}:${input.sourceKey} was not stored`)
    return { issue: winner, created: false }
  }
  for (const on of after) {
    await tx`INSERT INTO factory.issue_deps (issue_id, on_issue) VALUES (${row.id}, ${on})`
  }
  await logEvent(
    tx,
    { issueId: row.id, key: `created:${row.id}`, kind: 'created', from: null, to: 'queued', at: now },
    { source: row.source, ...(after.length > 0 ? { after } : {}) },
  )
  return { issue: toIssue(row), created: true }
}

export const createIssue = (
  sql: SQL,
  input: NewIssue,
  context: { repoRoots: readonly string[]; now: Date },
): Promise<{ issue: Issue; created: boolean }> => sql.begin((tx) => createIssueIn(tx, input, context))
