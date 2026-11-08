// Fix commits by class. A commit whose subject is `fix(<scope>): …` is a fix; where its scope or its words settle the class
// the factory says so without a model (`ruleClass`), the rest goes to `factory-fix-classes` in batches. The answer is checked
// against what was asked: a batch the workflow got wrong is stored not at all, and asked again next pass.

import {
  FIX_CLASS_KEYS,
  FIX_CLASSES,
  type FixClassesAnswer,
  type FixClassesRequest,
  type FixClassKey,
} from '@software-factory/contract'
import { key, type Key } from '../../kernel/keys.ts'

/** Commits older than this are not read: the Improve screen shows four weeks, and a week of slack covers a late pass. */
export const FIX_WINDOW_DAYS = 35
/** The most commits one workflow call sorts. */
export const FIX_BATCH = 40
/** A commit's body, as far as the workflow reads it. */
export const BODY_CHARS = 800
/** The most paths of one commit the workflow is shown. */
export const FILES_MAX = 20

/** A fix commit as read from git. */
export interface FixCommit {
  sha: string
  committedAt: Date
  subject: string
  scope: string | null
  body: string
  files: string[]
}

/** A fix commit with its class, as stored (`migrations/0997_fix_commits.sql`). */
export interface FixCommitRow {
  repo: string
  sha: string
  committedAt: Date
  subject: string
  scope: string | null
  class: FixClassKey
  by: 'rule' | 'workflow'
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

/** The class the scope or the words settle; null when only a read of the change can tell. */
export function ruleClass(commit: Pick<FixCommit, 'scope' | 'subject'>): { class: FixClassKey; reason: string } | null {
  const parsed = parseFixSubject(commit.subject)
  if (!parsed) return null
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
  return null
}

/** The batches the workflow is asked, oldest commit first within a batch. */
export function batchesOf<T>(items: readonly T[], size = FIX_BATCH): T[][] {
  const batches: T[][] = []
  for (let i = 0; i < items.length; i += size) batches.push(items.slice(i, i + size))
  return batches
}

export function requestOf(repo: string, commits: readonly FixCommit[]): FixClassesRequest {
  return {
    repo,
    classes: FIX_CLASSES.map((c) => ({ key: c.key, meaning: c.meaning })),
    commits: commits.map((c) => ({
      sha: c.sha,
      subject: c.subject,
      scope: c.scope,
      body: c.body.slice(0, BODY_CHARS),
      files: c.files.slice(0, FILES_MAX),
    })),
  }
}

/** The same commits of one repo on one day are the same run; a later day asks again (a refused answer is not asked for ever). */
export function batchKey(repo: string, shas: readonly string[], day: string): Key {
  const hash = new Bun.CryptoHasher('sha256')
    .update([...shas].sort().join(','))
    .digest('hex')
    .slice(0, 24)
  return key('fix-classes', repo, hash, day)
}

const isClass = (value: string): value is FixClassKey => (FIX_CLASS_KEYS as readonly string[]).includes(value)

/** One answer per asked sha with a class of the request: anything else leaves the whole batch unstored. */
export function checkAnswer(
  request: FixClassesRequest,
  answer: FixClassesAnswer,
): { ok: true; bySha: Map<string, { class: FixClassKey; reason: string }> } | { ok: false; why: string } {
  const asked = new Set(request.commits.map((c) => c.sha))
  const known = new Set(request.classes.map((c) => c.key))
  const bySha = new Map<string, { class: FixClassKey; reason: string }>()
  for (const a of answer.answers) {
    if (!asked.has(a.sha)) return { ok: false, why: `answered a commit that was not asked: ${a.sha.slice(0, 7)}` }
    if (bySha.has(a.sha)) return { ok: false, why: `answered ${a.sha.slice(0, 7)} twice` }
    if (!known.has(a.class) || !isClass(a.class)) return { ok: false, why: `unknown class ${a.class}` }
    bySha.set(a.sha, { class: a.class, reason: a.reason })
  }
  const missing = [...asked].filter((sha) => !bySha.has(sha))
  if (missing.length > 0) return { ok: false, why: `no answer for ${missing.map((s) => s.slice(0, 7)).join(', ')}` }
  return { ok: true, bySha }
}
