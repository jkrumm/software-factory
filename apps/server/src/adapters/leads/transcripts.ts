import { createReadStream } from 'node:fs'
import { open, realpath, rm, stat } from 'node:fs/promises'
import { basename, join, sep } from 'node:path'
import { createZstdDecompress } from 'node:zlib'
import type { TranscriptApiError, TranscriptTails, Transcripts } from '../../domains/leads/ports.ts'
import { issueNumber } from '../../kernel/ids.ts'
import { err, ok, portError } from '../../kernel/result.ts'
import {
  ARCHIVE_SUFFIX,
  archivedTranscript,
  attemptArchiveDir,
  type ArchiveTidy,
  transcriptPathNow,
} from '../../kernel/transcript-archive.ts'
import {
  archivedAttempts,
  compressFile,
  compressTree,
  convertAttempt,
  emptyReport,
  expire,
  removeFinishedProjects,
} from './archive-files.ts'

/**
 * Archives an attempt's transcripts to `<archiveDir>/<issue number>/<attempt>/<claude session>.jsonl.zst`, with the
 * subagents' directory beside it, each file compressed too. Claude Code deletes its own after 30 days, and the copy is the
 * only one kept: a source goes once its archive copy reads back equal, and the Claude project directory of a finished
 * factory worktree goes with its last transcript. The path a session reported is its own word: a file counts only if it
 * really lies under an account's Claude projects directory. The format is Claude Code's; the factory stores and links,
 * never parses.
 */
export function fileTranscripts(options: {
  archiveDir: string
  projectsDirs: () => Promise<string[]>
  /** attempts archived longer ago than this many days are deleted; 0 keeps them */
  retentionDays: number
  now?: () => Date
}): Transcripts {
  const now = options.now ?? (() => new Date())
  const rootsOf = options.projectsDirs
  let tidying: Promise<ArchiveTidy> | null = null

  async function tidy(): Promise<ArchiveTidy> {
    const report = emptyReport()
    const found = await archivedAttempts(options.archiveDir)
    const { expired, kept } = await expire({
      archiveDir: options.archiveDir,
      days: options.retentionDays,
      now: now(),
      attempts: found,
    })
    report.expired = expired
    for (const [issue, attempt] of kept) {
      const done = await convertAttempt(options.archiveDir, issue, attempt)
      report.converted.files += done.files
      report.converted.from += done.from
      report.converted.to += done.to
    }
    report.projectsRemoved = await removeFinishedProjects({
      projectRoots: await rootsOf(),
      archiveDir: options.archiveDir,
      attempts: kept,
    })
    return report
  }

  return {
    async archive({ issue, attempt, sessions }) {
      try {
        const roots = await Promise.all((await rootsOf()).map((dir) => realpath(dir).catch(() => undefined)))
        const number = issueNumber(issue)
        const dir = attemptArchiveDir(options.archiveDir, number, attempt)
        let archived = 0
        for (const session of sessions) {
          const from = await realpath(session.transcriptPath).catch(() => undefined)
          if (
            !from ||
            !(await stat(from).then(
              (s) => s.isFile(),
              () => false,
            ))
          )
            continue
          if (!roots.some((root) => root && from.startsWith(`${root}${sep}`))) continue
          await compressFile(
            from,
            archivedTranscript(options.archiveDir, { issue: number, attempt, claudeSession: session.claudeSession }),
          )
          const subagents = from.replace(/\.jsonl$/, '')
          const hasSubagents = await stat(subagents).then(
            (s) => s.isDirectory(),
            () => false,
          )
          if (hasSubagents) await compressTree(subagents, join(dir, basename(subagents)))
          // Both copies read back equal: the source is the only thing left that is twice there.
          await rm(from, { force: true })
          if (hasSubagents) await rm(subagents, { recursive: true, force: true })
          archived++
        }
        await removeFinishedProjects({
          projectRoots: await rootsOf(),
          archiveDir: options.archiveDir,
          attempts: [[number, attempt]],
          only: { issue: number, attempt },
        })
        return ok({ archived })
      } catch (cause) {
        return err(portError('gone', `transcripts of ${issue} attempt ${attempt}: ${String(cause)}`))
      }
    },

    async resolve({ issue, attempt, path }) {
      return transcriptPathNow(options.archiveDir, { issue: issueNumber(issue), attempt, path })
    },

    async tidy() {
      // One pass at a time: a second asker (a finalize during the boot pass) finds nothing left for it.
      if (tidying) return ok(null)
      tidying = tidy()
      try {
        return ok(await tidying)
      } catch (cause) {
        return err(portError('gone', `transcript archive tidy: ${String(cause)}`))
      } finally {
        tidying = null
      }
    },
  }
}

/** How much of the end of a transcript is read: a turn's last lines, never the file. */
const TAIL_BYTES = 128 * 1024

const text = (value: unknown): string | null => (typeof value === 'string' ? value : null)

/** The assistant text of a transcript line: the first text block of its message. */
function messageText(entry: Record<string, unknown>): string {
  const message = entry.message as { content?: unknown } | undefined
  const content = message?.content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const block = content.find((b) => typeof b === 'object' && b !== null && (b as { type?: unknown }).type === 'text')
  return text((block as { text?: unknown } | undefined)?.text) ?? ''
}

/**
 * The last conversation line of a transcript (`assistant` or `user`; bookkeeping lines are skipped), read from the end, if
 * Claude Code wrote it as an API error (`isApiErrorMessage`, with its `apiErrorStatus` and `error` type). The format is
 * Claude Code's and not a contract: a line that does not read is no error, and an unreadable file says nothing. The path is
 * the session's own word, so it must lie under an account's Claude projects directory.
 */
export function fileTranscriptTails(options: {
  projectsDirs: () => Promise<string[]>
  /** the archive: an archived (compressed) transcript lies under it */
  archiveDir?: string
}): TranscriptTails {
  /** The last `TAIL_BYTES` of a plain file; `cut` when the file is longer. */
  async function plainTail(from: string, size: number): Promise<{ raw: string; cut: boolean }> {
    const start = Math.max(0, size - TAIL_BYTES)
    const handle = await open(from, 'r')
    try {
      const buffer = Buffer.alloc(size - start)
      await handle.read(buffer, 0, buffer.length, start)
      return { raw: buffer.toString('utf8'), cut: start > 0 }
    } finally {
      await handle.close()
    }
  }

  /** The last `TAIL_BYTES` of an archived file, read through the decompressor: the file is never held whole. */
  async function archivedTail(from: string): Promise<{ raw: string; cut: boolean }> {
    let last: Buffer = Buffer.alloc(0)
    let cut = false
    for await (const chunk of createReadStream(from).pipe(createZstdDecompress())) {
      last = Buffer.concat([last, chunk as Buffer])
      if (last.length > TAIL_BYTES) {
        last = last.subarray(last.length - TAIL_BYTES)
        cut = true
      }
    }
    return { raw: last.toString('utf8'), cut }
  }

  /** The conversation lines of the transcript's end, newest first; null when the path is not a transcript under a root. */
  async function tail(path: string): Promise<Record<string, unknown>[] | null> {
    const from = await realpath(path).catch(() => undefined)
    if (!from) return null
    const dirs = [...(await options.projectsDirs()), ...(options.archiveDir ? [options.archiveDir] : [])]
    const roots = await Promise.all(dirs.map((dir) => realpath(dir).catch(() => undefined)))
    if (!roots.some((root) => root && from.startsWith(`${root}${sep}`))) return null
    const info = await stat(from)
    if (!info.isFile()) return null
    const { raw, cut } = from.endsWith(ARCHIVE_SUFFIX) ? await archivedTail(from) : await plainTail(from, info.size)
    const lines = raw.split('\n')
    // A cut start is a torn first line.
    if (cut) lines.shift()
    const entries: Record<string, unknown>[] = []
    for (const line of lines.toReversed()) {
      if (!line.trim()) continue
      try {
        const entry = JSON.parse(line) as Record<string, unknown>
        if (entry.type === 'assistant' || entry.type === 'user') entries.push(entry)
      } catch {
        // a line that does not read is skipped
      }
    }
    return entries
  }

  return {
    async lastWords(path, max) {
      try {
        const entries = await tail(path)
        if (!entries) return ok(null)
        const said: string[] = []
        let length = 0
        for (const entry of entries) {
          if (entry.type !== 'assistant' || entry.isApiErrorMessage === true) continue
          const words = messageText(entry).trim()
          if (!words) continue
          said.unshift(words)
          length += words.length
          if (length >= max) break
        }
        const joined = said.join('\n\n')
        return ok(joined ? joined.slice(-max) : null)
      } catch (cause) {
        return err(portError('gone', `transcript tail of ${path}: ${String(cause)}`))
      }
    },

    async apiError(path) {
      try {
        const entries = await tail(path)
        if (!entries) return ok(null)
        for (const entry of entries) {
          if (entry.isApiErrorMessage !== true) return ok(null)
          const at = new Date(text(entry.timestamp) ?? '')
          if (Number.isNaN(at.getTime())) return ok(null)
          return ok<TranscriptApiError>({
            at,
            error: text(entry.error),
            status: typeof entry.apiErrorStatus === 'number' ? entry.apiErrorStatus : null,
            text: messageText(entry).slice(0, 400),
          })
        }
        return ok(null)
      } catch (cause) {
        return err(portError('gone', `transcript tail of ${path}: ${String(cause)}`))
      }
    },
  }
}
