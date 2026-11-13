import type { ErrandRecord } from './ports.ts'

/** The owner is back at the desk after this long without a Console read. */
export const PRESENCE_GAP_MS = 2 * 3_600_000
/** The desk pass runs at least this often, whether or not he came back. */
export const DESK_EVERY_MS = 6 * 3_600_000
/** A pushed command is pushed again no sooner than this (it waits in a dialog until then). */
export const PUSH_AGAIN_MS = 6 * 3_600_000
/** Checks, re-screens and pushes one pass makes. */
export const DESK_CHECKS = 30
export const DESK_RESCREENS = 10

/** Whether the owner coming back is a new visit: the first ever, or a read this long after the last one. */
export const cameBack = (seenAt: Date | null, now: Date): boolean =>
  seenAt === null || now.getTime() - seenAt.getTime() >= PRESENCE_GAP_MS

/**
 * The desk pass is due when it never ran, when the owner came back since it last ran, and in any case every
 * `DESK_EVERY_MS`: one pass over the open Errands, so a list that grew while he was away is cleaned before he reads it.
 */
export function deskDue(input: { now: Date; lastPassAt: Date | null; returnedAt: Date | null }): boolean {
  const { now, lastPassAt, returnedAt } = input
  if (lastPassAt === null) return true
  if (returnedAt !== null && returnedAt.getTime() > lastPassAt.getTime()) return true
  return now.getTime() - lastPassAt.getTime() >= DESK_EVERY_MS
}

/**
 * The one MacBook command Errand the pass pushes: an open request that reached the owner with a command to run on the
 * MacBook, never pushed first (oldest first), then the one pushed longest ago, and none pushed within `PUSH_AGAIN_MS`.
 * One at a time: every dialog waits for a click, and a pile of them is what the owner came back to.
 */
export function nextPush(open: readonly ErrandRecord[], now: Date): ErrandRecord | null {
  const due = open.filter(
    (errand) =>
      errand.doneAt === null &&
      errand.reachedOwnerAt !== null &&
      errand.command !== null &&
      errand.host === 'macbook' &&
      errand.source !== null &&
      (errand.pushedAt === null || now.getTime() - errand.pushedAt.getTime() >= PUSH_AGAIN_MS),
  )
  const pushedAt = (errand: ErrandRecord): number => errand.pushedAt?.getTime() ?? 0
  // a stable sort: among equals the list's order (oldest raised first) stays
  return due.toSorted((a, b) => pushedAt(a) - pushedAt(b))[0] ?? null
}
