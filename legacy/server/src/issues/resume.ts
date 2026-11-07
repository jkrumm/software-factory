import type { RoleTable, Spawn } from '@software-factory/contract'
import type { SQL } from 'bun'
import { resolveRepo } from '../repos.ts'
import { createSpawn } from '../spawns.ts'
import { leadKey } from './names.ts'

export type Resumed = { ok: true; spawn: Spawn } | { ok: false; problem: 'unknown_issue' | 'no_archive' }

/**
 * `factory issue resume`: a fork of an attempt's archived session, in a tab of its own, through the queue like any spawn. It is the owner's
 * look at a closed attempt and no lead: no `issue_id`, so it takes no claim and reports on nothing. The session's own id goes nowhere
 * but `--resume`, and `--fork-session` leaves the archived one as it is.
 */
export async function resumeArchived(
  sql: SQL,
  input: { issueId: number; attempt?: number; id?: string; roles: RoleTable; repoRoots: readonly string[]; now: Date },
): Promise<Resumed> {
  const { issueId, now } = input
  const [issue]: { repo: string; attempt: number }[] =
    await sql`SELECT repo, attempt FROM factory.issues WHERE id = ${issueId}`
  if (!issue) return { ok: false, problem: 'unknown_issue' }
  const attempt = input.attempt ?? issue.attempt
  const [archived]: { link: string; claude: string }[] = await sql`
    SELECT link, payload->>'claudeSessionId' AS claude FROM factory.evidence
    WHERE issue_id = ${issueId} AND kind = 'transcript' AND attempt = ${attempt} AND payload->>'session' = ${leadKey(issueId, attempt)}
    ORDER BY id DESC LIMIT 1`
  if (!archived) return { ok: false, problem: 'no_archive' }
  const role = input.roles.get('lead')
  if (!role) throw new Error('the role table has no `lead`')
  const repo = await resolveRepo(issue.repo, input.repoRoots)
  const { spawn } = await createSpawn(
    sql,
    {
      key: `resume-${issueId}-${attempt}-${input.id ?? crypto.randomUUID().slice(0, 8)}`,
      repo,
      space: repo,
      prompt: `This is a fork of the lead of Issue ${issueId}, attempt ${attempt}, opened by the owner from the archive. Wait for the owner's question.`,
      role: 'lead',
      tier: role.tier,
      effort: role.effort,
      fork: { session: archived.claude, archive: archived.link },
    },
    now,
  )
  return { ok: true, spawn }
}
