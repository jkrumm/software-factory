import type { CapacityLoopModel, RetroCapacityFigure, RetroCapacityTune } from '@software-factory/contract'

/** Minutes a day over the load ceiling from which the loop takes less on. */
export const OVER_HIGH_PER_DAY = 60
/** Seat-hours a day idle behind a non-empty queue from which a gate is too tight. */
export const IDLE_HIGH_PER_DAY = 2
/** A test-slot wait (p90) from which the base of the slots is too small. */
export const WAIT_HIGH_MS = 10 * 60_000

type Totals = Pick<CapacityLoopModel, 'days' | 'throughput' | 'idleSeatHours' | 'minutesOverCeiling' | 'slotWait'>

/**
 * The capacity figures a retro signal can be filed against (`kpi=<key>` in its marker): per day, so a window of any length
 * compares with another. A figure with nothing behind it is null, never 0.
 */
export function capacityFigures(model: Totals): RetroCapacityFigure[] {
  const days = Math.max(1, model.days)
  return [
    {
      key: 'closed_per_day',
      label: 'Issues closed per day',
      value: model.throughput.total / days,
      unit: 'count',
    },
    {
      key: 'minutes_over_ceiling_per_day',
      label: 'Minutes a day over the load ceiling',
      value: model.minutesOverCeiling.total / days,
      unit: 'minutes',
    },
    {
      key: 'idle_seat_hours_per_day',
      label: 'Idle seat-hours a day behind a non-empty queue',
      value: model.idleSeatHours.total / days,
      unit: 'hours',
    },
    {
      key: 'slot_wait_p90_ms',
      label: 'Test-slot wait, p90',
      value: model.slotWait.n === 0 ? null : model.slotWait.p90Ms,
      unit: 'ms',
    },
  ]
}

const figure = (figures: readonly RetroCapacityFigure[], key: string): number | null =>
  figures.find((f) => f.key === key)?.value ?? null

/**
 * The one setting to change first, by fixed rules (no model): too much time over the ceiling takes less on (the seat bonus,
 * which the loop raises by itself, then the seats, then the extra slots); a machine under the ceiling with seats idle behind
 * a queue lets more in (the load ceiling); a long slot wait with the load low raises the base of the slots. Null when
 * nothing is out of range. The reason says what the rule saw; which gate held the queue is in `queue_time`'s parts.
 */
export function tuneConstant(
  figures: readonly RetroCapacityFigure[],
  constants: CapacityLoopModel['constants'],
): RetroCapacityTune | null {
  const over = figure(figures, 'minutes_over_ceiling_per_day') ?? 0
  const idle = figure(figures, 'idle_seat_hours_per_day') ?? 0
  const wait = figure(figures, 'slot_wait_p90_ms')
  const lowLoad = over < OVER_HIGH_PER_DAY / 2

  if (over >= OVER_HIGH_PER_DAY) {
    const seen = `${Math.round(over)} minutes a day were over the load ceiling`
    if (constants.seatsMaxBonus > 0)
      return {
        constant: 'seatsMaxBonus',
        direction: 'down',
        reason: `${seen}: stop raising seats past the account cap`,
      }
    if (constants.leadsPerAccount > 1)
      return { constant: 'leadsPerAccount', direction: 'down', reason: `${seen}: fewer leads per account` }
    if (constants.slotsMax > constants.slots)
      return { constant: 'slotsMax', direction: 'down', reason: `${seen}: fewer steps beyond the base slots` }
    return null
  }
  if (lowLoad && idle >= IDLE_HIGH_PER_DAY)
    return {
      constant: 'loadCeiling',
      direction: 'up',
      reason: `${idle.toFixed(1)} seat-hours a day sat idle behind a queue while the load was over the ceiling only ${Math.round(over)} minutes a day: check the queue reasons (\`queue_time\`) for the gate that held it, the ceiling first`,
    }
  if (lowLoad && wait !== null && wait >= WAIT_HIGH_MS && constants.slots < constants.slotsMax)
    return {
      constant: 'slots',
      direction: 'up',
      reason: `the test-slot wait p90 was ${Math.round(wait / 60_000)} minutes while the load stayed low`,
    }
  return null
}
