import { cp, mkdir, open, realpath, stat } from 'node:fs/promises'
import { join, sep } from 'node:path'
import type { TranscriptApiError, TranscriptTails, Transcripts } from '../../domains/leads/ports.ts'
import { issueNumber } from '../../kernel/ids.ts'
import { err, ok, portError } from '../../kernel/result.ts'

/**
 * Copies an attempt's transcripts to `<archiveDir>/<issue number>/<attempt>/<claude session>.jsonl`, with the
 * subagents' directory beside it. Claude Code deletes its own after 30 days. The path a session reported is its own word:
 * a file counts only if it really lies under an account's Claude projects directory. The format is Claude Code's;
 * the factory stores and links, never parses.
 */
export function fileTranscripts(options: { archiveDir: string; projectsDirs: () => Promise<string[]> }): Transcripts {
  return {
    async archive({ issue, attempt, sessions }) {
      try {
        const roots = await Promise.all(
          (await options.projectsDirs()).map((dir) => realpath(dir).catch(() => undefined)),
        )
        const dir = join(options.archiveDir, String(issueNumber(issue)), String(attempt))
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
          await mkdir(dir, { recursive: true })
          const name = session.claudeSession.replace(/[^A-Za-z0-9._-]/g, '_')
          await cp(from, join(dir, `${name}.jsonl`))
          const subagents = from.replace(/\.jsonl$/, '')
          if (
            await stat(subagents).then(
              (s) => s.isDirectory(),
              () => false,
            )
          ) {
            await cp(subagents, join(dir, name), { recursive: true })
          }
          archived++
        }
        return ok({ archived })
      } catch (cause) {
        return err(portError('gone', `transcripts of ${issue} attempt ${attempt}: ${String(cause)}`))
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
export function fileTranscriptTails(options: { projectsDirs: () => Promise<string[]> }): TranscriptTails {
  return {
    async apiError(path) {
      try {
        const from = await realpath(path).catch(() => undefined)
        if (!from) return ok(null)
        const roots = await Promise.all(
          (await options.projectsDirs()).map((dir) => realpath(dir).catch(() => undefined)),
        )
        if (!roots.some((root) => root && from.startsWith(`${root}${sep}`))) return ok(null)
        const info = await stat(from)
        if (!info.isFile()) return ok(null)
        const start = Math.max(0, info.size - TAIL_BYTES)
        const handle = await open(from, 'r')
        let raw: string
        try {
          const buffer = Buffer.alloc(info.size - start)
          await handle.read(buffer, 0, buffer.length, start)
          raw = buffer.toString('utf8')
        } finally {
          await handle.close()
        }
        const lines = raw.split('\n')
        // A cut start is a torn first line.
        if (start > 0) lines.shift()
        for (const line of lines.toReversed()) {
          if (!line.trim()) continue
          let entry: Record<string, unknown>
          try {
            entry = JSON.parse(line) as Record<string, unknown>
          } catch {
            continue
          }
          if (entry.type !== 'assistant' && entry.type !== 'user') continue
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
