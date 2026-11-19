import {
  anchorAround,
  headingPath,
  indexText,
  locateQuote,
  normalizeQuote,
  type Heading,
  type Occurrence,
  type PaintAnchor,
  type SelectionRect,
} from './artifact.ts'

/** The DOM side of marking in the Console's own page (Markdown): selection to quote and path, quotes to highlights. */

const HIGHLIGHT = 'annotation'
const BLOCK = 'p,li,h1,h2,h3,h4,h5,h6,td,th,pre,blockquote,div,section,figcaption,tr,ul,ol,table'

function textNodes(root: Element): Text[] {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  const nodes: Text[] = []
  for (let node = walker.nextNode(); node; node = walker.nextNode()) nodes.push(node as Text)
  return nodes
}

function textIndex(root: Element) {
  const nodes = textNodes(root)
  const index = indexText(nodes.map((node) => ({ text: node.data, block: node.parentElement?.closest(BLOCK) ?? root })))
  return { nodes, index }
}

/** The heading path of a node: the headings before it in document order, the way a selection names its place. */
function pathBefore(headings: readonly Element[], node: Node): string {
  const before: Heading[] = []
  for (const heading of headings) {
    const precedes = heading.contains(node) || heading.compareDocumentPosition(node) & Node.DOCUMENT_POSITION_FOLLOWING
    if (precedes) before.push({ level: Number(heading.tagName.charAt(1)), text: heading.textContent ?? '' })
  }
  return headingPath(before)
}

function rangesOf(root: Element, anchors: readonly PaintAnchor[]): { id?: string; quote: string; range: Range }[] {
  const { nodes, index } = textIndex(root)
  const headings = [...root.querySelectorAll('h1,h2,h3,h4,h5,h6')]
  const pathAt = (at: number) => {
    const node = nodes[index.at[at]?.[0] ?? -1]
    return node ? pathBefore(headings, node) : ''
  }
  return anchors.flatMap((anchor) => {
    const span = locateQuote(index, anchor.quote, anchor, pathAt)
    const from = span && nodes[span.start[0]]
    const to = span && nodes[span.end[0]]
    if (!span || !from || !to) return []
    const range = document.createRange()
    range.setStart(from, span.start[1])
    range.setEnd(to, span.end[1])
    return [{ ...(anchor.id === undefined ? {} : { id: anchor.id }), quote: anchor.quote, range }]
  })
}

/** Paints the quotes that are in `root` (no DOM change: the CSS Custom Highlight API). */
export function paintHighlights(root: Element, anchors: readonly PaintAnchor[]): void {
  if (typeof Highlight === 'undefined') return
  CSS.highlights.set(HIGHLIGHT, new Highlight(...rangesOf(root, anchors).map((found) => found.range)))
}

export function clearHighlights(): void {
  if (typeof Highlight !== 'undefined') CSS.highlights.delete(HIGHLIGHT)
}

/** Brings the place a comment's passage is shown in `root` to the middle of the screen. */
export function scrollToQuote(root: Element, anchor: PaintAnchor): void {
  const found = rangesOf(root, [anchor])[0]
  const element = found?.range.startContainer.parentElement
  element?.scrollIntoView({ block: 'center', behavior: 'smooth' })
}

/** The caret position under a point, in whichever form the browser offers it. */
function caretAt(x: number, y: number): { node: Node; offset: number } | null {
  const doc = document as Document & {
    caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null
  }
  if (doc.caretPositionFromPoint) {
    const at = doc.caretPositionFromPoint(x, y)
    return at ? { node: at.offsetNode, offset: at.offset } : null
  }
  const range = document.caretRangeFromPoint?.(x, y)
  return range ? { node: range.startContainer, offset: range.startOffset } : null
}

/** The quote, and the comment's id, of the highlighted passage under a point (the narrowest when passages overlap), or null. */
export function quoteAt(
  root: Element,
  anchors: readonly PaintAnchor[],
  x: number,
  y: number,
): { quote: string; id?: string } | null {
  const caret = caretAt(x, y)
  if (!caret || !root.contains(caret.node)) return null
  let best: { quote: string; id?: string; size: number } | null = null
  for (const { quote, id, range } of rangesOf(root, anchors)) {
    // the caret snaps to the nearest character, so a click past the end of a line must not count: the point must be on the text
    const on = [...range.getClientRects()].some((r) => x >= r.left && x <= r.right && y >= r.top && y <= r.bottom)
    if (!on || !range.isPointInRange(caret.node, caret.offset)) continue
    const size = range.toString().length
    if (!best || size < best.size) best = { quote, ...(id === undefined ? {} : { id }), size }
  }
  return best ? { quote: best.quote, ...(best.id === undefined ? {} : { id: best.id }) } : null
}

const ACTIVE = 'annotation-active'

/** The passage of the comment the owner is on, painted stronger than the others (null drops it). */
export function paintActive(root: Element, anchor: PaintAnchor | null): void {
  if (typeof Highlight === 'undefined') return
  const found = anchor === null ? undefined : rangesOf(root, [anchor])[0]
  if (found) CSS.highlights.set(ACTIVE, new Highlight(found.range))
  else CSS.highlights.delete(ACTIVE)
}

const PENDING = 'annotation-pending'

/** Keeps a selection painted while the comment box has the focus (a focused field takes the real selection away). */
export function paintPending(range: Range): void {
  if (typeof Highlight !== 'undefined') CSS.highlights.set(PENDING, new Highlight(range))
}

export function clearPending(): void {
  if (typeof Highlight !== 'undefined') CSS.highlights.delete(PENDING)
}

const rectOf = (range: Range): SelectionRect => {
  const { top, bottom, left } = range.getBoundingClientRect()
  return { top, bottom, left }
}

/** The first index of `index` at or after the start of `range`, or null: the characters are in document order. */
function startOf(nodes: readonly Text[], index: ReturnType<typeof textIndex>['index'], range: Range): number | null {
  let low = 0
  let high = index.at.length
  while (low < high) {
    const mid = (low + high) >> 1
    const [part, offset] = index.at[mid] ?? [0, 0]
    const node = nodes[part]
    // comparePoint: the point is before the range (-1), in it (0) or after it (1)
    if (node && range.comparePoint(node, offset) < 0) low = mid + 1
    else high = mid
  }
  return low < index.at.length ? low : null
}

/** The owner's current selection inside `root`: its quote, heading path, which occurrence it is, position and range, or null. */
export function selectionIn(
  root: Element,
): ({ quote: string; path: string; rect: SelectionRect; range: Range } & Occurrence) | null {
  const selection = window.getSelection()
  if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return null
  const range = selection.getRangeAt(0)
  if (!root.contains(range.commonAncestorContainer)) return null
  const quote = normalizeQuote(selection.toString())
  if (quote === '') return null
  const path = pathBefore([...root.querySelectorAll('h1,h2,h3,h4,h5,h6')], range.startContainer)
  const { nodes, index } = textIndex(root)
  const kept = range.cloneRange()
  const around = anchorAround(index.flat, quote, startOf(nodes, index, kept))
  return { quote, path, ...(around ?? {}), rect: rectOf(kept), range: kept }
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
