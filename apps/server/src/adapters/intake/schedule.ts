/**
 * Runs `pass` every `everyMs`, one at a time: a pass that is still running when the next is due is skipped, and one that
 * throws is logged and does not stop the schedule. The first pass comes after `min(everyMs, firstMs)`, so a boot does not
 * start with the network. Returns the stop function, which waits for the pass in flight, for `graceMs` at most (a restart
 * measured a GitHub pass keeping the old process alive for 17 s): a pass cut off is simply not finished, the next boot polls again.
 */
export function selfPaced(
  name: string,
  everyMs: number,
  pass: () => Promise<void>,
  options: { firstMs?: number; log?: (line: string) => void } = {},
): (graceMs?: number) => Promise<void> {
  const log = options.log ?? ((line: string) => console.error(line))
  let running: Promise<void> | undefined
  let stopped = false
  const tick = () => {
    if (stopped || running) return
    running = pass()
      .catch((error: unknown) => log(`${name}: ${error instanceof Error ? error.message : String(error)}`))
      .finally(() => {
        running = undefined
      })
  }
  const first = setTimeout(tick, Math.min(everyMs, options.firstMs ?? 30_000))
  const timer = setInterval(tick, everyMs)
  return async (graceMs = Number.POSITIVE_INFINITY) => {
    stopped = true
    clearTimeout(first)
    clearInterval(timer)
    if (graceMs === Number.POSITIVE_INFINITY) await running
    else {
      await Promise.race([running, Bun.sleep(graceMs)])
      if (running) log(`${name}: still running ${graceMs / 1000}s after the stop; going on without it`)
    }
  }
}
