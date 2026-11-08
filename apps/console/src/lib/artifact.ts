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
const FrameSelect = z.object({
  type: z.literal('factory.select'),
  quote: z.string().min(1).max(MAX_QUOTE),
  path: z.string().max(MAX_PATH),
})
const FrameReady = z.object({ type: z.literal('factory.ready') })

export type FrameMessage = { type: 'select'; quote: string; path: string } | { type: 'ready' }

/** The message a frame posted, or null for anything that is not exactly one. */
export function parseFrameMessage(data: unknown): FrameMessage | null {
  if (FrameReady.safeParse(data).success) return { type: 'ready' }
  const parsed = FrameSelect.safeParse(data)
  if (!parsed.success) return null
  const quote = normalizeQuote(parsed.data.quote)
  if (quote === '') return null
  return { type: 'select', quote, path: parsed.data.path.trim() }
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

/** Where a quote sits in the index: the first match, `end` after its last character. Null when it is not there. */
export function locateQuote(index: TextIndex, quote: string): Span | null {
  const wanted = normalizeQuote(quote)
  if (wanted === '') return null
  const from = index.flat.indexOf(wanted)
  if (from === -1) return null
  const first = index.at[from]
  const last = index.at[from + wanted.length - 1]
  if (!first || !last) return null
  return { start: first, end: [last[0], last[1] + 1] }
}

export interface AnnotationLike {
  path: string | null
}

/**
 * The page's groups: General (the global comments, whichever list the API put them in), the anchored ones, and the
 * Unanchored ones. A global comment's quote is the title, so the API may call it either.
 */
export function groupAnnotations<T extends AnnotationLike>(
  anchored: readonly T[],
  unanchored: readonly T[],
): { general: T[]; anchored: T[]; unanchored: T[] } {
  const isGeneral = (a: T) => a.path === GLOBAL_PATH
  return {
    general: [...anchored, ...unanchored].filter(isGeneral),
    anchored: anchored.filter((a) => !isGeneral(a)),
    unanchored: unanchored.filter((a) => !isGeneral(a)),
  }
}

export const KIND_WORDS = { concept: 'Concept', spec: 'Spec', decision: 'Decision', report: 'Report' } as const
export const FORMAT_WORDS = { markdown: 'Markdown', html: 'HTML' } as const
export const VERDICT_WORDS = {
  looks_good: 'Looks good',
  with_notes: 'With notes',
  changes: 'Changes',
  no_longer_applies: 'No longer applies',
} as const
