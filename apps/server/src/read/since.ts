import type { SQL } from 'bun'
import * as z from 'zod'
import {
  SIGNAL_ORIGINS,
  type SinceCategory,
  type SinceFiled,
  type SinceItem,
  type SinceModel,
} from '@software-factory/contract'
import { FIRST_WINDOW_MS } from '../kernel/visit.ts'
import { plain } from './words.ts'
import { isWorkRepo, loadOpenProjects, REDACTED_TITLE } from './work.ts'

/** Items a category lists; its count is not capped. */
export const SINCE_ITEMS = 8

const Row = z.object({
  issue_id: z.string().nullable(),
  repo: z.string().nullable(),
  title: z.string().nullable(),
  at: z.date(),
  total: z.coerce.number().int(),
})
type Row = z.infer<typeof Row>

/** Where the band begins for a caller that does not move the marker: the stored start, else the last 24 hours. */
export async function storedSince(sql: SQL, now: Date): Promise<Date> {
  const rows: unknown[] = await sql`SELECT since_at FROM factory.console_visit`
  if (rows.length === 0) return new Date(now.getTime() - FIRST_WINDOW_MS)
  return z.object({ since_at: z.date() }).parse(rows[0]).since_at
}

const parse = (rows: unknown[]): Row[] => rows.map((raw) => Row.parse(raw))

/** Issues with an applied event of `kind` (and `outcome`, when given) after `since`; each Issue once, at its latest such event. */
async function eventRows(sql: SQL, since: Date, kind: string, outcome: string | null): Promise<Row[]> {
  return parse(
    await sql`
    SELECT x.issue_id, x.repo, x.title, x.at, count(*) OVER () AS total FROM (
      SELECT DISTINCT ON (e.issue_id) e.issue_id, i.repo, f.payload->>'title' AS title, e.at
      FROM factory.issue_events e
      JOIN factory.issues i ON i.id = e.issue_id
      JOIN factory.issue_events f ON f.issue_id = e.issue_id AND f.kind = 'filed' AND f.version = 1
      WHERE e.kind = ${kind} AND e.result = 'applied' AND e.at > ${since}
        AND (${outcome}::text IS NULL OR e.outcome = ${outcome})
      ORDER BY e.issue_id, e.at DESC
    ) x ORDER BY x.at DESC, x.issue_id DESC LIMIT ${SINCE_ITEMS}`,
  )
}

/**
 * What happened since `since`: shipped with verification, regressed, dropped, settled by the Judge, screened off, filed
 * (by origin) and incidents opened, each with its count and the newest 8. The read token gets work-repo titles replaced
 * as in the needs. Read-only SQL; the visit marker is `app/visit.ts`.
 */
export async function readSince(sql: SQL, options: { now: Date; since: Date; redact?: boolean }): Promise<SinceModel> {
  const { now, since } = options
  const open = options.redact ? await loadOpenProjects(sql) : []
  const item = (row: Row, title: string): SinceItem => ({
    issue: row.issue_id,
    title: options.redact && isWorkRepo(row.repo, open) ? REDACTED_TITLE : plain(title, 120),
    repo: row.repo,
    at: row.at.toISOString(),
  })
  const category = (rows: Row[]): SinceCategory => ({
    count: rows[0]?.total ?? 0,
    items: rows.map((row) => item(row, row.title ?? '')),
  })

  const decisions = parse(
    await sql`
    SELECT x.issue_id, x.repo, x.title, x.at, count(*) OVER () AS total FROM (
      SELECT DISTINCT ON (d.issue_id) d.issue_id, d.repo, d.question AS title, d.answered_at AS at
      FROM factory.decisions d
      WHERE d.settled_by = 'judge' AND d.answered_at > ${since}
      ORDER BY d.issue_id, d.answered_at DESC
    ) x ORDER BY x.at DESC, x.issue_id DESC LIMIT ${SINCE_ITEMS}`,
  )

  const screened = parse(
    await sql`
    SELECT x.issue_id, x.repo, x.title, x.at, count(*) OVER () AS total FROM (
      SELECT s.issue_id, s.repo, s.title, s.dismissed_at AS at
      FROM factory.intake_signals s
      WHERE s.state = 'dismissed' AND s.dismissed_by = 'judge' AND s.dismissed_at > ${since}
      UNION ALL
      SELECT e.issue_id, e.repo, e.title, e.at FROM (
        SELECT DISTINCT ON (r.issue_id) r.issue_id, i.repo, r.summary AS title, r.turned_away_at AS at
        FROM factory.errands r JOIN factory.issues i ON i.id = r.issue_id
        WHERE r.turned_away_at > ${since}
        ORDER BY r.issue_id, r.turned_away_at DESC
      ) e
    ) x ORDER BY x.at DESC, x.issue_id DESC NULLS LAST LIMIT ${SINCE_ITEMS}`,
  )

  const filedRows = await eventRows(sql, since, 'filed', null)
  const byOrigin = z.array(z.object({ origin: z.string(), n: z.coerce.number().int() })).parse(
    await sql`
        SELECT f.payload->>'origin' AS origin, count(DISTINCT e.issue_id) AS n
        FROM factory.issue_events e
        JOIN factory.issue_events f ON f.issue_id = e.issue_id AND f.kind = 'filed' AND f.version = 1
        WHERE e.kind = 'filed' AND e.result = 'applied' AND e.at > ${since}
        GROUP BY 1`,
  )
  const filed: SinceFiled = {
    ...category(filedRows),
    byOrigin: SIGNAL_ORIGINS.flatMap((origin) => {
      const count = byOrigin.find((row) => row.origin === origin)?.n ?? 0
      return count > 0 ? [{ origin, count }] : []
    }),
  }

  const incidents = parse(
    await sql`
    SELECT x.issue_id, x.repo, x.title, x.at, count(*) OVER () AS total FROM (
      SELECT n.issue_id, i.repo, f.payload->>'title' AS title, n.opened_at AS at
      FROM factory.intake_incidents n
      JOIN factory.issues i ON i.id = n.issue_id
      JOIN factory.issue_events f ON f.issue_id = n.issue_id AND f.kind = 'filed' AND f.version = 1
      WHERE n.opened_at > ${since}
    ) x ORDER BY x.at DESC, x.issue_id DESC LIMIT ${SINCE_ITEMS}`,
  )

  return {
    at: now.toISOString(),
    since: since.toISOString(),
    categories: {
      shipped: category(await eventRows(sql, since, 'watch_passed', null)),
      failed: category(await eventRows(sql, since, 'regressed', null)),
      dropped: category(await eventRows(sql, since, 'closed', 'dropped')),
      judge: category(decisions),
      screen: category(screened),
      filed,
      incidents: category(incidents),
    },
  }
}
