import type { SQL } from 'bun'
import * as z from 'zod'
import { EFFECT_KINDS, type Effect } from '../../domains/work/effects.ts'
import { EVENT_KINDS } from '../../domains/work/events.ts'
import { OUTCOMES, STATES, type Wait } from '../../domains/work/issue.ts'
import type { AppliedRecord, Transition } from '../../domains/work/machine.ts'
import type { ClaimedEffect, EffectRun, StoredEvent, WorkStore } from '../../domains/work/ports.ts'
import { ACTORS } from '../../kernel/events.ts'
import type { EventId, IssueId } from '../../kernel/ids.ts'
import type { Key } from '../../kernel/keys.ts'

/** A wait as this adapter wrote it: the machine's own value, checked for its shape only. */
const WaitColumn = z
  .object({ reason: z.string(), since: z.number().int() })
  .loose()
  .transform((wait) => wait as unknown as Wait)

const EventRow = z.object({
  id: z.string(),
  issue_id: z.string(),
  key: z.string(),
  kind: z.enum(EVENT_KINDS),
  payload: z.unknown(),
  actor: z.enum(ACTORS),
  at: z.date(),
  result: z.enum(['applied', 'refused', 'ignored']),
  detail: z.string().nullable(),
  version: z.number().int().nullable(),
  from_state: z.enum(STATES).nullable(),
  to_state: z.enum(STATES).nullable(),
  wait: WaitColumn.nullable(),
  outcome: z.enum(OUTCOMES).nullable(),
  causation: z.string().nullable(),
})
type EventRow = z.infer<typeof EventRow>

const EffectRow = z.object({
  key: z.string(),
  issue_id: z.string(),
  kind: z.enum(EFFECT_KINDS),
  payload: z.record(z.string(), z.number()),
  planned_at: z.date(),
  failures: z.number().int(),
})

const transitionOf = (row: EventRow): Transition | null =>
  row.to_state ? { from: row.from_state, to: row.to_state, wait: row.wait, outcome: row.outcome } : null

function eventOf(raw: unknown): StoredEvent {
  const row = EventRow.parse(raw)
  return {
    id: row.id as EventId,
    issueId: row.issue_id as IssueId,
    key: row.key as Key,
    kind: row.kind,
    payload: row.payload,
    actor: row.actor,
    at: row.at,
    version: row.version,
    causation: row.causation as EventId | null,
    result: row.result,
    detail: row.detail,
    from: row.from_state,
    transition: transitionOf(row),
  }
}

/** The work domain's tables on one transaction's connection. */
export function postgresWorkStore(tx: SQL): WorkStore {
  return {
    async eventByKey(key) {
      const [row] = await tx`SELECT * FROM factory.issue_events WHERE key = ${key}`
      return row ? eventOf(row) : null
    },

    async history(id) {
      const rows: unknown[] = await tx`
        SELECT * FROM factory.issue_events WHERE issue_id = ${id} AND result = 'applied' ORDER BY version`
      if (rows.length === 0) return null
      return rows.map((raw): AppliedRecord => {
        const event = eventOf(raw)
        if (!event.transition || event.version === null)
          throw new Error(`event ${event.id} is applied without a transition`)
        return {
          kind: event.kind,
          payload: event.payload,
          at: event.at,
          version: event.version,
          transition: event.transition,
        }
      })
    },

    async insertIssue(issue) {
      await tx`
        INSERT INTO factory.issues (id, repo, state, wait_reason, outcome, version)
        VALUES (${issue.id}, ${issue.repo}, ${issue.state}, ${issue.wait?.reason ?? null}, ${issue.outcome}, ${issue.version})`
    },

    async updateIssue(issue, expected) {
      const rows: unknown[] = await tx`
        UPDATE factory.issues
        SET state = ${issue.state}, wait_reason = ${issue.wait?.reason ?? null}, outcome = ${issue.outcome}, version = ${issue.version}
        WHERE id = ${issue.id} AND version = ${expected}
        RETURNING id`
      return rows.length === 1
    },

    async appendEvent(event) {
      const { transition } = event
      const rows: unknown[] = await tx`
        INSERT INTO factory.issue_events
          (id, issue_id, key, kind, payload, actor, at, result, detail, version, from_state, to_state, wait, outcome, causation)
        VALUES (
          ${event.id}, ${event.issueId}, ${event.key}, ${event.kind}, ${event.payload}, ${event.actor}, ${event.at},
          ${event.result}, ${event.detail}, ${event.version}, ${event.from}, ${transition?.to ?? null},
          ${transition?.wait ?? null}, ${transition?.outcome ?? null}, ${event.causation}
        )
        ON CONFLICT (key) DO NOTHING
        RETURNING id`
      return rows.length === 1
    },

    async planEffects(event, effects: readonly Effect[]) {
      if (event.version === null) throw new Error(`event ${event.id} plans effects without being applied`)
      for (const [position, effect] of effects.entries()) {
        await tx`
          INSERT INTO factory.issue_effects (key, issue_id, event_id, kind, payload, version, position, planned_at)
          VALUES (${effect.key}, ${event.issueId}, ${event.id}, ${effect.kind}, ${effect.payload}, ${event.version}, ${position}, ${event.at})
          ON CONFLICT (key) DO NOTHING`
      }
    },

    async cancelOpenEffects(issueId, keep, at) {
      await tx`
        UPDATE factory.issue_effects SET cancelled_at = ${at}
        WHERE issue_id = ${issueId} AND done_at IS NULL AND cancelled_at IS NULL AND kind NOT IN ${tx(['', ...keep])}`
    },

    async claimEffects({ now, until, limit }) {
      const rows: unknown[] = await tx`
        WITH head AS (
          SELECT DISTINCT ON (issue_id) key FROM factory.issue_effects
          WHERE done_at IS NULL AND cancelled_at IS NULL
          ORDER BY issue_id, version, position
        ),
        due AS (
          SELECT e.key FROM factory.issue_effects e JOIN head USING (key)
          WHERE (e.not_before IS NULL OR e.not_before <= ${now}) AND (e.claimed_until IS NULL OR e.claimed_until <= ${now})
          ORDER BY e.planned_at, e.key
          LIMIT ${limit}
          FOR UPDATE OF e SKIP LOCKED
        )
        UPDATE factory.issue_effects e SET claimed_until = ${until}
        FROM due WHERE e.key = due.key
        RETURNING e.key, e.issue_id, e.kind, e.payload, e.planned_at,
          (SELECT count(*)::int FROM factory.issue_effect_runs r WHERE r.effect_key = e.key AND NOT r.ok) AS failures`
      return rows
        .map((raw) => EffectRow.parse(raw))
        .sort((a, b) => a.planned_at.getTime() - b.planned_at.getTime() || a.key.localeCompare(b.key))
        .map(
          (row) =>
            ({
              kind: row.kind,
              key: row.key as Key,
              payload: row.payload,
              issueId: row.issue_id as IssueId,
              failures: row.failures,
            }) as ClaimedEffect,
        )
    },

    async recordRun(key, run: EffectRun) {
      if (run.ok) {
        await tx`INSERT INTO factory.issue_effect_runs (effect_key, at, ok) VALUES (${key}, ${run.at}, true)`
        await tx`UPDATE factory.issue_effects SET done_at = ${run.at}, claimed_until = NULL WHERE key = ${key}`
        return
      }
      await tx`
        INSERT INTO factory.issue_effect_runs (effect_key, at, ok, error_kind, detail)
        VALUES (${key}, ${run.at}, false, ${run.error.kind}, ${run.error.detail})`
      await tx`UPDATE factory.issue_effects SET not_before = ${run.retryAt}, claimed_until = NULL WHERE key = ${key}`
    },
  }
}
