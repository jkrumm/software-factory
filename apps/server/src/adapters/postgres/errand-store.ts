import type { ErrandStore } from '../../domains/errands/ports.ts'
import type { SQL } from 'bun'
import * as z from 'zod'
import { RUN_STATUSES } from '../../kernel/run.ts'
import type { ErrandId } from '../../domains/errands/errand.ts'
import { NEEDS } from '../../domains/errands/need.ts'
import { HOSTS } from '../../domains/errands/request.ts'
import type { IssueId } from '../../kernel/ids.ts'
import type { Key } from '../../kernel/keys.ts'
import type { ErrandRecord } from '../../domains/errands/ports.ts'

const ErrandRow = z.object({
  id: z.string(),
  key: z.string(),
  issue_id: z.string().nullable(),
  attempt: z.number().int().nullable(),
  summary: z.string(),
  detail: z.string().nullable(),
  raised_at: z.date(),
  done_at: z.date().nullable(),
  done_note: z.string().nullable(),
  reached_owner_at: z.date().nullable(),
  screen_tries: z.number().int(),
  screen_retry_at: z.date().nullable(),
  screen_by: z.enum(['rule', 'judge', 'failed']).nullable(),
  screen_note: z.string().nullable(),
  turned_away_at: z.date().nullable(),
  source: z.string().nullable(),
  command: z.string().nullable(),
  check_command: z.string().nullable(),
  host: z.enum(HOSTS).nullable(),
  expires_at: z.date().nullable(),
  request_key: z.string().nullable(),
  closed_kind: z.enum(['done', 'not_needed', 'expired', 'superseded', 'turned_away', 'turned_back']).nullable(),
  closed_by: z.enum(['owner', 'orchestrator', 'check', 'judge', 'loop', 'request']).nullable(),
  check_at: z.date().nullable(),
  check_note: z.string().nullable(),
  check_fails: z.number().int(),
  needed_at: z.date().nullable(),
  run_attempts: z.number().int(),
  run_status: z.enum(RUN_STATUSES).nullable(),
  run_exit: z.number().int().nullable(),
  run_at: z.date().nullable(),
  run_head: z.string().nullable(),
  run_tail: z.string().nullable(),
  pushed_at: z.date().nullable(),
  need: z.enum(NEEDS).nullable(),
  approved_at: z.date().nullable(),
  match_key: z.string().nullable(),
})

const JoinRow = z.object({
  errand_id: z.string(),
  issue_id: z.string(),
  attempt: z.number().int(),
  joined_at: z.date(),
  key: z.string(),
})

const errandOf = (raw: unknown): ErrandRecord => {
  const row = ErrandRow.parse(raw)
  return {
    id: row.id as ErrandId,
    key: row.key as Key,
    issueId: row.issue_id as IssueId | null,
    attempt: row.attempt,
    summary: row.summary,
    detail: row.detail,
    raisedAt: row.raised_at,
    doneAt: row.done_at,
    doneNote: row.done_note,
    reachedOwnerAt: row.reached_owner_at,
    screenTries: row.screen_tries,
    screenRetryAt: row.screen_retry_at,
    screenBy: row.screen_by,
    screenNote: row.screen_note,
    turnedAwayAt: row.turned_away_at,
    source: row.source,
    command: row.command,
    checkCommand: row.check_command,
    host: row.host,
    expiresAt: row.expires_at,
    requestKey: row.request_key,
    closedKind: row.closed_kind,
    closedBy: row.closed_by,
    checkAt: row.check_at,
    checkNote: row.check_note,
    checkFails: row.check_fails,
    neededAt: row.needed_at,
    runAttempts: row.run_attempts,
    runStatus: row.run_status,
    runExit: row.run_exit,
    runAt: row.run_at,
    runHead: row.run_head,
    runTail: row.run_tail,
    pushedAt: row.pushed_at,
    need: row.need,
    approvedAt: row.approved_at,
    matchKey: row.match_key,
  }
}

export function postgresErrandStore(tx: SQL): ErrandStore {
  return {
    async insertErrand(e) {
      const rows: unknown[] = await tx`
        INSERT INTO factory.errands (id, key, issue_id, attempt, summary, detail, raised_at, reached_owner_at, screen_by,
          source, command, check_command, host, expires_at, request_key, need, match_key)
        VALUES (${e.id}, ${e.key}, ${e.issueId}, ${e.attempt}, ${e.summary}, ${e.detail}, ${e.raisedAt}, ${e.reachedOwnerAt},
          ${e.screenBy}, ${e.source}, ${e.command}, ${e.checkCommand}, ${e.host}, ${e.expiresAt}, ${e.requestKey}, ${e.need}, ${e.matchKey})
        ON CONFLICT (key) DO NOTHING
        RETURNING id`
      return rows.length === 1
    },

    async errand(id) {
      const [row] = await tx`SELECT * FROM factory.errands WHERE id = ${id}`
      return row ? errandOf(row) : null
    },

    async errandByKey(key) {
      const [row] = await tx`SELECT * FROM factory.errands WHERE key = ${key}`
      return row ? errandOf(row) : null
    },

    async errands(filter) {
      const rows: unknown[] = await tx`
        SELECT * FROM factory.errands
        WHERE (${filter.issueId ?? null}::text IS NULL OR issue_id = ${filter.issueId ?? null})
          AND (${filter.open ?? null}::boolean IS NULL OR (done_at IS NULL) = ${filter.open ?? null})
        ORDER BY raised_at DESC, id DESC LIMIT ${filter.limit}`
      return rows.map(errandOf)
    },

    async finishErrand(id, at, note, how = { kind: 'done', by: 'owner' }) {
      const rows: unknown[] = await tx`
        UPDATE factory.errands SET done_at = ${at}, done_note = ${note}, closed_kind = ${how.kind}, closed_by = ${how.by}
        WHERE id = ${id} AND done_at IS NULL RETURNING id`
      return rows.length === 1
    },

    async supersedeRequests(requestKey, by, at) {
      const rows: unknown[] = await tx`
        UPDATE factory.errands
        SET done_at = ${at}, done_note = ${`Superseded by a newer request (${by})`}, closed_kind = 'superseded', closed_by = 'request'
        WHERE request_key = ${requestKey} AND done_at IS NULL AND id <> ${by} RETURNING id`
      return rows.map((raw) => z.object({ id: z.string() }).parse(raw).id as ErrandId)
    },

    async requests({ closedSince, limit }) {
      const rows: unknown[] = await tx`
        SELECT * FROM factory.errands
        WHERE issue_id IS NULL AND (done_at IS NULL OR done_at >= ${closedSince})
        ORDER BY raised_at, id LIMIT ${limit}`
      return rows.map(errandOf)
    },

    async recordCheck(id, run) {
      const rows: unknown[] = await tx`
        UPDATE factory.errands SET check_at = ${run.at}, check_note = ${run.note}, check_fails = ${run.fails}
        WHERE id = ${id} AND done_at IS NULL RETURNING id`
      return rows.length === 1
    },

    async recordRun(id, run) {
      const rows: unknown[] = await tx`
        UPDATE factory.errands
        SET run_attempts = run_attempts + ${run.status === 'done' ? 0 : 1}, run_status = ${run.status}, run_exit = ${run.exit}, run_at = ${run.at},
            run_head = ${run.head}, run_tail = ${run.tail}
        WHERE id = ${id} AND done_at IS NULL RETURNING id`
      return rows.length === 1
    },

    async clearRun(id) {
      const rows: unknown[] = await tx`
        UPDATE factory.errands SET run_status = NULL, run_exit = NULL, run_at = NULL, run_head = NULL, run_tail = NULL
        WHERE id = ${id} AND done_at IS NULL RETURNING id`
      return rows.length === 1
    },

    async recordNeeded(id, run) {
      const rows: unknown[] = await tx`
        UPDATE factory.errands SET needed_at = ${run.at}, check_note = ${run.note}
        WHERE id = ${id} AND done_at IS NULL RETURNING id`
      return rows.length === 1
    },

    async recordPush(id, at) {
      const rows: unknown[] = await tx`
        UPDATE factory.errands SET pushed_at = ${at} WHERE id = ${id} AND done_at IS NULL RETURNING id`
      return rows.length === 1
    },

    async openErrands(limit) {
      const rows: unknown[] = await tx`
        SELECT * FROM factory.errands WHERE done_at IS NULL ORDER BY raised_at, id LIMIT ${limit}`
      return rows.map(errandOf)
    },

    async unscreenedErrands(now, limit) {
      const rows: unknown[] = await tx`
        SELECT * FROM factory.errands
        WHERE reached_owner_at IS NULL AND done_at IS NULL AND (screen_retry_at IS NULL OR screen_retry_at <= ${now})
        ORDER BY raised_at, id LIMIT ${limit}`
      return rows.map(errandOf)
    },

    async lockErrand(id) {
      const [row] = await tx`SELECT * FROM factory.errands WHERE id = ${id} FOR UPDATE`
      return row ? errandOf(row) : null
    },

    async failErrandScreen(id, failed) {
      const rows: unknown[] = await tx`
        UPDATE factory.errands
        SET screen_tries = ${failed.tries}, screen_retry_at = ${failed.retryAt}, screen_note = ${failed.note}
        WHERE id = ${id} AND done_at IS NULL RETURNING id`
      return rows.length === 1
    },

    async reachOwner(id, reached) {
      const rows: unknown[] = await tx`
        UPDATE factory.errands
        SET reached_owner_at = ${reached.at}, screen_by = ${reached.by}, screen_note = ${reached.note},
            screen_tries = ${reached.tries}, screen_retry_at = NULL, need = ${reached.need}
        WHERE id = ${id} AND done_at IS NULL AND reached_owner_at IS NULL RETURNING id`
      return rows.length === 1
    },

    async needlessErrands(limit) {
      const rows: unknown[] = await tx`
        SELECT * FROM factory.errands
        WHERE done_at IS NULL AND reached_owner_at IS NOT NULL AND need IS NULL ORDER BY raised_at, id LIMIT ${limit}`
      return rows.map(errandOf)
    },

    async setNeed(id, need) {
      const rows: unknown[] = await tx`
        UPDATE factory.errands SET need = ${need} WHERE id = ${id} AND done_at IS NULL AND need IS NULL RETURNING id`
      return rows.length === 1
    },

    async openMatching({ command, check, matchKey }) {
      if (command === null && check === null && matchKey === null) return null
      const [row] = await tx`
        SELECT * FROM factory.errands
        WHERE done_at IS NULL AND turned_away_at IS NULL
          AND (issue_id IS NULL OR EXISTS (SELECT 1 FROM factory.issues i WHERE i.id = errands.issue_id AND i.state <> 'closed'))
          AND ((${command}::text IS NOT NULL AND command = ${command}) OR (${check}::text IS NOT NULL AND check_command = ${check})
            OR (${matchKey}::text IS NOT NULL AND match_key = ${matchKey}))
        ORDER BY raised_at, id LIMIT 1`
      return row ? errandOf(row) : null
    },

    async declinedMatch(matchKey, since) {
      const [row] = await tx`
        SELECT done_at, done_note FROM factory.errands
        WHERE match_key = ${matchKey} AND closed_kind = 'turned_back' AND closed_by IN ('owner', 'orchestrator')
          AND done_at >= ${since}
        ORDER BY done_at DESC LIMIT 1`
      if (!row) return null
      const read = z.object({ done_at: z.coerce.date(), done_note: z.string().nullable() }).parse(row)
      return { at: read.done_at, note: read.done_note ?? '' }
    },

    async joinedErrand(key) {
      const [row] = await tx`
        SELECT e.* FROM factory.errands e JOIN factory.errand_joins j ON j.errand_id = e.id WHERE j.key = ${key}`
      return row ? errandOf(row) : null
    },

    async joinErrand(join) {
      const rows: unknown[] = await tx`
        INSERT INTO factory.errand_joins (errand_id, issue_id, attempt, joined_at, key)
        VALUES (${join.errandId}, ${join.issueId}, ${join.attempt}, ${join.joinedAt}, ${join.key})
        ON CONFLICT DO NOTHING RETURNING errand_id`
      return rows.length === 1
    },

    async joinsOf(id) {
      const rows: unknown[] = await tx`
        SELECT errand_id, issue_id, attempt, joined_at, key FROM factory.errand_joins WHERE errand_id = ${id}
        ORDER BY joined_at, issue_id`
      return rows.map((raw) => {
        const row = JoinRow.parse(raw)
        return {
          errandId: row.errand_id as ErrandId,
          issueId: row.issue_id as IssueId,
          attempt: row.attempt,
          joinedAt: row.joined_at,
          key: row.key as Key,
        }
      })
    },

    async startApprovedRun(id, at, staleBefore) {
      const rows: unknown[] = await tx`
        UPDATE factory.errands
        SET approved_at = ${at}, run_status = 'running', run_at = ${at}, run_head = NULL, run_tail = NULL, run_exit = NULL
        WHERE id = ${id} AND done_at IS NULL AND (run_status IS DISTINCT FROM 'running' OR run_at < ${staleBefore})
        RETURNING id`
      return rows.length === 1
    },

    async turnAwayErrand(id, away) {
      const rows: unknown[] = await tx`
        UPDATE factory.errands
        SET done_at = ${away.at}, turned_away_at = ${away.at}, done_note = ${away.reason}, closed_kind = 'turned_away',
            screen_note = ${away.reason}, screen_by = ${away.by}, screen_retry_at = NULL
        WHERE id = ${id} AND done_at IS NULL RETURNING id`
      return rows.length === 1
    },

    async insertErrandRefusal(refusal) {
      await tx`
        INSERT INTO factory.errand_refusals (at, rule, source) VALUES (${refusal.at}, ${refusal.rule}, ${refusal.source})`
    },
  }
}
