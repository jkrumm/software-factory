import { durationMs, type HealRule } from '@software-factory/contract'
import type { SQL } from 'bun'
import { INTAKE_SOURCES, createIssueIn, vetIntakeRepo } from './create.ts'
import { enqueue } from './inbox.ts'
import { findIssue } from './read.ts'

/**
 * The one entry of the intake (docs/design.md §4 "Intake"): the door and every poller hand it a signal and get one outcome. A source
 * that polls passes the `repo` itself (the project's); the door passes its route's. The payload never picks a repo.
 */
export interface Signal {
  /** `kuma`, `hyperdx` (the door), `github`, `checks`, `launchd`; no colon */
  source: string
  /** the monitor, the GitHub issue (`<owner>/<repo>#<n>`), the check, the job's label */
  subject: string
  /** the event's own id: one effect however often it arrives */
  event: string
  /** `down` and `up` are one episode of the subject; `event` is a one-off, deduped by `fingerprint` */
  status: 'down' | 'up' | 'event'
  title: string
  facts: unknown
  repo: string
  /** a stateless source's own: the same fingerprint is the same problem */
  fingerprint?: string
}

export type SignalOutcome = 'created' | 'attached' | 'replayed' | 'quiet' | 'settling' | 'healed' | 'repeat'

export interface SignalContext {
  repoRoots: readonly string[]
  now: Date
}

export interface SignalResult {
  status: 200 | 201 | 202
  outcome: SignalOutcome
  issue: number | null
}

/** A closed Issue still takes the repeats of its fingerprint for this long. */
export const FINGERPRINT_WINDOW_MS = 24 * 60 * 60_000

/** How long a settled event key is remembered. */
const SEEN_KEEP_MS = 7 * 24 * 60 * 60_000

/** What `heal:` snapshots into a pending row. */
export interface PendingRule {
  grace_ms: number
  runbook: string | null
  max: number
}

/**
 * `<source>:<subject>:<event>`. A source has no colon, and the subject's own colons and percent signs are escaped, so two different
 * pairs never make one key; a name without either is in the key as it is.
 */
const eventKey = (signal: Pick<Signal, 'source' | 'subject' | 'event'>): string =>
  `${signal.source}:${signal.subject.replace(/[%:]/g, (c) => (c === '%' ? '%25' : '%3A'))}:${signal.event}`

/** The door's sources file as `alert`; the pollers' own name is the Issue's source. */
const issueSourceOf = (source: string): string => (INTAKE_SOURCES.has(source) && source !== 'alert' ? source : 'alert')

/** An event is keyed by its subject (a GitHub issue is one Issue however it is labelled again); an episode's `down` by its event. */
const issueKeyOf = (signal: Signal): string => (signal.status === 'event' ? signal.subject : eventKey(signal))

/**
 * Creates the Issue of a signal and the episode row beside it, in the caller's transaction. A key filed before answers that Issue
 * (`created: false`) and stores nothing. `settle` is what a heal rule did before the `down` was filed.
 */
export async function createSignalIssueIn(
  tx: SQL,
  signal: Signal,
  context: SignalContext,
  settle?: { graceMs: number; attempts: number; results: unknown },
): Promise<{ issue: number; created: boolean }> {
  const facts = {
    source: signal.source,
    monitor: signal.subject,
    event: signal.event,
    status: signal.status,
    details: signal.facts,
    ...(settle ? { settle } : {}),
  }
  const { issue, created } = await createIssueIn(
    tx,
    {
      source: issueSourceOf(signal.source),
      sourceKey: issueKeyOf(signal),
      repo: signal.repo,
      title: signal.title,
      facts,
    },
    context,
  )
  if (!created) return { issue: issue.id, created }
  await tx`
    INSERT INTO factory.door_issues (issue_id, source, monitor, fingerprint, last_seen)
    VALUES (${issue.id}, ${signal.source}, ${signal.subject}, ${signal.fingerprint ?? null}, ${context.now})`
  return { issue: issue.id, created }
}

async function remember(tx: SQL, keys: readonly string[], now: Date): Promise<void> {
  await tx`DELETE FROM factory.intake_seen WHERE seen_at < ${new Date(now.getTime() - SEEN_KEEP_MS)}`
  for (const key of keys) {
    await tx`INSERT INTO factory.intake_seen (key, seen_at) VALUES (${key}, ${now}) ON CONFLICT (key) DO NOTHING`
  }
}

/** The signal on an Issue that is not closed; a retry is the inbox's key. */
async function attach(tx: SQL, issue: number, signal: Signal, key: string, now: Date): Promise<SignalResult> {
  // Wave 1 moves a `watching` Issue back to work on `regression: true` and records the signal everywhere else.
  const { duplicate } = await enqueue(tx, {
    issueId: issue,
    key: `door:${key}`,
    kind: 'signal',
    at: now,
    payload: {
      regression: signal.status === 'down',
      status: signal.status,
      title: signal.title,
      event: signal.event,
      facts: signal.facts,
    },
  })
  return { status: 200, outcome: duplicate ? 'replayed' : 'attached', issue }
}

/** The first `heal:` rule of the project that holds `repo` for `<source>.down`. */
async function healRuleFor(tx: SQL, repo: string, source: string): Promise<PendingRule | undefined> {
  const [row]: { manifest: { heal?: HealRule[] } | null }[] = await tx`
    SELECT manifest FROM factory.projects
    WHERE repo = ${repo} OR starts_with(${repo}, repo || '/')
    ORDER BY length(repo) DESC LIMIT 1`
  const heal = Array.isArray(row?.manifest?.heal) ? row.manifest.heal : []
  const rule = heal.find((r) => r.when === `${source}.down`)
  const graceMs = rule && durationMs(rule.grace)
  if (!rule || graceMs === undefined) return undefined
  return { grace_ms: graceMs, runbook: rule.runbook ?? null, max: rule.max ?? 1 }
}

async function fileEpisode(tx: SQL, signal: Signal, context: SignalContext, key: string): Promise<SignalResult> {
  const { now } = context
  const [open]: { id: number }[] = await tx`
    SELECT i.id FROM factory.door_issues d JOIN factory.issues i ON i.id = d.issue_id
    WHERE d.source = ${signal.source} AND d.monitor = ${signal.subject} AND i.state <> 'closed'
    ORDER BY i.id DESC LIMIT 1`
  if (open) {
    await tx`UPDATE factory.door_issues SET last_seen = ${now} WHERE issue_id = ${open.id}`
    return attach(tx, open.id, signal, key, now)
  }

  if (signal.status === 'up') {
    const [pending]: { signal: Signal }[] = await tx`
      DELETE FROM factory.intake_pending WHERE source = ${signal.source} AND subject = ${signal.subject} RETURNING signal`
    if (!pending) return { status: 202, outcome: 'quiet', issue: null }
    // The `down` that was waiting is settled too: its late retry opens no second row.
    await remember(tx, [key, eventKey(pending.signal)], now)
    return { status: 202, outcome: 'healed', issue: null }
  }

  const repo = await vetIntakeRepo(issueSourceOf(signal.source), signal.repo, context.repoRoots)
  const [waiting] = await tx`
    SELECT 1 FROM factory.intake_pending WHERE source = ${signal.source} AND subject = ${signal.subject}`
  if (waiting) return { status: 202, outcome: 'settling', issue: null }
  const rule = await healRuleFor(tx, repo, signal.source)
  if (rule) {
    await tx`
      INSERT INTO factory.intake_pending (source, subject, repo, signal, rule, opened_at, due_at)
      VALUES (${signal.source}, ${signal.subject}, ${repo}, ${JSON.stringify(signal)}::text::jsonb, ${JSON.stringify(rule)}::text::jsonb,
        ${now}, ${new Date(now.getTime() + rule.grace_ms)})
      ON CONFLICT (source, subject) DO NOTHING`
    return { status: 202, outcome: 'settling', issue: null }
  }
  return fileNew(tx, signal, context, key)
}

async function fileNew(tx: SQL, signal: Signal, context: SignalContext, key: string): Promise<SignalResult> {
  const made = await createSignalIssueIn(tx, signal, context)
  if (!made.created) return { status: 200, outcome: 'replayed', issue: made.issue }
  await remember(tx, [key], context.now)
  return { status: 201, outcome: 'created', issue: made.issue }
}

async function fileStateless(tx: SQL, signal: Signal, context: SignalContext, key: string): Promise<SignalResult> {
  const { now } = context
  if (signal.fingerprint === undefined) return fileNew(tx, signal, context, key)
  const [match]: { issue_id: number; state: string; created_at: Date }[] = await tx`
    SELECT d.issue_id, i.state, i.created_at FROM factory.door_issues d JOIN factory.issues i ON i.id = d.issue_id
    WHERE d.source = ${signal.source} AND d.fingerprint = ${signal.fingerprint}
    ORDER BY d.issue_id DESC LIMIT 1 FOR UPDATE OF d`
  const recent = match && now.getTime() - match.created_at.getTime() < FINGERPRINT_WINDOW_MS
  if (!match || (match.state === 'closed' && !recent)) return fileNew(tx, signal, context, key)

  await tx`
    UPDATE factory.door_issues SET repeats = repeats + 1, last_seen = ${now} WHERE issue_id = ${match.issue_id}`
  await remember(tx, [key], now)
  if (match.state === 'closed') return { status: 200, outcome: 'repeat', issue: match.issue_id }
  return attach(tx, match.issue_id, signal, key, now)
}

/**
 * Files one signal in the caller's transaction; no port is called here, everything an Issue then needs happens after the commit. The
 * caller serializes one subject (the door locks its route row).
 *
 * 1. Replay: the Issue's key, the inbox key or the settled-event table has this event, so it is one effect.
 * 2. `down` / `up`, one episode per `(source, subject)`: an open Issue takes a `signal`; none open, an `up` heals a pending `down` (or is
 *    quiet), a `down` waits out the project's `heal:` grace (`settling`) or, with no rule, files at once.
 * 3. `event` with a fingerprint: a repeat of an open Issue, or of one filed in the last `FINGERPRINT_WINDOW_MS`, is a `signal` on it or
 *    only a count; anything else is a new Issue.
 *
 * Throws `RepoRefused` for a repo the policy refuses (IuRoot, outside the roots) and stores nothing.
 */
export async function fileSignalIn(tx: SQL, signal: Signal, context: SignalContext): Promise<SignalResult> {
  const key = eventKey(signal)

  const created = await findIssue(tx, issueSourceOf(signal.source), issueKeyOf(signal))
  if (created) return { status: 200, outcome: 'replayed', issue: created.id }
  // The inbox's keys are one space for every kind of row (`wake:...`, `hold:...`), so the door's have a prefix of their own.
  const [filedBefore]: { issue_id: number }[] =
    await tx`SELECT issue_id FROM factory.issue_inbox WHERE key = ${`door:${key}`}`
  if (filedBefore) return { status: 200, outcome: 'replayed', issue: filedBefore.issue_id }
  const [seen] = await tx`SELECT 1 FROM factory.intake_seen WHERE key = ${key}`
  if (seen) return { status: 200, outcome: 'replayed', issue: null }

  return signal.status === 'event' ? fileStateless(tx, signal, context, key) : fileEpisode(tx, signal, context, key)
}
