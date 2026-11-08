import type {
  ReadArtifactLine,
  ReadCheckLine,
  ReadNoteLine,
  ReadShipLine,
  ReadTriageLine,
  ReadWatchLine,
} from '@software-factory/contract'
import type { SQL } from 'bun'
import { key } from '../kernel/keys.ts'
import { leadKeyOf } from './sessions.ts'

/** The parts of an Issue's page that come from tables beside its events: the signals, the owner's notes, artifacts, ships. */

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []

/** The signals routed to the Issue, oldest first: the first filed it, the rest amended it. */
export async function loadTriage(sql: SQL, issue: string): Promise<ReadTriageLine[]> {
  const rows: {
    received_at: Date
    state: ReadTriageLine['outcome']
    title: string
    text: string
    origin: string
    trust: string
    source: string
    kind: string
    link: string | null
  }[] = await sql`
    SELECT received_at, state, title, text, origin, trust, source, kind, link FROM factory.intake_signals
    WHERE issue_id = ${issue} ORDER BY received_at, id`
  return rows.map((r) => ({
    at: r.received_at.toISOString(),
    outcome: r.state,
    title: r.title,
    text: r.text,
    origin: r.origin,
    trust: r.trust,
    source: r.source,
    kind: r.kind,
    link: r.link,
  }))
}

/**
 * The owner's notes, full text (a signal's amendment is a `noted` of the factory's, and shows in `triage`). A note is typed
 * to a running lead as a delivery whose key is the `note_lead` effect's (`note_lead:<issue>:<version>`). A note taken while
 * the Issue waits is carried by the `note_lead` of the event that ends the wait, so when no delivery has the note's own
 * version, the first delivery at or after it stands for it. That is an approximation: two notes before one wake share the
 * delivery. An Issue never working after the note has none, and the next brief carries it.
 */
export async function loadNotes(sql: SQL, issue: string): Promise<ReadNoteLine[]> {
  const events: { at: Date; version: number; payload: unknown }[] = await sql`
    SELECT at, version, payload FROM factory.issue_events
    WHERE issue_id = ${issue} AND kind = 'noted' AND actor = 'owner' AND key NOT LIKE 'noted:signal:%' AND result = 'applied' ORDER BY version`
  if (events.length === 0) return []
  const deliveries: { key: string; attempt: number; typed_at: Date | null }[] = await sql`
    SELECT key, attempt, typed_at FROM factory.lead_deliveries WHERE issue_id = ${issue} AND kind = 'note'`
  const byKey = new Map(deliveries.map((d) => [d.key, d]))
  const versioned = deliveries
    .map((d) => ({ d, version: Number(d.key.slice(d.key.lastIndexOf(':') + 1)) }))
    .filter((v) => Number.isInteger(v.version))
    .sort((a, b) => a.version - b.version)
  return events.map((event) => {
    const delivery =
      byKey.get(key('note_lead', issue, event.version)) ?? versioned.find((v) => v.version >= event.version)?.d
    return {
      at: event.at.toISOString(),
      text: isRecord(event.payload) && typeof event.payload.text === 'string' ? event.payload.text : '',
      session: delivery ? leadKeyOf(issue, delivery.attempt) : null,
      delivered: delivery ? delivery.typed_at !== null : null,
    }
  })
}

/** Concepts, Specs and Reports (a Decision is an ask), with their revision count and the owner's latest verdict. */
export async function loadArtifacts(sql: SQL, issue: string): Promise<ReadArtifactLine[]> {
  const rows: {
    id: string
    kind: string
    title: string
    created_at: Date
    revisions: string
    verdict: string | null
  }[] = await sql`
    SELECT a.id, a.kind, a.title, a.created_at,
      (SELECT count(*) FROM factory.artifact_revisions r WHERE r.artifact_id = a.id)::text AS revisions,
      (SELECT v.verdict FROM factory.verdicts v WHERE v.artifact_id = a.id ORDER BY v.at DESC, v.revision DESC LIMIT 1) AS verdict
    FROM factory.artifacts a WHERE a.issue_id = ${issue} AND a.kind <> 'decision' ORDER BY a.created_at, a.id`
  return rows.map((r) => ({
    id: r.id,
    kind: r.kind,
    title: r.title,
    revisions: Number(r.revisions),
    verdict: r.verdict,
    at: r.created_at.toISOString(),
  }))
}

interface ShipRow {
  event_key: string
  at: Date
  attempt: number
  result: 'accepted' | 'refused'
  detail: string | null
  reported: unknown
}
interface WatchRow {
  key: string
  started_at: Date
  window_ms: string
  answer: ReadWatchLine['answer']
  answered_at: Date | null
}

function summaryOf(checks: unknown): string {
  const list = Array.isArray(checks) ? checks.filter(isRecord) : []
  const failed = list.filter((c) => c.ok !== true)
  if (failed.length === 0) return list.length === 0 ? 'No checks ran.' : `All ${list.length} checks passed.`
  return failed.map((c) => `${String(c.name)}: ${String(c.detail ?? 'failed')}`).join('; ')
}

function reviewOf(payload: unknown): ReadShipLine['review'] {
  if (!isRecord(payload)) return { present: false, note: null }
  const status = typeof payload.status === 'string' ? payload.status : null
  const reason = typeof payload.reason === 'string' && payload.reason.trim() ? payload.reason : null
  return { present: status === 'covered', note: reason ?? (status ? status.replaceAll('_', ' ') : null) }
}

/**
 * Every call of ship, oldest first, with the commits and review it proved, the watch it opened (the first watch begun at
 * or after the ship and before the next accepted ship) and that watch's verify runs.
 */
export async function loadShipping(sql: SQL, issue: string): Promise<ReadShipLine[]> {
  const ships: ShipRow[] = await sql`
    SELECT event_key, at, attempt, result, detail, reported FROM factory.quality_ships
    WHERE issue_id = ${issue} ORDER BY at, id`
  if (ships.length === 0) return []
  const proof: { source_key: string; kind: string; payload: unknown }[] = await sql`
    SELECT source_key, kind, payload FROM factory.quality_evidence WHERE issue_id = ${issue}`
  const watches: WatchRow[] = await sql`
    SELECT key, started_at, window_ms::text AS window_ms, answer, answered_at FROM factory.quality_watches
    WHERE issue_id = ${issue} ORDER BY started_at, watch`
  const runs: { watch_key: string; at: Date; outcome: string; checks: unknown }[] = await sql`
    SELECT c.watch_key, c.at, c.outcome, c.checks FROM factory.quality_checks c
    JOIN factory.quality_watches w ON w.key = c.watch_key WHERE w.issue_id = ${issue} ORDER BY c.watch_key, c.n`
  const accepted = ships.filter((s) => s.result === 'accepted')
  return ships.map((ship) => {
    // an event key is unique among accepted ships only: a refused one never reads another call's evidence
    const own = (kind: string) =>
      ship.result === 'accepted'
        ? proof.find((p) => p.source_key === ship.event_key && p.kind === kind)?.payload
        : undefined
    const commits = own('commits')
    const nextAt = accepted.find((s) => s.at > ship.at)?.at
    const watch =
      ship.result === 'accepted'
        ? watches.find((w) => w.started_at >= ship.at && (!nextAt || w.started_at < nextAt))
        : undefined
    const checks: ReadCheckLine[] = watch
      ? runs
          .filter((run) => run.watch_key === watch.key)
          .map((run) => ({ at: run.at.toISOString(), result: run.outcome, summary: summaryOf(run.checks) }))
      : []
    return {
      at: ship.at.toISOString(),
      attempt: ship.attempt,
      result: ship.result,
      detail: ship.detail,
      commits: isRecord(commits) ? strings(commits.commits) : strings(ship.reported),
      review: reviewOf(own('review')),
      watch: watch
        ? {
            startedAt: watch.started_at.toISOString(),
            windowMs: Number(watch.window_ms),
            answer: watch.answer,
            answeredAt: watch.answered_at?.toISOString() ?? null,
          }
        : null,
      checks,
    }
  })
}
