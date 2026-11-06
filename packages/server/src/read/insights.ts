import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { createInterface } from 'node:readline'
import type { Insights, Tokens } from '@software-factory/contract'
import { resolveTranscript } from '../fleet/transcript.ts'

/** What a transcript adds up to. Counted from the file, never from the events. */
export interface TranscriptStats {
  toolCalls: number
  subagents: number
  tokens: Tokens
  /** in order of first appearance */
  models: string[]
}

export const NO_TOKENS: Tokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
export const NO_STATS: TranscriptStats = { toolCalls: 0, subagents: 0, tokens: NO_TOKENS, models: [] }

/** Transcripts remembered by path: a bounded cache, so a long-lived server holds a few hundred small records, not their files. */
export const CACHE_ENTRIES = 256

/** The tool names that start a subagent. */
const SUBAGENT_TOOLS = new Set(['Agent', 'Task'])

const count = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0)

interface Usage {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
}

/**
 * One transcript, line by line: a line is data, parsed and never followed. Claude Code writes an assistant message once per
 * content block with the same message id, so usage is counted once per id (the last line of an id wins) and a tool call once
 * per tool-use id.
 */
export async function countTranscript(path: string): Promise<TranscriptStats> {
  const usageByMessage = new Map<string, Usage>()
  const loose: Usage[] = []
  const calls = new Set<string>()
  const agents = new Set<string>()
  const models: string[] = []
  let anonymous = 0
  const lines = createInterface({ input: createReadStream(path, { encoding: 'utf8' }), crlfDelay: Infinity })
  for await (const line of lines) {
    if (!line.includes('"assistant"')) continue
    let entry: { type?: unknown; message?: { id?: unknown; model?: unknown; usage?: unknown; content?: unknown } }
    try {
      entry = JSON.parse(line) as typeof entry
    } catch {
      continue
    }
    if (entry.type !== 'assistant' || typeof entry.message !== 'object' || entry.message === null) continue
    const message = entry.message
    if (typeof message.model === 'string' && message.model !== '<synthetic>' && !models.includes(message.model)) {
      models.push(message.model)
    }
    if (Array.isArray(message.content)) {
      for (const block of message.content) {
        const b = block as { type?: unknown; name?: unknown; id?: unknown } | null
        if (b?.type !== 'tool_use' || typeof b.name !== 'string') continue
        const id = typeof b.id === 'string' ? b.id : `anonymous:${anonymous++}`
        calls.add(id)
        if (SUBAGENT_TOOLS.has(b.name)) agents.add(id)
      }
    }
    const u = message.usage as Record<string, unknown> | null | undefined
    if (typeof u !== 'object' || u === null) continue
    const usage: Usage = {
      input: count(u.input_tokens),
      output: count(u.output_tokens),
      cacheRead: count(u.cache_read_input_tokens),
      cacheWrite: count(u.cache_creation_input_tokens),
    }
    if (typeof message.id === 'string') usageByMessage.set(message.id, usage)
    else loose.push(usage)
  }
  const tokens = { ...NO_TOKENS }
  for (const usage of [...usageByMessage.values(), ...loose]) {
    tokens.input += usage.input
    tokens.output += usage.output
    tokens.cacheRead += usage.cacheRead
    tokens.cacheWrite += usage.cacheWrite
  }
  return { toolCalls: calls.size, subagents: agents.size, tokens, models }
}

interface Cached {
  size: number
  mtimeMs: number
  stats: TranscriptStats
}

/** Transcript counts for the read API: read once, counted again only when the file's size or mtime moved. */
export class TranscriptInsights {
  private readonly cache = new Map<string, Cached>()

  constructor(private readonly limit = CACHE_ENTRIES) {}

  /** Never throws: a path outside Claude's transcripts, a missing or unreadable file is zeros and `partial`. */
  async read(transcriptPath: string | null): Promise<{ stats: TranscriptStats; partial: boolean }> {
    if (!transcriptPath) return { stats: NO_STATS, partial: true }
    const real = await resolveTranscript(transcriptPath)
    if (!real) return { stats: NO_STATS, partial: true }
    try {
      const { size, mtimeMs } = await stat(real)
      const known = this.cache.get(real)
      if (known?.size === size && known.mtimeMs === mtimeMs) return { stats: known.stats, partial: false }
      const stats = await countTranscript(real)
      this.cache.delete(real)
      this.cache.set(real, { size, mtimeMs, stats })
      for (const oldest of this.cache.keys()) {
        if (this.cache.size <= this.limit) break
        this.cache.delete(oldest)
      }
      return { stats, partial: false }
    } catch {
      return { stats: NO_STATS, partial: true }
    }
  }

  get size(): number {
    return this.cache.size
  }
}

/** A stored session event, as the time counting reads it. */
export interface TimedEvent {
  kind: string
  at: Date
}

/**
 * Working time and turns from one session's events, ordered by time: `turn_started` opens a turn, `turn_ended` closes it. A turn
 * a new life, the session's end or a pane that is gone interrupts ends there; one still open at the end counts to `now`, unless
 * the session is over (`endedAt`), then it counts to that.
 */
export function workingOf(
  events: readonly TimedEvent[],
  now: Date,
  endedAt: Date | null,
): { workingMs: number; turns: number } {
  let open: number | null = null
  let workingMs = 0
  let turns = 0
  const close = (at: number) => {
    if (open !== null) workingMs += Math.max(0, at - open)
    open = null
  }
  for (const event of events) {
    const at = event.at.getTime()
    if (event.kind === 'turn_started') {
      if (open === null) open = at
      turns++
    } else if (event.kind === 'turn_ended' || event.kind === 'session_ended' || event.kind === 'pane_gone') {
      close(at)
    } else if (event.kind === 'session_started') {
      close(at)
    }
  }
  close((endedAt ?? now).getTime())
  return { workingMs, turns }
}

/** The parts of an Issue's sessions, summed into one record. */
export function sumInsights(
  parts: readonly Pick<Insights, 'workingMs' | 'turns' | 'toolCalls' | 'subagents' | 'tokens' | 'models' | 'partial'>[],
): Pick<Insights, 'workingMs' | 'turns' | 'toolCalls' | 'subagents' | 'tokens' | 'models' | 'partial'> {
  const tokens = { ...NO_TOKENS }
  const models: string[] = []
  let partial = false
  const total = { workingMs: 0, turns: 0, toolCalls: 0, subagents: 0 }
  for (const part of parts) {
    total.workingMs += part.workingMs
    total.turns += part.turns
    total.toolCalls += part.toolCalls
    total.subagents += part.subagents
    tokens.input += part.tokens.input
    tokens.output += part.tokens.output
    tokens.cacheRead += part.tokens.cacheRead
    tokens.cacheWrite += part.tokens.cacheWrite
    for (const model of part.models) if (!models.includes(model)) models.push(model)
    partial ||= part.partial
  }
  return { ...total, tokens, models, partial }
}
