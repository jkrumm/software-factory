// Fix commits by cause. A commit whose subject is `fix(<scope>): …` is a fix; its scope or its words decide the cause by a rule
// (`causeOf`), and a commit no rule places is `other`. No model is asked.

import type { FixCauseKey } from '@software-factory/contract'

/** Commits older than this are not read: the Improve screen shows four weeks, and a week of slack covers a late pass. */
export const FIX_WINDOW_DAYS = 35

/** A fix commit as read from git. */
export interface FixCommit {
  sha: string
  committedAt: Date
  subject: string
  scope: string | null
}

/** A fix commit with its cause, as stored (`migrations/0997_fix_commits.sql`, the column `class`). */
export interface FixCommitRow {
  repo: string
  sha: string
  committedAt: Date
  subject: string
  scope: string | null
  class: FixCauseKey
  by: 'rule'
  reason: string | null
}

const SUBJECT = /^fix(?:\(([^)]*)\))?!?:\s*(\S.*)$/

/** The scope and the words after the colon of a conventional `fix` subject; null for any other subject. */
export function parseFixSubject(subject: string): { scope: string | null; text: string } | null {
  const match = SUBJECT.exec(subject.trim())
  if (!match) return null
  return { scope: match[1]?.trim() || null, text: (match[2] ?? '').trim() }
}

const BY_SCOPE: Record<string, FixCauseKey> = {
  test: 'tests',
  tests: 'tests',
  scenarios: 'tests',
  e2e: 'tests',
  docs: 'docs',
  doc: 'docs',
  readme: 'docs',
  ci: 'tooling',
  deps: 'tooling',
  build: 'tooling',
  lint: 'tooling',
  scripts: 'tooling',
  release: 'tooling',
}

const REVIEW_WORDS = /\b(review (finding|round)s?|address(ed|es|ing)? (the )?review)\b/i

/** The cause the scope or the words of the subject decide; `other` when no rule does. */
export function causeOf(commit: Pick<FixCommit, 'subject'>): { cause: FixCauseKey; reason: string } {
  const other = { cause: 'other', reason: 'no rule places it' } as const
  const parsed = parseFixSubject(commit.subject)
  if (!parsed) return other
  const causes = new Set(
    (parsed.scope ?? '')
      .toLowerCase()
      .split(/[\s,/+&]+/)
      .filter(Boolean)
      .map((part) => BY_SCOPE[part]),
  )
  const [only] = causes
  if (causes.size === 1 && only) return { cause: only, reason: `scope ${parsed.scope}` }
  if (REVIEW_WORDS.test(parsed.text)) return { cause: 'review', reason: 'the subject names a review' }
  return other
}
