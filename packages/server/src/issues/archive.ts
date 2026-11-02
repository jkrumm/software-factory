import { cp, lstat, copyFile, mkdir, rename, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { SQL } from 'bun'
import { storeEvidence } from './evidence.ts'
import { leadKey } from './names.ts'

/** Where an attempt's transcripts go. A port: a test copies into a directory of its own, or fails. */
export interface TranscriptStore {
  /** Copies a transcript; `false` when there is no such file (Claude Code removed it, or it never was one). */
  copy(input: { from: string; to: string }): Promise<boolean>
}

/** Claude's session id goes into a path here and onto a command line at `resume`, and a pane reported it. */
const SESSION_ID = /^[A-Za-z0-9-]{1,128}$/

/** What is at a path, not following a link; nothing there is an answer, and anything else that went wrong is an error to try again. */
async function look(path: string) {
  return lstat(path).catch((error: unknown) => {
    if ((error as { code?: string }).code === 'ENOENT') return undefined
    throw error
  })
}

/** The file, and the directory beside it where Claude Code keeps the session's subagents. Never read: the format is Claude Code's. */
export class FileTranscripts implements TranscriptStore {
  async copy({ from, to }: { from: string; to: string }): Promise<boolean> {
    if (!from.endsWith('.jsonl')) return false
    const found = await look(from)
    if (!found?.isFile()) return false
    // The archive holds whole sessions: only the owner reads it.
    await mkdir(dirname(to), { recursive: true, mode: 0o700 })
    const part = `${to}.part`
    await copyFile(from, part)
    await rename(part, to)
    const subagents = from.slice(0, -'.jsonl'.length)
    const beside = await look(subagents)
    if (beside?.isDirectory()) {
      const copied = to.slice(0, -'.jsonl'.length)
      await rm(copied, { recursive: true, force: true })
      await cp(subagents, copied, { recursive: true, verbatimSymlinks: true })
    }
    return true
  }
}

interface Transcript {
  id: string
  claude_session_id: string
  transcript_path: string
}

/**
 * Copies the transcripts of an attempt, the lead's and those of the workers it spawned, to `<archive>/<issue>/<attempt>/<session>.jsonl`
 * and links each in `evidence` (kind `transcript`): stored and linked, never parsed. Copied again on a replay, one row each.
 */
export async function archiveAttempt(
  deps: { sql: SQL; store: TranscriptStore; dir: string; now: () => Date },
  issueId: number,
  attempt: number,
): Promise<void> {
  const { sql, store } = deps
  const lead = leadKey(issueId, attempt)
  const sessions: Transcript[] = await sql`
    SELECT s.id, s.claude_session_id, s.transcript_path
    FROM factory.sessions s LEFT JOIN factory.spawns p ON p.key = s.id
    WHERE (s.id = ${lead} OR p.parent = ${lead}) AND s.claude_session_id IS NOT NULL AND s.transcript_path IS NOT NULL
    ORDER BY s.id`
  for (const session of sessions) {
    if (!SESSION_ID.test(session.claude_session_id)) continue
    const to = join(deps.dir, String(issueId), String(attempt), `${session.claude_session_id}.jsonl`)
    if (!(await store.copy({ from: session.transcript_path, to }))) continue
    await storeEvidence(sql, {
      issueId,
      key: `transcript:${issueId}:${attempt}:${session.claude_session_id}`,
      attempt,
      kind: 'transcript',
      link: to,
      payload: { session: session.id, claudeSessionId: session.claude_session_id },
      at: deps.now(),
      author: 'factory',
    })
  }
}
