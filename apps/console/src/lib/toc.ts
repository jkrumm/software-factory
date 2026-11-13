import { headingIds, type TocItem } from './artifact.ts'

/** The DOM side of the table of contents in the Console's own page (Markdown): the headings, their ids, the one in view. */

const HEADINGS = 'h1,h2,h3,h4,h5,h6'

/** Gives each heading under `root` its anchor id (a repeat is numbered) and lists them in order. */
export function collectHeadings(root: Element): { items: TocItem[]; elements: HTMLElement[] } {
  const elements = [...root.querySelectorAll<HTMLElement>(HEADINGS)]
  const ids = headingIds(elements.map((element) => element.textContent ?? ''))
  elements.forEach((element, i) => {
    element.id = ids[i] ?? `section-${i}`
  })
  return {
    elements,
    items: elements.map((element, i) => ({
      id: ids[i] ?? `section-${i}`,
      level: Number(element.tagName.charAt(1)),
      text: (element.textContent ?? '').replace(/\s+/g, ' ').trim(),
    })),
  }
}

/** The nearest ancestor that scrolls on its own, or null when the page does. */
export function scrollParentOf(element: Element): HTMLElement | null {
  for (let parent = element.parentElement; parent; parent = parent.parentElement) {
    const overflow = getComputedStyle(parent).overflowY
    if ((overflow === 'auto' || overflow === 'scroll') && parent.scrollHeight > parent.clientHeight) return parent
  }
  return null
}

/** How far under the top of the reading area a heading counts as the section the reader is in. */
export const SECTION_OFFSET = 48

/** The reading area the section is judged in: its top and bottom on screen, and whether it is scrolled to its very end. */
export interface ReadingArea {
  top: number
  bottom: number
  atEnd: boolean
}

/** The reading area of a scrolling element, or of the page itself when none scrolls on its own. */
export function readingArea(scroller: HTMLElement | null): ReadingArea {
  if (scroller) {
    const { top, bottom } = scroller.getBoundingClientRect()
    return {
      top,
      bottom,
      atEnd: scroller.scrollTop > 0 && scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 2,
    }
  }
  const page = document.documentElement
  return {
    top: 0,
    bottom: window.innerHeight,
    atEnd: window.scrollY > 0 && window.scrollY + window.innerHeight >= page.scrollHeight - 2,
  }
}

/**
 * The index of the heading the reader is in: the last one at or above the top of the reading area, or, when the document
 * is scrolled to its end (the last headings can never reach the top), the last one that is on screen; -1 before the first.
 */
export function sectionIndex(elements: readonly HTMLElement[], area: ReadingArea): number {
  let index = -1
  elements.forEach((element, i) => {
    const { top } = element.getBoundingClientRect()
    if (top <= area.top + SECTION_OFFSET || (area.atEnd && top < area.bottom)) index = i
  })
  return index
}

/** Scrolls to an element by id inside `root`. False when it is not there. */
export function scrollToId(root: Element, id: string): boolean {
  const element = [...root.querySelectorAll<HTMLElement>('[id]')].find((candidate) => candidate.id === id)
  if (!element) return false
  element.scrollIntoView({ block: 'start', behavior: 'smooth' })
  return true
}
