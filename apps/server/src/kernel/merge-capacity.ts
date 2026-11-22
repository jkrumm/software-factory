/**
 * What a repo can merge: its pull requests land one at a time through `factory merge-lock`, and a window is held from the
 * rebase through CI to the merge, so the median hold bounds the merges a day, whatever the lead cap says. The throughput loop
 * reads it before it proposes more leads for a repo, and the project page shows it beside the merges that happened. No I/O here.
 */
import type { ProjectMerge } from '@software-factory/contract'
import { MERGE_BUSY_SHARE, MERGE_WAIT_P90_MINUTES } from './throughput-limits.ts'

const DAY_MINUTES = 24 * 60

/** The measured side of a repo's merge windows and CI runs over `days` (`read/merge-capacity.ts`). */
export interface MergeFigures {
  days: number
  /** merge-lock calls that got the window */
  windows: number
  /** of those, the ones whose command exited 0 */
  merges: number
  /** the minutes the window was held in all */
  heldMinutes: number
  holdMedianMinutes: number
  waitMedianMinutes: number
  waitP90Minutes: number
  /** the median minutes a finished CI run of the repo waited for a runner, and ran; null: no run in the window */
  ciQueueMedianMinutes: number | null
  ciRunMedianMinutes: number | null
}

const round = (value: number, places = 1): number => Math.round(value * 10 ** places) / 10 ** places

/** The figures with what they mean: the merges a day it carried against the most its median hold allows; null when no window was held. */
export function mergeCapacityOf(figures: MergeFigures): ProjectMerge | null {
  if (figures.windows === 0 || figures.days <= 0) return null
  const busyShare = Math.min(1, figures.heldMinutes / (figures.days * DAY_MINUTES))
  return {
    days: figures.days,
    windows: figures.windows,
    merges: figures.merges,
    mergesPerDay: round(figures.merges / figures.days),
    allowedPerDay: Math.floor(DAY_MINUTES / Math.max(figures.holdMedianMinutes, 1)),
    busyShare: round(busyShare, 2),
    holdMedianMinutes: round(figures.holdMedianMinutes),
    waitMedianMinutes: round(figures.waitMedianMinutes),
    waitP90Minutes: round(figures.waitP90Minutes),
    ciQueueMedianMinutes: figures.ciQueueMedianMinutes === null ? null : round(figures.ciQueueMedianMinutes),
    ciRunMedianMinutes: figures.ciRunMedianMinutes === null ? null : round(figures.ciRunMedianMinutes),
    saturated: busyShare >= MERGE_BUSY_SHARE || figures.waitP90Minutes >= MERGE_WAIT_P90_MINUTES,
  }
}

/** One line of what the repo merges against what its window allows, for a signal's text. */
export function mergeCapacityText(c: ProjectMerge): string {
  const ci =
    c.ciRunMedianMinutes === null
      ? ''
      : `; CI waited for a runner a median ${c.ciQueueMedianMinutes ?? 0} min and ran ${c.ciRunMedianMinutes} min`
  return `${c.merges} merge${c.merges === 1 ? '' : 's'} in ${c.days} day${c.days === 1 ? '' : 's'} (${c.mergesPerDay} a day) against the ${c.allowedPerDay} a day a median hold of ${c.holdMedianMinutes} min allows; the window was held ${Math.round(c.busyShare * 100)} % of the time and a call waited a median ${c.waitMedianMinutes} min (slowest tenth ${c.waitP90Minutes} min)${ci}`
}
