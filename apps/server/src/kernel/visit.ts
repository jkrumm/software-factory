/** The very first band reaches this far back; a later visit's band begins where the last was seen, however long ago. */
export const FIRST_WINDOW_MS = 24 * 3_600_000
/** A read this long after the last one is a new visit. */
export const VISIT_GAP_MS = 30 * 60_000
