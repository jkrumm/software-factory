import { type IssueId, issueId, issueNumber } from '../../kernel/ids.ts'

/**
 * A lead's name, one per attempt: the spawn key the terminal's label carries, the `FACTORY_SESSION` its hooks report
 * under, and the spool file's name. The hook parses it too (`lead-<n>-<attempt>`, no server call), so it never changes.
 */
export const leadKey = (issue: IssueId, attempt: number): string => `lead-${issueNumber(issue)}-${attempt}`

const LEAD_KEY = /^lead-([1-9][0-9]*)-([1-9][0-9]*)$/

/** The Issue and attempt a session name stands for; null for any other session. */
export function parseLeadKey(session: string): { issue: IssueId; attempt: number } | null {
  const match = LEAD_KEY.exec(session)
  if (!match?.[1] || !match[2]) return null
  return { issue: issueId(Number(match[1])), attempt: Number(match[2]) }
}

/** The lead's branch, cut from the repo's default branch as the remote has it. */
export const leadBranch = (issue: IssueId, attempt: number): string => `factory/${issueNumber(issue)}-${attempt}`
