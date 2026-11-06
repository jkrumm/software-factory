import { open, stat } from 'node:fs/promises'
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

/** Transcripts remembered by path: a bounded cache, so a long-lived server holds a few thousand small records, not their files. */
export const CACHE_ENTRIES = 1024

/** The tool names that start a subagent. */
const SUBAGENT_TOOLS = new Set(['Agent', 'Task'])

const count = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0)

type Usage = Tokens

/**
 * The running count of one transcript, fed complete lines in file order. A line is data, parsed and never followed. Claude Code
 * writes an assistant message once per content block with the same message id, so usage is counted once per id (the last line of
 * an id wins) and a tool call once per tool-use id.
 */
class Counter {
  private readonly usageByMessage = new Map<string, Usage>()
  private readonly calls = new Set<string>()
  private readonly agents = new Set<string>()
  private readonly models: string[] = []
  private readonly tokens: Tokens = { ...NO_TOKENS }
  private anonymous = 0
  /** lines that were parsed as JSON, over this counter's whole life */
  parsed = 0

  private add(usage: Usage, sign: 1 | -1): void {
    this.tokens.input += sign * usage.input
    this.tokens.output += sign * usage.output
    this.tokens.cacheRead += sign * usage.cacheRead
    this.tokens.cacheWrite += sign * usage.cacheWrite
  }

  line(line: string): void {
    if (!line.includes('"assistant"')) return
    let entry: { type?: unknown; message?: { id?: unknown; model?: unknown; usage?: unknown; content?: unknown } }
    this.parsed++
    try {
      entry = JSON.parse(line) as typeof entry
    } catch {
      return
    }
    if (entry.type !== 'assistant' || typeof entry.message !== 'object' || entry.message === null) return
    const message = entry.message
    if (typeof message.model === 'string' && message.model !== '<synthetic>' && !this.models.includes(message.model)) {
      this.models.push(message.model)
    }
    if (Array.isArray(message.content)) {
      for (const block of message.content) {
        const b = block as { type?: unknown; name?: unknown; id?: unknown } | null
        if (b?.type !== 'tool_use' || typeof b.name !== 'string') continue
        const id = typeof b.id === 'string' ? b.id : `anonymous:${this.anonymous++}`
        this.calls.add(id)
        if (SUBAGENT_TOOLS.has(b.name)) this.agents.add(id)
      }
    }
    const u = message.usage as Record<string, unknown> | null | undefined
    if (typeof u !== 'object' || u === null) return
    const usage: Usage = {
      input: count(u.input_tokens),
      output: count(u.output_tokens),
      cacheRead: count(u.cache_read_input_tokens),
      cacheWrite: count(u.cache_creation_input_tokens),
    }
    if (typeof message.id === 'string') {
      const before = this.usageByMessage.get(message.id)
      if (before) this.add(before, -1)
      this.usageByMessage.set(message.id, usage)
    }
    this.add(usage, 1)
  }

  stats(): TranscriptStats {
    return {
      toolCalls: this.calls.size,
      subagents: this.agents.size,
      tokens: { ...this.tokens },
      models: [...this.models],
    }
  }
}

interface Cached {
  /** the file's identity: a different one is a different file */
  dev: number
  ino: number
  size: number
  mtimeMs: number
  /** the end of the last complete line counted */
  offset: number
  counter: Counter
  stats: TranscriptStats
}

/** The bytes of `path` from `from` up to `to`. */
async function readRange(path: string, from: number, to: number): Promise<Buffer> {
  const file = await open(path, 'r')
  try {
    const buffer = Buffer.alloc(to - from)
    let filled = 0
    while (filled < buffer.length) {
      const { bytesRead } = await file.read(buffer, filled, buffer.length - filled, from + filled)
      if (bytesRead === 0) break
      filled += bytesRead
    }
    return buffer.subarray(0, filled)
  } finally {
    await file.close()
  }
}

/**
 * Transcript counts for the read API. A transcript only grows, so each path keeps the byte offset after its last complete line
 * and the running totals: a later read counts just the appended bytes, never a half-written last line, and starts over if the
 * file shrank or is another file.
 */
export class TranscriptInsights {
  private readonly cache = new Map<string, Cached>()
  private readonly running = new Map<string, Promise<unknown>>()
  private linesParsed = 0

  constructor(private readonly limit = CACHE_ENTRIES) {}

  /** Never throws: a path outside Claude's transcripts, a missing or unreadable file is zeros and `partial`. */
  async read(transcriptPath: string | null): Promise<{ stats: TranscriptStats; partial: boolean }> {
    if (!transcriptPath) return { stats: NO_STATS, partial: true }
    const real = await resolveTranscript(transcriptPath)
    if (!real) return { stats: NO_STATS, partial: true }
    // one read of a path at a time, so two polls never count the same bytes twice
    const turn = (this.running.get(real) ?? Promise.resolve()).then(() => this.advance(real))
    const settled = turn.catch(() => undefined)
    this.running.set(real, settled)
    try {
      return { stats: await turn, partial: false }
    } catch {
      return { stats: NO_STATS, partial: true }
    } finally {
      if (this.running.get(real) === settled) this.running.delete(real)
    }
  }

  private async advance(real: string): Promise<TranscriptStats> {
    const info = await stat(real)
    let entry = this.cache.get(real)
    if (entry && (entry.dev !== info.dev || entry.ino !== info.ino || info.size < entry.offset)) entry = undefined
    if (entry?.size === info.size && entry.mtimeMs === info.mtimeMs) return this.keep(real, entry)
    const next: Cached = entry ?? {
      dev: info.dev,
      ino: info.ino,
      size: 0,
      mtimeMs: 0,
      offset: 0,
      counter: new Counter(),
      stats: NO_STATS,
    }
    const bytes = await readRange(real, next.offset, info.size)
    const end = bytes.lastIndexOf(0x0a) + 1
    if (end > 0) {
      const before = next.counter.parsed
      for (const line of bytes.subarray(0, end).toString('utf8').split('\n')) next.counter.line(line)
      this.linesParsed += next.counter.parsed - before
      next.offset += end
      next.stats = next.counter.stats()
    }
    next.size = info.size
    next.mtimeMs = info.mtimeMs
    return this.keep(real, next)
  }

  private keep(real: string, entry: Cached): TranscriptStats {
    this.cache.delete(real)
    this.cache.set(real, entry)
    for (const oldest of this.cache.keys()) {
      if (this.cache.size <= this.limit) break
      this.cache.delete(oldest)
    }
    return entry.stats
  }

  get size(): number {
    return this.cache.size
  }

  /** Lines parsed as JSON over this cache's life: a line counted once is never parsed again. */
  get parsed(): number {
    return this.linesParsed
  }
}

/** A stored session event, as the time counting reads it. */
export interface TimedEvent {
  kind: string
  at: Date
  /** of a `turn_ended`: it ended with background tasks still running (payload `backgroundTasks`) */
  background?: boolean
}

/**
 * Working time and turns from one session's events, ordered by time. `workingMs` is the time the session was busy: a span opens
 * at a `turn_started` and closes at the next `turn_ended` that is not a background one, a `session_ended`, a `pane_gone` or a
 * `session_started` (a new life). A `turn_ended` with `background` set (the agent ended its turn while background subagents
 * or tasks it started ran) does not close the span: the session is still busy and the next `turn_started` is only the wake-up.
 * A span still open at the end counts to `now`, unless the session is over (`endedAt`), then to that. `turns` counts every
 * `turn_started`.
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
    } else if (event.kind === 'turn_ended') {
      if (!event.background) close(at)
    } else if (event.kind === 'session_ended' || event.kind === 'pane_gone') {
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
