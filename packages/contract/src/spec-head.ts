/**
 * The head of a Spec: its Build and Decided sections, the part a reader (the owner on a card, the Judge in its request) needs
 * to see what the question belongs to. A Spec with neither section gives its first `FALLBACK_CHARS` characters.
 */
const FALLBACK_CHARS = 4000
const HEADING = /^(#{1,6})\s+(.*?)\s*#*\s*$/

export interface SpecHead {
  build: string | null
  decided: string | null
}

/** The text of the section under the first heading named `name`, up to the next heading of its level or above; null when there is none. */
function section(lines: readonly string[], name: string): string | null {
  let fenced = false
  let level = 0
  const found: string[] = []
  for (const line of lines) {
    if (/^\s{0,3}(?:```|~~~)/.test(line)) fenced = !fenced
    const heading = fenced ? null : HEADING.exec(line)
    if (level > 0) {
      if (heading?.[1] && heading[1].length <= level) break
      found.push(line)
    } else if (heading?.[1] && heading[2]?.toLowerCase() === name) {
      level = heading[1].length
    }
  }
  const text = found.join('\n').trim()
  return text === '' ? null : text
}

const ENTITIES: Record<string, string> = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
  '&nbsp;': ' ',
  '&middot;': '·',
}

/**
 * An HTML Spec (the artifact template) as Markdown-shaped text: its style, script and comments dropped, headings as `#` lines,
 * list items as `-` lines, the rest as plain lines. Enough to find Build and Decided and to read them; never rendered.
 */
function htmlAsText(html: string): string {
  return html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(style|script|head|svg)\b[\s\S]*?<\/\1>/gi, '')
    .replace(
      /<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi,
      (_, level: string, text: string) => `\n${'#'.repeat(Number(level))} ${text.replace(/<[^>]*>/g, '')}\n`,
    )
    .replace(/<li\b[^>]*>/gi, '\n- ')
    .replace(/<\/(p|div|section|tr|ul|ol|table|figure|pre|blockquote)>|<br\s*\/?>/gi, '\n')
    .replace(/<[^>]*>/g, '')
    .replace(/&(?:amp|lt|gt|quot|nbsp|middot|#39);/g, (entity) => ENTITIES[entity] ?? entity)
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

const isHtml = (content: string): boolean =>
  /^\s*(?:<!doctype html|<html\b|<!--[\s\S]*?-->\s*<(?:!doctype|html))/i.test(content)

export function specHead(source: string): SpecHead {
  const content = isHtml(source) ? htmlAsText(source) : source
  const lines = content.split(/\r?\n/)
  return { build: section(lines, 'build'), decided: section(lines, 'decided') }
}

/** The head as one text, headings kept: for the Judge's request. */
export function specHeadText(source: string): string {
  const content = isHtml(source) ? htmlAsText(source) : source
  const { build, decided } = specHead(content)
  if (build === null && decided === null) return content.trim().slice(0, FALLBACK_CHARS)
  return [build === null ? '' : `## Build\n\n${build}`, decided === null ? '' : `## Decided\n\n${decided}`]
    .filter(Boolean)
    .join('\n\n')
}
