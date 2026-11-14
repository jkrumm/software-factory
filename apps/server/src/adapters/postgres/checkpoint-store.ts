import type { SQL } from 'bun'
import * as z from 'zod'
import { ARTIFACT_KINDS, DISPOSITIONS, FORMATS, type ArtifactId, VERDICTS } from '../../domains/checkpoints/artifact.ts'
import {
  type DecisionId,
  JUDGE_BACKOFF_MS,
  JUDGE_MAX_TRIES,
  SETTLERS,
  STEPS,
} from '../../domains/checkpoints/decision.ts'
import type { ErrandId } from '../../domains/checkpoints/errand.ts'
import { NEEDS } from '../../domains/checkpoints/need.ts'
import { RUN_STATUSES } from '../../kernel/run.ts'
import type { Page } from '../../domains/checkpoints/page.ts'
import { HOSTS } from '../../domains/checkpoints/request.ts'
import {
  type AnnotationRecord,
  type ArtifactRecord,
  type CheckpointStore,
  type DecisionRecord,
  type ErrandRecord,
  type PageRecord,
  type RevisionRecord,
  type SpecScreenRecord,
  STEP_OUTCOMES,
  type Step,
  type VerdictRecord,
} from '../../domains/checkpoints/ports.ts'
import { SPEC_SOURCES } from '@software-factory/contract'
import { readSpecPrecedents } from '../../read/spec-screen.ts'
import type { RecheckCandidate } from '../../domains/checkpoints/recheck.ts'
import { type IssueId } from '../../kernel/ids.ts'
import type { Key } from '../../kernel/keys.ts'

const Option = z.object({ label: z.string(), reversible: z.boolean(), cost: z.string() })
const NoAnswer = z.object({
  consequence: z.string(),
  default: z.string().nullable(),
  waitMinutes: z.number().int().nullable(),
})

const DecisionRow = z.object({
  id: z.string(),
  key: z.string(),
  issue_id: z.string(),
  repo: z.string(),
  attempt: z.number().int(),
  question: z.string(),
  recommendation: z.string(),
  checked: z.string(),
  options: z.array(Option),
  no_answer: NoAnswer,
  asked_at: z.date(),
  asked_by: z.enum(['lead', 'steward']),
  artifact_id: z.string().nullable(),
  answer: z.string().nullable(),
  settled_by: z.enum(SETTLERS).nullable(),
  source: z.string().nullable(),
  answered_at: z.date().nullable(),
  withdrawn_at: z.date().nullable(),
  withdrawn_reason: z.string().nullable(),
  worth_asking: z.boolean().nullable(),
})

const StepRow = z.object({
  decision_id: z.string(),
  step: z.enum(STEPS),
  outcome: z.enum(STEP_OUTCOMES).nullable(),
  detail: z.string().nullable(),
  at: z.date().nullable(),
  tries: z.number().int(),
})

const PrecedentRow = z.object({
  question: z.string(),
  answer: z.string(),
  settled_by: z.enum(SETTLERS),
  worth_asking: z.boolean().nullable(),
  repo: z.string(),
})

const ArtifactRow = z.object({
  id: z.string(),
  key: z.string(),
  issue_id: z.string(),
  kind: z.enum(ARTIFACT_KINDS),
  title: z.string(),
  format: z.enum(FORMATS),
  author: z.enum(['lead', 'factory']),
  created_at: z.date(),
})

const RevisionRow = z.object({
  artifact_id: z.string(),
  n: z.number().int(),
  blob: z.string(),
  sha256: z.string(),
  bytes: z.number().int(),
  note: z.string().nullable(),
  created_at: z.date(),
})

const AnnotationRow = z.object({
  id: z.string(),
  key: z.string(),
  artifact_id: z.string(),
  revision: z.number().int(),
  quote: z.string(),
  path: z.string().nullable(),
  comment: z.string(),
  author: z.enum(['owner', 'lead']),
  at: z.date(),
  edited_at: z.date().nullable(),
  disposition: z.enum(DISPOSITIONS).nullable(),
  disposition_note: z.string().nullable(),
  disposed_at: z.date().nullable(),
})

const VerdictRow = z.object({
  artifact_id: z.string(),
  revision: z.number().int(),
  verdict: z.enum(VERDICTS),
  note: z.string().nullable(),
  at: z.date(),
  needed_me: z.boolean().nullable().optional(),
})

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
})

const JoinRow = z.object({
  errand_id: z.string(),
  issue_id: z.string(),
  attempt: z.number().int(),
  joined_at: z.date(),
  key: z.string(),
})

const PageRow = z.object({
  key: z.string(),
  kind: z.enum(['decision', 'review', 'errand']),
  checkpoint: z.string(),
  issue_id: z.string(),
  title: z.string(),
  body: z.string(),
  link: z.string(),
  planned_at: z.date(),
  attempts: z.number().int(),
  sent_at: z.date().nullable(),
  cancelled_at: z.date().nullable(),
  error: z.string().nullable(),
})

const decisionOf = (raw: unknown, steps: Step[]): DecisionRecord => {
  const row = DecisionRow.parse(raw)
  return {
    id: row.id as DecisionId,
    key: row.key as Key,
    issueId: row.issue_id as IssueId,
    repo: row.repo,
    attempt: row.attempt,
    form: {
      question: row.question,
      recommendation: row.recommendation,
      checked: row.checked,
      options: row.options,
      noAnswer: row.no_answer,
    },
    askedAt: row.asked_at,
    askedBy: row.asked_by,
    artifactId: row.artifact_id as ArtifactId | null,
    answer: row.answer,
    settledBy: row.settled_by,
    source: row.source,
    answeredAt: row.answered_at,
    withdrawnAt: row.withdrawn_at,
    withdrawnReason: row.withdrawn_reason,
    worthAsking: row.worth_asking,
    steps,
  }
}

const artifactOf = (raw: unknown): ArtifactRecord => {
  const row = ArtifactRow.parse(raw)
  return {
    id: row.id as ArtifactId,
    key: row.key as Key,
    issueId: row.issue_id as IssueId,
    kind: row.kind,
    title: row.title,
    format: row.format,
    author: row.author,
    createdAt: row.created_at,
  }
}

const revisionOf = (raw: unknown): RevisionRecord => {
  const row = RevisionRow.parse(raw)
  return {
    artifactId: row.artifact_id as ArtifactId,
    n: row.n,
    blob: row.blob,
    sha256: row.sha256,
    bytes: row.bytes,
    note: row.note,
    createdAt: row.created_at,
  }
}

const annotationOf = (raw: unknown): AnnotationRecord => {
  const row = AnnotationRow.parse(raw)
  return {
    id: row.id,
    key: row.key as Key,
    artifactId: row.artifact_id as ArtifactId,
    revision: row.revision,
    quote: row.quote,
    path: row.path,
    comment: row.comment,
    author: row.author,
    at: row.at,
    editedAt: row.edited_at,
    disposition: row.disposition,
    dispositionNote: row.disposition_note,
    disposedAt: row.disposed_at,
  }
}

const verdictOf = (raw: unknown): VerdictRecord => {
  const row = VerdictRow.parse(raw)
  return {
    artifactId: row.artifact_id as ArtifactId,
    revision: row.revision,
    verdict: row.verdict,
    note: row.note,
    at: row.at,
    neededMe: row.needed_me ?? null,
  }
}

const SpecScreenRow = z.object({
  artifact_id: z.string(),
  revision: z.number().int(),
  outcome: z.enum(['passed', 'settled']).nullable(),
  by: z.enum(['rule', 'judge', 'failed']).nullable(),
  source: z.enum(SPEC_SOURCES),
  note: z.string().nullable(),
  tries: z.number().int(),
  retry_at: z.date().nullable(),
  at: z.date(),
})

const specScreenOf = (raw: unknown): SpecScreenRecord => {
  const row = SpecScreenRow.parse(raw)
  return {
    artifactId: row.artifact_id as ArtifactId,
    revision: row.revision,
    outcome: row.outcome,
    by: row.by,
    source: row.source,
    note: row.note,
    tries: row.tries,
    retryAt: row.retry_at,
    at: row.at,
  }
}

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
  }
}

const StaleReviewRow = z.object({
  id: z.string(),
  issue_id: z.string(),
  kind: z.enum(['concept', 'spec']),
  title: z.string(),
  n: z.number().int(),
  created_at: z.date(),
  filed: z.boolean(),
})

const RecheckRow = z.object({
  kind: z.enum(['decision', 'errand']),
  id: z.string(),
  issue_id: z.string(),
  reached_at: z.date(),
  last_at: z.date().nullable(),
  through_version: z.number().int().nullable(),
})

const pageStatus = (row: z.infer<typeof PageRow>): PageRecord['status'] =>
  row.sent_at ? 'sent' : row.cancelled_at ? 'cancelled' : row.error !== null ? 'failing' : 'pending'

/** The checkpoints domain's tables on one transaction's connection. */
export function postgresCheckpointStore(tx: SQL): CheckpointStore {
  /** The steps of these Decisions, grouped, in the order they were tried. */
  async function stepsOf(ids: readonly string[]): Promise<Map<string, Step[]>> {
    const grouped = new Map<string, Step[]>()
    if (ids.length === 0) return grouped
    const rows: unknown[] = await tx`
      SELECT decision_id, step, outcome, detail, at, tries FROM factory.decision_steps
      WHERE decision_id IN ${tx(ids)} ORDER BY array_position(ARRAY['policy', 'judge', 'default', 'owner'], step)`
    for (const raw of rows) {
      const row = StepRow.parse(raw)
      const list = grouped.get(row.decision_id) ?? []
      list.push({ step: row.step, outcome: row.outcome, at: row.at, detail: row.detail, tries: row.tries })
      grouped.set(row.decision_id, list)
    }
    return grouped
  }

  async function decisionsOf(rows: unknown[]): Promise<DecisionRecord[]> {
    const steps = await stepsOf(rows.map((raw) => DecisionRow.shape.id.parse((raw as { id: unknown }).id)))
    return rows.map((raw) => decisionOf(raw, steps.get(DecisionRow.shape.id.parse((raw as { id: unknown }).id)) ?? []))
  }

  return {
    async insertDecision(d) {
      const rows: unknown[] = await tx`
        INSERT INTO factory.decisions
          (id, key, issue_id, repo, attempt, question, recommendation, checked, options, no_answer, asked_at, asked_by, artifact_id)
        VALUES (${d.id}, ${d.key}, ${d.issueId}, ${d.repo}, ${d.attempt}, ${d.form.question}, ${d.form.recommendation},
                ${d.form.checked}, ${d.form.options}, ${d.form.noAnswer}, ${d.askedAt}, ${d.askedBy}, ${d.artifactId})
        ON CONFLICT (key) DO NOTHING
        RETURNING id`
      return rows.length === 1
    },

    async amendDecision(id, form) {
      const rows: unknown[] = await tx`
        UPDATE factory.decisions
        SET question = ${form.question}, recommendation = ${form.recommendation}, checked = ${form.checked},
            options = ${form.options}, no_answer = ${form.noAnswer}
        WHERE id = ${id} AND answered_at IS NULL AND withdrawn_at IS NULL
        RETURNING id`
      if (rows.length !== 1) return false
      await tx`DELETE FROM factory.decision_steps WHERE decision_id = ${id}`
      await tx`UPDATE factory.artifacts SET title = ${form.question.slice(0, 200)} WHERE id = ${id}`
      return true
    },

    async decision(id) {
      const rows: unknown[] = await tx`SELECT * FROM factory.decisions WHERE id = ${id}`
      return (await decisionsOf(rows))[0] ?? null
    },

    async lockDecision(id) {
      const rows: unknown[] = await tx`SELECT * FROM factory.decisions WHERE id = ${id} FOR UPDATE`
      return (await decisionsOf(rows))[0] ?? null
    },

    async decisionByKey(key) {
      const rows: unknown[] = await tx`SELECT * FROM factory.decisions WHERE key = ${key}`
      return (await decisionsOf(rows))[0] ?? null
    },

    async answerDecision(id, answer) {
      const rows: unknown[] = await tx`
        UPDATE factory.decisions
        SET answer = ${answer.text}, settled_by = ${answer.by}, source = ${answer.source}, answered_at = ${answer.at}
        WHERE id = ${id} AND answered_at IS NULL AND withdrawn_at IS NULL
        RETURNING id`
      return rows.length === 1
    },

    async withdrawDecision(id, reason, at) {
      const rows: unknown[] = await tx`
        UPDATE factory.decisions SET withdrawn_at = ${at}, withdrawn_reason = ${reason}
        WHERE id = ${id} AND answered_at IS NULL AND withdrawn_at IS NULL
        RETURNING id`
      return rows.length === 1
    },

    async setWorthAsking(id, worth) {
      const [row]: { answered_at: Date | null; worth_asking: boolean | null }[] = await tx`
        SELECT answered_at, worth_asking FROM factory.decisions WHERE id = ${id} FOR UPDATE`
      if (!row) return 'unknown'
      if (!row.answered_at) return 'unanswered'
      if (row.worth_asking === worth) return 'unchanged'
      await tx`UPDATE factory.decisions SET worth_asking = ${worth} WHERE id = ${id}`
      return 'set'
    },

    async decisions(filter) {
      const rows: unknown[] = await tx`
        SELECT * FROM factory.decisions
        WHERE (${filter.issueId ?? null}::text IS NULL OR issue_id = ${filter.issueId ?? null})
          AND (${filter.status ?? null}::text IS NULL
               OR (${filter.status ?? null} = 'answered' AND answered_at IS NOT NULL)
               OR (${filter.status ?? null} = 'withdrawn' AND withdrawn_at IS NOT NULL)
               OR (${filter.status ?? null} = 'open' AND answered_at IS NULL AND withdrawn_at IS NULL))
          AND (${filter.worthAsking ?? null}::boolean IS NULL OR worth_asking = ${filter.worthAsking ?? null})
        ORDER BY asked_at DESC, id DESC LIMIT ${filter.limit}`
      return decisionsOf(rows)
    },

    async openDecisions(limit) {
      const rows: unknown[] = await tx`
        SELECT * FROM factory.decisions WHERE answered_at IS NULL AND withdrawn_at IS NULL
        ORDER BY asked_at, id LIMIT ${limit}`
      return decisionsOf(rows)
    },

    async precedents(terms, { excluding, limit }) {
      const rows: unknown[] = await tx`
        SELECT question, answer, settled_by, worth_asking, repo FROM factory.decisions
        WHERE answered_at IS NOT NULL AND id <> ${excluding}
          AND to_tsvector('english', question) @@ to_tsquery('english', ${terms})
        ORDER BY (settled_by = 'owner') DESC,
                 ts_rank(to_tsvector('english', question), to_tsquery('english', ${terms})) DESC,
                 answered_at DESC
        LIMIT ${limit}`
      return rows.map((raw) => {
        const row = PrecedentRow.parse(raw)
        return {
          question: row.question,
          answer: row.answer,
          settledBy: row.settled_by,
          worthAsking: row.worth_asking,
          repo: row.repo,
        }
      })
    },

    async claimStep(id, step, now, until) {
      // A failed Judge call is claimed again once its backoff ran out and tries are left; every other step is claimed once.
      const retryBefore = new Date(now.getTime() - JUDGE_BACKOFF_MS)
      const rows: unknown[] = await tx`
        INSERT INTO factory.decision_steps (decision_id, step, claimed_until) VALUES (${id}, ${step}, ${until})
        ON CONFLICT (decision_id, step) DO UPDATE SET
          claimed_until = ${until},
          tries = CASE WHEN factory.decision_steps.outcome = 'failed' THEN factory.decision_steps.tries + 1 ELSE factory.decision_steps.tries END,
          detail = CASE WHEN factory.decision_steps.outcome = 'failed' THEN NULL ELSE factory.decision_steps.detail END,
          outcome = NULL,
          at = NULL
        WHERE (factory.decision_steps.outcome IS NULL
               AND (factory.decision_steps.claimed_until IS NULL OR factory.decision_steps.claimed_until <= ${now}))
          OR (factory.decision_steps.step = 'judge' AND factory.decision_steps.outcome = 'failed'
              AND factory.decision_steps.tries < ${JUDGE_MAX_TRIES} AND factory.decision_steps.at <= ${retryBefore})
        RETURNING decision_id`
      if (rows.length === 1) return 'claimed'
      const [held]: { outcome: string | null; tries: number }[] = await tx`
        SELECT outcome, tries FROM factory.decision_steps WHERE decision_id = ${id} AND step = ${step}`
      if (held?.outcome === null) return 'in_flight'
      return step === 'judge' && held?.outcome === 'failed' && held.tries < JUDGE_MAX_TRIES ? 'retry_later' : 'done'
    },

    async finishStep(id, step, done) {
      await tx`
        UPDATE factory.decision_steps
        SET outcome = ${done.outcome}, detail = ${done.detail}, at = ${done.at}, claimed_until = NULL
        WHERE decision_id = ${id} AND step = ${step} AND outcome IS NULL`
    },

    async recordStep(id, step, done) {
      const rows: unknown[] = await tx`
        INSERT INTO factory.decision_steps (decision_id, step, outcome, detail, at)
        VALUES (${id}, ${step}, ${done.outcome}, ${done.detail}, ${done.at})
        ON CONFLICT (decision_id, step) DO NOTHING
        RETURNING decision_id`
      return rows.length === 1
    },

    async insertArtifact(a) {
      const rows: unknown[] = await tx`
        INSERT INTO factory.artifacts (id, key, issue_id, kind, title, format, author, created_at)
        VALUES (${a.id}, ${a.key}, ${a.issueId}, ${a.kind}, ${a.title}, ${a.format}, ${a.author}, ${a.createdAt})
        ON CONFLICT DO NOTHING
        RETURNING id`
      return rows.length === 1
    },

    async artifact(id) {
      const [row] = await tx`SELECT * FROM factory.artifacts WHERE id = ${id}`
      return row ? artifactOf(row) : null
    },

    async artifactByKey(key) {
      const [row] = await tx`SELECT * FROM factory.artifacts WHERE key = ${key}`
      return row ? artifactOf(row) : null
    },

    async artifacts(filter) {
      const rows: unknown[] = await tx`
        SELECT * FROM factory.artifacts
        WHERE (${filter.issueId ?? null}::text IS NULL OR issue_id = ${filter.issueId ?? null})
          AND (${filter.kind ?? null}::text IS NULL OR kind = ${filter.kind ?? null})
        ORDER BY created_at DESC, id DESC LIMIT ${filter.limit}`
      return rows.map(artifactOf)
    },

    async insertRevision(r) {
      const rows: unknown[] = await tx`
        INSERT INTO factory.artifact_revisions (artifact_id, n, key, blob, sha256, bytes, note, created_at)
        VALUES (${r.artifactId}, ${r.n}, ${r.key}, ${r.blob}, ${r.sha256}, ${r.bytes}, ${r.note}, ${r.createdAt})
        ON CONFLICT DO NOTHING
        RETURNING n`
      return rows.length === 1
    },

    async revisions(id) {
      const rows: unknown[] = await tx`SELECT * FROM factory.artifact_revisions WHERE artifact_id = ${id} ORDER BY n`
      return rows.map(revisionOf)
    },

    async insertAnnotation(a) {
      const rows: unknown[] = await tx`
        INSERT INTO factory.annotations (id, key, artifact_id, revision, quote, path, comment, author, at)
        VALUES (${a.id}, ${a.key}, ${a.artifactId}, ${a.revision}, ${a.quote}, ${a.path}, ${a.comment}, ${a.author}, ${a.at})
        ON CONFLICT (key) DO NOTHING
        RETURNING id`
      return rows.length === 1
    },

    async annotationByKey(key) {
      const [row] = await tx`SELECT * FROM factory.annotations WHERE key = ${key}`
      return row ? annotationOf(row) : null
    },

    async annotation(id) {
      const [row] = await tx`SELECT * FROM factory.annotations WHERE id = ${id}`
      return row ? annotationOf(row) : null
    },

    async editAnnotation(id, comment, key, at) {
      const rows: unknown[] = await tx`
        UPDATE factory.annotations SET comment = ${comment}, key = ${key}, edited_at = ${at},
          disposition = NULL, disposition_note = NULL, disposed_at = NULL
        WHERE id = ${id} AND comment IS DISTINCT FROM ${comment}
        RETURNING id`
      return rows.length === 1
    },

    async deleteAnnotation(id) {
      const rows: unknown[] = await tx`DELETE FROM factory.annotations WHERE id = ${id} RETURNING id`
      return rows.length === 1
    },

    async disposeAnnotation(id, disposition, note, at) {
      const rows: unknown[] = await tx`
        UPDATE factory.annotations SET disposition = ${disposition}, disposition_note = ${note}, disposed_at = ${at}
        WHERE id = ${id} AND (disposition IS DISTINCT FROM ${disposition} OR disposition_note IS DISTINCT FROM ${note})
        RETURNING id`
      return rows.length === 1
    },

    async annotations(id) {
      const rows: unknown[] = await tx`SELECT * FROM factory.annotations WHERE artifact_id = ${id} ORDER BY at, id`
      return rows.map(annotationOf)
    },

    async insertVerdict(v) {
      const rows: unknown[] = await tx`
        INSERT INTO factory.verdicts (artifact_id, revision, key, verdict, note, at)
        VALUES (${v.artifactId}, ${v.revision}, ${v.key}, ${v.verdict}, ${v.note}, ${v.at})
        ON CONFLICT DO NOTHING
        RETURNING revision`
      return rows.length === 1
    },

    async verdictByKey(key) {
      const [row] = await tx`SELECT * FROM factory.verdicts WHERE key = ${key}`
      return row ? verdictOf(row) : null
    },

    async verdicts(id) {
      const rows: unknown[] = await tx`SELECT * FROM factory.verdicts WHERE artifact_id = ${id} ORDER BY revision`
      return rows.map(verdictOf)
    },

    async setNeededMe(id, revision, needed, at) {
      const [artifact] = await tx`SELECT id FROM factory.artifacts WHERE id = ${id}`
      if (!artifact) return 'unknown'
      const [row]: { needed_me: boolean | null }[] = await tx`
        SELECT needed_me FROM factory.verdicts WHERE artifact_id = ${id} AND revision = ${revision} FOR UPDATE`
      if (!row) return 'no_verdict'
      if (row.needed_me === needed) return 'unchanged'
      await tx`
        UPDATE factory.verdicts SET needed_me = ${needed}, needed_at = ${at}
        WHERE artifact_id = ${id} AND revision = ${revision}`
      return 'set'
    },

    async unscreenedSpecs(now, limit) {
      const rows: unknown[] = await tx`
        SELECT a.id, r.n
        FROM factory.artifacts a
        JOIN factory.issues i ON i.id = a.issue_id
        JOIN LATERAL (
          SELECT n, created_at FROM factory.artifact_revisions WHERE artifact_id = a.id ORDER BY n DESC LIMIT 1
        ) r ON true
        LEFT JOIN factory.spec_screens s ON s.artifact_id = a.id AND s.revision = r.n
        WHERE a.kind = 'spec' AND i.state <> 'closed'
          AND NOT EXISTS (SELECT 1 FROM factory.verdicts v WHERE v.artifact_id = a.id AND v.revision = r.n)
          AND (s.artifact_id IS NULL OR (s.outcome IS NULL AND (s.retry_at IS NULL OR s.retry_at <= ${now})))
        ORDER BY r.created_at, a.id LIMIT ${limit}`
      return rows.map((raw) => {
        const row = z.object({ id: z.string(), n: z.number().int() }).parse(raw)
        return { artifact: row.id as ArtifactId, revision: row.n }
      })
    },

    async lockSpecRevision(id, revision, options = { lock: true }) {
      const [artifactRow] = options.lock
        ? await tx`SELECT * FROM factory.artifacts WHERE id = ${id} AND kind = 'spec' FOR UPDATE`
        : await tx`SELECT * FROM factory.artifacts WHERE id = ${id} AND kind = 'spec'`
      if (!artifactRow) return null
      const artifact = artifactOf(artifactRow)
      const revisions: unknown[] = await tx`
        SELECT * FROM factory.artifact_revisions WHERE artifact_id = ${id} ORDER BY n DESC LIMIT 1`
      const latest = revisions[0] ? revisionOf(revisions[0]) : null
      if (!latest || latest.n !== revision) return null
      const [origin] = await tx`
        SELECT
          EXISTS (SELECT 1 FROM factory.replans p WHERE p.issue_id = ${artifact.issueId}) AS replan,
          EXISTS (
            SELECT 1 FROM factory.issue_events e
            WHERE e.issue_id = ${artifact.issueId} AND e.kind = 'settled' AND e.result = 'applied'
              AND e.payload->>'checkpoint' = 'spec'
          ) AS triaged,
          EXISTS (
            SELECT 1 FROM factory.issue_events e
            WHERE e.issue_id = ${artifact.issueId} AND e.kind = 'filed' AND e.result = 'applied'
              AND e.payload->>'checkpoint' = 'spec'
          ) AS filed`
      const facts = z.object({ replan: z.boolean(), triaged: z.boolean(), filed: z.boolean() }).parse(origin)
      const verdicts: unknown[] = await tx`
        SELECT * FROM factory.verdicts WHERE artifact_id = ${id} ORDER BY revision`
      const all = verdicts.map(verdictOf)
      const [screenRow] = await tx`
        SELECT * FROM factory.spec_screens WHERE artifact_id = ${id} AND revision = ${revision}`
      return {
        artifact,
        revision: latest,
        origin: {
          replan: facts.replan,
          filedSpec: artifact.key.startsWith('filed-spec:'),
          triaged: facts.triaged,
          filedWithCheckpoint: facts.filed,
        },
        answered: all.some((v) => v.revision === revision),
        earlier: all.filter((v) => v.revision < revision).map((v) => v.verdict),
        screen: screenRow ? specScreenOf(screenRow) : null,
      }
    },

    async specScreen(id, revision) {
      const [row] = await tx`SELECT * FROM factory.spec_screens WHERE artifact_id = ${id} AND revision = ${revision}`
      return row ? specScreenOf(row) : null
    },

    async recordSpecScreen(s) {
      const rows: unknown[] = await tx`
        INSERT INTO factory.spec_screens (artifact_id, revision, outcome, by, source, note, tries, retry_at, at)
        VALUES (${s.artifactId}, ${s.revision}, ${s.outcome}, ${s.by}, ${s.source}, ${s.note?.slice(0, 300) ?? null},
                ${s.tries}, ${s.retryAt}, ${s.at})
        ON CONFLICT (artifact_id, revision) DO UPDATE SET
          outcome = EXCLUDED.outcome, by = EXCLUDED.by, source = EXCLUDED.source, note = EXCLUDED.note,
          tries = EXCLUDED.tries, retry_at = EXCLUDED.retry_at, at = EXCLUDED.at
        WHERE factory.spec_screens.outcome IS NULL
        RETURNING revision`
      return rows.length === 1
    },

    specPrecedents: (limit) => readSpecPrecedents(tx, limit),

    async insertErrand(e) {
      const rows: unknown[] = await tx`
        INSERT INTO factory.errands (id, key, issue_id, attempt, summary, detail, raised_at, reached_owner_at, screen_by,
          source, command, check_command, host, expires_at, request_key, need)
        VALUES (${e.id}, ${e.key}, ${e.issueId}, ${e.attempt}, ${e.summary}, ${e.detail}, ${e.raisedAt}, ${e.reachedOwnerAt},
          ${e.screenBy}, ${e.source}, ${e.command}, ${e.checkCommand}, ${e.host}, ${e.expiresAt}, ${e.requestKey}, ${e.need})
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
        SET run_attempts = run_attempts + 1, run_status = ${run.status}, run_exit = ${run.exit}, run_at = ${run.at},
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

    async openMatching({ command, check }) {
      if (command === null && check === null) return null
      const [row] = await tx`
        SELECT * FROM factory.errands
        WHERE done_at IS NULL AND turned_away_at IS NULL
          AND (issue_id IS NULL OR EXISTS (SELECT 1 FROM factory.issues i WHERE i.id = errands.issue_id AND i.state <> 'closed'))
          AND ((${command}::text IS NOT NULL AND command = ${command}) OR (${check}::text IS NOT NULL AND check_command = ${check}))
        ORDER BY raised_at, id LIMIT 1`
      return row ? errandOf(row) : null
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

    async recheckCandidates({ reachedBefore, limit }) {
      const rows: unknown[] = await tx`
        WITH reached AS (
          SELECT 'decision' AS kind, d.id, d.issue_id, s.at AS reached_at
          FROM factory.decisions d
          JOIN factory.decision_steps s ON s.decision_id = d.id AND s.step = 'owner' AND s.outcome = 'open'
          WHERE d.answered_at IS NULL AND d.withdrawn_at IS NULL AND s.at <= ${reachedBefore}
          UNION ALL
          SELECT 'errand', e.id, e.issue_id, e.reached_owner_at
          FROM factory.errands e
          WHERE e.done_at IS NULL AND e.issue_id IS NOT NULL AND e.reached_owner_at <= ${reachedBefore}
        )
        SELECT r.kind, r.id, r.issue_id, r.reached_at, last.at AS last_at, last.through_version
        FROM reached r
        LEFT JOIN LATERAL (
          SELECT c.at, c.through_version FROM factory.checkpoint_rechecks c
          WHERE c.checkpoint_id = r.id ORDER BY c.through_version DESC LIMIT 1
        ) last ON true
        WHERE last.at IS NULL OR last.at <= ${reachedBefore}
        ORDER BY r.reached_at, r.id LIMIT ${limit}`
      return rows.map((raw): RecheckCandidate => {
        const row = RecheckRow.parse(raw)
        return {
          kind: row.kind,
          id: row.id,
          issueId: row.issue_id as IssueId,
          reachedAt: row.reached_at,
          lastCheckedAt: row.last_at,
          throughVersion: row.through_version,
        }
      })
    },

    async staleReviews({ before, limit }) {
      const rows: unknown[] = await tx`
        SELECT a.id, a.issue_id, a.kind, a.title, r.n, r.created_at, a.key LIKE 'filed-spec:%' AS filed
        FROM factory.artifacts a
        JOIN LATERAL (
          SELECT n, created_at FROM factory.artifact_revisions WHERE artifact_id = a.id ORDER BY n DESC LIMIT 1
        ) r ON true
        WHERE a.kind IN ('concept', 'spec') AND r.created_at <= ${before}
          AND NOT EXISTS (SELECT 1 FROM factory.verdicts v WHERE v.artifact_id = a.id AND v.revision = r.n)
          AND NOT EXISTS (
            SELECT 1 FROM factory.checkpoint_rechecks c WHERE c.checkpoint_id = a.id AND c.through_version = r.n)
        ORDER BY r.created_at, a.id LIMIT ${limit}`
      return rows.map((raw) => {
        const row = StaleReviewRow.parse(raw)
        return {
          artifact: row.id,
          issueId: row.issue_id as IssueId,
          kind: row.kind,
          title: row.title,
          revision: row.n,
          at: row.created_at,
          filed: row.filed,
        }
      })
    },

    async insertRecheck(recheck) {
      const rows: unknown[] = await tx`
        INSERT INTO factory.checkpoint_rechecks
          (checkpoint_id, kind, issue_id, through_version, outcome, by, reason, at)
        VALUES (${recheck.checkpointId}, ${recheck.kind}, ${recheck.issueId}, ${recheck.throughVersion},
                ${recheck.outcome}, ${recheck.by}, ${recheck.reason.slice(0, 300)}, ${recheck.at})
        ON CONFLICT (checkpoint_id, through_version) DO NOTHING
        RETURNING checkpoint_id`
      return rows.length === 1
    },

    async planPage(page: Page, at) {
      const rows: unknown[] = await tx`
        INSERT INTO factory.checkpoint_pages (key, kind, checkpoint, issue_id, title, body, link, planned_at)
        VALUES (${page.key}, ${page.kind}, ${page.checkpoint}, ${page.issueId}, ${page.title}, ${page.body}, ${page.link}, ${at})
        ON CONFLICT (key) DO UPDATE SET
          title = ${page.title}, body = ${page.body}, link = ${page.link}, planned_at = ${at},
          cancelled_at = NULL, attempts = 0, error = NULL, claimed_until = NULL
        WHERE factory.checkpoint_pages.sent_at IS NULL AND factory.checkpoint_pages.cancelled_at IS NOT NULL
        RETURNING key`
      return rows.length === 1
    },

    async cancelPages(checkpoint, at) {
      await tx`
        UPDATE factory.checkpoint_pages SET cancelled_at = ${at}
        WHERE checkpoint = ${checkpoint} AND sent_at IS NULL AND cancelled_at IS NULL`
    },

    async claimPages({ now, until, limit }) {
      const rows: unknown[] = await tx`
        WITH due AS (
          SELECT key FROM factory.checkpoint_pages
          WHERE sent_at IS NULL AND cancelled_at IS NULL
            AND (not_before IS NULL OR not_before <= ${now})
            AND (claimed_until IS NULL OR claimed_until <= ${now})
          ORDER BY planned_at, key
          LIMIT ${limit}
          FOR UPDATE SKIP LOCKED
        )
        UPDATE factory.checkpoint_pages p SET claimed_until = ${until}, attempts = p.attempts + 1
        FROM due WHERE p.key = due.key
        RETURNING p.*`
      return rows
        .map((raw) => PageRow.parse(raw))
        .sort((a, b) => a.planned_at.getTime() - b.planned_at.getTime() || a.key.localeCompare(b.key))
        .map((row) => ({
          key: row.key as Key,
          kind: row.kind,
          checkpoint: row.checkpoint,
          issueId: row.issue_id,
          title: row.title,
          body: row.body,
          link: row.link,
          attempts: row.attempts,
        }))
    },

    async recordPage(key, run) {
      if (run.ok) {
        await tx`UPDATE factory.checkpoint_pages SET sent_at = ${run.at}, claimed_until = NULL, error = NULL WHERE key = ${key}`
        return
      }
      await tx`
        UPDATE factory.checkpoint_pages
        SET error = ${`${run.error.kind}: ${run.error.detail}`}, claimed_until = NULL,
            not_before = ${run.retryAt}
        WHERE key = ${key} AND sent_at IS NULL`
    },

    async pages(limit) {
      const rows: unknown[] =
        await tx`SELECT * FROM factory.checkpoint_pages ORDER BY planned_at DESC, key DESC LIMIT ${limit}`
      return rows.map((raw): PageRecord => {
        const row = PageRow.parse(raw)
        return {
          key: row.key as Key,
          kind: row.kind,
          checkpoint: row.checkpoint,
          issueId: row.issue_id,
          title: row.title,
          body: row.body,
          link: row.link,
          plannedAt: row.planned_at,
          attempts: row.attempts,
          sentAt: row.sent_at,
          error: row.error,
          status: pageStatus(row),
        }
      })
    },
  }
}
