import { open, realpath } from 'node:fs/promises'

/** How much of the end of a transcript is read: the last reply is near the end, and a transcript is megabytes. */
export const TAIL_BYTES = 512 * 1024

/** Where Claude Code keeps a session's transcript: `<config dir>/projects/<project>/<session>.jsonl`. Nothing else is read. */
const TRANSCRIPT = /\/\.claude[^/]*\/projects\/[^/]+\/[^/]+\.jsonl$/

/** The last thing a session said, as text: what the digest is asked about. */
export interface ReplyReader {
  /** The last assistant text of the turn that ended last, or `null` (no transcript, none readable, no text since the last prompt). Never throws. */
  lastReply(transcriptPath: string): Promise<string | null>
}

/** The text blocks of one assistant message, joined. */
function textOf(content: unknown): string {
  if (typeof content === 'string') return content.trim()
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const block of content) {
    if (typeof block !== 'object' || block === null) continue
    const b = block as { type?: unknown; text?: unknown }
    if (b.type === 'text' && typeof b.text === 'string' && b.text.trim()) parts.push(b.text.trim())
  }
  return parts.join('\n\n')
}

/** Whether a `user` line is a prompt of the owner's (or an agent's) and not a tool's result: the turn begins there. */
function isPrompt(content: unknown): boolean {
  if (typeof content === 'string') return true
  if (!Array.isArray(content)) return false
  return content.some((block) => (block as { type?: unknown } | null)?.type !== 'tool_result')
}

/**
 * The last assistant text after the last prompt in the JSONL text `tail` (its first line may be cut and is dropped by the
 * caller). A transcript is data: every line is parsed, nothing in it is followed, and only `text` blocks of `assistant` lines
 * count (no thinking, no tool call).
 */
export function lastReplyOf(tail: string): string | null {
  const lines = tail.split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]
    if (!line) continue
    let entry: { type?: unknown; isSidechain?: unknown; message?: { content?: unknown } }
    try {
      entry = JSON.parse(line) as typeof entry
    } catch {
      continue
    }
    if (entry.isSidechain === true) continue
    if (entry.type === 'user' && isPrompt(entry.message?.content)) return null
    if (entry.type === 'assistant') {
      const text = textOf(entry.message?.content)
      if (text) return text
    }
  }
  return null
}

/** Reads the end of the session's transcript file. A path that is no transcript of Claude Code (after `realpath`) is not read. */
export class FileReplies implements ReplyReader {
  async lastReply(transcriptPath: string): Promise<string | null> {
    try {
      const real = await realpath(transcriptPath)
      if (!TRANSCRIPT.test(real)) return null
      const file = await open(real, 'r')
      try {
        const { size } = await file.stat()
        const length = Math.min(size, TAIL_BYTES)
        const buffer = Buffer.alloc(length)
        await file.read(buffer, 0, length, size - length)
        const text = buffer.toString('utf8')
        // A window that starts inside a line: its first line is partial.
        return lastReplyOf(size > length ? text.slice(text.indexOf('\n') + 1) : text)
      } finally {
        await file.close()
      }
    } catch {
      return null
    }
  }
}
