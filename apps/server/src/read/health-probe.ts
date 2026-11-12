export interface Probed {
  queueMovedAt: string | null
  doorLines: readonly string[]
}

export interface ProbeSnapshot extends Probed {
  /** why the last read failed (the database refused or broke), once it has done so for `DATABASE_FAILURE_GRACE_MS`; a read that is only slow is no failure */
  databaseFailure: string | null
}

/** A database that errors this long without one good read is down; a single refused read (a restart of Postgres) is not. */
export const DATABASE_FAILURE_GRACE_MS = 5 * 60_000

/**
 * The part of `/health` that needs the database, read in the background and served from memory. A request never waits
 * for it: on a host so loaded that a query takes 20 s, `/health` still answers at once with what the probe last saw. One
 * read at a time, so a hung database holds one connection, never a pile; the next read starts `everyMs` after the last ended.
 */
export function startHealthProbe(input: { everyMs: number; now: () => Date; read: () => Promise<Probed> }): {
  snapshot(): ProbeSnapshot
  stop(): void
} {
  let last: Probed = { queueMovedAt: null, doorLines: [] }
  let failing: { since: Date; why: string } | null = null
  let stopped = false
  let timer: ReturnType<typeof setTimeout> | null = null

  const run = async (): Promise<void> => {
    try {
      last = await input.read()
      failing = null
    } catch (error) {
      const why = `the database failed: ${error instanceof Error ? error.message : String(error)}`
      failing = { since: failing?.since ?? input.now(), why }
    }
    if (stopped) return
    timer = setTimeout(() => void run(), input.everyMs)
  }
  void run()

  return {
    snapshot: () => ({
      ...last,
      databaseFailure:
        failing !== null && input.now().getTime() - failing.since.getTime() >= DATABASE_FAILURE_GRACE_MS
          ? failing.why
          : null,
    }),
    stop() {
      stopped = true
      if (timer) clearTimeout(timer)
    },
  }
}
