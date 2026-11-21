import { type IssueKind, type IssueOrigin, RETRO_MARKER, type Signal } from '@software-factory/contract'
import { key, type Key } from '../../kernel/keys.ts'
import type { LoopFinding, OpenIssue, Received, RepoSignals } from './model.ts'

/** The sources whose alerts come through the door; a route in the registry is the owner's act of listening. */
const DOOR_SOURCES: readonly string[] = ['kuma', 'hyperdx']
/** The sources that correlate into an incident when they sit on one host. */
const CORRELATED_SOURCES: readonly string[] = ['kuma', 'hyperdx']

/** Where a source comes from, in the words a person uses (`docs/language.md`, Origin). */
export function originOf(source: string): IssueOrigin {
  if (source === 'kuma' || source === 'launchd') return 'infrastructure'
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
export function issueKindOf(received: Received): IssueKind {
  const { signal } = received
  if (signal.kind === 'alert') return signal.source === 'launchd' ? 'bug' : 'incident'
  return signal.kind === 'remark' ? 'chore' : 'feature'
}

/** Whether a project hears this automatic source. The door's are routed; the rest its `signals:` lists. */
export function hears(info: RepoSignals, source: string): boolean {
  return DOOR_SOURCES.includes(source) || info.sources.includes(source)
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
const MATCH_AT = 0.6
/** Between this and `MATCH_AT` a person would have to look: the triage workflow does. */
const UNSURE_AT = 0.3

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

/**
 * A signal that carries the retro marker (it ends with it, but a stray full stop must not lose the guard) is one recommendation with its own number to move: it files its own Issue and
 * is never folded into another by title or by the triage workflow (an amended signal rides on an Issue that asked for
 * other work and is counted shipped with it).
 */
export function isRetroSignal(text: string): boolean {
  return RETRO_MARKER.test(text)
}

/** Every subject row a loop's finding keeps starts with this: an Issue with one answers its key alone. */
export const FINDING_PREFIX = 'finding:'

/** A loop's finding as one subject: the loop, the class, the repo and the subject, never the words. */
export const findingKeyOf = (finding: LoopFinding, repo: string | null): Key =>
  key('finding', finding.loop, finding.class, repo ?? '-', finding.subject)

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
  /** every host of `config/infra.json` */
  hosts: ReadonlySet<string>
}

/**
 * The incident an alert would belong to: alerts on one host or dependency join one root cause. Kuma and HyperDX alert in the
 * repo whose host it is: the infra table's host for the repo, else the host the project names (`ownHost`) when it is a known
 * host. Null when the alert sits on no known host.
 */
export function groupOf(topology: Topology, received: Received, repo: string, ownHost?: string | null): string | null {
  if (received.signal.kind !== 'alert' || !CORRELATED_SOURCES.includes(received.signal.source)) return null
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
