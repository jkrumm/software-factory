import type { Host } from '../../kernel/hands.ts'
import { normalizeAsk, normalizeCommand } from './match.ts'
import type { Need } from './need.ts'
import { type Declined, DECLINE_HOLD_MS, type Triage, triage, type StatedNeed } from './triage.ts'

/**
 * Replays recorded Errands (`factory errand list --format json`) through the rules of `triage.ts`, to show which would still
 * reach the owner and why. The recorded need stands for what the lead would have stated; the one the owner turned back stands
 * for the hold. Pure: `scripts/errand-replay.ts` reads the list and prints this.
 */

/** The fields of an Errand the replay reads (a subset of the list's rows). */
export interface ReplayRow {
  id: string
  issueId: string | null
  summary: string
  detail: string | null
  command: string | null
  host: Host | null
  need: Need | null
  raisedAt: string
  doneAt: string | null
  doneNote: string | null
  closedKind: string | null
  closedBy: string | null
}

export type ReplayOutcome =
  | { kind: 'reach'; why: string }
  | { kind: 'refused'; rule: string }
  | { kind: 'run'; verb: string }

export interface Replayed {
  row: ReplayRow
  outcome: ReplayOutcome
}

/** What makes two recorded Errands the same need for the hold: the command, else the one-line ask (the repo is not in the list). */
const sameKey = (row: ReplayRow): string | null =>
  row.command !== null
    ? `cmd:${normalizeCommand(row.command)}`
    : normalizeAsk(row.summary) === ''
      ? null
      : `ask:${normalizeAsk(row.summary)}`

/** The stated need of a recorded Errand: the stored one, except `approval`, which is only ever a rule's word. */
const statedOf = (need: Need | null): StatedNeed | null => (need === null || need === 'approval' ? null : need)

/** Why an Errand that the rules let through still reaches the owner, in the owner's words. */
function whyReach(row: ReplayRow): string {
  if (row.need === 'secret') return 'a secret, a password or a passphrase only he has'
  if (row.need === 'hands') return 'his hands: a device, a portal, a physical step or a look'
  if (row.need === 'approval') return 'only his yes (a restart, a gate release, a delete)'
  if (row.need === 'place') return 'a command for his MacBook outside the fixed classes'
  return 'no need recorded: the rules cannot place it'
}

/** Replays the Errands oldest first, so a turn-back holds the asks that came after it. */
export function replayErrands(rows: readonly ReplayRow[]): Replayed[] {
  const ordered = rows.toSorted((a, b) => Date.parse(a.raisedAt) - Date.parse(b.raisedAt))
  const turnedBack = new Map<string, Declined>()
  const out: Replayed[] = []
  for (const row of ordered) {
    const key = sameKey(row)
    const raisedAt = new Date(row.raisedAt)
    const held = key === null ? undefined : turnedBack.get(key)
    const answer: Triage = triage(
      { summary: row.summary, detail: row.detail, command: row.command, host: row.host },
      {
        standalone: row.issueId === null,
        stated: statedOf(row.need),
        declined: held && raisedAt.getTime() - held.at.getTime() < DECLINE_HOLD_MS ? held : null,
        now: raisedAt,
      },
    )
    out.push({
      row,
      outcome:
        answer.action === 'refuse'
          ? { kind: 'refused', rule: answer.rule }
          : answer.action === 'run'
            ? { kind: 'run', verb: answer.verb.verb }
            : { kind: 'reach', why: whyReach(row) },
    })
    if (
      key !== null &&
      row.closedKind === 'turned_back' &&
      (row.closedBy === 'owner' || row.closedBy === 'orchestrator')
    )
      turnedBack.set(key, { at: new Date(row.doneAt ?? row.raisedAt), note: row.doneNote ?? '' })
  }
  return out
}

/** The Errands whose recorded need is a secret, a password, a passphrase or hands, and that the rules would run: must be none. */
export const wronglyRun = (replayed: readonly Replayed[]): Replayed[] =>
  replayed.filter(({ row, outcome }) => outcome.kind === 'run' && (row.need === 'secret' || row.need === 'hands'))

export interface ReplaySummary {
  total: number
  reach: number
  refused: number
  run: number
  /** reaching the owner, by recorded need (`none` for one with none recorded) */
  reachByNeed: Record<string, number>
  refusedByRule: Record<string, number>
  runByVerb: Record<string, number>
}

export function summarize(replayed: readonly Replayed[]): ReplaySummary {
  const summary: ReplaySummary = {
    total: replayed.length,
    reach: 0,
    refused: 0,
    run: 0,
    reachByNeed: {},
    refusedByRule: {},
    runByVerb: {},
  }
  const bump = (counts: Record<string, number>, key: string): void => void (counts[key] = (counts[key] ?? 0) + 1)
  for (const { row, outcome } of replayed) {
    if (outcome.kind === 'reach') {
      summary.reach++
      bump(summary.reachByNeed, row.need ?? 'none')
    } else if (outcome.kind === 'refused') {
      summary.refused++
      bump(summary.refusedByRule, outcome.rule)
    } else {
      summary.run++
      bump(summary.runByVerb, outcome.verb)
    }
  }
  return summary
}
