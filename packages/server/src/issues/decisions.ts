import { type Context, badTime, text, time } from './shared.ts'

export async function recordDecision({ tx, issue, row, now }: Context): Promise<string | undefined> {
  const question = text(row.payload, 'question')
  if (!question) return 'an ask needs a question'
  if (badTime(row.payload, 'expiresAt')) return 'expiresAt is not a time'
  const options = Array.isArray(row.payload?.options) ? JSON.stringify(row.payload.options) : null
  await tx`
    INSERT INTO factory.decisions (issue_id, key, question, options, default_option, expires_at, created_at)
    VALUES (${issue.id}, ${row.key}, ${question}, ${options}::text::jsonb, ${text(row.payload, 'default')},
            ${time(row.payload, 'expiresAt')}, ${now})
    ON CONFLICT (key) DO NOTHING`
  return undefined
}

export async function answerDecision({ tx, issue, row, now }: Context): Promise<string | undefined> {
  const answer = text(row.payload, 'answer')
  if (!answer) return 'an answer needs its text'
  // An answer that names its question (an expiry's default) applies to that one only: a question asked since is not its.
  const named = typeof row.payload?.decision === 'number' ? row.payload.decision : null
  const answered = await tx`
    UPDATE factory.decisions SET answer = ${answer}, answered_by = ${text(row.payload, 'who') ?? 'owner'}, answered_at = ${now}
    WHERE issue_id = ${issue.id} AND answered_at IS NULL AND (${named}::bigint IS NULL OR id = ${named})
    RETURNING id`
  if (named !== null && answered.length === 0) return `question ${named} is answered already`
  return undefined
}
