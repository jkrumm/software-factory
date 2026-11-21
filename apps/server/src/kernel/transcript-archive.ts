import { existsSync } from 'node:fs'
import { basename, join } from 'node:path'

/** What one tidy pass of the transcript archive did. */
export interface ArchiveTidy {
  /** attempts deleted for their age */
  expired: number
  /** plain files compressed, with the bytes before and after */
  converted: { files: number; from: number; to: number }
  /** Claude project directories of finished worktrees removed */
  projectsRemoved: number
}

/** What an archived file is called beside its plain name: every archived file is zstd-compressed. */
export const ARCHIVE_SUFFIX = '.zst'

/** A Claude session id as a file name. */
const safeSessionName = (claudeSession: string): string => claudeSession.replace(/[^A-Za-z0-9._-]/g, '_')

/** `<archive>/<issue number>/<attempt>`: where an attempt's transcripts lie. */
export const attemptArchiveDir = (archiveDir: string, issue: number, attempt: number): string =>
  join(archiveDir, String(issue), String(attempt))

/** The archived copy of one session's transcript. */
export const archivedTranscript = (
  archiveDir: string,
  of: { issue: number; attempt: number; claudeSession: string },
): string =>
  join(
    attemptArchiveDir(archiveDir, of.issue, of.attempt),
    `${safeSessionName(of.claudeSession)}.jsonl${ARCHIVE_SUFFIX}`,
  )

/**
 * Where a session's transcript can be read now: the path its hook reported while that still exists, otherwise the
 * archived copy of it, otherwise the reported path (a reader of a missing file says so).
 */
export function transcriptPathNow(
  archiveDir: string | undefined,
  of: { issue: number; attempt: number; path: string },
): string {
  if (!archiveDir || existsSync(of.path)) return of.path
  const archived = archivedTranscript(archiveDir, {
    issue: of.issue,
    attempt: of.attempt,
    claudeSession: basename(of.path).replace(/\.jsonl$/, ''),
  })
  return existsSync(archived) ? archived : of.path
}
