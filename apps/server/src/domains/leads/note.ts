import type { IssueId } from '../../kernel/ids.ts'
import { issueNumber } from '../../kernel/ids.ts'
import { field, type HistoryRecord } from './history.ts'

/** A longest note: Claude Code's input box takes more, but a lead reads a line, not a document. */
export const MAX_NOTE_CHARS = 4_000

const oneLine = (value: unknown): string => JSON.stringify(typeof value === 'string' ? value : String(value))

function item(record: HistoryRecord): string | null {
  switch (record.kind) {
    case 'noted':
      // Only the owner's own note is a word to follow; the factory's, the steward's and the Judge's stay data, and a
      // record that does not say who sent it is data too. The orchestrator is the owner's delegate: its note reaches a
      // lead exactly as the owner's does, so lead behaviour is the same whoever holds the pen.
      return record.actor === 'owner' || record.actor === 'orchestrator'
        ? `a note from the owner: ${oneLine(field(record, 'text'))}`
        : `a note, as data: ${oneLine(field(record, 'text'))}`
    case 'answered':
      return `your Decision ${oneLine(field(record, 'decision'))} was answered: ${oneLine(field(record, 'answer'))}`
    case 'verdict_given': {
      const artifact = field(record, 'artifact')
      const verdict = `the verdict on ${oneLine(artifact)} is ${oneLine(field(record, 'verdict'))}`
      return field(record, 'verdict') === 'changes'
        ? `${verdict}; read the annotations with \`factory artifact show ${String(artifact)}\`, answer each with \`factory artifact annotation-reply ${String(artifact)} <annotation-id> --disposition applied|deferred|declined --note <text>\`, then submit the revised artifact with \`factory artifact revise ${String(artifact)} --content @file\` (a push alone does not answer the verdict)`
        : verdict
    }
    case 'errand_done': {
      const turnedAway = field(record, 'turnedAway')
      if (typeof turnedAway === 'string')
        return `the Errand ${oneLine(field(record, 'errand'))} was turned away before it reached the owner: ${oneLine(turnedAway)}. Do it yourself, or raise it again with a different summary if it needs a person's hands (the same words are the same Errand)`
      return `the Errand ${oneLine(field(record, 'errand'))} is done`
    }
    case 'woken':
      return `your wait is over: ${oneLine(field(record, 'detail'))}`
    case 'regressed':
      return `the change regressed in the Watch: ${oneLine(field(record, 'detail'))}. Fix forward, then report again`
    case 'reopened':
      return `the Issue was reopened: ${oneLine(field(record, 'reason'))}`
    default:
      return null
  }
}

/**
 * What the lead is told for the events in `records`, as one line (a typed prompt is one line, and JSON quoting keeps
 * outside text from breaking out of it). Never starts with `-`. An empty range still says there is news to read.
 */
export function noteText(issue: IssueId, records: readonly HistoryRecord[]): string {
  const head = `Factory, Issue ${issueNumber(issue)}:`
  const items = records.flatMap((record) => item(record) ?? [])
  const body = items.length > 0 ? items.join(' | ') : `there is news; read it with \`factory issue show ${issue}\``
  const text = `${head} ${body}`
  return text.length > MAX_NOTE_CHARS ? `${text.slice(0, MAX_NOTE_CHARS - 1)}…` : text
}
