import {
  type ImageAnchor,
  type ImageRef,
  imageQuote,
  MAX_IMAGE_LABEL,
  resolveImage,
  srcHash,
} from '@software-factory/contract'
import type { Id } from '../../kernel/ids.ts'
import { err, ok, type Result } from '../../kernel/result.ts'
import type { MissingFields } from '../../kernel/missing-fields.ts'
import type { DecisionForm } from './decision.ts'

export type ArtifactId = Id<'artifact'>
/** `collection_<id>`: a named set of artifacts with one lead page (`artifact collection`). */
export type CollectionId = Id<'collection'>

/** One model, four kinds (`docs/language.md`, Artifact). */
export const ARTIFACT_KINDS = ['concept', 'spec', 'decision', 'report'] as const
export type ArtifactKind = (typeof ARTIFACT_KINDS)[number]

/** What a lead may hand over with `artifact submit`; a Decision comes from `issue ask`. */
const SUBMITTABLE_KINDS = ['concept', 'spec', 'report'] as const
export type SubmittableKind = (typeof SUBMITTABLE_KINDS)[number]

export const FORMATS = ['markdown', 'html'] as const
export type Format = (typeof FORMATS)[number]

/** The owner's answer on an artifact (`docs/language.md`, Verdict). The same words as the Issue's `verdict_given`. */
export const VERDICTS = ['looks_good', 'with_notes', 'changes', 'no_longer_applies'] as const
export type Verdict = (typeof VERDICTS)[number]

/** A Concept or a Spec waits for its verdict; a Report never waits, and a Decision is answered, not judged. */
export const waitsForReview = (kind: ArtifactKind): kind is 'concept' | 'spec' => kind === 'concept' || kind === 'spec'

export const MAX_CONTENT = 1_000_000
export const MAX_TITLE = 200
const MAX_QUOTE = 2000
const MAX_COMMENT = 5000

export interface Submission {
  kind: SubmittableKind
  title: string
  format: Format
  content: string
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const filled = (value: unknown): string | null => (typeof value === 'string' && value.trim() !== '' ? value : null)

function refused(fields: string[], what: string): Result<never, MissingFields> {
  return err({ kind: 'missing_field', fields, detail: `${what} needs: ${fields.join(', ')}` })
}

/** Reads what a lead hands over; every missing or wrong field is named. */
export function readSubmission(raw: unknown): Result<Submission, MissingFields> {
  const body = isRecord(raw) ? raw : {}
  const problems: string[] = []
  const title = filled(body.title)?.trim() ?? ''
  if (title === '') problems.push('title')
  if (title.length > MAX_TITLE) problems.push(`title (longer than ${MAX_TITLE} characters)`)
  const content = filled(body.content) ?? ''
  if (content === '') problems.push('content')
  if (content.length > MAX_CONTENT) problems.push(`content (longer than ${MAX_CONTENT} characters)`)
  const kind = SUBMITTABLE_KINDS.find((candidate) => candidate === body.kind)
  if (!kind) problems.push(`kind (${SUBMITTABLE_KINDS.join(', ')})`)
  const format =
    body.contentFormat === undefined ? 'markdown' : FORMATS.find((candidate) => candidate === body.contentFormat)
  if (!format) problems.push(`contentFormat (${FORMATS.join(', ')})`)
  if (problems.length > 0 || !kind || !format) return refused(problems, 'an artifact')
  return ok({ kind, title, format, content })
}

/** The text kept either side of a quote to tell equal passages apart: about 32 characters, never more than this. */
const MAX_CONTEXT = 200
const MAX_OCCURRENCE = 2_147_483_647

export interface AnnotationInput {
  quote: string
  path: string | null
  /** which occurrence of the quote in the document's text (0-based), and the text around it: null on a comment without them */
  occurrence: number | null
  prefix: string | null
  suffix: string | null
  /** the picture it hangs on; null for a comment on text. Its quote is then derived from it (`imageQuote`) */
  image: ImageAnchor | null
  comment: string
}

/** Reads the new comment of an annotation: trimmed, not empty, not over the cap. */
export function readComment(raw: unknown): Result<string, MissingFields> {
  const body = isRecord(raw) ? raw : {}
  const problems: string[] = []
  const comment = filled(body.comment)?.trim() ?? ''
  if (comment === '') problems.push('comment')
  if (comment.length > MAX_COMMENT) problems.push(`comment (longer than ${MAX_COMMENT} characters)`)
  if (problems.length > 0) return refused(problems, 'an annotation')
  return ok(comment)
}

/** How a lead handled one of the owner's annotations. */
export const DISPOSITIONS = ['applied', 'deferred', 'declined'] as const
export type Disposition = (typeof DISPOSITIONS)[number]

export interface DispositionInput {
  disposition: Disposition
  /** a deferral names the Issue or signal it filed, a decline its reason; empty only for `applied` */
  note: string
}

/** Reads the lead's answer to an annotation: a disposition, and a note that a deferral and a decline cannot go without. */
export function readDisposition(raw: unknown): Result<DispositionInput, MissingFields> {
  const body = isRecord(raw) ? raw : {}
  const problems: string[] = []
  const disposition = DISPOSITIONS.find((candidate) => candidate === body.disposition)
  if (!disposition) problems.push(`disposition (${DISPOSITIONS.join(', ')})`)
  const note = filled(body.note)?.trim() ?? ''
  if (note.length > MAX_COMMENT) problems.push(`note (longer than ${MAX_COMMENT} characters)`)
  if (disposition && disposition !== 'applied' && note === '') {
    problems.push(`note (${disposition === 'deferred' ? 'the Issue or signal it filed' : 'the reason'})`)
  }
  if (problems.length > 0 || !disposition) return refused(problems, 'an annotation reply')
  return ok({ disposition, note })
}

/** The text around a quote as it is written: spaces at its edge count, an empty one is none. */
function context(value: unknown, name: string, problems: string[]): string | null {
  if (value === undefined || value === null || value === '') return null
  if (typeof value !== 'string') problems.push(`${name} (text)`)
  else if (value.length > MAX_CONTEXT) problems.push(`${name} (longer than ${MAX_CONTEXT} characters)`)
  else return value
  return null
}

const foldSpaces = (text: string): string => text.replace(/\s+/g, ' ').trim()

/** The picture an annotation names, or null when it names none (its problems are pushed, each named `image.<field>`). */
function readImage(raw: unknown, problems: string[]): ImageAnchor | null {
  if (!isRecord(raw)) {
    problems.push('image (an object: occurrence, srcHash, label, x, y)')
    return null
  }
  const before = problems.length
  const { occurrence, srcHash: hash, label: rawLabel, x, y } = raw
  if (
    !(typeof occurrence === 'number' && Number.isInteger(occurrence) && occurrence >= 0 && occurrence <= MAX_OCCURRENCE)
  )
    problems.push('image.occurrence (a whole number from 0)')
  if (!(typeof hash === 'string' && /^[0-9a-f]{0,8}$/.test(hash)))
    problems.push("image.srcHash ('' or up to 8 lowercase hex characters)")
  let label = ''
  if (rawLabel !== undefined && rawLabel !== null) {
    if (typeof rawLabel !== 'string') problems.push('image.label (text)')
    else label = foldSpaces(rawLabel)
    if (label.length > MAX_IMAGE_LABEL) problems.push(`image.label (longer than ${MAX_IMAGE_LABEL} characters)`)
  }
  const given = (value: unknown) => value !== undefined && value !== null
  const inRange = (value: unknown) => typeof value === 'number' && value >= 0 && value <= 1
  if (given(x) !== given(y)) problems.push('image.x and image.y (both, or neither)')
  else if (given(x) && !(inRange(x) && inRange(y))) problems.push('image.x and image.y (numbers from 0 to 1)')
  if (problems.length > before) return null
  return {
    occurrence: occurrence as number,
    srcHash: hash as string,
    label,
    x: given(x) ? (x as number) : null,
    y: given(y) ? (y as number) : null,
  }
}

/**
 * Reads an annotation: the quote it hangs on (or, instead, the picture it hangs on: the quote is then derived from it), an
 * optional path hint (a heading path, a selector), an optional occurrence number with the text before and after the quote,
 * and the comment.
 */
export function readAnnotation(raw: unknown): Result<AnnotationInput, MissingFields> {
  const body = isRecord(raw) ? raw : {}
  const problems: string[] = []
  const hasImage = body.image !== undefined && body.image !== null
  const image = hasImage ? readImage(body.image, problems) : null
  const quote = image ? imageQuote(image) : (filled(body.quote)?.trim() ?? '')
  if (quote === '' && !hasImage) problems.push('quote')
  if (quote.length > MAX_QUOTE) problems.push(`quote (longer than ${MAX_QUOTE} characters)`)
  const comment = filled(body.comment)?.trim() ?? ''
  if (comment === '') problems.push('comment')
  if (comment.length > MAX_COMMENT) problems.push(`comment (longer than ${MAX_COMMENT} characters)`)
  const path = body.path === undefined || body.path === null ? null : filled(body.path)
  if (body.path !== undefined && body.path !== null && path === null) problems.push('path (when given, not empty)')
  const occurrence = !image && body.occurrence !== undefined && body.occurrence !== null ? body.occurrence : null
  // the column is a 32-bit integer
  if (
    occurrence !== null &&
    !(Number.isInteger(occurrence) && (occurrence as number) >= 0 && (occurrence as number) <= MAX_OCCURRENCE)
  )
    problems.push('occurrence (when given, a whole number from 0)')
  const prefix = image ? null : context(body.prefix, 'prefix', problems)
  const suffix = image ? null : context(body.suffix, 'suffix', problems)
  if (problems.length > 0) return refused(problems, 'an annotation')
  return ok({
    quote,
    path: path?.trim() ?? null,
    occurrence: occurrence as number | null,
    prefix,
    suffix,
    image,
    comment,
  })
}

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  middot: '\u00b7',
  mdash: '\u2014',
  ndash: '\u2013',
  hellip: '\u2026',
  rarr: '\u2192',
  larr: '\u2190',
  bull: '\u2022',
  copy: '\u00a9',
  laquo: '\u00ab',
  raquo: '\u00bb',
  times: '\u00d7',
  lsquo: '\u2018',
  rsquo: '\u2019',
  ldquo: '\u201c',
  rdquo: '\u201d',
  deg: '\u00b0',
  euro: '\u20ac',
  ne: '\u2260',
  le: '\u2264',
  ge: '\u2265',
  check: '\u2713',
  cross: '\u2717',
  trade: '\u2122',
  harr: '\u2194',
  uarr: '\u2191',
  darr: '\u2193',
  rArr: '\u21d2',
  hArr: '\u21d4',
  ...Object.fromEntries(
    // the Latin-1 block, U+00A0 to U+00FF in order: the accented letters and symbols a page writes by name
    (
      'nbsp iexcl cent pound curren yen brvbar sect uml copy ordf laquo not shy reg macr deg plusmn sup2 sup3 acute micro ' +
      'para middot cedil sup1 ordm raquo frac14 frac12 frac34 iquest Agrave Aacute Acirc Atilde Auml Aring AElig Ccedil ' +
      'Egrave Eacute Ecirc Euml Igrave Iacute Icirc Iuml ETH Ntilde Ograve Oacute Ocirc Otilde Ouml times Oslash Ugrave ' +
      'Uacute Ucirc Uuml Yacute THORN szlig agrave aacute acirc atilde auml aring aelig ccedil egrave eacute ecirc euml ' +
      'igrave iacute icirc iuml eth ntilde ograve oacute ocirc otilde ouml divide oslash ugrave uacute ucirc uuml yacute ' +
      'thorn yuml'
    )
      .split(' ')
      .map((name, i) => [name, String.fromCharCode(0xa0 + i)])
      // `nbsp` stays the space it is shown as
      .filter(([name]) => name !== 'nbsp'),
  ),
}

/** Tags that sit inside a line of text: a browser shows `<code>make</code>,` as `make,`, so they leave no space behind. */
const INLINE_TAGS =
  'a|abbr|b|bdi|bdo|cite|code|data|dfn|em|i|kbd|mark|q|s|samp|small|span|strong|sub|sup|time|u|var|del|ins'

/** An entity as the browser shows it: named (the common ones), decimal or hex; anything else stays as written. */
function decodeEntities(text: string): string {
  return text.replace(/&(?:#(\d+)|#x([0-9a-f]+)|([a-z]+));/gi, (entity, dec?: string, hex?: string, name?: string) => {
    if (name) return ENTITIES[name] ?? entity
    const code = dec ? Number(dec) : Number.parseInt(hex ?? '', 16)
    return Number.isInteger(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : entity
  })
}

/**
 * The text a reader can select, as a plain line. HTML: without comments, scripts and styles; inline tags leave nothing,
 * every other tag a space; entities decoded. Markdown: without the marks that do not show (emphasis, headings, quotes,
 * links keep their text). Whitespace collapses. A quote is found in this text, so a quote taken from the rendered page
 * matches the source it came from.
 */
export function readableText(content: string, format: Format): string {
  const flat =
    format === 'html'
      ? decodeEntities(
          content
            .replace(/<!--[\s\S]*?-->/g, '')
            .replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, '')
            .replace(new RegExp(`</?(?:${INLINE_TAGS})\\b[^>]*>`, 'gi'), '')
            .replace(/<[^>]*>/g, ' '),
        )
      : decodeEntities(
          content
            .replace(/```[^\n]*\n?/g, ' ')
            // a table's rule row (`|-|:-:|`) shows nothing, and its cell borders are not text: cells read as separate words
            .replace(/^[ \t]*[|:\- \t]*\|[|:\- \t]*$/gm, ' ')
            .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
            // raw HTML in a source is dropped by the page: `a<br>b` reads `ab`
            .replace(/<\/?[a-z][^>\n]*>/gi, '')
            .replace(/^\s{0,3}(?:#{1,6}|>|[-*+]|\d+[.)])\s+/gm, '')
            .replace(/\\([\\`*_{}[\]()#+\-.!|<>~])/g, '$1')
            .replace(/[*_`~|]/g, (mark) => (mark === '|' ? ' ' : '')),
        )
  return flat.replace(/\s+/g, ' ').trim()
}

export type Anchor = 'anchored' | 'unanchored'

/** A quote is anchored in a revision while its text is still in it; once it is gone the annotation is "Unanchored". */
export function anchorOf(content: string, format: Format, quote: string): Anchor {
  // An HTML quote is the selection of a rendered page: only its whitespace folds. A Markdown quote is stripped like its source.
  const wanted = format === 'html' ? quote.replace(/\s+/g, ' ').trim() : readableText(quote, 'markdown')
  if (wanted === '') return 'unanchored'
  return readableText(content, format).includes(wanted) ? 'anchored' : 'unanchored'
}

/** The value of an attribute of one tag as written (quotes stripped, entities decoded), or null when the tag has none. */
function attributeOf(tag: string, name: string): string | null {
  const found = new RegExp(`(?<=[\\s"'/])${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i').exec(tag)
  if (!found) return null
  return decodeEntities(found[1] ?? found[2] ?? found[3] ?? '')
}

const PICTURE_TAGS = /<(\/?)(figure|figcaption|img|svg)\b[^>]*>/gi

/**
 * The pictures of a document, in order, as a comment names them: the hash of the `src` as written ('' for an svg or an
 * image without one, as in the frame) and the label (a figure's caption, else the alt, aria-label or an svg's `<title>`). HTML follows the frame's lightbox: a
 * figure that holds an image or svg is one picture (the first it holds), an image or svg outside a figure is one, and one
 * inside an svg or a nested figure is not. Markdown: every `![alt](src "title")` outside a fenced code block.
 *
 * Approximate by design: the server cannot see sizes or links, so the lightbox's size filter (an image under 200 px wide,
 * an svg under 160 px) and its skipping of an `<a href>`-wrapped image are not applied.
 * A document the frame counts differently still resolves by hash and label; only the place among them is then off.
 */
export function imageRefs(content: string, format: Format): ImageRef[] {
  if (format === 'markdown') return markdownImages(content)
  const html = content.replace(/<!--[\s\S]*?-->/g, '').replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, '')
  const refs: ImageRef[] = []
  let figures = 0
  let svgs = 0
  let figure: { media: ImageRef | null; caption: string } | null = null
  const media = (tag: string, vector: boolean, title = ''): ImageRef => {
    const src = vector ? null : attributeOf(tag, 'src')
    return {
      hash: src ? srcHash(src) : '',
      label: foldSpaces(attributeOf(tag, 'alt') || attributeOf(tag, 'aria-label') || title).slice(0, MAX_IMAGE_LABEL),
    }
  }
  /** The text of the first `<title>` of the svg that opens at `from`, as the frame reads it (querySelector('title')). */
  const titleOf = (from: number): string => {
    const rest = html.slice(from)
    // up to the close that matches the svg's own open: a nested svg is part of it, as it is for the frame's querySelector
    let depth = 1
    let end = rest.length
    for (const tag of rest.matchAll(/<(\/?)svg\b[^>]*>/gi)) {
      if (tag[1] === '/') depth--
      else if (!tag[0].endsWith('/>')) depth++
      if (depth === 0) {
        end = tag.index
        break
      }
    }
    const found = /<title\b[^>]*>([\s\S]*?)<\/title\s*>/i.exec(rest.slice(0, end))
    return found ? foldSpaces(readableText(found[1] ?? '', 'html')) : ''
  }
  const take = (picture: ImageRef): void => {
    if (!figure) refs.push(picture)
    else figure.media ??= picture
  }
  const closeFigure = (): void => {
    if (figure?.media) refs.push({ hash: figure.media.hash, label: figure.caption || figure.media.label })
    figure = null
  }
  for (const match of html.matchAll(PICTURE_TAGS)) {
    const [tag, slash, name = ''] = match
    const closing = slash === '/'
    switch (name.toLowerCase()) {
      case 'figure':
        if (closing) {
          if (figures > 0 && --figures === 0) closeFigure()
        } else if (figures++ === 0) figure = { media: null, caption: '' }
        break
      case 'figcaption': {
        if (closing || !figure) break
        if (figure.caption !== '') break
        const from = (match.index ?? 0) + tag.length
        figure.caption = foldSpaces(readableText(html.slice(from).split(/<\/figcaption\s*>/i)[0] ?? '', 'html')).slice(
          0,
          MAX_IMAGE_LABEL,
        )
        break
      }
      case 'img':
        if (!closing && svgs === 0) take(media(tag, false))
        break
      default:
        if (closing) svgs = Math.max(0, svgs - 1)
        else if (svgs > 0) svgs += tag.endsWith('/>') ? 0 : 1
        else {
          const self = tag.endsWith('/>')
          take(media(tag, true, self ? '' : titleOf((match.index ?? 0) + tag.length)))
          if (!self) svgs = 1
        }
    }
  }
  closeFigure()
  return refs
}

function markdownImages(content: string): ImageRef[] {
  let fenced = false
  const prose = content.split('\n').filter((line) => {
    if (/^\s{0,3}(?:```|~~~)/.test(line)) fenced = !fenced
    else if (!fenced) return true
    return false
  })
  return Array.from(prose.join('\n').matchAll(/!\[([^\]]*)\]\(\s*([^\s)]*)[^)]*\)/g), (match) => ({
    hash: match[2] ? srcHash(match[2]) : '',
    label: foldSpaces(match[1] ?? '').slice(0, MAX_IMAGE_LABEL),
  }))
}

/** A picture comment is anchored while a picture of the revision resolves from it (`resolveImage`); else it is "Unanchored". */
export function imageAnchorOf(content: string, format: Format, image: ImageAnchor): Anchor {
  return resolveImage(imageRefs(content, format), image) >= 0 ? 'anchored' : 'unanchored'
}

/** What a Decision looks like as an artifact: its form, as Markdown. Revision 1, and the only one. */
export function renderDecisionForm(form: DecisionForm): string {
  const options = form.options
    .map(
      (option) => `- **${option.label}**${option.reversible ? ' (reversible)' : ' (not reversible)'}: ${option.cost}`,
    )
    .join('\n')
  const fallback = form.noAnswer.default
    ? `After ${form.noAnswer.waitMinutes} minutes the default is taken: **${form.noAnswer.default}**.`
    : 'There is no default: it waits for an answer.'
  return [
    `# ${form.question}`,
    '',
    `**Recommendation:** ${form.recommendation}`,
    '',
    '## What was checked',
    '',
    form.checked,
    '',
    '## Options',
    '',
    options,
    '',
    '## With no answer',
    '',
    form.noAnswer.consequence,
    '',
    fallback,
    '',
  ].join('\n')
}
