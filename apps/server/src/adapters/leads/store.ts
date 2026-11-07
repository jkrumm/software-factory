import { EVENT_KINDS } from '@software-factory/contract/spool'
import type { SQL } from 'bun'
import * as z from 'zod'
import {
  FINALIZE_STEPS,
  type Delivery,
  type Finalization,
  type FinalizeStep,
  type LeadAttempt,
  type LeadStore,
} from '../../domains/leads/ports.ts'
import type { HookFact } from '../../domains/leads/session.ts'
import { type IssueId } from '../../kernel/ids.ts'

const AttemptRow = z.object({
  issue_id: z.string(),
  attempt: z.number().int(),
  branch: z.string(),
  account: z.string().nullable(),
  repo_path: z.string().nullable(),
  worktree_path: z.string().nullable(),
  base_sha: z.string().nullable(),
  terminal: z.string().nullable(),
  tab: z.string().nullable(),
  space: z.string().nullable(),
  first_try_at: z.date(),
  tries: z.number().int(),
  started_at: z.date().nullable(),
  gone_at: z.date().nullable(),
})

const attemptOf = (raw: unknown): LeadAttempt => {
  const row = AttemptRow.parse(raw)
  return {
    issueId: row.issue_id as IssueId,
    attempt: row.attempt,
    branch: row.branch,
    account: row.account,
    repoPath: row.repo_path,
    worktreePath: row.worktree_path,
    baseSha: row.base_sha,
    terminal: row.terminal,
    tab: row.tab,
    space: row.space,
    firstTryAt: row.first_try_at,
    tries: row.tries,
    startedAt: row.started_at,
    goneAt: row.gone_at,
  }
}

const HookRow = z.object({
  key: z.string(),
  kind: z.enum(EVENT_KINDS),
  at: z.date(),
  seq: z.coerce.number(),
  payload: z.record(z.string(), z.unknown()),
})

const DeliveryRow = z.object({
  key: z.string(),
  issue_id: z.string(),
  attempt: z.number().int(),
  kind: z.enum(['brief', 'note']),
  text: z.string(),
  claimed_at: z.date(),
  typed_at: z.date().nullable(),
  forced: z.boolean(),
})

const FinalizationRow = z.object({
  issue_id: z.string(),
  attempt: z.number().int(),
  claim_at: z.date().nullable(),
  terminals_at: z.date().nullable(),
  transcripts_at: z.date().nullable(),
  worktree_at: z.date().nullable(),
  archived: z.number().int(),
  worktree_kept: z.string().nullable(),
  worktree_path: z.string().nullable(),
  done_at: z.date().nullable(),
})

const SignalRow = z.object({
  source: z.string(),
  title: z.string(),
  text: z.string(),
  facts: z.unknown(),
  received_at: z.date(),
})

const COLUMN = {
  claim: 'claim_at',
  terminals: 'terminals_at',
  transcripts: 'transcripts_at',
  worktree: 'worktree_at',
} as const satisfies Record<FinalizeStep, string>

/** The leads domain's tables on one transaction's connection. */
export function postgresLeadStore(tx: SQL): LeadStore {
  return {
    async signalsOf(issue, limit) {
      const rows: unknown[] = await tx`
        SELECT source, title, text, alert -> 'facts' AS facts, received_at
        FROM factory.intake_signals WHERE issue_id = ${issue} ORDER BY received_at, id LIMIT ${limit}`
      return rows.map((raw) => {
        const row = SignalRow.parse(raw)
        return { source: row.source, title: row.title, text: row.text, facts: row.facts ?? null, at: row.received_at }
      })
    },

    async attempt(issue, attempt) {
      const [row] = await tx`SELECT * FROM factory.lead_attempts WHERE issue_id = ${issue} AND attempt = ${attempt}`
      return row ? attemptOf(row) : null
    },

    async tried(issue, attempt, branch, at) {
      const [row] = await tx`
        INSERT INTO factory.lead_attempts (issue_id, attempt, branch, first_try_at)
        VALUES (${issue}, ${attempt}, ${branch}, ${at})
        ON CONFLICT (issue_id, attempt) DO UPDATE SET tries = factory.lead_attempts.tries + 1
        RETURNING *`
      return attemptOf(row)
    },

    async saveWorktree(issue, attempt, input) {
      await tx`
        UPDATE factory.lead_attempts
        SET account = ${input.account}, repo_path = ${input.repoPath}, worktree_path = ${input.worktreePath}, base_sha = ${input.baseSha}
        WHERE issue_id = ${issue} AND attempt = ${attempt}`
    },

    async saveStarted(issue, attempt, input) {
      await tx`
        UPDATE factory.lead_attempts
        SET terminal = ${input.terminal}, tab = ${input.tab}, space = ${input.space}, started_at = ${input.at}
        WHERE issue_id = ${issue} AND attempt = ${attempt}`
    },

    async markGone(issue, attempt, at) {
      await tx`
        UPDATE factory.lead_attempts SET gone_at = ${at}
        WHERE issue_id = ${issue} AND attempt = ${attempt} AND gone_at IS NULL`
    },

    async followed() {
      const rows: unknown[] = await tx`
        SELECT * FROM factory.lead_attempts WHERE started_at IS NOT NULL AND gone_at IS NULL ORDER BY issue_id, attempt`
      return rows.map(attemptOf)
    },

    async appendHook({ issue, attempt, session, fact, receivedAt }) {
      const rows: unknown[] = await tx`
        INSERT INTO factory.lead_hook_events (key, session, issue_id, attempt, kind, at, received_at, payload)
        VALUES (${fact.key}, ${session}, ${issue}, ${attempt}, ${fact.kind}, ${fact.at}, ${receivedAt}, ${fact.payload})
        ON CONFLICT (key) DO NOTHING
        RETURNING seq`
      return rows.length === 1
    },

    async hookFacts(session) {
      const rows: unknown[] = await tx`
        SELECT key, kind, at, seq, payload FROM factory.lead_hook_events WHERE session = ${session} ORDER BY at, seq`
      return rows.map((raw): HookFact => HookRow.parse(raw))
    },

    async delivery(key) {
      const [row] = await tx`SELECT * FROM factory.lead_deliveries WHERE key = ${key}`
      if (!row) return null
      const parsed = DeliveryRow.parse(row)
      return {
        key: parsed.key,
        issueId: parsed.issue_id as IssueId,
        attempt: parsed.attempt,
        kind: parsed.kind,
        text: parsed.text,
        claimedAt: parsed.claimed_at,
        typedAt: parsed.typed_at,
        forced: parsed.forced,
      } satisfies Delivery
    },

    async claimDelivery(delivery) {
      const rows: unknown[] = await tx`
        INSERT INTO factory.lead_deliveries (key, issue_id, attempt, kind, text, claimed_at)
        VALUES (${delivery.key}, ${delivery.issueId}, ${delivery.attempt}, ${delivery.kind}, ${delivery.text}, ${delivery.claimedAt})
        ON CONFLICT (key) DO NOTHING
        RETURNING key`
      return rows.length === 1
    },

    async markTyped(key, at, forced) {
      await tx`UPDATE factory.lead_deliveries SET typed_at = ${at}, forced = ${forced} WHERE key = ${key}`
    },

    async typedAt(issue, attempt) {
      const rows: { typed_at: Date }[] = await tx`
        SELECT typed_at FROM factory.lead_deliveries
        WHERE issue_id = ${issue} AND attempt = ${attempt} AND typed_at IS NOT NULL ORDER BY typed_at`
      return rows.map((row) => row.typed_at)
    },

    async recordSendBack({ key, issue, attempt, turn, at }) {
      const rows: unknown[] = await tx`
        INSERT INTO factory.lead_sendbacks (key, issue_id, attempt, turn, at)
        VALUES (${key}, ${issue}, ${attempt}, ${turn}, ${at})
        ON CONFLICT (key) DO NOTHING
        RETURNING key`
      return rows.length === 1
    },

    async sentBack(key) {
      const rows: unknown[] = await tx`SELECT 1 FROM factory.lead_sendbacks WHERE key = ${key}`
      return rows.length === 1
    },

    async finalization(issue, attempt) {
      const [row] =
        await tx`SELECT * FROM factory.lead_finalizations WHERE issue_id = ${issue} AND attempt = ${attempt}`
      if (!row) return null
      const parsed = FinalizationRow.parse(row)
      const steps: Finalization['steps'] = {}
      for (const step of FINALIZE_STEPS) {
        const at = parsed[COLUMN[step]]
        if (at) steps[step] = at
      }
      return {
        issueId: parsed.issue_id as IssueId,
        attempt: parsed.attempt,
        steps,
        archived: parsed.archived,
        worktreeKept: parsed.worktree_kept,
        worktreePath: parsed.worktree_path,
        doneAt: parsed.done_at,
      }
    },

    async markStep(issue, attempt, step, at, detail) {
      await tx`
        INSERT INTO factory.lead_finalizations (issue_id, attempt) VALUES (${issue}, ${attempt})
        ON CONFLICT (issue_id, attempt) DO NOTHING`
      switch (step) {
        case 'claim':
          await tx`UPDATE factory.lead_finalizations SET claim_at = ${at} WHERE issue_id = ${issue} AND attempt = ${attempt}`
          break
        case 'terminals':
          await tx`UPDATE factory.lead_finalizations SET terminals_at = ${at} WHERE issue_id = ${issue} AND attempt = ${attempt}`
          break
        case 'transcripts':
          await tx`
            UPDATE factory.lead_finalizations SET transcripts_at = ${at}, archived = ${detail?.archived ?? 0}
            WHERE issue_id = ${issue} AND attempt = ${attempt}`
          break
        case 'worktree':
          await tx`
            UPDATE factory.lead_finalizations
            SET worktree_at = ${at}, worktree_kept = ${detail?.kept ?? null}, worktree_path = ${detail?.path ?? null}
            WHERE issue_id = ${issue} AND attempt = ${attempt}`
          break
      }
    },

    async markFinalized(issue, attempt, at) {
      await tx`
        INSERT INTO factory.lead_finalizations (issue_id, attempt, done_at) VALUES (${issue}, ${attempt}, ${at})
        ON CONFLICT (issue_id, attempt) DO UPDATE SET done_at = ${at}`
    },
  }
}
