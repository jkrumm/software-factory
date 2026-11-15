import { createHash } from 'node:crypto'

/**
 * What makes two Errands the same need, so the second joins the first instead of paging the owner again. One key per
 * Errand, stored when it is raised: `need:` (the lead stated it), else `cmd:` (the same command, whitespace and a trailing
 * `;` aside), else `ask:` (the same one-line ask in the same repo). A need key and an ask are the repo's own; a command is
 * the same command wherever it is raised.
 */

export const MAX_NEED_KEY = 80
/** the alphabet of a lead's own need key: a short name, lowercase */
export const NEED_KEY_RE = /^[a-z0-9][a-z0-9._:/-]{0,79}$/

const digest = (text: string): string => createHash('sha256').update(text).digest('hex').slice(0, 16)

/** A command with its whitespace collapsed and no trailing `;` or `&`: what a person would call the same command. */
export const normalizeCommand = (command: string): string =>
  command
    .trim()
    .replace(/\s+/g, ' ')
    .replace(/[\s;&]+$/, '')

/** An ask in a word list: lowercase, no punctuation, one space between words. */
export const normalizeAsk = (summary: string): string =>
  summary
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()

export function matchKeyOf(input: {
  /** the repo whose Issue raised it, or the asker of a request */
  repo: string
  needKey: string | null
  command: string | null
  summary: string
}): string | null {
  if (input.needKey !== null) return `need:${input.repo}:${input.needKey}`
  if (input.command !== null) return `cmd:${digest(normalizeCommand(input.command))}`
  const ask = normalizeAsk(input.summary)
  return ask === '' ? null : `ask:${input.repo}:${digest(ask)}`
}
