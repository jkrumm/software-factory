// Fix commits by class. A commit whose subject is `fix(<scope>): …` is a fix; its scope or its words settle the class by a rule
// (`classOf`), and a commit no rule classes is `other`. No model is asked.

import type { FixClassKey } from '@software-factory/contract'

/** Commits older than this are not read: the Improve screen shows four weeks, and a week of slack covers a late pass. */
export const FIX_WINDOW_DAYS = 35

/** A fix commit as read from git. */
export interface FixCommit {
  sha: string
  committedAt: Date
  subject: string
  scope: string | null
}

/** A fix commit with its class, as stored (`migrations/0997_fix_commits.sql`). */
export interface FixCommitRow {
  repo: string
  sha: string
  committedAt: Date
  subject: string
  scope: string | null
  class: FixClassKey
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

const BY_SCOPE: Record<string, FixClassKey> = {
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

/** The class the scope or the words of the subject settle; `other` when no rule does. */
export function classOf(commit: Pick<FixCommit, 'subject'>): { class: FixClassKey; reason: string } {
  const other = { class: 'other', reason: 'no rule classes it' } as const
  const parsed = parseFixSubject(commit.subject)
  if (!parsed) return other
  const classes = new Set(
    (parsed.scope ?? '')
      .toLowerCase()
      .split(/[\s,/+&]+/)
      .filter(Boolean)
      .map((part) => BY_SCOPE[part]),
  )
  const [only] = classes
  if (classes.size === 1 && only) return { class: only, reason: `scope ${parsed.scope}` }
  if (REVIEW_WORDS.test(parsed.text)) return { class: 'review', reason: 'the subject names a review' }
  return other
}
