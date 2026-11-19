import * as z from 'zod'

/** The pure parts of the artifact page: quotes, paths, the frame's messages, the text index highlights are found in. */

/** The API's limits (`domains/checkpoints/artifact.ts`): a longer quote is refused, so the page never sends one. */
export const MAX_QUOTE = 2000
export const MAX_PATH = 500

/** A global comment hangs on the artifact's title with this path, and lists in its own "General" group. */
export const GLOBAL_PATH = 'global'

/** A selection as the API wants it: whitespace folded to single spaces, trimmed, cut to the limit. */
export function normalizeQuote(text: string): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, MAX_QUOTE)
}

export interface Heading {
  level: number
  text: string
}

/**
 * The heading path of a position: the headings before it in document order, each popping the ones at its level or deeper
 * ("Options > Cost"). `before` is in document order, the position's own heading last.
 */
export function headingPath(before: readonly Heading[]): string {
  const stack: Heading[] = []
  for (const heading of before) {
    while (stack.length > 0 && (stack.at(-1)?.level ?? 0) >= heading.level) stack.pop()
    stack.push(heading)
  }
  return stack
    .map((heading) => normalizeQuote(heading.text))
    .filter((text) => text !== '')
    .join(' > ')
    .slice(0, MAX_PATH)
}

/** What the annotator in an HTML artifact's frame posts out: the selected text and where it is, or that it is loaded. */
const FrameRectShape = z.object({ top: z.number().finite(), bottom: z.number().finite(), left: z.number().finite() })
/** The text kept either side of a quote, as the API takes it. */
const MAX_CONTEXT = 200
const FrameSelect = z.object({
  type: z.literal('factory.select'),
  quote: z.string().min(1).max(MAX_QUOTE),
  path: z.string().max(MAX_PATH),
  occurrence: z.number().int().min(0).optional(),
  prefix: z.string().max(MAX_CONTEXT).optional(),
  suffix: z.string().max(MAX_CONTEXT).optional(),
  rect: FrameRectShape,
})
const MAX_HREF = 2048
const MAX_HEADING = 300
const MAX_HEADINGS = 500

const FrameReady = z.object({ type: z.literal('factory.ready') })
const FrameOpen = z.object({
  type: z.literal('factory.open'),
  quote: z.string().min(1).max(MAX_QUOTE),
  id: z.string().max(200).optional(),
})
const FrameLink = z.object({ type: z.literal('factory.link'), href: z.string().min(1).max(MAX_HREF) })
const FrameHeadings = z.object({
  type: z.literal('factory.headings'),
  items: z
    .array(z.object({ level: z.number().int().min(1).max(6), text: z.string().max(MAX_HEADING) }))
    .max(MAX_HEADINGS),
})
const FrameSection = z.object({ type: z.literal('factory.section'), index: z.number().int().min(-1).max(MAX_HEADINGS) })

/** Where a selection sits: top, bottom and left edges, in the coordinates of the viewport the rect is relative to. */
export interface SelectionRect {
  top: number
  bottom: number
  left: number
}

/** Which of the equal passages a selection is, when the frame could tell: absent otherwise. */
export interface Occurrence {
  occurrence?: number
  prefix?: string
  suffix?: string
}

export type FrameMessage =
  | ({ type: 'select'; quote: string; path: string; rect: SelectionRect } & Occurrence)
  | { type: 'ready' }
  /** a click on a highlighted passage: the quote that was painted there, and the comment it was painted for */
  | { type: 'open'; quote: string; id?: string }
  /** a click on a link that leaves the frame: an absolute http(s) URL, to be opened by the page */
  | { type: 'link'; href: string }
  /** the document's headings in order, and the index of the one the reader is in (-1 before the first) */
  | { type: 'headings'; items: Heading[] }
  | { type: 'section'; index: number }

/** The message a frame posted, or null for anything that is not exactly one. */
export function parseFrameMessage(data: unknown): FrameMessage | null {
  if (FrameReady.safeParse(data).success) return { type: 'ready' }
  const open = FrameOpen.safeParse(data)
  if (open.success) {
    const quote = normalizeQuote(open.data.quote)
    return quote === '' ? null : { type: 'open', quote, ...(open.data.id ? { id: open.data.id } : {}) }
  }
  const link = FrameLink.safeParse(data)
  if (link.success) return /^https?:\/\//i.test(link.data.href) ? { type: 'link', href: link.data.href } : null
  const headings = FrameHeadings.safeParse(data)
  if (headings.success)
    return {
      type: 'headings',
      items: headings.data.items.map((item) => ({ level: item.level, text: normalizeQuote(item.text) })),
    }
  const section = FrameSection.safeParse(data)
  if (section.success) return { type: 'section', index: section.data.index }
  const parsed = FrameSelect.safeParse(data)
  if (!parsed.success) return null
  const quote = normalizeQuote(parsed.data.quote)
  if (quote === '') return null
  const { top, bottom, left } = parsed.data.rect
  const { occurrence, prefix, suffix } = parsed.data
  return {
    type: 'select',
    quote,
    path: parsed.data.path.trim(),
    // the three go together: an occurrence number without its text, or the reverse, is not believed
    ...(occurrence !== undefined && prefix !== undefined && suffix !== undefined ? { occurrence, prefix, suffix } : {}),
    rect: { top, bottom, left },
  }
}

/** The comment popover's width in px (22 rem); its height is measured. */
export const POPOVER_WIDTH = 352

/**
 * Where the comment popover opens: just below the selection, its left edge on the selection's, flipped above when it does
 * not fit below and kept inside the viewport. All in viewport coordinates, `box` being the popover's measured size.
 */
export function popoverPosition(
  selection: SelectionRect,
  box: { width: number; height: number },
  viewport: { width: number; height: number },
  gap = 8,
): { top: number; left: number } {
  const left = Math.max(gap, Math.min(selection.left, viewport.width - box.width - gap))
  const below = selection.bottom + gap
  const above = selection.top - gap - box.height
  const top =
    below + box.height <= viewport.height - gap ? below : above >= gap ? above : viewport.height - box.height - gap
  return { top: Math.max(gap, top), left }
}

/** Text nodes of a rendered page in order, each with its block: two blocks are never glued without a space. */
export interface TextPart {
  text: string
  block: unknown
}

export interface TextIndex {
  /** the readable text: whitespace folded, a space between blocks */
  flat: string
  /** for each character of `flat`, the part and the offset in it */
  at: ReadonlyArray<readonly [part: number, offset: number]>
}

export function indexText(parts: readonly TextPart[]): TextIndex {
  let flat = ''
  const at: Array<readonly [number, number]> = []
  let previous: unknown = undefined
  parts.forEach((part, i) => {
    if (part.block !== previous && flat !== '' && !flat.endsWith(' ')) {
      flat += ' '
      at.push([i, 0])
    }
    previous = part.block
    for (let offset = 0; offset < part.text.length; offset++) {
      const char = part.text[offset] ?? ''
      if (/\s/.test(char)) {
        if (flat === '' || flat.endsWith(' ')) continue
        flat += ' '
      } else {
        flat += char
      }
      at.push([i, offset])
    }
  })
  return { flat, at }
}

export interface Span {
  start: readonly [part: number, offset: number]
  end: readonly [part: number, offset: number]
}

/** The text kept either side of a selection to tell equal passages apart (the W3C TextQuoteSelector's prefix and suffix). */
const CONTEXT = 32

/** Which of the equal passages a comment hangs on: its quote, the heading path, and what tells the occurrences apart. */
export interface QuoteHint {
  /** the occurrence's number among the quote's matches in the text (0-based) */
  occurrence?: number | null
  prefix?: string | null
  suffix?: string | null
  path?: string | null
}

/*
 * The occurrence resolver below (occurrencesOf, anchorAround, resolveQuote) is the same algorithm as the block between
 * "anchor:begin" and "anchor:end" in public/frame/annotator.js; test/anchor.test.ts runs both against one table of cases.
 * Change them together.
 */

/** Every index of `wanted` in `flat`, overlapping ones too, in order. */
export function occurrencesOf(flat: string, wanted: string): number[] {
  const found: number[] = []
  if (wanted === '') return found
  for (let at = flat.indexOf(wanted); at !== -1; at = flat.indexOf(wanted, at + 1)) found.push(at)
  return found
}

/**
 * What to record when `wanted` is selected at `near` (the index in `flat` where the selection starts): the number of the
 * occurrence nearest to it, and the text around it. Null when the quote is not in the text or the position is unknown, so
 * the comment is made as before, on the quote alone.
 */
export function anchorAround(
  flat: string,
  wanted: string,
  near: number | null,
): { occurrence: number; prefix: string; suffix: string } | null {
  const found = occurrencesOf(flat, wanted)
  if (near === null || found.length === 0) return null
  let occurrence = 0
  found.forEach((at, i) => {
    if (Math.abs(at - near) < Math.abs((found[occurrence] ?? 0) - near)) occurrence = i
  })
  const from = found[occurrence] ?? 0
  return {
    occurrence,
    prefix: flat.slice(Math.max(0, from - CONTEXT), from),
    suffix: flat.slice(from + wanted.length, from + wanted.length + CONTEXT),
  }
}

/**
 * Where the comment's passage starts in `flat`, or -1. The quote must be there; of its occurrences the one with the same
 * prefix and suffix wins (it survives a revision that moves the text), then the occurrence number, then the first one
 * under the stored heading path (`pathAt` names the path of an index), then the first one: what a comment without a hint
 * always resolved to.
 */
export function resolveQuote(
  flat: string,
  wanted: string,
  hint?: QuoteHint | null,
  pathAt?: (index: number) => string,
): number {
  const found = occurrencesOf(flat, wanted)
  const first = found[0]
  if (first === undefined) return -1
  if (!hint || found.length === 1) return first
  const prefix = hint.prefix ?? ''
  const suffix = hint.suffix ?? ''
  const numbered = typeof hint.occurrence === 'number' ? found[hint.occurrence] : undefined
  if (prefix !== '' || suffix !== '') {
    const same = found.filter(
      (at) => flat.slice(Math.max(0, at - prefix.length), at) === prefix && flat.startsWith(suffix, at + wanted.length),
    )
    if (same.length > 0) return numbered !== undefined && same.includes(numbered) ? numbered : (same[0] ?? first)
  }
  if (numbered !== undefined) return numbered
  if (hint.path && pathAt) {
    const under = found.find((at) => pathAt(at) === hint.path)
    if (under !== undefined) return under
  }
  return first
}

/** A comment's passage as it is painted: its quote, the hint that says which occurrence, and the comment's id (what a click answers with). */
export interface PaintAnchor extends QuoteHint {
  id?: string
  quote: string
}

/** Where a quote sits in the index: the occurrence the hint names (else the first match), `end` after its last character. Null when it is not there. */
export function locateQuote(
  index: TextIndex,
  quote: string,
  hint?: QuoteHint | null,
  pathAt?: (index: number) => string,
): Span | null {
  const wanted = normalizeQuote(quote)
  if (wanted === '') return null
  const from = resolveQuote(index.flat, wanted, hint, pathAt)
  if (from === -1) return null
  const first = index.at[from]
  const last = index.at[from + wanted.length - 1]
  if (!first || !last) return null
  return { start: first, end: [last[0], last[1] + 1] }
}

export const KIND_WORDS = { concept: 'Concept', spec: 'Spec', decision: 'Decision', report: 'Report' } as const
export const FORMAT_WORDS = { markdown: 'Markdown', html: 'HTML' } as const
/** How the lead handled a comment: the word, and the tone the owner reads it in (a decline is not an error, so it is not red). */
export const DISPOSITION_WORDS = { applied: 'Applied', deferred: 'Deferred', declined: 'Declined' } as const
export const DISPOSITION_TONE = { applied: 'good', deferred: 'warn', declined: 'neutral' } as const
export const VERDICT_WORDS = {
  looks_good: 'Looks good',
  with_notes: 'With notes',
  changes: 'Changes',
  no_longer_applies: 'No longer applies',
} as const

/**
 * A heading path as a card shows it: the leading segment goes when it is the document's own name (its title, or its first
 * H1), since only one document is open and every path would start with it.
 */
export function displayPath(path: string, names: readonly string[]): string {
  const segments = path.split(' > ')
  const first = normalizeQuote(segments[0] ?? '').toLowerCase()
  if (segments.length > 1 && names.some((name) => normalizeQuote(name).toLowerCase() === first)) segments.shift()
  return segments.join(' > ')
}

/** The text of a Markdown document's first H1, or null: the document's name as its own text gives it. */
export function firstH1(markdown: string): string | null {
  const match = /^#[ \t]+(.+?)[ \t]*#*[ \t]*$/m.exec(markdown)
  return match?.[1] ? match[1].replace(/[*_`]/g, '') : null
}

/**
 * A heading's anchor, the way GitHub makes it: lower-case, everything but letters, digits, `_` and `-` dropped, and each
 * space a `-` (so "Options & Cost" is `options--cost`).
 */
export function slugOf(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, '')
    .replace(/\s/g, '-')
}

/** The ids of headings in order: the slug, a repeat getting `-1`, `-2`; an empty slug is `section`. */
export function headingIds(texts: readonly string[]): string[] {
  const seen = new Map<string, number>()
  return texts.map((text) => {
    const base = slugOf(text) || 'section'
    const n = seen.get(base) ?? 0
    seen.set(base, n + 1)
    return n === 0 ? base : `${base}-${n}`
  })
}

export interface TocItem extends Heading {
  id: string
}

/** What a link in a document does: scroll to a heading, open a new tab, open a Console page, or nothing. */
export type LinkTarget =
  | { kind: 'anchor'; id: string }
  | { kind: 'external'; url: string }
  | { kind: 'route'; path: string }
  | { kind: 'none' }

const CONSOLE_PAGE = /^\/(issues|artifacts)\/[^/?#]+/

/**
 * Where a link goes. `#id` scrolls inside the document; an absolute http(s) URL opens in a new tab, unless it is a page of
 * this Console (`origin`), which opens in place; a path to an Issue or an artifact is a Console page. Anything else (a
 * relative file, a wiki name, `mailto:`) has no destination here and is `none`.
 */
export function linkTarget(href: string | undefined, origin: string): LinkTarget {
  const value = (href ?? '').trim()
  if (value === '') return { kind: 'none' }
  if (value.startsWith('#')) {
    if (value.length === 1) return { kind: 'none' }
    try {
      return { kind: 'anchor', id: decodeURIComponent(value.slice(1)) }
    } catch {
      return { kind: 'anchor', id: value.slice(1) }
    }
  }
  if (value.startsWith('/') && !value.startsWith('//'))
    return CONSOLE_PAGE.test(value) ? { kind: 'route', path: value } : { kind: 'none' }
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return { kind: 'none' }
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return { kind: 'none' }
  if (url.origin === origin && CONSOLE_PAGE.test(url.pathname))
    return { kind: 'route', path: `${url.pathname}${url.search}` }
  return { kind: 'external', url: url.href }
}

export interface RevisionOf {
  revision: number
}

/**
 * The comments of the revision shown, and the others: earlier revisions' first (a comment from before the text changed),
 * then later ones (the owner is looking at an older revision).
 */
export function splitByRevision<T extends RevisionOf>(
  items: readonly T[],
  shown: number,
): { current: T[]; previous: T[]; later: T[] } {
  return {
    current: items.filter((item) => item.revision === shown),
    previous: items.filter((item) => item.revision < shown),
    later: items.filter((item) => item.revision > shown),
  }
}

/** What each verdict does to the lead, in the words the verdict control shows under its button. */
export const VERDICT_CONSEQUENCES = {
  looks_good: 'The lead builds as written.',
  with_notes: 'The lead builds and applies your comments.',
  changes: 'The lead revises and resubmits before building.',
  no_longer_applies: 'The lead drops this artifact and goes on.',
} as const satisfies Record<keyof typeof VERDICT_WORDS, string>
