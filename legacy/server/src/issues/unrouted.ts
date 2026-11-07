import { basename } from 'node:path'
import type { SQL } from 'bun'
import { RepoRefused } from '../repos.ts'
import { vetIntakeRepo } from './create.ts'
import { fileSignalIn } from './signals.ts'

/**
 * A monitor that is down with no route still reaches someone (docs/design.md §11 "Unrouted monitors"). The door counts an alert with no
 * route in `door_unrouted` and nothing else; this is what reads that row: a health line while the monitor is down past the grace, and
 * the steward's filing of the down, once, as an Issue. Both are derived from the row (`status`, `down_since`), never from a transition
 * event, so a monitor that has been down for a month keeps its line. Nothing here calls a model or a port.
 */

/** A down must last this long before it is a line and an Issue: a flapping monitor's `up` comes before it. */
export const UNROUTED_GRACE_MS = 10 * 60_000
/** At most this many are filed in one pass; the rest follow on the next. */
const PER_PASS = 20
/** The Issue's title is `<prefix><the alert's title>`, cut so the whole stays well inside the title limit. */
const TITLE_MAX = 200

export interface UnroutedDeps {
  repoRoots: readonly string[]
  /** the repo whose Issue picks a home for a monitor the default rule cannot place: the dotfiles repo */
  home: string
}

interface DownRow {
  source: string
  monitor: string
  last_event: string
  last_title: string
  down_since: Date
}

/** A monitor down past the grace with no route: not a group, which is its children's news. */
const DUE = (sql: SQL, now: Date) => sql`
  u.status = 'down' AND NOT u.is_group AND u.down_since <= ${new Date(now.getTime() - UNROUTED_GRACE_MS)}
  AND NOT EXISTS (SELECT 1 FROM factory.door_routes r WHERE r.source = u.source AND r.monitor = u.monitor)`

/** The Issue of the monitor's current down (none for an up): the one the steward filed, else an open Issue of the monitor (a `heal:` grace files it later, off the row). */
export const ISSUE_OF = (sql: SQL) => sql`CASE WHEN u.status = 'down' THEN COALESCE(u.filed_issue, (
  SELECT max(d.issue_id) FROM factory.door_issues d JOIN factory.issues i ON i.id = d.issue_id AND i.state <> 'closed'
  WHERE d.source = u.source AND d.monitor = u.monitor)) END`

const SUFFIX = /\s+[-–—]\s+(push|door)$/i

/**
 * The repos a monitor named `<name> - Push` or `<name> - Door` is likely about, best first: the repo of a route whose monitor starts with
 * `<name> - ` (the same source), then a project whose manifest name or directory is `<name>`. Any other name has none: the Issue in the
 * home repo picks.
 */
async function candidates(sql: SQL, source: string, monitor: string): Promise<string[]> {
  const base = monitor.replace(SUFFIX, '')
  if (base === monitor || !base) return []
  const wanted = base.toLowerCase()
  const routes: { monitor: string; repo: string }[] = await sql`
    SELECT monitor, repo FROM factory.door_routes WHERE source = ${source} ORDER BY monitor`
  const found = routes
    .filter((route) => route.monitor.toLowerCase().startsWith(`${wanted} - `))
    .map((route) => route.repo)
  const projects: { repo: string; name: string }[] = await sql`SELECT repo, name FROM factory.projects ORDER BY repo`
  for (const project of projects) {
    if (project.name.toLowerCase() === wanted || basename(project.repo).toLowerCase() === wanted)
      found.push(project.repo)
  }
  return found
}

/**
 * Where the monitor's down is filed: the first mapped repo the intake policy accepts (inside the roots, never IuRoot), else the home
 * repo. Undefined when even that is refused.
 */
async function placeFor(
  sql: SQL,
  row: Pick<DownRow, 'source' | 'monitor'>,
  deps: UnroutedDeps,
): Promise<{ repo: string; mapped: boolean } | undefined> {
  for (const repo of await candidates(sql, row.source, row.monitor)) {
    try {
      return { repo: await vetIntakeRepo('alert', repo, deps.repoRoots), mapped: true }
    } catch (error) {
      if (!(error instanceof RepoRefused)) throw error
    }
  }
  try {
    return { repo: await vetIntakeRepo('alert', deps.home, deps.repoRoots), mapped: false }
  } catch (error) {
    if (error instanceof RepoRefused) return undefined
    throw error
  }
}

const HOME_TITLE = 'No door route for a monitor that is down, pick its repo: '
const HOME_ASK =
  'No door route exists for this monitor, so its alerts reach no repo. Decide which repo it belongs to and add the route with `factory door route set <source> <monitor> <repo>`; fix the monitor if it is down for a reason of its own.'

/**
 * The steward's filing of an unrouted down: once per down, in the repo the default rule maps it to, else as an Issue in the home repo
 * to pick one. It goes through `fileSignalIn` like any alert of a route (so the project's `heal:` grace, an open Issue of the monitor
 * and a replay of the event all behave as they do there); an `up` clears `filed_at`, so the next down files again. A repo that is
 * refused is stored as `file_error` on the row (the health line says so) and tried again on the next pass.
 */
export async function fileUnrouted(sql: SQL, deps: UnroutedDeps, now: Date): Promise<void> {
  const due: DownRow[] = await sql`
    SELECT u.source, u.monitor, u.last_event, u.last_title, u.down_since FROM factory.door_unrouted u
    WHERE ${DUE(sql, now)} AND u.filed_at IS NULL ORDER BY u.down_since, u.source, u.monitor LIMIT ${PER_PASS}`
  for (const row of due) {
    const place = await placeFor(sql, row, deps)
    await sql.begin(async (tx) => {
      // The row is locked and read again: an `up`, a route or another pass may have settled it since the look above.
      const [current]: { last_event: string }[] = await tx`
        SELECT u.last_event FROM factory.door_unrouted u
        WHERE u.source = ${row.source} AND u.monitor = ${row.monitor} AND ${DUE(tx, now)} AND u.filed_at IS NULL FOR UPDATE`
      if (!current || current.last_event !== row.last_event) return
      if (!place) {
        await tx`
          UPDATE factory.door_unrouted SET file_error = 'no repo accepts it, the default one included'
          WHERE source = ${row.source} AND monitor = ${row.monitor}`
        return
      }
      const filed = await fileSignalIn(
        tx,
        {
          source: row.source,
          subject: row.monitor,
          event: row.last_event,
          status: 'down',
          title: (place.mapped ? row.last_title : `${HOME_TITLE}${row.last_title}`).slice(0, TITLE_MAX),
          facts: {
            unrouted: true,
            downSince: row.down_since.toISOString(),
            ...(place.mapped ? {} : { ask: HOME_ASK }),
          },
          repo: place.repo,
        },
        { repoRoots: deps.repoRoots, now },
      )
      await tx`
        UPDATE factory.door_unrouted SET filed_at = ${now}, filed_issue = ${filed.issue}, file_error = NULL
        WHERE source = ${row.source} AND monitor = ${row.monitor}`
    })
  }
}

/** `3 min`, `2.5 h`: a down is read in minutes first and hours once it is long. */
const since = (ms: number): string =>
  ms < 2 * 3_600_000 ? `${Math.floor(ms / 60_000)} min` : `${Math.round(ms / 360_000) / 10} h`

/**
 * The health lines of unrouted monitors that are down now, past the grace: `monitor kuma/<name> down 28 h with no route, filed as
 * Issue N`. Derived at read from the row: it is there while the monitor is down and gone at its `up`, a route, or a month with no
 * alert if the row is not down any more.
 */
export async function unroutedLines(sql: SQL, now: Date): Promise<string[]> {
  const rows: (DownRow & { filed_at: Date | null; filed_issue: number | null; file_error: string | null })[] =
    await sql`
    SELECT u.source, u.monitor, u.last_event, u.last_title, u.down_since, u.filed_at, ${ISSUE_OF(sql)} AS filed_issue, u.file_error
    FROM factory.door_unrouted u WHERE ${DUE(sql, now)} ORDER BY u.down_since, u.source, u.monitor LIMIT 50`
  return rows.map((row) => {
    const name = row.monitor.length > 80 ? `${row.monitor.slice(0, 79)}…` : row.monitor
    const state = row.file_error
      ? `not filed: ${row.file_error}`
      : row.filed_issue !== null
        ? `filed as Issue ${row.filed_issue}`
        : row.filed_at
          ? 'filing waits for the repo’s heal rule'
          : 'to be filed'
    return `monitor ${row.source}/${name} down ${since(now.getTime() - row.down_since.getTime())} with no route, ${state}`
  })
}
