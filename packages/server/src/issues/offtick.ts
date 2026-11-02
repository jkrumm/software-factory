import { Waiting } from './effects.ts'

/** Most jobs at once; the rest wait for a later pass. */
const DEFAULT_LIMIT = 4

/**
 * Port work too long for the tick (`make verify`, a fetch and a worktree removal), whose health is judged on its passes. A port asks by
 * key: the first ask starts the work and every ask throws `Waiting` until it is over, and then the next one returns or throws what it
 * threw. Nothing here outlives the process: a restart asks again and the work starts over, so work given here finds its own result by key.
 */
export class OffTick {
  private readonly running = new Map<string, Promise<void>>()
  private readonly over = new Map<string, { failure?: unknown }>()
  private stopped = false

  constructor(private readonly limit = DEFAULT_LIMIT) {}

  async run(key: string, work: () => Promise<void>): Promise<void> {
    const ended = this.over.get(key)
    if (ended) {
      this.over.delete(key)
      if (ended.failure !== undefined) throw ended.failure
      return
    }
    if (this.running.has(key)) throw new Waiting(`${key} is running`)
    if (this.stopped || this.running.size >= this.limit) throw new Waiting(`${key} waits for room`)
    const job = work()
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

  /** Starts nothing more, and waits up to `waitMs` for what is running: a shutdown does not release its lock under a running `make`. */
  async stop(waitMs: number): Promise<void> {
    this.stopped = true
    await Promise.race([Promise.all(this.running.values()), Bun.sleep(waitMs)])
  }

  /** Waits for what is running now. The tests use it; the server never waits. */
  async settled(): Promise<void> {
    await Promise.all(this.running.values())
  }
}
