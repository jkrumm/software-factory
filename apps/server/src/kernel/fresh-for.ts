/**
 * Wraps an async read so concurrent callers share one run and a finished answer is reused for `ttlMs`. For a read that
 * costs far more than the answer changes (the capacity queue view spawns `sysctl` several times and opens a unit of
 * work, and every read route asked for it on every request). A run that rejects is not kept: the next call tries again.
 */
export function freshFor<T>(ttlMs: number, read: () => Promise<T>, now: () => number = Date.now): () => Promise<T> {
  let running: Promise<T> | null = null
  let kept: { value: T; at: number } | null = null
  return () => {
    if (kept && now() - kept.at < ttlMs) return Promise.resolve(kept.value)
    if (running) return running
    const run: Promise<T> = read()
      .then((value) => {
        kept = { value, at: now() }
        return value
      })
      .finally(() => {
        if (running === run) running = null
      })
    running = run
    return run
  }
}
