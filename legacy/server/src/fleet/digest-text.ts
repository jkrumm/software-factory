import { z } from 'zod'

/** What `agw digest` accepts per item, in UTF-16 units (a limit is checked as `.length`; more is refused, never cut). */
export const LIMIT = { heading: 300, session: 2_000, reply: 4_000 } as const

/** Postgres refuses NUL and a lone surrogate in jsonb: a text goes in and out of the cache only without them. */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g
export const wellFormed = (text: string): string => text.replace(LONE_SURROGATE, '�').replaceAll('\0', '')

/**
 * The first / last `n` UTF-16 units of a well-formed text, never through the middle of a surrogate pair: a cut that lands inside
 * one drops the half that is left.
 */
export function head(text: string, n: number): string {
  if (text.length <= n) return text
  const cut = text.slice(0, n)
  return /[\uD800-\uDBFF]$/.test(cut) ? cut.slice(0, -1) : cut
}
export function tail(text: string, n: number): string {
  if (text.length <= n) return text
  const cut = text.slice(text.length - n)
  return /^[\uDC00-\uDFFF]/.test(cut) ? cut.slice(1) : cut
}

export const cleanHeading = (text: string): string => head(wellFormed(text).replace(/\s+/g, ' ').trim(), LIMIT.heading)

/** A message cut to what a call takes: whole, else its start and its end (the question is usually last). */
export function boundReply(text: string): string {
  const t = wellFormed(text).trim()
  return t.length <= LIMIT.reply ? t : `${head(t, 1_000)}\n[…]\n${tail(t, LIMIT.reply - 1_010)}`
}

/** Characters that make a line read other than it is written: bidi overrides and isolates, and the zero-width spaces. */
// oxlint-disable-next-line prefer-regex-literals -- the formatter rewrites \uXXXX escapes of invisible characters in a regex literal into the characters themselves, which no reviewer can read
const SPOOFING = new RegExp(String.raw`[\u200B\u2060\uFEFF\u200E\u200F\u061C\u202A-\u202E\u2066-\u2069]`, 'g')
/** A control character that is not whitespace: removed (the whitespace ones become one space with the rest of the whitespace). */
const dropControl = (c: string): string => (/\s/.test(c) ? c : '')

/**
 * Model text that is stored and shown: one line, well-formed, without bidi overrides, zero-width spaces and control characters
 * (removed, never replaced by a space: a space would split a word), and of a bounded length. A joiner (ZWJ, ZWNJ) and the
 * variation selectors stay: an emoji sequence and a script need them.
 */
export const line = (max: number) =>
  z
    .string()
    .transform((t) =>
      wellFormed(t)
        .replace(SPOOFING, '')
        .replace(/\p{Cc}/gu, dropControl)
        .replace(/\s+/g, ' ')
        .trim(),
    )
    .pipe(z.string().min(1).max(max))
