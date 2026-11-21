import { SPEC_BUILD_LINES, SPEC_VISIBLE_MAX } from '@software-factory/contract'
import { type Format, readableText } from './artifact.ts'
import { withoutFences } from './pictures.ts'

/**
 * The form of a Spec (Issue 2799): it fits a page. A Markdown Spec opens with a Build section and a Decided section, and
 * the text outside details blocks, fenced code and images is at most `SPEC_VISIBLE_MAX` characters; an HTML Spec is held to
 * the same count on its visible text outside details. `specFormRefusal` is the one check, run on `artifact submit`,
 * `artifact revise` and `issue new --spec`; it answers null for a Spec that fits, else the words the lead reads.
 */

const DETAILS_TAG = /<(\/?)details\b[^>]*>/gi

/** The content with every details block cut out, or null when the tags do not pair up. Nested blocks go with their parent. */
function outsideDetails(content: string): string | null {
  let depth = 0
  let kept = ''
  let from = 0
  for (const tag of content.matchAll(DETAILS_TAG)) {
    if (depth === 0) kept += content.slice(from, tag.index)
    depth += tag[1] === '/' ? -1 : 1
    if (depth < 0) return null
    from = tag.index + tag[0].length
  }
  if (depth !== 0) return null
  return kept + content.slice(from)
}

const MD_IMAGE = /!\[[^\]]*\]\([^)]*\)/g

/** The Markdown a reader sees without opening anything: no fences, no details, no pictures. */
function markdownOutside(content: string): string | null {
  const open = outsideDetails(withoutFences(content))
  return open === null ? null : open.replace(MD_IMAGE, '')
}

/** The HTML a reader sees without opening anything: no head, details, diagrams (svg) or preformatted code. */
function htmlOutside(content: string): string | null {
  const open = outsideDetails(content)
  if (open === null) return null
  return open.replace(/<head\b[\s\S]*?<\/head>/gi, '').replace(/<(svg|pre)\b[\s\S]*?<\/\1>/gi, '')
}

/** The characters of a Spec a reader meets before he opens anything; null when its details tags do not pair up. */
export function specVisibleLength(content: string, format: Format): number | null {
  const outside = format === 'html' ? htmlOutside(content) : markdownOutside(content)
  return outside === null ? null : readableText(outside, format).length
}

interface Heading {
  level: number
  name: string
  /** the lines after it up to the next heading that hold anything */
  lines: number
}

/** The headings of the visible Markdown, each with the filled lines under it. */
function headingsOf(visible: string): Heading[] {
  const found: Heading[] = []
  for (const line of visible.split('\n')) {
    const heading = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line)
    if (heading) {
      found.push({
        level: heading[1]?.length ?? 1,
        name: (heading[2] ?? '')
          .replace(/[:*_`]/g, '')
          .trim()
          .toLowerCase(),
        lines: 0,
      })
    } else if (line.trim() !== '' && found.length > 0) {
      const last = found.at(-1)
      if (last) last.lines += 1
    }
  }
  return found
}

const TWO_WAYS_OUT =
  'Two ways out: move detail into a collapsed block (<details><summary>one line</summary> the detail </details>, with a diagram or a screenshot where it says it shorter), or, for a document several Issues build from, file it as a Report (`factory artifact new`) and link it from the Spec.'

const SECTIONS = `A Spec opens with a "## Build" section (what will be built, at most ${SPEC_BUILD_LINES} lines) and a "## Decided" section (each choice and why, a line each)`

/** Why a Spec does not fit a page, in words that name the count and the way out; null when it fits. */
export function specFormRefusal(content: string, format: Format): string | null {
  const length = specVisibleLength(content, format)
  if (length === null) {
    return 'A <details> block is not closed (or a </details> has no opening): every <details> needs its </details>, and the Spec is counted without what is inside them.'
  }
  if (format === 'markdown') {
    const headings = headingsOf(markdownOutside(content) ?? '')
    const [first] = headings
    // a leading level-1 title may stand before the two sections
    const body = first?.level === 1 && first.name !== 'build' ? headings.slice(1) : headings
    const [build, decided] = body
    if (build?.name !== 'build' || decided?.name !== 'decided') {
      const found = headings.map((heading) => heading.name).filter((name) => name !== '')
      return `${SECTIONS}. This one opens with ${found.length === 0 ? 'no heading' : `the headings ${found.slice(0, 4).join(', ')}`}.`
    }
    if (build.lines > SPEC_BUILD_LINES) {
      return `The Build section has ${build.lines} lines; it holds at most ${SPEC_BUILD_LINES}: what will be built, sharply. Detail goes into a collapsed block.`
    }
  }
  if (length > SPEC_VISIBLE_MAX) {
    return `This Spec has ${length} characters of text outside details blocks, code fences and images; a Spec fits a page, at most ${SPEC_VISIBLE_MAX}. ${TWO_WAYS_OUT}`
  }
  return null
}
