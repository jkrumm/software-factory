import type {
  DoorRoute,
  DoorRouteInput,
  DoorRouteKey,
  DoorUnrouted,
  IntakeAck,
  IntakeInput,
} from '@software-factory/contract'
import type { SQL } from 'bun'
import { notifyDoorRefused } from '../notify/rules.ts'
import { RepoRefused } from '../repos.ts'
import { enqueue } from './inbox.ts'
import { createIssueIn } from './create.ts'
import { findIssue } from './read.ts'

/** The door's intake (docs/design.md §11): one alert becomes a signal on an open Issue, a new Issue, or a count. */
export interface IntakeContext {
  repoRoots: readonly string[]
  now: Date
}

/** How long a monitor with no route stays listed after its last alert. */
export const UNROUTED_KEEP_MS = 30 * 24 * 60 * 60_000

/** The HTTP status and the body of an intake. */
export interface IntakeResult {
  status: 200 | 201 | 202
  ack: IntakeAck
}

/**
 * `<source>:<monitor>:<event>`. A source has no colon, and the monitor's own colons and percent signs are escaped, so two different
 * pairs never make one key; a name without either is in the key as it is.
 */
const alertKey = (input: Pick<IntakeInput, 'source' | 'monitor' | 'event'>): string =>
  `${input.source}:${input.monitor.replace(/[%:]/g, (c) => (c === '%' ? '%25' : '%3A'))}:${input.event}`

/**
 * Files one alert, in one transaction. The route row is locked first, so two alerts of one monitor are filed one after the other
 * and the second sees the Issue the first created. No port is called here: everything an Issue then needs happens after the commit.
 *
 * 1. No route for `(source, monitor)`: no Issue, one row counts it (202).
 * 2. Routed, an Issue of this monitor not closed: the event is a `signal` on it, a regression when the monitor is down (200).
 * 3. Routed, none open, down: a new Issue from the route's repo, never the payload's (201).
 * 4. Routed, none open, up: only the route's counter (202).
 *
 * An event filed before is one effect: the Issue's key, the inbox key and the counters' last event all see it.
 */
export async function intakeAlert(sql: SQL, input: IntakeInput, context: IntakeContext): Promise<IntakeResult> {
  try {
    return await fileAlert(sql, input, context)
  } catch (error) {
    // The filing rolled back, so the owner is told from outside it: the alert is refused (the sender gets its 422 and retries), and
    // a route that points where no alert may file is the owner's to fix.
    if (error instanceof RepoRefused) {
      await notifyDoorRefused(sql, {
        source: input.source,
        monitor: input.monitor,
        reason: error.message,
        now: context.now,
      })
    }
    throw error
  }
}

async function fileAlert(sql: SQL, input: IntakeInput, context: IntakeContext): Promise<IntakeResult> {
  const { now } = context
  const key = alertKey(input)
  return sql.begin(async (tx): Promise<IntakeResult> => {
    const [route]: { repo: string }[] = await tx`
      SELECT repo FROM factory.door_routes WHERE source = ${input.source} AND monitor = ${input.monitor} FOR UPDATE`
    if (!route) {
      // A row not seen for a month is a monitor nobody alerts on: the table is a recent list, not a history, and a sender with a
      // token cannot grow it past what it has made in thirty days.
      await tx`DELETE FROM factory.door_unrouted WHERE last_seen < ${new Date(now.getTime() - UNROUTED_KEEP_MS)}`
      await tx`
        INSERT INTO factory.door_unrouted (source, monitor, count, last_seen, last_title, last_event)
        VALUES (${input.source}, ${input.monitor}, 1, ${now}, ${input.title}, ${input.event})
        ON CONFLICT (source, monitor) DO UPDATE
          SET count = factory.door_unrouted.count + 1, last_seen = EXCLUDED.last_seen, last_title = EXCLUDED.last_title,
              last_event = EXCLUDED.last_event
          WHERE factory.door_unrouted.last_event <> EXCLUDED.last_event`
      return { status: 202, ack: { outcome: 'unrouted', issue: null } }
    }

    // The event that created an Issue is not a signal on it: a late retry must not regress what the Issue became.
    const created = await findIssue(tx, 'alert', key)
    if (created) return { status: 200, ack: { outcome: 'replayed', issue: created.id } }

    // An event that was a signal before is one now, whatever became of the Issue it went to: a retry must not make a second Issue.
    // The inbox's keys are one space for every kind of row (`wake:...`, `hold:...`), so the door's have a prefix of their own.
    const inboxKey = `door:${key}`
    const [filedBefore]: { issue_id: number }[] =
      await tx`SELECT issue_id FROM factory.issue_inbox WHERE key = ${inboxKey}`
    if (filedBefore) return { status: 200, ack: { outcome: 'replayed', issue: filedBefore.issue_id } }

    const [open]: { id: number }[] = await tx`
      SELECT i.id FROM factory.door_issues d JOIN factory.issues i ON i.id = d.issue_id
      WHERE d.source = ${input.source} AND d.monitor = ${input.monitor} AND i.state <> 'closed'
      ORDER BY i.id DESC LIMIT 1`
    if (open) {
      // Wave 1 moves a `watching` Issue back to work on `regression: true` and records the signal everywhere else.
      const { duplicate } = await enqueue(tx, {
        issueId: open.id,
        key: inboxKey,
        kind: 'signal',
        at: now,
        payload: {
          regression: input.status === 'down',
          status: input.status,
          title: input.title,
          event: input.event,
          facts: input.facts,
        },
      })
      return { status: 200, ack: { outcome: duplicate ? 'replayed' : 'attached', issue: open.id } }
    }

    if (input.status === 'up') {
      const counted = await tx`
        UPDATE factory.door_routes SET quiet = quiet + 1, last_quiet_at = ${now}, last_event = ${input.event}
        WHERE source = ${input.source} AND monitor = ${input.monitor} AND last_event IS DISTINCT FROM ${input.event}
        RETURNING 1`
      return { status: 202, ack: { outcome: counted.length ? 'quiet' : 'replayed', issue: null } }
    }

    const facts = {
      source: input.source,
      monitor: input.monitor,
      event: input.event,
      status: input.status,
      details: input.facts,
    }
    const { issue, created: isNew } = await createIssueIn(
      tx,
      { source: 'alert', sourceKey: key, repo: route.repo, title: input.title, facts },
      context,
    )
    if (!isNew) return { status: 200, ack: { outcome: 'replayed', issue: issue.id } }
    await tx`INSERT INTO factory.door_issues (issue_id, source, monitor) VALUES (${issue.id}, ${input.source}, ${input.monitor})`
    return { status: 201, ack: { outcome: 'created', issue: issue.id } }
  })
}

/** Thrown to roll a probe back. */
class Probe extends Error {}

/**
 * The real path of a route's repo, if an alert may file an Issue there. It asks `createIssueIn`, the one place the policy lives
 * (inside the allowed roots, never IuRoot), and rolls the Issue it would have made back: a route and an alert can never disagree.
 * Throws `RepoRefused` as a create does.
 */
async function vetRepo(sql: SQL, repo: string, context: IntakeContext): Promise<string> {
  let real = repo
  await sql
    .begin(async (tx) => {
      const probe = {
        source: 'alert',
        sourceKey: `route-check:${crypto.randomUUID()}`,
        repo,
        title: 'route',
        facts: {},
      }
      real = (await createIssueIn(tx, probe, context)).issue.repo
      throw new Probe()
    })
    .catch((error: unknown) => {
      if (!(error instanceof Probe)) throw error
    })
  return real
}

interface RouteRow {
  source: string
  monitor: string
  repo: string
  quiet: number
  last_quiet_at: Date | null
}

const toRoute = (row: RouteRow): DoorRoute => ({
  source: row.source,
  monitor: row.monitor,
  repo: row.repo,
  quiet: row.quiet,
  lastQuietAt: row.last_quiet_at?.toISOString() ?? null,
})

/** Sets (or moves) a route. A monitor that was unrouted is no longer listed as such. */
export async function setRoute(sql: SQL, input: DoorRouteInput, context: IntakeContext): Promise<DoorRoute> {
  const repo = await vetRepo(sql, input.repo, context)
  return sql.begin(async (tx) => {
    const [row]: RouteRow[] = await tx`
      INSERT INTO factory.door_routes (source, monitor, repo) VALUES (${input.source}, ${input.monitor}, ${repo})
      ON CONFLICT (source, monitor) DO UPDATE SET repo = EXCLUDED.repo
      RETURNING source, monitor, repo, quiet, last_quiet_at`
    await tx`DELETE FROM factory.door_unrouted WHERE source = ${input.source} AND monitor = ${input.monitor}`
    if (!row) throw new Error('route was not stored')
    return toRoute(row)
  })
}

export async function removeRoute(sql: SQL, input: DoorRouteKey): Promise<DoorRoute | undefined> {
  const [row]: RouteRow[] = await sql`
    DELETE FROM factory.door_routes WHERE source = ${input.source} AND monitor = ${input.monitor}
    RETURNING source, monitor, repo, quiet, last_quiet_at`
  return row && toRoute(row)
}

export async function listRoutes(sql: SQL): Promise<DoorRoute[]> {
  const rows: RouteRow[] = await sql`
    SELECT source, monitor, repo, quiet, last_quiet_at FROM factory.door_routes ORDER BY source, monitor`
  return rows.map(toRoute)
}

/** Most recent first. Each alert keeps only its latest event, so a retry of an older one than the last counts again. */
export async function listUnrouted(sql: SQL, limit = 1000): Promise<DoorUnrouted[]> {
  // A route set while an alert was in flight can leave a row behind: a routed monitor is not unrouted.
  const rows: { source: string; monitor: string; count: number; last_seen: Date; last_title: string }[] = await sql`
    SELECT u.source, u.monitor, u.count, u.last_seen, u.last_title FROM factory.door_unrouted u
    WHERE NOT EXISTS (SELECT 1 FROM factory.door_routes r WHERE r.source = u.source AND r.monitor = u.monitor)
    ORDER BY u.last_seen DESC, u.source, u.monitor LIMIT ${limit}`
  return rows.map((row) => ({
    source: row.source,
    monitor: row.monitor,
    count: row.count,
    lastSeen: row.last_seen.toISOString(),
    lastTitle: row.last_title,
  }))
}
