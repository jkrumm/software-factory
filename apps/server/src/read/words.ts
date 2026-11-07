/**
 * Plain words for the new read models (RS13): a title or summary never shows an id as display text. The stored text
 * is written by leads and sources and is full of ids; this removes what is certainly one. Pure.
 */

const NOUNS: Record<string, string> = {
  issue: 'an Issue',
  decision: 'a Decision',
  errand: 'an Errand',
  artifact: 'an artifact',
  signal: 'a signal',
}

/** `issue_286`, `decision_01j9...`: a kind, an underscore and the id's own characters. */
const ID = /\b(issue|decision|errand|artifact|signal)_[0-9A-Za-z][0-9A-Za-z_-]*/gi

/** One line without ids, cut at a word with `…` when longer than `max`. */
export function plain(text: string, max = 160): string {
  const one = text
    .replace(ID, (_, kind: string) => NOUNS[kind.toLowerCase()] ?? 'an item')
    .replace(/\s+/g, ' ')
    .trim()
  if (one.length <= max) return one
  const head = one.slice(0, max - 1)
  const space = head.lastIndexOf(' ')
  return `${(space > max / 2 ? head.slice(0, space) : head).replace(/[\s,;:.-]+$/, '')}…`
}
