import { cameBack } from '../domains/checkpoints/desk.ts'
import { FIRST_WINDOW_MS, VISIT_GAP_MS } from '../kernel/visit.ts'
import { ok, type PortError, type Result } from '../kernel/result.ts'
import type { UnitOfWork } from './unit-of-work.ts'

export interface VisitMarker {
  seenAt: Date
  sinceAt: Date
  /** the last time he came back after two hours or more away (the first read counts); the desk pass reads it */
  returnedAt: Date | null
}

/** The owner's visit marker (`migrations/1003_console_visit.sql`), inside one transaction. */
export interface VisitStore {
  /** null before the first visit */
  marker(): Promise<VisitMarker | null>
  save(marker: VisitMarker): Promise<void>
}

/**
 * The owner reads the band at `now`: the first visit looks back 24 hours; a read more than 30 minutes after the last
 * one starts a new visit, whose band begins where the last one was seen; any other read only moves `seenAt`. A read two
 * hours or more after the last one also marks that he is back (`returnedAt`), which makes the desk pass due. Answers
 * where the band begins, and whether this read was his return: the caller starts the desk pass at once.
 */
export async function registerVisit(
  uow: UnitOfWork<{ visits: VisitStore }>,
  now: Date,
): Promise<Result<{ since: Date; returned: boolean }, PortError>> {
  return uow.run(async ({ visits }) => {
    const marker = await visits.marker()
    const sinceAt = !marker
      ? new Date(now.getTime() - FIRST_WINDOW_MS)
      : now.getTime() - marker.seenAt.getTime() > VISIT_GAP_MS
        ? marker.seenAt
        : marker.sinceAt
    const returned = cameBack(marker?.seenAt ?? null, now)
    const returnedAt = returned ? now : (marker?.returnedAt ?? null)
    await visits.save({ seenAt: now, sinceAt, returnedAt })
    return ok({ since: sinceAt, returned })
  })
}
