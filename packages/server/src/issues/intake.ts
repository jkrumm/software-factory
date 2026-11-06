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
import { createIssueIn } from './create.ts'
import { fileSignalIn } from './signals.ts'

/** The door's intake (docs/design.md §11): one alert becomes a signal on an open Issue, a new Issue, or a count. */
export interface IntakeContext {
  repoRoots: readonly string[]
  now: Date
}

/** How long a monitor with no route stays listed after its last alert. */
const UNROUTED_KEEP_MS = 30 * 24 * 60 * 60_000
/** How long one that is still down stays listed after its last alert. */
const UNROUTED_DOWN_KEEP_MS = 365 * 24 * 60 * 60_000

/** A group monitor's alert (Kuma: 'Child monitors down') names no thing of its own: the children are the alerts. */
const GROUP_MESSAGE = /child monitors? (down|up)/i
const isGroupAlert = (input: IntakeInput): boolean => {
  const facts = input.facts as { msg?: unknown; heartbeat?: { msg?: unknown } } | null
  return [input.title, facts?.msg, facts?.heartbeat?.msg].some(
    (text) => typeof text === 'string' && GROUP_MESSAGE.test(text),
  )
}

/** The HTTP status and the body of an intake. */
export interface IntakeResult {
  status: 200 | 201 | 202
  ack: IntakeAck
}

/**
 * Files one alert, in one transaction. The route row is locked first, so two alerts of one monitor are filed one after the other
 * and the second sees the Issue the first created. No port is called here: everything an Issue then needs happens after the commit.
 *
 * 1. No route for `(source, monitor)`: no Issue, one row counts it (202).
 * 2. Routed: `fileSignalIn` (`signals.ts`) decides, with the route's repo, never the payload's: a `signal` on an open Issue of the monitor
 *    (200), a new Issue (201), a `down` waiting out the project's `heal:` grace (`settling`, 202) or an `up` that cancels one (`healed`, 202).
 * 3. An `up` with no open Issue and nothing pending: only the route's counter (202).
 *
 * An event filed before is one effect: the Issue's key, the inbox key, the settled-event table and the counters' last event all see it.
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
  return sql.begin(async (tx): Promise<IntakeResult> => {
    const [route]: { repo: string }[] = await tx`
      SELECT repo FROM factory.door_routes WHERE source = ${input.source} AND monitor = ${input.monitor} FOR UPDATE`
    if (!route) {
      // A row not seen for a month is a monitor nobody alerts on: the table is a recent list, not a history, and a sender with a
      // token cannot grow it past what it has made in thirty days. A monitor still down keeps its row (Kuma sends the `down` once,
      // and the line must outlive it), for a year at most.
      await tx`
        DELETE FROM factory.door_unrouted
        WHERE last_seen < ${new Date(now.getTime() - UNROUTED_KEEP_MS)} AND status IS DISTINCT FROM 'down'`
      await tx`DELETE FROM factory.door_unrouted WHERE last_seen < ${new Date(now.getTime() - UNROUTED_DOWN_KEEP_MS)}`
      const down = input.status === 'down'
      // The steward may have handed the down to a project's `heal:` grace (`unrouted.ts`): the `up` cancels it as a routed one does.
      if (!down)
        await tx`DELETE FROM factory.intake_pending WHERE source = ${input.source} AND subject = ${input.monitor}`
      await tx`
        INSERT INTO factory.door_unrouted (source, monitor, count, last_seen, last_title, last_event, status, down_since, is_group)
        VALUES (${input.source}, ${input.monitor}, 1, ${now}, ${input.title}, ${input.event}, ${input.status},
          ${down ? now : null}, ${isGroupAlert(input)})
        ON CONFLICT (source, monitor) DO UPDATE
          SET count = factory.door_unrouted.count + 1, last_seen = EXCLUDED.last_seen, last_title = EXCLUDED.last_title,
              last_event = EXCLUDED.last_event, status = EXCLUDED.status,
              is_group = factory.door_unrouted.is_group OR EXCLUDED.is_group,
              down_since = CASE WHEN EXCLUDED.status <> 'down' THEN NULL
                                WHEN factory.door_unrouted.status = 'down' THEN factory.door_unrouted.down_since
                                ELSE EXCLUDED.down_since END,
              filed_at = CASE WHEN EXCLUDED.status = 'down' AND factory.door_unrouted.status = 'down'
                              THEN factory.door_unrouted.filed_at END,
              filed_issue = CASE WHEN EXCLUDED.status = 'down' AND factory.door_unrouted.status = 'down'
                                 THEN factory.door_unrouted.filed_issue END,
              file_error = CASE WHEN EXCLUDED.status = 'down' AND factory.door_unrouted.status = 'down'
                                THEN factory.door_unrouted.file_error END
          WHERE factory.door_unrouted.last_event <> EXCLUDED.last_event`
      return { status: 202, ack: { outcome: 'unrouted', issue: null } }
    }

    const filed = await fileSignalIn(
      tx,
      {
        source: input.source,
        subject: input.monitor,
        event: input.event,
        status: input.status,
        title: input.title,
        facts: input.facts,
        repo: route.repo,
      },
      context,
    )
    if (filed.outcome !== 'quiet') {
      const outcome = filed.outcome === 'repeat' ? 'replayed' : filed.outcome
      return { status: filed.status, ack: { outcome, issue: filed.issue } }
    }
    const counted = await tx`
      UPDATE factory.door_routes SET quiet = quiet + 1, last_quiet_at = ${now}, last_event = ${input.event}
      WHERE source = ${input.source} AND monitor = ${input.monitor} AND last_event IS DISTINCT FROM ${input.event}
      RETURNING 1`
    return { status: 202, ack: { outcome: counted.length ? 'quiet' : 'replayed', issue: null } }
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
  const rows: {
    source: string
    monitor: string
    count: number
    last_seen: Date
    last_title: string
    status: 'down' | 'up' | null
    down_since: Date | null
    is_group: boolean
    filed_issue: number | null
  }[] = await sql`
    SELECT u.source, u.monitor, u.count, u.last_seen, u.last_title, u.status, u.down_since, u.is_group, u.filed_issue
    FROM factory.door_unrouted u
    WHERE NOT EXISTS (SELECT 1 FROM factory.door_routes r WHERE r.source = u.source AND r.monitor = u.monitor)
    ORDER BY u.last_seen DESC, u.source, u.monitor LIMIT ${limit}`
  return rows.map((row) => ({
    source: row.source,
    monitor: row.monitor,
    count: row.count,
    lastSeen: row.last_seen.toISOString(),
    lastTitle: row.last_title,
    status: row.status,
    downSince: row.down_since?.toISOString() ?? null,
    group: row.is_group,
    issue: row.filed_issue,
  }))
}
