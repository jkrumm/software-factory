/**
 * The counting epoch (`config/throughput.json`): the one time before which no throughput read counts a sample. Rows older than
 * it stay in the tables (retention removes them on its own); a window it cuts short starts at it and says so.
 */

/** The window a read counts: `[from, to)` where `from` is the asked start or the epoch, whichever is later. */
export function countedFrom(from: Date, epoch: Date | null): Date {
  return epoch !== null && epoch.getTime() > from.getTime() ? epoch : from
}

/** Whether the epoch cuts a window that was asked to start at `from`. */
export const isCut = (from: Date, epoch: Date | null): boolean => epoch !== null && epoch.getTime() > from.getTime()

/** What a read model says about the epoch: the time, and where a cut window really starts (`countingSince`, null when whole). */
export interface EpochNote {
  at: string
  cut: boolean
  countingSince: string | null
}

export function epochNote(from: Date, epoch: Date | null): EpochNote | null {
  if (epoch === null) return null
  const cut = isCut(from, epoch)
  return { at: epoch.toISOString(), cut, countingSince: cut ? epoch.toISOString() : null }
}

/** A baseline over earlier days that the epoch cuts is judged only with this many whole days after the epoch. */
export const MIN_CUT_BASELINE_DAYS = 3
