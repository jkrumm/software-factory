import { copyFile, cp, lstat, mkdir, realpath, rename, rm } from 'node:fs/promises'
import { dirname, join, sep } from 'node:path'
import type { SQL } from 'bun'
import { storeEvidence } from './evidence.ts'
import { leadKey } from './names.ts'
import { markEvent } from './shared.ts'

/** Where an attempt's transcripts go. A port: a test copies into a directory of its own, or fails. */
export interface TranscriptStore {
  /**
   * Copies a transcript from inside `root`, the account's Claude projects directory; `false` when there is no such file (Claude Code
   * removed it, or it never was one) or it is not in there. No root is no copy: a pane reported the path, and the server reads it.
   * The file store never throws for it: a transcript that cannot be read or copied is `false`, a line, and the attempt ends.
   */
  copy(input: { from: string; to: string; root: string | undefined }): Promise<boolean>
}

/** The Claude projects directory of an account; undefined when the account is none the registry knows. */
export type ProjectsDir = (account: string | null) => Promise<string | undefined>

/** Claude's session id goes into a path here and onto a command line at `resume`, and a pane reported it. */
const SESSION_ID = /^[A-Za-z0-9-]{1,128}$/

/** What is at a path, not following a link; nothing there is an answer, and anything else that went wrong is an error to try again. */
async function look(path: string) {
  return lstat(path).catch((error: unknown) => {
    if ((error as { code?: string }).code === 'ENOENT') return undefined
    throw error
  })
}

async function resolved(path: string): Promise<string | undefined> {
  return realpath(path).catch((error: unknown) => {
    if ((error as { code?: string }).code === 'ENOENT') return undefined
    throw error
  })
}

/** The file, and the directory beside it where Claude Code keeps the session's subagents. Never read: the format is Claude Code's. */
export class FileTranscripts implements TranscriptStore {
  async copy(input: { from: string; to: string; root: string | undefined }): Promise<boolean> {
    // Whatever goes wrong with one transcript (a permission, a path that is no directory, a full disk) is a transcript not archived.
    return this.copyInside(input).catch(async () => {
      await rm(`${input.to}.part`, { force: true }).catch(() => undefined)
      return false
    })
  }

  private async copyInside({
    from,
    to,
    root,
  }: {
    from: string
    to: string
    root: string | undefined
  }): Promise<boolean> {
    if (!root) return false
    // Both real: a link anywhere along the path leads out of the root in the answer, not past it.
    const real = await resolved(from)
    const inside = await resolved(root)
    if (!real || !inside || !real.startsWith(`${inside}${sep}`) || !real.endsWith('.jsonl')) return false
    const found = await look(real)
    if (!found?.isFile()) return false
    // The archive holds whole sessions: only the owner reads it.
    await mkdir(dirname(to), { recursive: true, mode: 0o700 })
    const part = `${to}.part`
    await copyFile(real, part)
    await rename(part, to)
    const subagents = real.slice(0, -'.jsonl'.length)
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
  /** the spawn's, which the factory chose, before the one the pane reported */
  account: string | null
}

/**
 * Copies the transcripts of an attempt, the lead's and those of the workers it spawned, to `<archive>/<issue>/<attempt>/<session>.jsonl`
 * and links each in `evidence` (kind `transcript`): stored and linked, never parsed. Copied again on a replay, one row each. Only what
 * really lies under the session's account's Claude projects directory is copied.
 */
export async function archiveAttempt(
  deps: { sql: SQL; store: TranscriptStore; dir: string; projectsDir: ProjectsDir; now: () => Date },
  issueId: number,
  attempt: number,
): Promise<void> {
  const { sql, store } = deps
  const lead = leadKey(issueId, attempt)
  const sessions: Transcript[] = await sql`
    SELECT s.id, s.claude_session_id, s.transcript_path, COALESCE(p.account, s.account) AS account
    FROM factory.sessions s LEFT JOIN factory.spawns p ON p.key = s.id
    WHERE (s.id = ${lead} OR p.parent = ${lead}) AND s.claude_session_id IS NOT NULL AND s.transcript_path IS NOT NULL
    ORDER BY s.id`
  // The registry is read once per account, and one that cannot be read is no root: a transcript that cannot be archived never stops an attempt's end.
  const roots = new Map<string | null, Promise<string | undefined>>()
  const rootOf = (account: string | null) => {
    let root = roots.get(account)
    if (!root) {
      root = Promise.resolve()
        .then(() => deps.projectsDir(account))
        .catch(() => undefined)
      roots.set(account, root)
    }
    return root
  }
  for (const session of sessions) {
    if (!SESSION_ID.test(session.claude_session_id)) continue
    const to = join(deps.dir, String(issueId), String(attempt), `${session.claude_session_id}.jsonl`)
    if (!(await store.copy({ from: session.transcript_path, to, root: await rootOf(session.account) }))) {
      // The attempt ends all the same, without this transcript, and says so.
      const key = `transcript_missing:${issueId}:${attempt}:${session.claude_session_id}`
      await markEvent(sql, issueId, key, 'transcript_missing', deps.now(), { session: session.id })
      continue
    }
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
