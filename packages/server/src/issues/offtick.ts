import { Waiting } from './effects.ts'
import { worktreeRetryMs } from './leadtree.ts'

/** Most jobs at once; the rest wait for a later pass. */
const DEFAULT_LIMIT = 4

/**
 * Port work too long for the tick (`make verify`, a fetch and a worktree removal), whose health is judged on its passes. A port asks by
 * key: the first ask starts the work and every ask throws `Waiting` until it is over, and then the next one returns or throws what it
 * threw. Work that threw is started again only after a backoff (30 s doubling to 5 min), so it is no ten-minute `make verify` per tick. A
 * stop aborts the signal each job was given, so no child of this process outlives it to meet its replacement's. Nothing here outlives
 * the process: a restart asks again and the work starts over, so work given here finds its own result by key.
 */
export class OffTick {
  private readonly running = new Map<string, Promise<void>>()
  private readonly over = new Map<string, { failure?: unknown }>()
  private readonly backoff = new Map<string, { failures: number; until: number }>()
  private readonly stopping = new AbortController()
  private readonly limit: number
  private readonly now: () => number

  constructor(options: { limit?: number; now?: () => number } = {}) {
    this.limit = options.limit ?? DEFAULT_LIMIT
    this.now = options.now ?? Date.now
  }

  async run(key: string, work: (signal: AbortSignal) => Promise<void>): Promise<void> {
    const ended = this.over.get(key)
    if (ended) {
      this.over.delete(key)
      if (ended.failure === undefined) {
        this.backoff.delete(key)
        return
      }
      const failures = (this.backoff.get(key)?.failures ?? 0) + 1
      this.backoff.set(key, { failures, until: this.now() + worktreeRetryMs(failures) })
      throw ended.failure
    }
    if (this.running.has(key)) throw new Waiting(`${key} is running`)
    if ((this.backoff.get(key)?.until ?? 0) > this.now()) throw new Waiting(`${key} backs off`)
    if (this.stopping.signal.aborted || this.running.size >= this.limit) throw new Waiting(`${key} waits for room`)
    const job = work(this.stopping.signal)
      .then(
        () => void this.over.set(key, {}),
        // Work that says it must wait is asked for again, from the start.
        (failure: unknown) => {
          if (!(failure instanceof Waiting)) this.over.set(key, { failure })
        },
      )
      .finally(() => this.running.delete(key))
    this.running.set(key, job)
    throw new Waiting(`${key} is running`)
  }

  /** Starts nothing more, stops what can be stopped, and waits up to `waitMs` for the rest: a shutdown does not release its lock under running work. */
  async stop(waitMs: number): Promise<void> {
    this.stopping.abort()
    await Promise.race([Promise.all(this.running.values()), Bun.sleep(waitMs)])
  }

  /** Waits for what is running now. The tests use it; the server never waits. */
  async settled(): Promise<void> {
    await Promise.all(this.running.values())
  }
}
