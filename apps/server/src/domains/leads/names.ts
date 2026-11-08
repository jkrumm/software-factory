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

const TAB_NAME_MAX = 32
const TAB_NAME_PREFIX = 'Lead: '

/**
 * The name of a lead's tab in the Herdr app: `Lead: <topic>`, the topic being the start of the Issue's title (cut at the
 * first `,` `;` `—` `–`, without a leading article, at most four words) shortened to fit 32 characters. No number: the
 * tab says what the lead works on, the Issue is one click away. A blank title is just `Lead`.
 */
export function tabName(title: string): string {
  const head = (title.split(/[,;—–]/)[0] ?? '').trim().replace(/^(?:a|an|the)\s+/i, '')
  const words = head.split(/\s+/).filter(Boolean).slice(0, 4)
  if (words.length === 0) return 'Lead'
  while (words.length > 1 && (TAB_NAME_PREFIX + words.join(' ')).length > TAB_NAME_MAX) words.pop()
  return (TAB_NAME_PREFIX + words.join(' ')).slice(0, TAB_NAME_MAX)
}
