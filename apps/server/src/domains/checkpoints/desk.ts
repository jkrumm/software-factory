import type { ErrandRecord } from './ports.ts'

/** The owner is back at the desk after this long without a Console read. */
export const PRESENCE_GAP_MS = 2 * 3_600_000
/** The desk pass runs at least this often, whether or not he came back. */
export const DESK_EVERY_MS = 6 * 3_600_000
/** While he is away, a pushed command is pushed again no sooner than this (it waits in a dialog until then). */
export const PUSH_AGAIN_MS = 6 * 3_600_000
/** Checks, re-screens and pushes one pass makes. */
export const DESK_CHECKS = 30
export const DESK_RESCREENS = 10

/** `ask-human.sh push`'s exit when the MacBook did not answer (ssh failed, or the answer made no sense). */
export const PUSH_UNREACHABLE = 69

/** Whether the owner coming back is a new visit: the first ever, or a read this long after the last one. */
export const cameBack = (seenAt: Date | null, now: Date): boolean =>
  seenAt === null || now.getTime() - seenAt.getTime() >= PRESENCE_GAP_MS

/**
 * The owner is back for this pass: he asked for it (`force`, the Needs you button), or something that marks his return
 * (a Console read after two hours or more, the MacBook answering after it was unreachable) is newer than the last pass.
 */
export function isReturn(input: { lastPassAt: Date | null; returnedAt: Date | null; force?: boolean }): boolean {
  if (input.force) return true
  const { lastPassAt, returnedAt } = input
  return lastPassAt !== null && returnedAt !== null && returnedAt.getTime() > lastPassAt.getTime()
}

/**
 * The desk pass is due when it never ran, when the owner came back since it last ran, when he asked for it, and in any
 * case every `DESK_EVERY_MS`: one pass over the open Errands, so a list that grew while he was away is cleaned before he
 * reads it.
 */
export function deskDue(input: {
  now: Date
  lastPassAt: Date | null
  returnedAt: Date | null
  force?: boolean
}): boolean {
  const { now, lastPassAt } = input
  if (lastPassAt === null || isReturn(input)) return true
  return now.getTime() - lastPassAt.getTime() >= DESK_EVERY_MS
}

/**
 * The MacBook commands the pass pushes, in order: an open Errand, Issue's or request, that reached the owner with a command
 * to run on the MacBook. One whose pushed run is still going in a MacBook terminal is left (a second push would run it
 * again).
 *
 * He is back: every one, oldest raised first, to be pushed one dialog at a time (the next after the last was answered or
 * timed out). He is away: the one never pushed, oldest first, else the one pushed longest ago, and none within
 * `PUSH_AGAIN_MS` of its last push; a pile of dialogs is what he would come back to.
 */
export function pushQueue(open: readonly ErrandRecord[], now: Date, returned: boolean): ErrandRecord[] {
  const pending = open.filter(
    (errand) =>
      errand.doneAt === null &&
      errand.reachedOwnerAt !== null &&
      errand.command !== null &&
      errand.host === 'macbook' &&
      errand.runStatus !== 'running',
  )
  // a stable sort: among equals the list's order stays
  if (returned) return pending.toSorted((a, b) => a.raisedAt.getTime() - b.raisedAt.getTime())
  const pushedAt = (errand: ErrandRecord): number => errand.pushedAt?.getTime() ?? 0
  const due = pending.filter(
    (errand) => errand.pushedAt === null || now.getTime() - errand.pushedAt.getTime() >= PUSH_AGAIN_MS,
  )
  const first = due.toSorted((a, b) => pushedAt(a) - pushedAt(b))[0]
  return first ? [first] : []
}
