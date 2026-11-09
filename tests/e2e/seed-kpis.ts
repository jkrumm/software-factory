import type { SQL } from 'bun'

const HOUR = 3_600_000
const DAY = 24 * HOUR

/**
 * Earlier work for Improve's history: closed Issues of one repo, filed, admitted and closed on days well before the current
 * window (ids from 9001, outside the sequence the other seeds use), so the KPIs have readings in the windows before. A
 * 7-day window with no day in it stays empty (the line breaks there); the 30-day windows get the same Issues, wider.
 * Each Issue was filed, waited a while for a lead (the queue wait), then closed (the cycle); some had an owner note (an
 * avoidable touch) and some a refused event (a refusal). They closed days ago, so Flow's "closed in the last day" is
 * unchanged.
 */
const EARLIER = [
  { daysAgo: 9, waitMin: 12, cycleHours: 20, touch: true, refused: true },
  { daysAgo: 12, waitMin: 45, cycleHours: 30, touch: false, refused: false },
  { daysAgo: 16, waitMin: 25, cycleHours: 26, touch: true, refused: false },
  { daysAgo: 20, waitMin: 90, cycleHours: 50, touch: false, refused: true },
  // nothing 21 to 28 days ago: the 7-day line breaks there
  { daysAgo: 31, waitMin: 30, cycleHours: 18, touch: true, refused: false },
  { daysAgo: 38, waitMin: 15, cycleHours: 40, touch: false, refused: false },
  { daysAgo: 44, waitMin: 60, cycleHours: 22, touch: true, refused: true },
  { daysAgo: 52, waitMin: 35, cycleHours: 28, touch: false, refused: false },
  { daysAgo: 60, waitMin: 20, cycleHours: 36, touch: true, refused: false },
  { daysAgo: 75, waitMin: 75, cycleHours: 44, touch: false, refused: true },
  { daysAgo: 90, waitMin: 40, cycleHours: 24, touch: true, refused: false },
  { daysAgo: 105, waitMin: 18, cycleHours: 32, touch: false, refused: false },
  { daysAgo: 120, waitMin: 55, cycleHours: 60, touch: true, refused: true },
  { daysAgo: 140, waitMin: 28, cycleHours: 21, touch: false, refused: false },
]

export async function seedKpiHistory(sql: SQL, repo: string): Promise<void> {
  const now = Date.now()
  for (const [i, e] of EARLIER.entries()) {
    const id = `issue_${9001 + i}`
    const filed = new Date(now - e.daysAgo * DAY)
    const admitted = new Date(filed.getTime() + e.waitMin * 60_000)
    const closed = new Date(filed.getTime() + e.cycleHours * HOUR)
    const touched = new Date(admitted.getTime() + HOUR)
    await sql`INSERT INTO factory.issues (id, repo, state, outcome, version) VALUES (${id}, ${repo}, 'closed', 'done', ${e.touch ? 4 : 3})`
    const event = (
      n: number,
      kind: string,
      at: Date,
      o: {
        actor?: string
        from?: string | null
        to?: string
        version?: number | null
        result?: string
        detail?: string | null
        payload?: object
        outcome?: string | null
        key?: string
      },
    ) => sql`INSERT INTO factory.issue_events
      (id, issue_id, key, kind, payload, actor, at, result, detail, version, from_state, to_state, outcome)
      VALUES (${`event_earlier_${i}_${n}`}, ${id}, ${o.key ?? `earlier:${id}:${n}`}, ${kind}, ${JSON.stringify(o.payload ?? {})}::text::jsonb,
        ${o.actor ?? 'factory'}, ${at}, ${o.result ?? 'applied'}, ${o.detail ?? null}, ${o.version ?? null},
        ${o.from ?? null}, ${o.to ?? null}, ${o.outcome ?? null})`
    await event(1, 'filed', filed, {
      actor: 'owner',
      version: 1,
      to: 'settling',
      payload: { repo, title: `Earlier work ${i + 1}`, kind: 'chore', origin: 'you' },
    })
    await event(2, 'admitted', admitted, { version: 2, from: 'settling', to: 'working' })
    if (e.touch) {
      await event(3, 'noted', touched, {
        actor: 'owner',
        version: 3,
        from: 'working',
        to: 'working',
        key: `noted:${id}:owner:earlier`,
        payload: { text: 'A note to the lead' },
      })
    }
    if (e.refused) {
      await event(5, 'cancelled', touched, {
        actor: 'owner',
        result: 'refused',
        from: 'working',
        detail: 'the Issue is already closed',
      })
    }
    await event(4, 'closed', closed, { version: e.touch ? 4 : 3, from: 'working', to: 'closed', outcome: 'done' })
  }
}
