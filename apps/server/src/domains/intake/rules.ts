import type { Signal } from '@software-factory/contract'
import type { OpenIssue, Received, RepoSignals } from './model.ts'

/** The sources whose alerts come through the door; a route in the registry is the owner's act of listening. */
export const DOOR_SOURCES: readonly string[] = ['kuma', 'hyperdx']
/** The sources that correlate into an incident when they sit on one host. */
export const CORRELATED_SOURCES: readonly string[] = ['kuma', 'hyperdx', 'beszel']

export type IssueKindName = 'feature' | 'bug' | 'chore' | 'docs' | 'incident'
export type OriginName = Signal['origin']

/** Where a source comes from, in the words a person uses (`docs/language.md`, Origin). */
export function originOf(source: string): OriginName {
  if (source === 'kuma' || source === 'beszel' || source === 'launchd') return 'infrastructure'
  if (source === 'hyperdx') return 'application'
  if (source === 'github' || source === 'checks') return 'github'
  if (source.startsWith('feedback:')) return 'feedback'
  if (source.startsWith('owner')) return 'you'
  return 'factory'
}

/**
 * What the Issue is when intake files it. Alerts of the monitoring sources are incidents (one root cause seen through
 * many signals); a failing check on the default branch is one too, since a red default branch stops every merge and
 * takes the urgent claim; a failing job is a bug; the rest is a request, which triage refines.
 */
export function issueKindOf(received: Received): IssueKindName {
  const { signal } = received
  if (signal.kind === 'alert') return signal.source === 'launchd' ? 'bug' : 'incident'
  return signal.kind === 'remark' ? 'chore' : 'feature'
}

/** Whether a project hears this automatic source. The door's and Beszel's are routed; the rest its `signals:` lists. */
export function hears(info: RepoSignals, source: string): boolean {
  return DOOR_SOURCES.includes(source) || source === 'beszel' || info.sources.includes(source)
}

export type Gate =
  | { pass: true }
  | { pass: false; detail: 'work_repo' | 'no_project' | 'not_listened' | 'no_repo'; reason: string }

/**
 * Who may put work in which repo (NL18): a work repo hears the owner only, an unknown repo hears no one, and a project
 * hears the automatic sources its `signals:` lists. The owner and agents are never gated by `signals:`.
 */
export function gate(signal: Signal, info: RepoSignals | null): Gate {
  if (signal.repo === null) return { pass: false, detail: 'no_repo', reason: 'the signal names no repo' }
  if (info === null)
    return { pass: false, detail: 'no_project', reason: `${signal.repo} is not a project the factory knows` }
  if (info.work && signal.trust !== 'owner') {
    return { pass: false, detail: 'work_repo', reason: `${signal.repo} is a work repo: it hears the owner only` }
  }
  if (signal.trust === 'machine' && !hears(info, signal.source)) {
    return {
      pass: false,
      detail: 'not_listened',
      reason: `${signal.repo} does not list ${signal.source} under signals`,
    }
  }
  return { pass: true }
}

const STOP = new Set(['the', 'and', 'for', 'with', 'that', 'this', 'from', 'are', 'was', 'not', 'when', 'into', 'its'])

const tokens = (text: string): Set<string> =>
  new Set(
    text
      .toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .filter((word) => word.length >= 3 && !STOP.has(word)),
  )

/** How much two titles say the same: the share of their words they have in common, 0 to 1. */
export function overlap(a: string, b: string): number {
  const left = tokens(a)
  const right = tokens(b)
  if (left.size === 0 || right.size === 0) return 0
  let shared = 0
  for (const word of left) if (right.has(word)) shared++
  return shared / (left.size + right.size - shared)
}

/** At or above this a title is the same ask. */
export const MATCH_AT = 0.6
/** Between this and `MATCH_AT` a person would have to look: the triage workflow does. */
export const UNSURE_AT = 0.3

export type Match = { kind: 'match'; issue: OpenIssue } | { kind: 'unsure'; candidates: OpenIssue[] } | { kind: 'none' }

/** Deterministic amend-or-new against the open Issues of the repo: one clear match, nothing near, or unsure. */
export function matchOpen(title: string, open: readonly OpenIssue[]): Match {
  const scored = open
    .map((issue) => ({ issue, score: overlap(title, issue.title) }))
    .filter((entry) => entry.score >= UNSURE_AT)
    .sort((a, b) => b.score - a.score || a.issue.id.localeCompare(b.issue.id))
  const best = scored[0]
  if (!best) return { kind: 'none' }
  const second = scored[1]
  // A clear match is both high and well ahead of the next candidate.
  if (best.score >= MATCH_AT && (!second || second.score < MATCH_AT)) return { kind: 'match', issue: best.issue }
  return { kind: 'unsure', candidates: scored.slice(0, 5).map((entry) => entry.issue) }
}

/** The same ask under another day's words: the repo and the title lower-cased, digits and punctuation out. */
export function fingerprintOf(repo: string | null, title: string): string {
  const normalized = title
    .toLowerCase()
    .replace(/[\p{N}\p{P}\p{S}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return new Bun.CryptoHasher('sha256')
    .update(`${repo ?? ''}\n${normalized}`)
    .digest('hex')
    .slice(0, 16)
}

/** What the lead reads of a signal: the title, then its text. Outside text is fenced as data wherever it is shown. */
export function fence(text: string): string {
  return text
    .split('\n')
    .map((line) => `> ${line}`)
    .join('\n')
}

export interface Topology {
  /** the host a repo's alerts sit on, from `config/infra.json`'s hosts; a project's own `host:` is the fallback in `groupOf` */
  hostOfRepo: ReadonlyMap<string, string>
  /** every host the Beszel source may name */
  hosts: ReadonlySet<string>
}

/**
 * The incident an alert would belong to: alerts on one host or dependency join one root cause. Beszel names its system
 * in the subject; Kuma and HyperDX alert in the repo whose host it is: the infra table's host for the repo, else the host the project names (`ownHost`) when
 * it is a known host. Null when the alert sits on no known host.
 */
export function groupOf(topology: Topology, received: Received, repo: string, ownHost?: string | null): string | null {
  if (received.signal.kind !== 'alert' || !CORRELATED_SOURCES.includes(received.signal.source)) return null
  if (received.signal.source === 'beszel') {
    const system = received.alert?.subject.split(':')[0]?.toLowerCase()
    return system && topology.hosts.has(system) ? `host:${system}` : null
  }
  const named = ownHost?.toLowerCase()
  const host = topology.hostOfRepo.get(repo) ?? (named && topology.hosts.has(named) ? named : null)
  return host ? `host:${host}` : null
}

/** One word for an Issue's number in a sentence a lead reads. */
export const noteOf = (received: Received, extra?: string): string => {
  const head = received.signal.title
  const body = received.signal.text
  return [extra ? `${extra}: ${head}` : head, body ? fence(body.slice(0, 2000)) : ''].filter(Boolean).join('\n')
}
