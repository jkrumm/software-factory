/** Pure helpers that turn machine text (ids, ISO times, env names, markdown, HTML source) into words for the screen. */

export type SignalPart = { kind: 'text'; text: string } | { kind: 'time'; iso: string }

const ISO_TIME = /\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z/
const ISO_FRAGMENT = /\d{4}-\d\d-\d\dT\d\d:\d\d/
const ENV_NAME = /\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/
const MACHINE_ID = /\bissue_\d+|\blead-\d+-\d+|\bartifact_/
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
const DIGIT_WORD = 'zero|one|two|three|four|five|six|seven|eight|nine'

/** A signal's text without its machine parts; the spaces on both ends are kept so a time part can sit next to it. */
function cleanText(text: string): string {
  return text
    .replace(new RegExp(`\\blead lead-(?:\\s+(?:${DIGIT_WORD}))+`, 'gi'), 'the lead')
    .replace(new RegExp(`\\s*\\(\\s*${ENV_NAME.source}\\s*\\)`, 'g'), '')
    .replace(new RegExp(`\\s*${ENV_NAME.source}`, 'g'), '')
    .replace(/\blead-\d+-\d+\b/g, 'the lead')
    .replace(/\bissue_\d+\b/g, 'an Issue')
    .replace(new RegExp(`\\s*\\bartifact_${UUID}`, 'gi'), '')
    .replace(new RegExp(`\\s*\\b${UUID}`, 'gi'), '')
    .replace(/\bthe the\b/gi, 'the')
    .replace(/[^\S\n]+/g, ' ')
    .replace(/ ?\n ?/g, '\n')
}

/** A signal's title or text as text and times: ISO times become their own parts, a trailing `Reproduce:` command is dropped. */
export function signalParts(text: string): SignalPart[] {
  const cut = text.replace(/\s*Reproduce:[\s\S]*$/, '')
  const parts: SignalPart[] = []
  const split = new RegExp(`(${ISO_TIME.source})`, 'g')
  for (const [index, piece] of cut.split(split).entries()) {
    if (index % 2 === 1) parts.push({ kind: 'time', iso: piece })
    else if (piece !== '') parts.push({ kind: 'text', text: cleanText(piece) })
  }
  const first = parts[0]
  if (first?.kind === 'text') first.text = first.text.trimStart()
  const last = parts.at(-1)
  if (last?.kind === 'text') last.text = last.text.trimEnd()
  return parts.filter((part) => part.kind === 'time' || part.text !== '')
}

/** The source of a signal in words: `agent:argo` is "Agent in argo", `owner:hermes` is "hermes". */
export function sourceLabel(source: string): string | null {
  const value = source.trim()
  if (value === '') return null
  const colon = value.indexOf(':')
  if (colon < 0) return value
  const prefix = value.slice(0, colon)
  const rest = value.slice(colon + 1)
  if (prefix === 'agent') return rest === '' ? 'Agent' : `Agent in ${rest}`
  return /^[A-Za-z][\w.-]*$/.test(rest) ? rest : value
}

/** The "What it is" sentence, or null when it repeats the title or is not a clean sentence (the server can cut it mid-word). */
export function aboutLine(about: string | null, title: string, filedTitle: string | null): string | null {
  const text = about?.trim() ?? ''
  if (text === '' || text === title || text === filedTitle) return null
  if (!/^[A-Z"'“‘]/.test(text) || !/[.!?…]["'”’)]?$/.test(text)) return null
  if (ISO_FRAGMENT.test(text) || ENV_NAME.test(text) || MACHINE_ID.test(text)) return null
  return text
}

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  middot: '·',
  hellip: '…',
  ndash: '–',
  mdash: '—',
}

const decode = (text: string): string =>
  text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, name: string) => {
    if (name.startsWith('#')) {
      const code =
        name[1]?.toLowerCase() === 'x' ? Number.parseInt(name.slice(2), 16) : Number.parseInt(name.slice(1), 10)
      return Number.isInteger(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : whole
    }
    return ENTITIES[name.toLowerCase()] ?? whole
  })

const htmlText = (html: string): string =>
  decode(html.replace(/<\/?(?:a|b|i|u|em|strong|code|span|mark|small|sub|sup)\b[^>]*>/gi, '').replace(/<[^>]*>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim()

const PREVIEW_CHARS = 400

/** Cut to about 400 characters at a word, with an ellipsis. */
function cutAtWord(text: string): string {
  if (text.length <= PREVIEW_CHARS) return text
  const head = text.slice(0, PREVIEW_CHARS)
  const space = head.lastIndexOf(' ')
  return `${(space > PREVIEW_CHARS / 2 ? head.slice(0, space) : head).replace(/[\s,;:.-]+$/, '')}…`
}

/** The inner HTML of the element opened by `open`, which ends at `from` in `html`; nested elements of the same tag are counted. */
function innerOf(html: string, tag: string, from: number): string {
  const tags = new RegExp(`<(/?)${tag}\\b[^>]*>`, 'gi')
  tags.lastIndex = from
  let depth = 1
  for (let match = tags.exec(html); match; match = tags.exec(html)) {
    depth += match[1] === '/' ? -1 : match[0].endsWith('/>') ? 0 : 1
    if (depth === 0) return html.slice(from, match.index)
  }
  return html.slice(from)
}

const TLDR_LABEL = /^(?:tl;?dr|in short)\s*:?$/i

function htmlTldr(source: string): string | null {
  const html = source.replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, '').replace(/<!--[\s\S]*?-->/g, '')
  // an element named tldr
  const named = /<([a-z][a-z0-9]*)\b[^>]*\b(?:id|class)\s*=\s*["'][^"']*tldr[^"']*["'][^>]*>/i.exec(html)
  if (named?.[1]) {
    const text = htmlText(innerOf(html, named[1], named.index + named[0].length))
    if (text !== '' && !TLDR_LABEL.test(text)) return text
  }
  // an element that only says TLDR, followed by its paragraph
  for (const label of html.matchAll(/<([a-z][a-z0-9]*)\b[^>]*>([^<]{2,12})<\/\1>/gi)) {
    if (!TLDR_LABEL.test(decode(label[2] ?? '').trim())) continue
    const rest = html.slice((label.index ?? 0) + label[0].length)
    const paragraph = /<p\b[^>]*>([\s\S]*?)<\/p>/i.exec(rest)
    const text = paragraph?.[1] ? htmlText(paragraph[1]) : ''
    if (text !== '') return text
  }
  return null
}

/** Markdown syntax removed: what is left reads as plain text. */
function markdownPlain(markdown: string): string {
  return markdown
    .replace(/^\s*(```|~~~).*$/gm, '')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^\s{0,3}(?:#{1,6}\s+|>\s?|[-*+]\s+|\d+[.)]\s+)/gm, '')
    .replace(/(\*\*|__)(.+?)\1/g, '$2')
    .replace(/(?<![\w*])[*_]([^*_\n]+)[*_](?![\w*])/g, '$1')
    .replace(/`+/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

function markdownTldr(markdown: string): string | null {
  const lines = markdown.split('\n')
  const heading = lines.findIndex((line) => /^#{1,6}\s+(?:tl;?dr|in short)\s*:?\s*$/i.test(line.trim()))
  if (heading >= 0) {
    const rest = lines.slice(heading + 1)
    const end = rest.findIndex((line) => /^#{1,6}\s/.test(line.trim()))
    return markdownPlain((end < 0 ? rest : rest.slice(0, end)).join('\n'))
  }
  const paragraph = markdown.split(/\n\s*\n/).find((block) => {
    const trimmed = block.trim()
    return trimmed !== '' && !/^#{1,6}\s/.test(trimmed) && !/^(```|~~~)/.test(trimmed)
  })
  return paragraph ? markdownPlain(paragraph) : null
}

/** A few sentences of an artifact for the card that opens it (its TLDR, else a markdown artifact's first paragraph), or null. */
export function artifactPreview(format: 'markdown' | 'html', content: string): string | null {
  const text = format === 'html' ? htmlTldr(content) : markdownTldr(content)
  return text ? cutAtWord(text) : null
}

/** A held signal's text without markdown fences, inline code ticks, heading, quote and list markers or emphasis. */
export function plainExcerpt(text: string): string {
  return text
    .replace(/^[ \t]*(```|~~~).*$/gm, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^[ \t]*(?:#{1,6}\s+|>\s?|[-*+]\s+)/gm, '')
    .replace(/(\*\*|__)(.+?)\1/g, '$2')
    .replace(/`+/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}
