import { cp, mkdir, realpath, stat } from 'node:fs/promises'
import { join, sep } from 'node:path'
import type { Transcripts } from '../../domains/leads/ports.ts'
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
