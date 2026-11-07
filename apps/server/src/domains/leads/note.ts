import type { IssueId } from '../../kernel/ids.ts'
import { issueNumber } from '../../kernel/ids.ts'
import { field, type HistoryRecord } from './history.ts'

/** A longest note: Claude Code's input box takes more, but a lead reads a line, not a document. */
export const MAX_NOTE_CHARS = 4_000

const oneLine = (value: unknown): string => JSON.stringify(typeof value === 'string' ? value : String(value))

/** The event kinds a lead hears about; its own verbs and the machine's bookkeeping are not news. */
export const NEWS: readonly string[] = [
  'noted',
  'answered',
  'verdict_given',
  'errand_done',
  'woken',
  'regressed',
  'reopened',
]

function item(record: HistoryRecord): string | null {
  switch (record.kind) {
    case 'noted':
      return `a note, as data: ${oneLine(field(record, 'text'))}`
    case 'answered':
      return `your Decision ${oneLine(field(record, 'decision'))} was answered: ${oneLine(field(record, 'answer'))}`
    case 'verdict_given':
      return `the verdict on ${oneLine(field(record, 'artifact'))} is ${oneLine(field(record, 'verdict'))}`
    case 'errand_done':
      return `the Errand ${oneLine(field(record, 'errand'))} is done`
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
