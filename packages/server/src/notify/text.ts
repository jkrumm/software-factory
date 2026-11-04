import { basename } from 'node:path'

/** Most characters of agent text in a message. */
export const QUOTE_MAX = 200

const SECRETS: RegExp[] = [
  /\bBearer\s+\S+/gi,
  /\bop:\/\/\S+/g,
  /\b(?:sk|pk|rk)-[A-Za-z0-9_-]{8,}/g,
  /\b(?:ghp|gho|ghu|ghs|ghr|github_pat|glpat|xox[a-z])[-_A-Za-z0-9]{8,}/g,
  /\bAKIA[0-9A-Z]{12,}/g,
  /\b[a-z][a-z0-9+.-]*:\/\/[^\s/@:]+:[^\s/@]+@\S+/gi,
  // a long run of token characters is a key or a hash, never prose
  /[A-Za-z0-9_+/=-]{32,}/g,
]
const HOSTS: RegExp[] = [
  /\b(?:[a-z0-9-]+\.)+(?:ts\.net|local|lan|internal|home\.arpa|localdomain)\b/gi,
  /\b\d{1,3}(?:\.\d{1,3}){3}\b/g,
]

/** Best effort, not a guarantee: the texts are templates around agent words, and these are the shapes a secret or a host has. */
export function redact(text: string): string {
  // A link keeps its address and loses what carries a credential: a query string and a fragment, with or without a scheme.
  let out = text.replace(/(?<=\S)\?(?=\S*=)\S*/g, '').replace(/(?<=[\w/])#\S*/g, '')
  // A path on this machine says where the repos live: only its last part stays.
  out = out.replace(/\bfile:\/\/\S*\/([^\s/]+)/gi, 'file://…/$1')
  out = out.replace(
    /(?<![\w:/.~-])~?(?:\/[^\s/"'()<>,;:]+){2,}/g,
    (path) => `…/${path.slice(path.lastIndexOf('/') + 1)}`,
  )
  for (const pattern of SECRETS) out = out.replace(pattern, '[secret]')
  for (const pattern of HOSTS) out = out.replace(pattern, '[host]')
  return out
}

// oxlint-disable-next-line no-control-regex -- exactly what is removed
const CONTROL = /[\u0000-\u001f\u007f-\u009f]+/g

/**
 * Agent text as the owner reads it in a message: one line, no control characters, no secrets or hosts, cut to `max`, and fenced in
 * quotation marks it cannot contain, so it reads as a quote and never as part of the factory's own sentence.
 */
export function quote(text: string, max = QUOTE_MAX): string {
  const clean = redact(text.replace(CONTROL, ' ').replace(/\s+/g, ' ').trim()).replace(/[“”"]/g, "'")
  const cut = clean.length > max ? `${clean.slice(0, max).trimEnd()}…` : clean
  return `“${cut}”`
}

/** `Issue 12 (software-factory)`: the id and the repo's name first, never its path. */
export const issueHead = (issue: { id: number; repo: string }): string =>
  `Issue ${issue.id} (${basename(issue.repo) || 'repo'})`

export interface Message {
  key: string
  kind: 'ask' | 'parked' | 'failed' | 'regression' | 'digest' | 'test'
  issueId: number | null
  text: string
}

export interface IssueRef {
  id: number
  repo: string
}

export function askMessage(input: {
  issue: IssueRef
  decision: number
  question: string
  options?: readonly string[]
  default?: string | null
}): Message {
  const options = input.options?.length ? ` [options: ${input.options.map((o) => quote(o, 40)).join(', ')}]` : ''
  const fallback = input.default ? ` [default: ${quote(input.default, 40)}]` : ''
  return {
    key: `notify:ask:${input.decision}`,
    kind: 'ask',
    issueId: input.issue.id,
    text: `${issueHead(input.issue)} asks: ${quote(input.question)}${options}${fallback} Answer: factory issue answer ${input.issue.id} "<text>" --decision ${input.decision}`,
  }
}

export function parkedMessage(input: {
  issue: IssueRef
  revision: number
  reason: 'unreported' | 'lead_gone' | 'regressed'
  detail?: string | null
}): Message {
  const what =
    input.reason === 'unreported'
      ? 'its lead stopped twice with nothing reported'
      : input.reason === 'regressed'
        ? 'it regressed three times after its ship'
        : `its lead is gone${input.detail ? ` ${quote(input.detail)}` : ''}`
  return {
    key: `notify:parked:${input.issue.id}:${input.revision}`,
    kind: 'parked',
    issueId: input.issue.id,
    text: `${issueHead(input.issue)} parked: ${what}`,
  }
}

export function failedMessage(input: {
  issue: IssueRef | null
  kind: string
  id: string
  what: string
  detail?: string | null
}): Message {
  const head = input.issue ? issueHead(input.issue) : 'Factory'
  return {
    key: `notify:failed:${input.kind}:${input.id}`,
    kind: 'failed',
    issueId: input.issue?.id ?? null,
    text: `${head} failed: ${input.what}${input.detail ? ` ${quote(input.detail)}` : ''}`,
  }
}

export function regressionMessage(input: { issue: IssueRef; hold: number; title?: string | null }): Message {
  return {
    key: `notify:regression:${input.issue.id}:${input.hold}`,
    kind: 'regression',
    issueId: input.issue.id,
    text: `${issueHead(input.issue)} regressed after its ship (hold ${input.hold}) and went back to its lead${input.title ? `: ${quote(input.title)}` : ''}`,
  }
}
