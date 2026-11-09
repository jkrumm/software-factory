import type { LoopName, LoopView } from '@software-factory/contract'
import type { Clock } from '../../kernel/clock.ts'
import type { PortError, Result } from '../../kernel/result.ts'

/**
 * A loop (`docs/language.md`): a named tick with a trigger (an interval, or a kick when something changed), a budget (the
 * items its pass takes, one pass at a time) and one way to act. `run` is one pass and answers a line saying what it did.
 */
export interface LoopSpec {
  name: LoopName
  /** the clock trigger in ms; 0 turns the loop off: it runs only when asked (`runNow`), and no kick starts it */
  intervalMs: number
  /** an event (`changed`) kicks it besides the clock */
  onChange: boolean
  /** passes that may run at once; 1 (single-flight) unless a pass can take minutes and must not hold the next back */
  maxPasses?: number
  run(): Promise<Result<string, PortError>>
}

export interface LoopRunner {
  /**
   * Starts the clocks; a loop with no interval has none. With `passes` each loop is scheduled from its last recorded pass
   * (the first one after the time left of its interval, at once when it never ran); without, from now.
   */
  start(): Promise<void>
  /**
   * Stops the clocks and waits for the passes in flight, at most `graceMs`. A pass inside an agw call is not killed and not
   * waited out: its call is recorded in `loop_calls` and the next boot takes it up again under the same key.
   */
  stop(graceMs?: number): Promise<void>
  /**
   * One pass now, for `loop run` and the scenarios. A pass already running is not started again (single-flight): the
   * answer says so and waits for it.
   */
  runNow(name: LoopName): Promise<{ started: boolean; summary: string | null; error: string | null } | null>
  /**
   * Something changed. Every loop that listens for change, but the one that made it, starts a pass (or is marked to run once
   * more when it is in one). The loop guard: a change a loop made never fires that loop again.
   */
  changed(madeBy: LoopName | null): void
  view(): LoopView[]
  /** the last time a pass of the loop ended ok */
  lastOkAt(name: LoopName): Date | null
}

interface State {
  spec: LoopSpec
  timer: ReturnType<typeof setInterval> | ReturnType<typeof setTimeout> | null
  inFlight: Set<Promise<void>>
  again: boolean
  runs: number
  kicks: number
  droppedKicks: number
  lastStartedAt: Date | null
  lastPassAt: Date | null
  lastOkAt: Date | null
  lastError: string | null
  lastSummary: string | null
}

/** When each loop's pass last ended, kept across restarts (`migrations/1000_loop_passes.sql`). */
export interface LoopPasses {
  load(): Promise<ReadonlyMap<LoopName, Date>>
  record(name: LoopName, at: Date): Promise<void>
}

export function createLoopRunner(input: {
  loops: readonly LoopSpec[]
  clock: Clock
  passes?: LoopPasses
  log?: (message: string) => void
}): LoopRunner {
  const log = input.log ?? ((message: string) => console.error(message))
  const states = new Map<LoopName, State>(
    input.loops.map((spec) => [
      spec.name,
      {
        spec,
        timer: null,
        inFlight: new Set<Promise<void>>(),
        again: false,
        runs: 0,
        kicks: 0,
        droppedKicks: 0,
        lastStartedAt: null,
        lastPassAt: null,
        lastOkAt: null,
        lastError: null,
        lastSummary: null,
      },
    ]),
  )

  /** One pass; never throws. A problem that stands is logged once, not on every pass. */
  async function pass(state: State): Promise<void> {
    state.runs++
    state.lastStartedAt = input.clock.now()
    const before = state.lastError
    try {
      const result = await state.spec.run()
      if (result.ok) {
        state.lastOkAt = input.clock.now()
        state.lastError = null
        state.lastSummary = result.value
      } else {
        state.lastError = `${result.error.kind}: ${result.error.detail}`
      }
    } catch (error) {
      state.lastError = `crashed: ${error instanceof Error ? error.message : String(error)}`
    }
    if (state.lastError !== null && state.lastError !== before) log(`loop ${state.spec.name}: ${state.lastError}`)
    const at = input.clock.now()
    state.lastPassAt = at
    try {
      await input.passes?.record(state.spec.name, at)
    } catch (error) {
      log(`loop ${state.spec.name}: pass not recorded: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  const busy = (state: State): boolean => state.inFlight.size >= (state.spec.maxPasses ?? 1)

  /** Starts a pass unless the loop is at its limit (then waits for those); once more after it if something changed meanwhile. */
  function start(state: State): Promise<void> {
    if (busy(state)) return Promise.all(state.inFlight).then(() => undefined)
    const running: Promise<void> = (async () => {
      do {
        state.again = false
        await pass(state)
      } while (state.again)
    })().finally(() => {
      state.inFlight.delete(running)
    })
    state.inFlight.add(running)
    return running
  }

  let stopped = false
  /** false when the record could not be read: no loop is then known to be due, so each waits one interval from now */
  let recordRead = true

  /** Seeds each loop's last pass from the record; a record that cannot be read schedules every loop from boot. */
  async function loadPasses(passes: LoopPasses): Promise<void> {
    try {
      for (const [name, at] of await passes.load()) {
        const state = states.get(name)
        if (state) state.lastPassAt = at
      }
    } catch (error) {
      recordRead = false
      log(
        `loops: last passes not loaded, scheduling from boot: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }

  /** The clock of one loop: from now without a record, else the first pass after what is left of the interval since the last. */
  function arm(state: State): void {
    const { intervalMs } = state.spec
    const tick = () => {
      if (!busy(state)) void start(state)
    }
    if (!input.passes) {
      state.timer = setInterval(tick, intervalMs)
      return
    }
    const left = !recordRead
      ? intervalMs
      : state.lastPassAt
        ? state.lastPassAt.getTime() + intervalMs - input.clock.now().getTime()
        : 0
    state.timer = setTimeout(
      () => {
        tick()
        state.timer = setInterval(tick, intervalMs)
      },
      Math.max(0, left),
    )
  }

  return {
    async start() {
      if (input.passes) await loadPasses(input.passes)
      if (stopped) return
      for (const state of states.values()) if (state.spec.intervalMs > 0 && !state.timer) arm(state)
    },

    async stop(graceMs = Number.POSITIVE_INFINITY) {
      stopped = true
      for (const state of states.values()) {
        if (state.timer) clearTimeout(state.timer)
        state.timer = null
      }
      const passes = Promise.all([...states.values()].flatMap((state) => [...state.inFlight]))
      if (graceMs === Number.POSITIVE_INFINITY) await passes
      else await Promise.race([passes, Bun.sleep(graceMs)])
    },

    async runNow(name) {
      const state = states.get(name)
      if (!state) return null
      const started = !busy(state)
      await start(state)
      return { started, summary: state.lastSummary, error: state.lastError }
    },

    changed(madeBy) {
      for (const state of states.values()) {
        if (!state.spec.onChange || state.spec.intervalMs <= 0) continue
        if (state.spec.name === madeBy) {
          state.droppedKicks++
          continue
        }
        state.kicks++
        if (busy(state)) state.again = true
        else void start(state)
      }
    },

    view() {
      return [...states.values()].map((state) => ({
        name: state.spec.name,
        intervalMs: state.spec.intervalMs,
        onChange: state.spec.onChange,
        running: state.inFlight.size > 0,
        runs: state.runs,
        kicks: state.kicks,
        droppedKicks: state.droppedKicks,
        lastStartedAt: state.lastStartedAt?.toISOString() ?? null,
        lastPassAt: state.lastPassAt?.toISOString() ?? null,
        lastOkAt: state.lastOkAt?.toISOString() ?? null,
        lastError: state.lastError,
        lastSummary: state.lastSummary,
      }))
    },

    lastOkAt: (name) => states.get(name)?.lastOkAt ?? null,
  }
}
