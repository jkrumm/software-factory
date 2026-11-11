import type { SQL } from 'bun'
import * as z from 'zod'
import type { AcceptanceEvidence, CiEvidence, CommitsEvidence, ReviewEvidence } from '../../domains/quality/evidence.ts'
import type {
  OpenWatch,
  QualityStore,
  QualityView,
  StoredEvidence,
  WatchAnswer,
  WatchRecord,
} from '../../domains/quality/store.ts'
import type { IssueId } from '../../kernel/ids.ts'
import type { Key } from '../../kernel/keys.ts'

const OUTCOME = z.enum(['green', 'red', 'blocked'])
const CheckList = z.array(z.object({ name: z.string(), ok: z.boolean(), detail: z.string() }))

const WatchRow = z.object({
  key: z.string(),
  issue_id: z.string(),
  attempt: z.number().int(),
  watch: z.number().int(),
  started_at: z.date(),
  // bigint arrives as a string
  window_ms: z.coerce.number().int(),
  answer: z.enum(['passed', 'regressed', 'ended']).nullable(),
})

const watchOf = (raw: unknown): WatchRecord => {
  const row = WatchRow.parse(raw)
  return {
    key: row.key as Key,
    issueId: row.issue_id as IssueId,
    attempt: row.attempt,
    watch: row.watch,
    startedAt: row.started_at,
    windowMs: row.window_ms,
    answer: row.answer,
  }
}

const ShipRow = z.object({
  id: z.string(),
  attempt: z.number().int(),
  event_key: z.string(),
  at: z.date(),
  result: z.enum(['accepted', 'refused']),
  detail: z.string().nullable(),
  reported: z.array(z.string()),
})

const EvidenceRow = z.object({
  id: z.string(),
  source_key: z.string(),
  kind: z.enum(['commits', 'review', 'acceptance', 'ci']),
  payload: z.unknown(),
})

/** The payloads are this adapter's own writes: checked for their shape only, as `work-store` does for waits. */
const evidenceOf = (raw: unknown): StoredEvidence => {
  const row = EvidenceRow.parse(raw)
  switch (row.kind) {
    case 'commits':
      return { id: row.id, kind: 'commits', payload: row.payload as CommitsEvidence }
    case 'review':
      return { id: row.id, kind: 'review', payload: row.payload as ReviewEvidence }
    case 'acceptance':
      return { id: row.id, kind: 'acceptance', payload: row.payload as AcceptanceEvidence }
    case 'ci':
      return { id: row.id, kind: 'ci', payload: row.payload as CiEvidence }
  }
}

/** The quality domain's tables on one transaction's connection. */
export function postgresQualityStore(tx: SQL): QualityStore {
  return {
    async shipAccepted(eventKey) {
      const [row] = await tx`
        SELECT 1 AS found FROM factory.quality_ships WHERE event_key = ${eventKey} AND result = 'accepted'`
      return row !== undefined
    },

    async recordShip(ship, evidence) {
      const rows = await tx`
        INSERT INTO factory.quality_ships (id, issue_id, attempt, event_key, at, result, detail, reported)
        VALUES (${ship.id}, ${ship.issueId}, ${ship.attempt}, ${ship.eventKey}, ${ship.at}, ${ship.result},
                ${ship.detail}, ${ship.reported})
        ON CONFLICT DO NOTHING
        RETURNING id`
      if (rows.length === 0) return
      for (const one of evidence) {
        await tx`
          INSERT INTO factory.quality_evidence (id, issue_id, attempt, source_key, kind, at, payload)
          VALUES (${one.id}, ${ship.issueId}, ${ship.attempt}, ${ship.eventKey}, ${one.kind}, ${ship.at},
                  ${one.payload})
          ON CONFLICT DO NOTHING`
      }
    },

    async lastShip(issueId, attempt) {
      const [ship] = await tx`
        SELECT event_key FROM factory.quality_ships
        WHERE issue_id = ${issueId} AND attempt = ${attempt} AND result = 'accepted'
        ORDER BY at DESC, id DESC LIMIT 1`
      if (!ship) return null
      const [row] = await tx`
        SELECT id, source_key, kind, payload FROM factory.quality_evidence
        WHERE source_key = ${z.object({ event_key: z.string() }).parse(ship).event_key} AND kind = 'commits'`
      return { commits: row ? (evidenceOf(row).payload as CommitsEvidence) : null }
    },

    async openWatch(watch) {
      const rows = await tx`
        INSERT INTO factory.quality_watches (key, issue_id, attempt, watch, started_at, window_ms)
        VALUES (${watch.key}, ${watch.issueId}, ${watch.attempt}, ${watch.watch}, ${watch.startedAt}, ${watch.windowMs})
        ON CONFLICT DO NOTHING
        RETURNING key`
      return rows.length > 0
    },

    async openWatches(now) {
      const rows = await tx`
        SELECT key, issue_id, attempt, watch, started_at, window_ms::text AS window_ms, answer
        FROM factory.quality_watches
        WHERE answer IS NULL AND (claimed_until IS NULL OR claimed_until <= ${now})
        ORDER BY started_at, key`
      const watches: OpenWatch[] = []
      for (const row of rows) {
        const watch = watchOf(row)
        const runs = await tx`
          SELECT at, outcome FROM factory.quality_checks WHERE watch_key = ${watch.key} ORDER BY n`
        watches.push({
          ...watch,
          ran: runs.map((run: unknown) => {
            const parsed = z.object({ at: z.date(), outcome: OUTCOME }).parse(run)
            return { at: parsed.at, outcome: parsed.outcome }
          }),
        })
      }
      return watches
    },

    async claimWatch(key, now, until) {
      const rows = await tx`
        UPDATE factory.quality_watches SET claimed_until = ${until}
        WHERE key = ${key} AND answer IS NULL AND (claimed_until IS NULL OR claimed_until <= ${now})
        RETURNING key`
      return rows.length > 0
    },

    async releaseWatch(key) {
      await tx`UPDATE factory.quality_watches SET claimed_until = NULL WHERE key = ${key}`
    },

    async recordCheck(input) {
      const [next] = await tx`
        SELECT coalesce(max(n), 0) + 1 AS n FROM factory.quality_checks WHERE watch_key = ${input.watch}`
      const n = z.object({ n: z.coerce.number().int() }).parse(next).n
      await tx`
        INSERT INTO factory.quality_checks (watch_key, n, at, outcome, checks)
        VALUES (${input.watch}, ${n}, ${input.at}, ${input.outcome}, ${input.checks})`
    },

    async answerWatch(key, answer: WatchAnswer, at) {
      await tx`UPDATE factory.quality_watches SET answer = ${answer}, answered_at = ${at}, claimed_until = NULL WHERE key = ${key}`
    },

    async view(issueId): Promise<QualityView> {
      const ships = await tx`
        SELECT id, attempt, event_key, at, result, detail, reported FROM factory.quality_ships
        WHERE issue_id = ${issueId} ORDER BY at, id`
      const evidence = await tx`
        SELECT id, source_key, kind, payload FROM factory.quality_evidence WHERE issue_id = ${issueId} ORDER BY at, id`
      const stored = evidence.map((row: unknown) => ({
        source: EvidenceRow.parse(row).source_key,
        one: evidenceOf(row),
      }))
      const watchRows = await tx`
        SELECT key, issue_id, attempt, watch, started_at, window_ms::text AS window_ms, answer
        FROM factory.quality_watches WHERE issue_id = ${issueId} ORDER BY watch`
      const watches = []
      for (const row of watchRows) {
        const watch = watchOf(row)
        const runs = await tx`
          SELECT n, at, outcome, checks FROM factory.quality_checks WHERE watch_key = ${watch.key} ORDER BY n`
        watches.push({
          ...watch,
          checks: runs.map((run: unknown) => {
            const parsed = z
              .object({ n: z.number().int(), at: z.date(), outcome: OUTCOME, checks: CheckList })
              .parse(run)
            return { n: parsed.n, at: parsed.at, outcome: parsed.outcome, checks: parsed.checks }
          }),
        })
      }
      return {
        ships: ships.map((row: unknown) => {
          const ship = ShipRow.parse(row)
          return {
            id: ship.id,
            attempt: ship.attempt,
            eventKey: ship.event_key as Key,
            at: ship.at,
            result: ship.result,
            detail: ship.detail,
            reported: ship.reported,
            evidence: stored
              .filter((e: { source: string }) => e.source === ship.event_key)
              .map((e: { one: StoredEvidence }) => e.one),
          }
        }),
        watches,
      }
    },
  }
}
