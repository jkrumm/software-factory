import { type Key, key } from '../../kernel/keys.ts'

/** What the owner's line carries: a checkpoint, and nothing else (NL20). Work the factory settles never pages. */
export const PAGE_KINDS = ['decision', 'review', 'errand'] as const
export type PageKind = (typeof PAGE_KINDS)[number]

/** A message on the owner's line, finished text: the factory calls no model for it. */
export interface Page {
  key: Key
  kind: PageKind
  /** the Decision, artifact or Errand it is about */
  checkpoint: string
  issueId: string
  title: string
  body: string
  /** where the checkpoint is answered */
  link: string
}

/** A Decision pages once, however often its steps replay. */
export const decisionPageKey = (decision: string): Key => key('page', 'decision', decision)
/** A revision pages once; a revised artifact is a new revision and pages again. */
export const reviewPageKey = (artifact: string, revision: number): Key => key('page', 'review', artifact, revision)
/** The one push of a revision that stayed unanswered for a day; the first page keeps its own key. */
export const reviewPushKey = (artifact: string, revision: number): Key =>
  key('page', 'review', 'push', artifact, revision)
export const errandPageKey = (errand: string): Key => key('page', 'errand', errand)

/** The Console's page for a checkpoint. `base` is a setting until the Console exists. */
export const deepLink = (base: string, checkpoint: string): string =>
  `${base.replace(/\/+$/, '')}/checkpoints/${encodeURIComponent(checkpoint)}`

const MAX_QUOTE = 200

const SECRETS: RegExp[] = [
  /\bBearer\s+\S+/gi,
  /\bop:\/\/\S+/g,
  /\b(?:sk|pk|rk)-[A-Za-z0-9_-]{8,}/g,
  /\b(?:ghp|gho|ghu|ghs|ghr|github_pat|glpat|xox[a-z])[-_A-Za-z0-9]{8,}/g,
  /\bAKIA[0-9A-Z]{12,}/g,
  /\b[a-z][a-z0-9+.-]*:\/\/[^\s/@:]+:[^\s/@]+@\S+/gi,
  /[A-Za-z0-9_+/=-]{32,}/g,
]
const HOSTS: RegExp[] = [
  /\b(?:[a-z0-9-]+\.)+(?:ts\.net|local|lan|internal|home\.arpa|localdomain)\b/gi,
  /\b\d{1,3}(?:\.\d{1,3}){3}\b/g,
]
// oxlint-disable-next-line no-control-regex -- exactly what is removed
const CONTROL = /[\u0000-\u001f\u007f-\u009f]+/g

/** Best effort, not a guarantee: the messages are templates around a lead's words, and these are the shapes a secret or a host has. */
export function redact(value: string): string {
  let out = value.replace(/(?<=\S)\?(?=\S*=)\S*/g, '').replace(/(?<=[\w/])#\S*/g, '')
  out = out.replace(/\bfile:\/\/\S*\/([^\s/]+)/gi, 'file://…/$1')
  out = out.replace(
    /(?<![\w:/.~-])~?(?:\/[^\s/"'()<>,;:]+){2,}/g,
    (path) => `…/${path.slice(path.lastIndexOf('/') + 1)}`,
  )
  for (const pattern of SECRETS) out = out.replace(pattern, '[secret]')
  for (const pattern of HOSTS) out = out.replace(pattern, '[host]')
  return out
}

/** A lead's words as the owner reads them in a message: one line, redacted, cut, fenced in quotes it cannot contain. */
export function quote(value: string, max = MAX_QUOTE): string {
  const clean = redact(value.replace(CONTROL, ' ').replace(/\s+/g, ' ').trim()).replace(/[“”"]/g, "'")
  return `“${clean.length > max ? `${clean.slice(0, max).trimEnd()}…` : clean}”`
}

/** `Issue 12 (software-factory)`: the number and the repo's name first, never a path. */
export const issueHead = (issue: { id: string; repo: string }): string => {
  const name = issue.repo.split('/').filter(Boolean).pop() ?? 'repo'
  return `Issue ${issue.id.replace(/^issue_/, '')} (${name})`
}

type About = { issue: { id: string; repo: string }; link: string }

export function decisionPage(about: About & { decision: string; question: string; recommendation: string }): Page {
  return {
    key: decisionPageKey(about.decision),
    kind: 'decision',
    checkpoint: about.decision,
    issueId: about.issue.id,
    title: 'Decision',
    body: `${issueHead(about.issue)} asks: ${quote(about.question)} Recommended: ${quote(about.recommendation, 60)}`,
    link: about.link,
  }
}

export function reviewPage(
  about: About & { artifact: string; revision: number; kind: 'concept' | 'spec'; title: string },
): Page {
  return {
    key: reviewPageKey(about.artifact, about.revision),
    kind: 'review',
    checkpoint: about.artifact,
    issueId: about.issue.id,
    title: about.kind === 'concept' ? 'Concept to review' : 'Spec to review',
    body: `${issueHead(about.issue)} waits for your verdict on ${quote(about.title)} (revision ${about.revision})`,
    link: about.link,
  }
}

/** The second and last page of a revision nobody answered in a day. */
export function reviewPushPage(
  about: About & { artifact: string; revision: number; kind: 'concept' | 'spec'; title: string },
): Page {
  return {
    ...reviewPage(about),
    key: reviewPushKey(about.artifact, about.revision),
    title: about.kind === 'concept' ? 'Concept still waiting' : 'Spec still waiting',
    body: `${issueHead(about.issue)} still waits for your verdict on ${quote(about.title)} (revision ${about.revision}) after a day`,
  }
}

export function errandPage(about: About & { errand: string; summary: string }): Page {
  return {
    key: errandPageKey(about.errand),
    kind: 'errand',
    checkpoint: about.errand,
    issueId: about.issue.id,
    title: 'Errand',
    body: `${issueHead(about.issue)} needs your hands: ${quote(about.summary)}`,
    link: about.link,
  }
}

/** A claim not recorded within this long was a crashed send's: the page is due again, so it may arrive twice. */
export const PAGE_LEASE_MS = 120_000

/** The wait after the `attempt`th failed send: 30 s, doubling, at most 5 min. */
export const pageBackoffMs = (attempt: number): number => Math.min(30_000 * 2 ** Math.max(0, attempt - 1), 5 * 60_000)
