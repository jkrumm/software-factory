import type { SQL } from 'bun'

/** The reason a prompt carries when its Issue closed before it was typed. */
export const CLOSED_NOTE_ERROR = 'the Issue closed; nothing is left to tell its lead'

/**
 * Fails every prompt still `pending` for a session of a closed Issue: its lead has nothing to act on, and a note that waits
 * for ever is only noise. One Issue at the close (in its transaction), every closed Issue as a sweep (`issueId` omitted).
 * A prompt already typed (`typing`, `sent`) is left to prove itself.
 */
export async function failNotesOfClosed(sql: SQL, now: Date, issueId?: number): Promise<void> {
  await sql`
    UPDATE factory.prompts p
    SET status = 'failed', failed_at = ${now}, error = ${CLOSED_NOTE_ERROR}
    FROM factory.sessions s
    JOIN factory.issues i ON i.id = s.issue_id
    WHERE p.status = 'pending' AND s.id = p.session AND i.state = 'closed'
      AND (${issueId ?? null}::integer IS NULL OR i.id = ${issueId ?? null})`
}
