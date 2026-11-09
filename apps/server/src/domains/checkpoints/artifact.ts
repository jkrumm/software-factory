import type { Id } from '../../kernel/ids.ts'
import { err, ok, type Result } from '../../kernel/result.ts'
import type { DecisionForm, MissingFields } from './decision.ts'

export type ArtifactId = Id<'artifact'>

/** One model, four kinds (`docs/language.md`, Artifact). */
export const ARTIFACT_KINDS = ['concept', 'spec', 'decision', 'report'] as const
export type ArtifactKind = (typeof ARTIFACT_KINDS)[number]

/** What a lead may hand over with `artifact submit`; a Decision comes from `issue ask`. */
export const SUBMITTABLE_KINDS = ['concept', 'spec', 'report'] as const
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
export const MAX_QUOTE = 2000
export const MAX_COMMENT = 5000

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

export interface AnnotationInput {
  quote: string
  path: string | null
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

/** Reads an annotation: the quote it hangs on, an optional path hint (a heading path, a selector), and the comment. */
export function readAnnotation(raw: unknown): Result<AnnotationInput, MissingFields> {
  const body = isRecord(raw) ? raw : {}
  const problems: string[] = []
  const quote = filled(body.quote)?.trim() ?? ''
  if (quote === '') problems.push('quote')
  if (quote.length > MAX_QUOTE) problems.push(`quote (longer than ${MAX_QUOTE} characters)`)
  const comment = filled(body.comment)?.trim() ?? ''
  if (comment === '') problems.push('comment')
  if (comment.length > MAX_COMMENT) problems.push(`comment (longer than ${MAX_COMMENT} characters)`)
  const path = body.path === undefined || body.path === null ? null : filled(body.path)
  if (body.path !== undefined && body.path !== null && path === null) problems.push('path (when given, not empty)')
  if (problems.length > 0) return refused(problems, 'an annotation')
  return ok({ quote, path: path?.trim() ?? null, comment })
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
      : content
          .replace(/```[^\n]*\n?/g, ' ')
          .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
          .replace(/^\s{0,3}(?:#{1,6}|>|[-*+]|\d+[.)])\s+/gm, '')
          .replace(/[*_`~]/g, '')
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
