import type { SQL } from 'bun'
import { latestReadings } from '../capacity.ts'
import { quote } from './text.ts'

/** The window the digest looks back over. */
export const DIGEST_WINDOW_MS = 24 * 60 * 60_000
/** A server that was down at the digest time sends it at start, but only before this local time. */
export const DIGEST_LATEST = '12:00'
/** Hard limit of a digest, in characters. */
export const DIGEST_MAX_CHARS = 3000
const SHOWN = 6
/** A list's line is cut here, so five lists, the quota and the activity line fit the 3000 whatever the titles are. */
const LINE_MAX = 450
const QUOTA_SHOWN = 8

export interface DigestData {
  /** the local date it is for, `YYYY-MM-DD` */
  date: string
  closed: { id: number; outcome: string; title: string }[]
  watching: { id: number; title: string }[]
  parked: { id: number; reason: string }[]
  decisions: { issueId: number; question: string }[]
  failedSpawns: { key: string; error: string | null }[]
  quota: { account: string; fiveHourUsed: number | null; weeklyUsed: number | null; fresh: boolean }[]
  ran: { spawns: number; started: number; failed: number; events: number; sessions: number; issueEvents: number }
}

/** The local date and `HH:MM` of an instant in a time zone. */
export function localParts(at: Date, timeZone: string): { date: string; time: string } {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).formatToParts(at)
  const get = (type: string): string => parts.find((p) => p.type === type)?.value ?? ''
  return { date: `${get('year')}-${get('month')}-${get('day')}`, time: `${get('hour')}:${get('minute')}` }
}

/**
 * The local date the digest is due for, or none: from `at` on, until noon. Before `at` it is not time yet; after noon a server
 * that was down missed it, and a digest at three in the afternoon is not the morning's. `HH:MM` strings of one day compare as text.
 */
export function digestDue(now: Date, input: { at: string; timeZone: string }): string | null {
  const local = localParts(now, input.timeZone)
  return local.time >= input.at && local.time < DIGEST_LATEST ? local.date : null
}

const more = (total: number): string => (total > SHOWN ? ` (+${total - SHOWN} more)` : '')
const percent = (value: number | null): string => (value === null ? '?' : `${Math.round(value)}%`)

/** The digest as plain text: a pure function of what the database held, under 3000 characters. */
export function renderDigest(data: DigestData): string {
  const lines = [`Factory digest ${data.date}`]
  const list = <T>(label: string, items: T[], show: (item: T) => string, none: string): void => {
    const line =
      items.length === 0
        ? `${label}: ${none}`
        : `${label}: ${items.length}: ${items.slice(0, SHOWN).map(show).join('; ')}${more(items.length)}`
    lines.push(line.length > LINE_MAX ? `${line.slice(0, LINE_MAX - 1)}…` : line)
  }
  list('Closed in 24 h', data.closed, (i) => `#${i.id} ${i.outcome} ${quote(i.title, 50)}`, 'none')
  list('Shipped and watching', data.watching, (i) => `#${i.id} ${quote(i.title, 50)}`, 'none')
  list('Parked', data.parked, (i) => `#${i.id} ${i.reason}`, 'none')
  list('Decisions open', data.decisions, (d) => `#${d.issueId} ${quote(d.question, 60)}`, 'none')
  list('Failed spawns', data.failedSpawns, (s) => `${s.key}${s.error ? ` ${quote(s.error, 60)}` : ''}`, 'none')
  lines.push(
    data.quota.length === 0
      ? 'Quota: no reading'
      : `Quota: ${data.quota
          .slice(0, QUOTA_SHOWN)
          .map(
            (q) =>
              `${q.account} 5h ${percent(q.fiveHourUsed)} week ${percent(q.weeklyUsed)}${q.fresh ? '' : ' (stale)'}`,
          )
          .join('; ')}`,
  )
  const r = data.ran
  lines.push(
    `Ran in 24 h: ${r.spawns} spawns (${r.started} started, ${r.failed} failed), ${r.events} session events from ${r.sessions} sessions, ${r.issueEvents} Issue events`,
  )
  const text = lines.join('\n')
  return text.length > DIGEST_MAX_CHARS ? `${text.slice(0, DIGEST_MAX_CHARS - 1)}…` : text
}

/** How long a reading stays fresh: the account picker is read once a minute, so a quarter of an hour is a dead poller. */
const FRESH_MS = 15 * 60_000

/** What the digest says, read as of `now` for the local `date`. */
export async function loadDigest(sql: SQL, now: Date, date: string): Promise<DigestData> {
  const since = new Date(now.getTime() - DIGEST_WINDOW_MS)
  const closed: DigestData['closed'] = await sql`
    SELECT id, outcome, title FROM factory.issues WHERE closed_at > ${since} ORDER BY closed_at DESC, id DESC`
  const watching: DigestData['watching'] = await sql`
    SELECT id, title FROM factory.issues WHERE state = 'watching' ORDER BY id`
  const parked: DigestData['parked'] = await sql`
    SELECT id, reason FROM factory.issues
    WHERE state = 'waiting' AND reason IN ('unreported', 'blocked', 'parked', 'lead_gone') ORDER BY id`
  const decisions: { issue_id: number; question: string }[] = await sql`
    SELECT d.issue_id, d.question FROM factory.decisions d JOIN factory.issues i ON i.id = d.issue_id
    WHERE d.answered_at IS NULL AND i.state <> 'closed' ORDER BY d.id`
  const failedSpawns: DigestData['failedSpawns'] = await sql`
    SELECT s.key, s.error FROM factory.spawns s LEFT JOIN factory.issues i ON i.id = s.issue_id
    WHERE s.status = 'failed' AND (s.created_at > ${since} OR i.state <> 'closed') ORDER BY s.created_at, s.key`
  const readings = await latestReadings(sql)
  const [spawns]: { total: string; started: string; failed: string }[] = await sql`
    SELECT count(*) AS total, count(*) FILTER (WHERE status = 'started') AS started, count(*) FILTER (WHERE status = 'failed') AS failed
    FROM factory.spawns WHERE created_at > ${since}`
  const [events]: { events: string; sessions: string }[] = await sql`
    SELECT count(*) AS events, count(DISTINCT session) AS sessions FROM factory.events WHERE at > ${since}`
  const [issueEvents]: { n: string }[] = await sql`SELECT count(*) AS n FROM factory.issue_events WHERE at > ${since}`
  return {
    date,
    closed,
    watching,
    parked,
    decisions: decisions.map((d) => ({ issueId: d.issue_id, question: d.question })),
    failedSpawns,
    quota: readings
      .map((r) => ({
        account: r.account,
        fiveHourUsed: r.fiveHourUsed,
        weeklyUsed: r.weeklyUsed,
        fresh: now.getTime() - r.readAt.getTime() <= FRESH_MS,
      }))
      .sort((a, b) => a.account.localeCompare(b.account)),
    ran: {
      spawns: Number(spawns?.total ?? 0),
      started: Number(spawns?.started ?? 0),
      failed: Number(spawns?.failed ?? 0),
      events: Number(events?.events ?? 0),
      sessions: Number(events?.sessions ?? 0),
      issueEvents: Number(issueEvents?.n ?? 0),
    },
  }
}
