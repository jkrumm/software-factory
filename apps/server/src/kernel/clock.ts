/** What time it is, a port so a test decides. */
export interface Clock {
  now(): Date
}

export const systemClock: Clock = { now: () => new Date() }

export interface FixedClock extends Clock {
  set(at: Date): void
  advance(ms: number): void
}

/** A clock that moves only when told to. */
export function fixedClock(start: Date | string): FixedClock {
  let at = new Date(start)
  return {
    now: () => new Date(at),
    set: (next) => {
      at = new Date(next)
    },
    advance: (ms) => {
      at = new Date(at.getTime() + ms)
    },
  }
}
