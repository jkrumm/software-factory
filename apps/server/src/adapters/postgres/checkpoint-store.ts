import type { SQL } from 'bun'
import * as z from 'zod'
import {
  ARTIFACT_KINDS,
  DISPOSITIONS,
  FORMATS,
  type ArtifactId,
  type CollectionId,
  VERDICTS,
} from '../../domains/checkpoints/artifact.ts'
import {
  type DecisionId,
  JUDGE_BACKOFF_MS,
  JUDGE_MAX_TRIES,
  ANSWERERS,
  STEPS,
} from '../../domains/checkpoints/decision.ts'
import type { Page } from '../../domains/checkpoints/page.ts'
import {
  type AnnotationRecord,
  type ArtifactRecord,
  type CheckpointStore,
  type DecisionRecord,
  type PageRecord,
  type RevisionRecord,
  type SpecPathRecord,
  STEP_OUTCOMES,
  type Step,
  type VerdictRecord,
} from '../../domains/checkpoints/ports.ts'
import { DECISION_CLASSES, Exhibit, ImageAnchor, SPEC_SOURCES } from '@software-factory/contract'
import type { RecheckCandidate } from '../../domains/checkpoints/recheck.ts'
import { type IssueId } from '../../kernel/ids.ts'
import type { Key } from '../../kernel/keys.ts'

const Option = z.object({
  label: z.string(),
  /** absent on a Decision asked before the form had it */
  leadsTo: z
    .string()
    .nullable()
    .optional()
    .transform((value) => value ?? null),
  reversible: z.boolean(),
  cost: z.string(),
})
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
  class: z.enum(DECISION_CLASSES).nullable(),
  why_yours: z.string().nullable(),
  exhibit: Exhibit.nullable(),
  spec_id: z.string().nullable(),
  answer: z.string().nullable(),
  settled_by: z.enum(ANSWERERS).nullable(),
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
  repo: z.string(),
})

const ArtifactRow = z.object({
  id: z.string(),
  key: z.string(),
  issue_id: z.string().nullable(),
  repo: z.string().nullable(),
  kind: z.enum(ARTIFACT_KINDS),
  title: z.string(),
  format: z.enum(FORMATS),
  author: z.enum(['lead', 'factory']),
  created_at: z.date(),
  retired_at: z.date().nullable(),
  collection_id: z.string().nullable(),
  issue_closed: z.boolean().nullable().optional(),
  issue_repo: z.string().nullable().optional(),
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
  occurrence: z.number().int().nullable(),
  prefix: z.string().nullable(),
  suffix: z.string().nullable(),
  image: ImageAnchor.nullable(),
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
  by: z.enum(['owner', 'factory', 'orchestrator']),
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
      class: row.class,
      whyYours: row.why_yours,
      question: row.question,
      recommendation: row.recommendation,
      checked: row.checked,
      options: row.options,
      exhibit: row.exhibit,
      artifact: row.spec_id,
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
    issueId: row.issue_id as IssueId | null,
    repo: row.repo,
    kind: row.kind,
    title: row.title,
    format: row.format,
    author: row.author,
    createdAt: row.created_at,
    retiredAt: row.retired_at,
    collectionId: row.collection_id as CollectionId | null,
    issueClosed: row.issue_closed ?? null,
    issueRepo: row.issue_repo ?? null,
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
    occurrence: row.occurrence,
    prefix: row.prefix,
    suffix: row.suffix,
    image: row.image,
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
    // a verdict stored as With notes reads as Looks good
    verdict: row.verdict === 'with_notes' ? 'looks_good' : row.verdict,
    note: row.note,
    at: row.at,
    by: row.by,
  }
}

const SpecPathRow = z.object({
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

const specPathRowOf = (raw: unknown): SpecPathRecord => {
  const row = SpecPathRow.parse(raw)
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
      WHERE decision_id IN ${tx([...ids])} ORDER BY array_position(ARRAY['policy', 'judge', 'default', 'owner'], step)`
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
          (id, key, issue_id, repo, attempt, question, recommendation, checked, options, no_answer, asked_at, asked_by, artifact_id,
           class, why_yours, exhibit, spec_id)
        VALUES (${d.id}, ${d.key}, ${d.issueId}, ${d.repo}, ${d.attempt}, ${d.form.question}, ${d.form.recommendation},
                ${d.form.checked}, ${d.form.options}, ${d.form.noAnswer}, ${d.askedAt}, ${d.askedBy}, ${d.artifactId},
                ${d.form.class}, ${d.form.whyYours}, ${d.form.exhibit}, ${d.form.artifact})
        ON CONFLICT (key) DO NOTHING
        RETURNING id`
      return rows.length === 1
    },

    async amendDecision(id, form) {
      const rows: unknown[] = await tx`
        UPDATE factory.decisions
        SET question = ${form.question}, recommendation = ${form.recommendation}, checked = ${form.checked},
            options = ${form.options}, no_answer = ${form.noAnswer}, class = ${form.class}, why_yours = ${form.whyYours},
            exhibit = ${form.exhibit}, spec_id = ${form.artifact}
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
        SELECT question, answer, repo FROM factory.decisions
        WHERE answered_at IS NOT NULL AND settled_by = 'owner' AND id <> ${excluding}
          AND to_tsvector('english', question) @@ to_tsquery('english', ${terms})
        ORDER BY ts_rank(to_tsvector('english', question), to_tsquery('english', ${terms})) DESC,
                 answered_at DESC
        LIMIT ${limit}`
      return rows.map((raw) => {
        const row = PrecedentRow.parse(raw)
        return {
          question: row.question,
          answer: row.answer,
          settledBy: 'owner' as const,
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
        INSERT INTO factory.artifacts (id, key, issue_id, repo, kind, title, format, author, created_at)
        VALUES (${a.id}, ${a.key}, ${a.issueId}, ${a.repo ?? null}, ${a.kind}, ${a.title}, ${a.format}, ${a.author}, ${a.createdAt})
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
        SELECT artifacts.*,
          (SELECT i.state = 'closed' FROM factory.issues i WHERE i.id = artifacts.issue_id) AS issue_closed,
          (SELECT i.repo FROM factory.issues i WHERE i.id = artifacts.issue_id) AS issue_repo
        FROM factory.artifacts
        WHERE (${filter.issueId ?? null}::text IS NULL OR issue_id = ${filter.issueId ?? null}
            OR EXISTS (SELECT 1 FROM factory.artifact_links l
              WHERE l.artifact_id = artifacts.id AND l.issue_id = ${filter.issueId ?? null}))
          AND (${filter.kind ?? null}::text IS NULL OR kind = ${filter.kind ?? null})
          AND (${filter.retired ?? false}::boolean OR retired_at IS NULL)
        ORDER BY created_at DESC, id DESC LIMIT ${filter.limit}`
      return rows.map(artifactOf)
    },

    async retireArtifact(artifact, at) {
      const rows: unknown[] = await tx`
        UPDATE factory.artifacts SET retired_at = ${at} WHERE id = ${artifact} AND retired_at IS NULL RETURNING id`
      return rows.length === 1
    },

    async restoreArtifact(artifact) {
      const rows: unknown[] = await tx`
        UPDATE factory.artifacts SET retired_at = NULL WHERE id = ${artifact} AND retired_at IS NOT NULL RETURNING id`
      return rows.length === 1
    },

    async linkArtifact(artifact, issue, at) {
      const rows: unknown[] = await tx`
        INSERT INTO factory.artifact_links (artifact_id, issue_id, linked_at)
        VALUES (${artifact}, ${issue}, ${at})
        ON CONFLICT DO NOTHING
        RETURNING artifact_id`
      return rows.length === 1
    },

    async artifactLinks(ids) {
      const links = new Map<ArtifactId, IssueId[]>(ids.map((id) => [id, []]))
      if (ids.length === 0) return links
      const rows: { artifact_id: string; issue_id: string }[] = await tx`
        SELECT artifact_id, issue_id FROM factory.artifact_links
        WHERE artifact_id IN ${tx([...ids])} ORDER BY linked_at, issue_id`
      for (const row of rows) links.get(row.artifact_id as ArtifactId)?.push(row.issue_id as IssueId)
      return links
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
        INSERT INTO factory.annotations (id, key, artifact_id, revision, quote, path, occurrence, prefix, suffix, image, comment, author, at)
        VALUES (${a.id}, ${a.key}, ${a.artifactId}, ${a.revision}, ${a.quote}, ${a.path}, ${a.occurrence}, ${a.prefix}, ${a.suffix}, ${a.image ? JSON.stringify(a.image) : null}::text::jsonb, ${a.comment}, ${a.author}, ${a.at})
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
        INSERT INTO factory.verdicts (artifact_id, revision, key, verdict, note, at, by)
        VALUES (${v.artifactId}, ${v.revision}, ${v.key}, ${v.verdict}, ${v.note}, ${v.at}, ${v.by})
        ON CONFLICT DO NOTHING
        RETURNING revision`
      return rows.length === 1
    },

    async replaceDelegatedVerdict(v) {
      const [row] = await tx`
        UPDATE factory.verdicts
        SET verdict = ${v.verdict}, note = ${v.note}, at = ${v.at}, by = ${v.by}
        WHERE artifact_id = ${v.artifactId} AND revision = ${v.revision} AND by = 'orchestrator'
        RETURNING *`
      return row ? verdictOf(row) : null
    },

    async verdictByKey(key) {
      const [row] = await tx`SELECT * FROM factory.verdicts WHERE key = ${key}`
      return row ? verdictOf(row) : null
    },

    async verdicts(id) {
      const rows: unknown[] = await tx`SELECT * FROM factory.verdicts WHERE artifact_id = ${id} ORDER BY revision`
      return rows.map(verdictOf)
    },

    async undecidedSpecs(now, limit) {
      const rows: unknown[] = await tx`
        SELECT a.id, r.n
        FROM factory.artifacts a
        JOIN factory.issues i ON i.id = a.issue_id
        JOIN LATERAL (
          SELECT n, created_at FROM factory.artifact_revisions WHERE artifact_id = a.id ORDER BY n DESC LIMIT 1
        ) r ON true
        LEFT JOIN factory.spec_paths s ON s.artifact_id = a.id AND s.revision = r.n
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
              AND e.payload->>'checkpoint' IN ('spec', 'gate')
          ) AS filed,
          EXISTS (
            SELECT 1 FROM factory.issue_events e
            WHERE e.issue_id = ${artifact.issueId} AND e.kind = 'filed' AND e.result = 'applied'
              AND e.payload->>'checkpoint' = 'gate'
          ) AS gate`
      const facts = z
        .object({ replan: z.boolean(), triaged: z.boolean(), filed: z.boolean(), gate: z.boolean() })
        .parse(origin)
      const verdicts: unknown[] = await tx`
        SELECT * FROM factory.verdicts WHERE artifact_id = ${id} ORDER BY revision`
      const all = verdicts.map(verdictOf)
      const [pathRow] = await tx`
        SELECT * FROM factory.spec_paths WHERE artifact_id = ${id} AND revision = ${revision}`
      return {
        artifact,
        revision: latest,
        origin: {
          replan: facts.replan,
          filedSpec: artifact.key.startsWith('filed-spec:'),
          triaged: facts.triaged,
          filedWithCheckpoint: facts.filed,
          gate: facts.gate,
        },
        answered: all.some((v) => v.revision === revision),
        earlier: all.filter((v) => v.revision < revision).map((v) => v.verdict),
        recorded: pathRow ? specPathRowOf(pathRow) : null,
      }
    },

    async specPath(id, revision) {
      const [row] = await tx`SELECT * FROM factory.spec_paths WHERE artifact_id = ${id} AND revision = ${revision}`
      return row ? specPathRowOf(row) : null
    },

    async recordSpecPath(s) {
      const rows: unknown[] = await tx`
        INSERT INTO factory.spec_paths (artifact_id, revision, outcome, by, source, note, tries, retry_at, at)
        VALUES (${s.artifactId}, ${s.revision}, ${s.outcome}, ${s.by}, ${s.source}, ${s.note?.slice(0, 300) ?? null},
                ${s.tries}, ${s.retryAt}, ${s.at})
        ON CONFLICT (artifact_id, revision) DO UPDATE SET
          outcome = EXCLUDED.outcome, by = EXCLUDED.by, source = EXCLUDED.source, note = EXCLUDED.note,
          tries = EXCLUDED.tries, retry_at = EXCLUDED.retry_at, at = EXCLUDED.at
        WHERE factory.spec_paths.outcome IS NULL
        RETURNING revision`
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
          -- a lead's plan (settled by rule when handed over, with no verdict) waited for no one: nothing to default or withdraw
          AND NOT EXISTS (
            SELECT 1 FROM factory.spec_paths s WHERE s.artifact_id = a.id AND s.revision = r.n AND s.outcome = 'settled')
          -- an owner gate waits for his own verdict: no default after the hours (it is looked at only once it is closed)
          AND NOT EXISTS (
            SELECT 1 FROM factory.issues gi JOIN factory.issue_events ge ON ge.issue_id = gi.id
            WHERE gi.id = a.issue_id AND gi.state <> 'closed'
              AND ge.kind = 'filed' AND ge.version = 1 AND ge.payload->>'checkpoint' = 'gate')
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
