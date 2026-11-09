import { ReadChange } from '@software-factory/contract'

/** How often a query refetches while the stream is not open. */
export const POLL_MS = 15_000
/** While the stream is open a missed change still shows within this long: its keepalive is an SSE comment, invisible to `EventSource`. */
export const LIVE_SAFETY_MS = 60_000

export const pollEvery = (live: boolean): number => (live ? LIVE_SAFETY_MS : POLL_MS)

export const WATCHDOG_TICK_MS = 15_000
/** A tick this late means the machine slept or the tab was frozen, and a socket opened before it is likely dead. */
const SLEEP_GAP_MS = 45_000

export const sleptBetween = (previousTick: number, now: number): boolean => now - previousTick > SLEEP_GAP_MS

export interface FocusedElement {
  tagName: string
  isContentEditable: boolean
}

const isField = (element: FocusedElement | null): boolean =>
  element !== null && (element.isContentEditable || element.tagName === 'INPUT' || element.tagName === 'TEXTAREA')

/** A reload must not eat what the owner is typing: not while a field has focus, nor while a textarea holds a draft. */
export const safeToReload = (focused: FocusedElement | null, hasDraft: boolean): boolean =>
  !isField(focused) && !hasDraft

/** What a stream frame says about a change; only the fields that decide which queries it can alter. */
export interface Change {
  kind: string
  ref: string | null
  issue?: number | null
  detail?: Record<string, unknown>
}

type Key = readonly unknown[]
export type KeyPredicate = (key: Key) => boolean

/** The strip's readings: not in the stream, so a change never invalidates them (they poll). */
const POLLED_ONLY = new Set(['accounts', 'machine'])
/** Slower-moving figures over windows of history: they refetch on the longer debounce. */
const AGGREGATES = new Set(['kpis', 'friction', 'finding-classes', 'fix-commits'])
/** What `needs`, `flow` and `chain` read: Issues, their Decisions, artifacts, Errands and held signals. Hook events (`session`) are not among them. */
const LISTED_KINDS = new Set(['issue', 'decision', 'artifact', 'errand', 'signal'])

const rootOf = (key: Key): unknown => key[0]
export const isAggregate: KeyPredicate = (key) => AGGREGATES.has(String(rootOf(key)))

const ISSUE_ID = /^(?:issue_)?([1-9][0-9]*)$/

/** The number of the Issue an id or ref names (`12` or `issue_12`), or null. */
export function issueNumber(id: string | null | undefined): number | null {
  const match = id ? ISSUE_ID.exec(id) : null
  return match?.[1] ? Number(match[1]) : null
}

const changeIssue = (change: Change): number | null => change.issue ?? issueNumber(change.ref)
const named = (change: Change, field: string): string | null => {
  const value = change.detail?.[field]
  return typeof value === 'string' ? value : null
}

/**
 * The cached queries one change can alter. Conservative: a change that is missing (a frame that did not parse) or has a
 * kind this does not know alters everything except the strip's readings; a per-Issue query is spared only when the
 * change names another Issue.
 */
export function affected(change: Change | null): KeyPredicate {
  return (key) => {
    const root = String(rootOf(key))
    if (POLLED_ONLY.has(root)) return false
    if (change === null) return true
    return (BY_ROOT[root] ?? (() => true))(change, key)
  }
}

type RootRule = (change: Change, key: Key) => boolean

const listsAffected: RootRule = (change) => LISTED_KINDS.has(change.kind) || !isKnownKind(change.kind)
const errandsAffected: RootRule = (change) => change.kind === 'errand' || !isKnownKind(change.kind)
const issueAffected: RootRule = (change, key) => {
  const number = changeIssue(change)
  return number === null || number === issueNumber(String(key[1]))
}

const BY_ROOT: Record<string, RootRule> = {
  needs: listsAffected,
  since: listsAffected,
  flow: listsAffected,
  chain: listsAffected,
  errands: errandsAffected,
  issue: issueAffected,
  decision: (change, key) => detailAffects(change, 'decision', String(key[1])),
  artifact: (change, key) => detailAffects(change, 'artifact', String(key[1])),
}

const KNOWN_KINDS = new Set(['issue', 'session', 'decision', 'artifact', 'errand', 'signal'])
const isKnownKind = (kind: string): boolean => KNOWN_KINDS.has(kind)

/** A Decision or artifact page: its own kind of change when it names it (or names nothing), or any Issue's state moving. */
function detailAffects(change: Change, kind: 'decision' | 'artifact', id: string): boolean {
  if (!isKnownKind(change.kind)) return true
  if (change.kind === kind) {
    const target = named(change, kind)
    return target === null || target === id
  }
  return change.kind === 'issue'
}

/** The union of several changes: a query is affected when any of them can alter it. */
export const affectedByAny =
  (changes: readonly (Change | null)[]): KeyPredicate =>
  (key) =>
    changes.some((change) => affected(change)(key))

/** The stream went quiet while the tab was hidden for longer than a sleep gap: the socket is likely dead. */
export const silentWhileHidden = (hiddenAt: number | null, lastFrameAt: number, now: number): boolean =>
  hiddenAt !== null && lastFrameAt < hiddenAt && now - hiddenAt > SLEEP_GAP_MS

/** The `data:` of a change frame carries no cursor: the frame's `id:` line is the cursor. */
const ChangeData = ReadChange.omit({ cursor: true })

/** The change a frame carries; null (alters everything) when its data does not parse. */
export function parseChange(data: unknown): Change | null {
  if (typeof data !== 'string') return null
  try {
    const parsed = ChangeData.safeParse(JSON.parse(data))
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}
