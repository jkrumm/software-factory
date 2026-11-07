import { Signal } from '@software-factory/contract'
import type { SQL } from 'bun'
import * as z from 'zod'
import type { Received as ReceivedInput } from '../../domains/intake/model.ts'
import type {
  DoorRouteRow,
  DoorSourceRow,
  IncidentRow,
  IntakeStore,
  PendingRow,
  SignalRow,
  SubjectRow,
  UnroutedRow,
  WritebackRow,
} from '../../domains/intake/ports.ts'
import type { IssueId } from '../../kernel/ids.ts'
import { LOCKS } from '../postgres/locks.ts'

/** Seen event keys are kept this long. */
const SEEN_KEEP_MS = 7 * 24 * 60 * 60_000
/** A month without an alert, an unrouted monitor that is up is forgotten; a down one stays up to a year. */
const UNROUTED_KEEP_MS = 30 * 24 * 60 * 60_000
const UNROUTED_DOWN_KEEP_MS = 365 * 24 * 60 * 60_000

const Alert = z.object({
  subject: z.string(),
  event: z.string(),
  status: z.enum(['down', 'up', 'event']),
  facts: z.unknown(),
})
const Rule = z.object({
  when: z.string(),
  graceMs: z.number(),
  runbook: z.literal('make restart').nullable(),
  max: z.number().int(),
})

const json = (value: unknown): string => JSON.stringify(value)

type Row = Record<string, unknown>
const date = (value: unknown): Date => z.date().parse(value)
const dateOrNull = (value: unknown): Date | null => z.date().nullable().parse(value)
const text = (value: unknown): string => z.string().parse(value)
const textOrNull = (value: unknown): string | null => z.string().nullable().parse(value)
// a bigint identity arrives as text
const int = (value: unknown): number => z.coerce.number().int().parse(value)

const received = (row: Row): ReceivedInput => ({
  signal: Signal.parse({
    source: row.source,
    kind: row.kind,
    origin: row.origin,
    trust: row.trust,
    repo: row.repo,
    fingerprint: row.fingerprint,
    title: row.title,
    text: row.text,
    link: row.link,
    madeBy: row.made_by,
  }),
  alert: row.alert === null ? null : Alert.parse(row.alert),
})

const signalOf = (row: Row): SignalRow => ({
  id: text(row.id),
  key: textOrNull(row.key),
  received: received(row),
  receivedAt: date(row.received_at),
  state: z.enum(['held', 'filed', 'amended', 'incident', 'promoted']).parse(row.state),
  issueId: textOrNull(row.issue_id) as IssueId | null,
})

const subjectOf = (row: Row): SubjectRow => ({
  id: int(row.id),
  source: text(row.source),
  subject: text(row.subject),
  fingerprint: textOrNull(row.fingerprint),
  issueId: text(row.issue_id) as IssueId,
  groupKey: textOrNull(row.group_key),
  filedAt: date(row.filed_at),
  lastSeen: date(row.last_seen),
  repeats: int(row.repeats),
  upAt: dateOrNull(row.up_at),
  writeback: z.boolean().parse(row.writeback),
  admitted: textOrNull(row.admitted),
})

const Received = z.object({ signal: Signal, alert: Alert.nullable() })

const pendingOf = (row: Row): PendingRow => ({
  source: text(row.source),
  subject: text(row.subject),
  repo: text(row.repo),
  received: Received.parse(row.received),
  rule: Rule.parse(row.rule),
  openedAt: date(row.opened_at),
  dueAt: date(row.due_at),
  attempts: int(row.attempts),
  results: z.array(z.unknown()).parse(row.results),
})

const routeOf = (row: Row): DoorRouteRow => ({
  source: text(row.source),
  monitor: text(row.monitor),
  repo: text(row.repo),
  quiet: int(row.quiet),
  lastQuietAt: dateOrNull(row.last_quiet_at),
  lastEvent: textOrNull(row.last_event),
})

const unroutedOf = (row: Row): UnroutedRow => ({
  source: text(row.source),
  monitor: text(row.monitor),
  count: int(row.count),
  lastSeen: date(row.last_seen),
  lastTitle: text(row.last_title),
  lastEvent: text(row.last_event),
  status: z.enum(['down', 'up']).nullable().parse(row.status),
  downSince: dateOrNull(row.down_since),
  group: z.boolean().parse(row.is_group),
  filedAt: dateOrNull(row.filed_at),
  filedIssue: textOrNull(row.filed_issue) as IssueId | null,
})

/** Intake's tables on one transaction's connection. */
export function postgresIntakeStore(tx: SQL): IntakeStore {
  return {
    async lock(name) {
      await tx`SELECT pg_advisory_xact_lock(${LOCKS.intake}, hashtext(${name}))`
    },

    async seen(key) {
      const rows: unknown[] = await tx`SELECT 1 FROM factory.intake_seen WHERE key = ${key}`
      return rows.length > 0
    },

    async remember(keys, now) {
      await tx`DELETE FROM factory.intake_seen WHERE seen_at < ${new Date(now.getTime() - SEEN_KEEP_MS)}`
      for (const key of keys) {
        await tx`INSERT INTO factory.intake_seen (key, seen_at) VALUES (${key}, ${now}) ON CONFLICT (key) DO NOTHING`
      }
    },

    async insertSignal(row) {
      const { signal, alert } = row.received
      const rows: unknown[] = await tx`
        INSERT INTO factory.intake_signals
          (id, key, source, kind, origin, trust, repo, fingerprint, title, text, link, made_by, alert, received_at, state, issue_id)
        VALUES (${row.id}, ${row.key}, ${signal.source}, ${signal.kind}, ${signal.origin}, ${signal.trust}, ${signal.repo},
          ${signal.fingerprint}, ${signal.title}, ${signal.text}, ${signal.link}, ${signal.madeBy},
          ${alert ? json(alert) : null}::text::jsonb, ${row.receivedAt}, ${row.state}, ${row.issueId})
        ON CONFLICT (key) DO NOTHING
        RETURNING id`
      return rows.length === 1
    },

    async signal(id) {
      const [row]: Row[] = await tx`SELECT * FROM factory.intake_signals WHERE id = ${id}`
      return row ? signalOf(row) : null
    },

    async signalByKey(key) {
      const [row]: Row[] = await tx`SELECT * FROM factory.intake_signals WHERE key = ${key}`
      return row ? signalOf(row) : null
    },

    async setSignal(id, patch) {
      await tx`
        UPDATE factory.intake_signals
        SET state = ${patch.state}, issue_id = ${patch.issueId}, repo = COALESCE(${patch.repo ?? null}, repo)
        WHERE id = ${id}`
    },

    async signals(state, limit) {
      const rows: Row[] = state
        ? await tx`SELECT * FROM factory.intake_signals WHERE state = ${state} ORDER BY received_at, id LIMIT ${limit}`
        : await tx`SELECT * FROM factory.intake_signals ORDER BY received_at DESC, id LIMIT ${limit}`
      return rows.map(signalOf)
    },

    async latestSubject(source, subject) {
      const [row]: Row[] = await tx`
        SELECT * FROM factory.intake_subjects WHERE source = ${source} AND subject = ${subject} ORDER BY id DESC LIMIT 1`
      return row ? subjectOf(row) : null
    },

    async latestByFingerprint(source, fingerprint) {
      const [row]: Row[] = await tx`
        SELECT * FROM factory.intake_subjects
        WHERE source = ${source} AND fingerprint = ${fingerprint} ORDER BY id DESC LIMIT 1`
      return row ? subjectOf(row) : null
    },

    async subjectsOfIssue(issueId) {
      const rows: Row[] = await tx`SELECT * FROM factory.intake_subjects WHERE issue_id = ${issueId} ORDER BY id`
      return rows.map(subjectOf)
    },

    async latestSubjects(source, prefix) {
      const rows: Row[] = await tx`
        SELECT DISTINCT ON (subject) * FROM factory.intake_subjects
        WHERE source = ${source} AND starts_with(subject, ${prefix}) ORDER BY subject, id DESC`
      return rows.map(subjectOf)
    },

    async insertSubject(row) {
      await tx`
        INSERT INTO factory.intake_subjects
          (source, subject, fingerprint, issue_id, group_key, filed_at, last_seen, repeats, up_at, writeback, admitted)
        VALUES (${row.source}, ${row.subject}, ${row.fingerprint}, ${row.issueId}, ${row.groupKey}, ${row.filedAt},
          ${row.lastSeen}, ${row.repeats}, ${row.upAt}, ${row.writeback}, ${row.admitted})
        ON CONFLICT (issue_id, source, subject) DO UPDATE
          SET last_seen = EXCLUDED.last_seen, up_at = EXCLUDED.up_at`
    },

    async touchSubject(id, patch) {
      await tx`
        UPDATE factory.intake_subjects
        SET last_seen = ${patch.at}, up_at = ${patch.upAt}, repeats = repeats + ${patch.repeat ? 1 : 0}
        WHERE id = ${id}`
    },

    async latestIncident(groupKey) {
      const [row]: Row[] = await tx`
        SELECT * FROM factory.intake_incidents WHERE group_key = ${groupKey} ORDER BY opened_at DESC, issue_id DESC LIMIT 1`
      return row
        ? ({
            issueId: text(row.issue_id) as IssueId,
            groupKey: text(row.group_key),
            openedAt: date(row.opened_at),
            lastAlertAt: date(row.last_alert_at),
          } satisfies IncidentRow)
        : null
    },

    async insertIncident(row) {
      await tx`
        INSERT INTO factory.intake_incidents (issue_id, group_key, opened_at, last_alert_at)
        VALUES (${row.issueId}, ${row.groupKey}, ${row.openedAt}, ${row.lastAlertAt}) ON CONFLICT (issue_id) DO NOTHING`
    },

    async touchIncident(issueId, at) {
      await tx`UPDATE factory.intake_incidents SET last_alert_at = GREATEST(last_alert_at, ${at}) WHERE issue_id = ${issueId}`
    },

    async pendingOf(source, subject) {
      const [row]: Row[] =
        await tx`SELECT * FROM factory.intake_pending WHERE source = ${source} AND subject = ${subject}`
      return row ? pendingOf(row) : null
    },

    async pendingSubjects(source, prefix) {
      const rows: Row[] = await tx`
        SELECT subject, opened_at FROM factory.intake_pending WHERE source = ${source} AND starts_with(subject, ${prefix})`
      return rows.map((row) => ({ subject: text(row.subject), openedAt: date(row.opened_at) }))
    },

    async insertPending(row) {
      await tx`
        INSERT INTO factory.intake_pending (source, subject, repo, received, rule, opened_at, due_at, attempts, results)
        VALUES (${row.source}, ${row.subject}, ${row.repo}, ${json(row.received)}::text::jsonb, ${json(row.rule)}::text::jsonb,
          ${row.openedAt}, ${row.dueAt}, ${row.attempts}, ${json(row.results)}::text::jsonb)
        ON CONFLICT (source, subject) DO NOTHING`
    },

    async deletePending(source, subject) {
      const [row]: Row[] = await tx`
        DELETE FROM factory.intake_pending WHERE source = ${source} AND subject = ${subject} RETURNING *`
      return row ? pendingOf(row) : null
    },

    async duePending(now, limit) {
      const rows: Row[] = await tx`
        SELECT source, subject FROM factory.intake_pending WHERE due_at <= ${now} ORDER BY due_at, source, subject LIMIT ${limit}`
      return rows.map((row) => ({ source: text(row.source), subject: text(row.subject) }))
    },

    async claimPending(source, subject, now) {
      const [row]: Row[] = await tx`
        SELECT * FROM factory.intake_pending
        WHERE source = ${source} AND subject = ${subject} AND due_at <= ${now} FOR UPDATE SKIP LOCKED`
      return row ? pendingOf(row) : null
    },

    async leasePending(source, subject, patch) {
      await tx`
        UPDATE factory.intake_pending SET attempts = ${patch.attempts}, due_at = ${patch.dueAt}
        WHERE source = ${source} AND subject = ${subject}`
    },

    async recordPendingRun(source, subject, entry, dueAt) {
      await tx`
        UPDATE factory.intake_pending
        SET results = results || ${json([entry])}::text::jsonb, due_at = ${dueAt}
        WHERE source = ${source} AND subject = ${subject}`
    },

    async routeFor(source, monitor) {
      const [row]: Row[] = await tx`
        SELECT * FROM factory.intake_door_routes WHERE source = ${source} AND monitor = ${monitor} FOR UPDATE`
      return row ? routeOf(row) : null
    },

    async routes() {
      const rows: Row[] = await tx`SELECT * FROM factory.intake_door_routes ORDER BY source, monitor`
      return rows.map(routeOf)
    },

    async setRoute(source, monitor, repo) {
      const [row]: Row[] = await tx`
        INSERT INTO factory.intake_door_routes (source, monitor, repo) VALUES (${source}, ${monitor}, ${repo})
        ON CONFLICT (source, monitor) DO UPDATE SET repo = EXCLUDED.repo
        RETURNING *`
      await tx`DELETE FROM factory.intake_door_unrouted WHERE source = ${source} AND monitor = ${monitor}`
      if (!row) throw new Error('route was not stored')
      return routeOf(row)
    },

    async removeRoute(source, monitor) {
      const [row]: Row[] = await tx`
        DELETE FROM factory.intake_door_routes WHERE source = ${source} AND monitor = ${monitor} RETURNING *`
      return row ? routeOf(row) : null
    },

    async countQuiet(source, monitor, event, now) {
      const rows: unknown[] = await tx`
        UPDATE factory.intake_door_routes SET quiet = quiet + 1, last_quiet_at = ${now}, last_event = ${event}
        WHERE source = ${source} AND monitor = ${monitor} AND last_event IS DISTINCT FROM ${event}
        RETURNING 1`
      return rows.length > 0
    },

    async noteUnrouted(row) {
      await tx`
        DELETE FROM factory.intake_door_unrouted
        WHERE last_seen < ${new Date(row.now.getTime() - UNROUTED_KEEP_MS)} AND status IS DISTINCT FROM 'down'`
      await tx`DELETE FROM factory.intake_door_unrouted WHERE last_seen < ${new Date(row.now.getTime() - UNROUTED_DOWN_KEEP_MS)}`
      const down = row.status === 'down'
      await tx`
        INSERT INTO factory.intake_door_unrouted (source, monitor, count, last_seen, last_title, last_event, status, down_since, is_group)
        VALUES (${row.source}, ${row.monitor}, 1, ${row.now}, ${row.title}, ${row.event}, ${row.status},
          ${down ? row.now : null}, ${row.group})
        ON CONFLICT (source, monitor) DO UPDATE
          SET count = factory.intake_door_unrouted.count + 1, last_seen = EXCLUDED.last_seen, last_title = EXCLUDED.last_title,
              last_event = EXCLUDED.last_event, status = EXCLUDED.status,
              is_group = factory.intake_door_unrouted.is_group OR EXCLUDED.is_group,
              down_since = CASE WHEN EXCLUDED.status <> 'down' THEN NULL
                                WHEN factory.intake_door_unrouted.status = 'down' THEN factory.intake_door_unrouted.down_since
                                ELSE EXCLUDED.down_since END,
              filed_at = CASE WHEN EXCLUDED.status = 'down' AND factory.intake_door_unrouted.status = 'down'
                              THEN factory.intake_door_unrouted.filed_at END,
              filed_issue = CASE WHEN EXCLUDED.status = 'down' AND factory.intake_door_unrouted.status = 'down'
                                 THEN factory.intake_door_unrouted.filed_issue END
          WHERE factory.intake_door_unrouted.last_event <> EXCLUDED.last_event`
      if (!down) await tx`DELETE FROM factory.intake_pending WHERE source = ${row.source} AND subject = ${row.monitor}`
    },

    async unrouted(limit) {
      const rows: Row[] = await tx`
        SELECT u.* FROM factory.intake_door_unrouted u
        WHERE NOT EXISTS (SELECT 1 FROM factory.intake_door_routes r WHERE r.source = u.source AND r.monitor = u.monitor)
        ORDER BY u.last_seen DESC, u.source, u.monitor LIMIT ${limit}`
      return rows.map(unroutedOf)
    },

    async dueUnrouted(now, graceMs, limit) {
      const rows: Row[] = await tx`
        SELECT u.* FROM factory.intake_door_unrouted u
        WHERE u.status = 'down' AND NOT u.is_group AND u.filed_at IS NULL
          AND u.down_since <= ${new Date(now.getTime() - graceMs)}
          AND NOT EXISTS (SELECT 1 FROM factory.intake_door_routes r WHERE r.source = u.source AND r.monitor = u.monitor)
        ORDER BY u.down_since, u.source, u.monitor LIMIT ${limit}`
      return rows.map(unroutedOf)
    },

    async markUnroutedFiled(source, monitor, event, issueId, now) {
      await tx`
        UPDATE factory.intake_door_unrouted SET filed_at = ${now}, filed_issue = ${issueId}
        WHERE source = ${source} AND monitor = ${monitor} AND last_event = ${event}`
    },

    async doorSources() {
      const rows: Row[] = await tx`SELECT * FROM factory.intake_door_sources ORDER BY source`
      return rows.map((row): DoorSourceRow => ({
        source: text(row.source),
        firstSeen: date(row.first_seen),
        lastAccepted: dateOrNull(row.last_accepted),
        refused: int(row.refused),
        refusedSince: dateOrNull(row.refused_since),
        lastRefused: dateOrNull(row.last_refused),
      }))
    },

    async doorStarted(sources, now) {
      for (const source of sources) {
        await tx`INSERT INTO factory.intake_door_sources (source, first_seen) VALUES (${source}, ${now}) ON CONFLICT (source) DO NOTHING`
      }
      // A source the door no longer holds a token for is retired: its row would be a silence line for ever.
      if (sources.length === 0) await tx`DELETE FROM factory.intake_door_sources`
      else await tx`DELETE FROM factory.intake_door_sources WHERE source NOT IN ${tx(sources)}`
    },

    async doorRefused(source, now) {
      await tx`
        INSERT INTO factory.intake_door_sources (source, first_seen, refused, refused_since, last_refused)
        VALUES (${source}, ${now}, 1, ${now}, ${now})
        ON CONFLICT (source) DO UPDATE
          SET refused_since = CASE WHEN factory.intake_door_sources.refused = 0 THEN EXCLUDED.refused_since
                                   ELSE factory.intake_door_sources.refused_since END,
              refused = factory.intake_door_sources.refused + 1, last_refused = EXCLUDED.last_refused`
    },

    async doorAccepted(source, now) {
      await tx`
        INSERT INTO factory.intake_door_sources (source, first_seen, last_accepted) VALUES (${source}, ${now}, ${now})
        ON CONFLICT (source) DO UPDATE SET last_accepted = EXCLUDED.last_accepted, refused = 0, refused_since = NULL`
    },

    async unwrittenBack(limit) {
      const rows: Row[] = await tx`
        SELECT s.issue_id, s.source, s.subject, s.admitted FROM factory.intake_subjects s
        WHERE s.writeback AND NOT EXISTS (SELECT 1 FROM factory.intake_writebacks w WHERE w.issue_id = s.issue_id)
        ORDER BY s.id LIMIT ${limit}`
      return rows.map((row): WritebackRow => ({
        issueId: text(row.issue_id) as IssueId,
        source: text(row.source),
        subject: text(row.subject),
        admitted: textOrNull(row.admitted),
      }))
    },

    async recordWriteback(issueId, result, now) {
      await tx`
        INSERT INTO factory.intake_writebacks (issue_id, result, at) VALUES (${issueId}, ${result}, ${now})
        ON CONFLICT (issue_id) DO NOTHING`
    },
  }
}
