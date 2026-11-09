import { headingPath, indexText, locateQuote, normalizeQuote, type Heading, type SelectionRect } from './artifact.ts'

/** The DOM side of marking in the Console's own page (Markdown): selection to quote and path, quotes to highlights. */

const HIGHLIGHT = 'annotation'
const BLOCK = 'p,li,h1,h2,h3,h4,h5,h6,td,th,pre,blockquote,div,section,figcaption,tr,ul,ol,table'

function textNodes(root: Element): Text[] {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  const nodes: Text[] = []
  for (let node = walker.nextNode(); node; node = walker.nextNode()) nodes.push(node as Text)
  return nodes
}

function rangesOf(root: Element, quotes: readonly string[]): { quote: string; range: Range }[] {
  const nodes = textNodes(root)
  const index = indexText(nodes.map((node) => ({ text: node.data, block: node.parentElement?.closest(BLOCK) ?? root })))
  return quotes.flatMap((quote) => {
    const span = locateQuote(index, quote)
    const from = span && nodes[span.start[0]]
    const to = span && nodes[span.end[0]]
    if (!span || !from || !to) return []
    const range = document.createRange()
    range.setStart(from, span.start[1])
    range.setEnd(to, span.end[1])
    return [{ quote, range }]
  })
}

/** Paints the quotes that are in `root` (no DOM change: the CSS Custom Highlight API). */
export function paintHighlights(root: Element, quotes: readonly string[]): void {
  if (typeof Highlight === 'undefined') return
  CSS.highlights.set(HIGHLIGHT, new Highlight(...rangesOf(root, quotes).map((found) => found.range)))
}

export function clearHighlights(): void {
  if (typeof Highlight !== 'undefined') CSS.highlights.delete(HIGHLIGHT)
}

/** Brings the first place a quote is shown in `root` to the middle of the screen. */
export function scrollToQuote(root: Element, quote: string): void {
  const found = rangesOf(root, [quote])[0]
  const element = found?.range.startContainer.parentElement
  element?.scrollIntoView({ block: 'center', behavior: 'smooth' })
}

const PENDING = 'annotation-pending'

/** Keeps a selection painted while the comment box has the focus (a focused field takes the real selection away). */
export function paintPending(range: Range): void {
  if (typeof Highlight !== 'undefined') CSS.highlights.set(PENDING, new Highlight(range))
}

export function clearPending(): void {
  if (typeof Highlight !== 'undefined') CSS.highlights.delete(PENDING)
}

export const rectOf = (range: Range): SelectionRect => {
  const { top, bottom, left } = range.getBoundingClientRect()
  return { top, bottom, left }
}

/** The owner's current selection inside `root`: its quote, heading path, position and range, or null. */
export function selectionIn(root: Element): { quote: string; path: string; rect: SelectionRect; range: Range } | null {
  const selection = window.getSelection()
  if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return null
  const range = selection.getRangeAt(0)
  if (!root.contains(range.commonAncestorContainer)) return null
  const quote = normalizeQuote(selection.toString())
  if (quote === '') return null
  const before: Heading[] = []
  for (const heading of root.querySelectorAll('h1,h2,h3,h4,h5,h6')) {
    const precedes =
      heading.contains(range.startContainer) ||
      heading.compareDocumentPosition(range.startContainer) & Node.DOCUMENT_POSITION_FOLLOWING
    if (precedes) before.push({ level: Number(heading.tagName.charAt(1)), text: heading.textContent ?? '' })
  }
  const kept = range.cloneRange()
  return { quote, path: headingPath(before), rect: rectOf(kept), range: kept }
}

/** The words of a search: lower-cased, split on spaces, a leading `#` dropped ("#534" is the number 534). */
export function queryWords(query: string): string[] {
  return query
    .toLowerCase()
    .split(/\s+/)
    .map((word) => word.replace(/^#/, ''))
    .filter((word) => word !== '')
}

/**
 * The [start, end) ranges of `text` where a word of `query` occurs, case-insensitively, merged where they touch or
 * overlap and in order. Pure, for painting a match in a title.
 */
export function highlightRanges(text: string, query: string): [number, number][] {
  const haystack = text.toLowerCase()
  const found: [number, number][] = []
  for (const word of new Set(queryWords(query))) {
    for (let at = haystack.indexOf(word); at !== -1; at = haystack.indexOf(word, at + word.length))
      found.push([at, at + word.length])
  }
  found.sort((a, b) => a[0] - b[0] || a[1] - b[1])
  const merged: [number, number][] = []
  for (const [start, end] of found) {
    const last = merged[merged.length - 1]
    if (last && start <= last[1]) last[1] = Math.max(last[1], end)
    else merged.push([start, end])
  }
  return merged
}

/** `text` cut into runs, each marked as matched or not, from `highlightRanges`. */
export function highlightRuns(text: string, query: string): { text: string; match: boolean }[] {
  const runs: { text: string; match: boolean }[] = []
  let from = 0
  for (const [start, end] of highlightRanges(text, query)) {
    if (start > from) runs.push({ text: text.slice(from, start), match: false })
    runs.push({ text: text.slice(start, end), match: true })
    from = end
  }
  if (from < text.length) runs.push({ text: text.slice(from), match: false })
  return runs
}
