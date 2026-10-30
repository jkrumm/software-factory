import { readdir, rename, stat, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { parseSpool, parseSummary, summarize } from '@software-factory/contract/spool'
import type { SQL } from 'bun'
import { EventInput } from './schemas.ts'
import { recordIn } from './sessions.ts'

/** An acknowledged spool larger than this is rotated once its session has been quiet for `QUIET_MS`. */
export const ROTATE_BYTES = 64 * 1024
export const QUIET_MS = 60_000

export interface ReplayResult {
  /** lines read, whether they were new to the database or not */
  lines: number
  /** lines that are not an event the server accepts; skipped, logged once per pass */
  rejected: number
  rotated: string[]
}

/**
 * Reads the spool directory the hooks append to and stores what the server has not yet acknowledged. A hook that
 * could not reach the server (or ran while it was down) lost nothing: its line is here. The unique key makes the
 * live post and the replay of the same line one event.
 *
 * "Acknowledged" is a byte offset per file, in memory: a restart starts again from zero and posts the lot, which the
 * keys make harmless, and rotation keeps what is re-read small. A rotated file leaves `<file>.base` behind, the
 * hook's count of turns and of the current turn's events, so numbering carries on where it was.
 */
export class SpoolReplayer {
  private readonly acked = new Map<string, number>()

  constructor(
    private readonly options: { sql: SQL; dir: string; now: () => Date; rotateBytes?: number; quietMs?: number },
  ) {}

  async replay(): Promise<ReplayResult> {
    const result: ReplayResult = { lines: 0, rejected: 0, rotated: [] }
    const files = await readdir(this.options.dir).catch(() => [] as string[])
    for (const file of files.filter((f) => f.endsWith('.jsonl')).sort()) {
      try {
        await this.replayFile(file, result)
      } catch (error) {
        // One unreadable file must not hold up the others.
        console.error('spool replay failed', { file, error: error instanceof Error ? error.message : String(error) })
      }
    }
    return result
  }

  private async replayFile(file: string, result: ReplayResult): Promise<void> {
    const path = join(this.options.dir, file)
    const info = await stat(path)
    this.acked.set(file, await this.ingest(file, path, Math.min(this.acked.get(file) ?? 0, info.size), result))
    await this.rotateIfDue(file, path, result)
  }

  /** Stores the whole lines from `from` on and returns the offset they end at. */
  private async ingest(file: string, path: string, from: number, result: ReplayResult): Promise<number> {
    const size = (await stat(path)).size
    if (size <= from) return from
    const text = await Bun.file(path).slice(from, size).text()
    // Only whole lines: a write in flight ends without its newline and is read on the next pass.
    const whole = text.slice(0, text.lastIndexOf('\n') + 1)
    const events = parseSpool(whole).flatMap((line) => {
      const parsed = EventInput.safeParse(line)
      if (parsed.success) return [parsed.data]
      result.rejected++
      console.error('spool line rejected', { file, key: line.key })
      return []
    })
    result.lines += events.length
    if (events.length) {
      await this.options.sql.begin(async (tx) => {
        for (const event of events) await recordIn(tx, event)
      })
    }
    return from + Buffer.byteLength(whole)
  }

  /** Fully acknowledged, large, and no hook has written for a minute: its sums go to `.base` and the file is retired. */
  private async rotateIfDue(file: string, path: string, result: ReplayResult): Promise<void> {
    const info = await stat(path)
    const { rotateBytes = ROTATE_BYTES, quietMs = QUIET_MS } = this.options
    if (info.size < rotateBytes || this.acked.get(file) !== info.size) return
    if (this.options.now().getTime() - info.mtimeMs < quietMs) return

    const base = parseSummary(
      await Bun.file(`${path}.base`)
        .text()
        .catch(() => ''),
    )
    const next = summarize(base, parseSpool(await Bun.file(path).text()))
    // The sums first, then the move: a hook between the two reads the new sums and the old file, which only skips ahead.
    await Bun.write(`${path}.base.tmp`, JSON.stringify(next))
    await rename(`${path}.base.tmp`, `${path}.base`)
    const retired = `${path}.retired`
    await rename(path, retired)
    // A hook that had the file open when it moved may still have appended: store that, then let the file go.
    await this.ingest(file, retired, info.size, result)
    await unlink(retired)
    this.acked.delete(file)
    result.rotated.push(file)
  }
}
