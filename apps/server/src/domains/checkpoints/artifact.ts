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
  const format = body.format === undefined ? 'markdown' : FORMATS.find((candidate) => candidate === body.format)
  if (!format) problems.push(`format (${FORMATS.join(', ')})`)
  if (problems.length > 0 || !kind || !format) return refused(problems, 'an artifact')
  return ok({ kind, title, format, content })
}

export interface AnnotationInput {
  quote: string
  path: string | null
  comment: string
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
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
  '&nbsp;': ' ',
}

/**
 * The text a reader can select, as a plain line: HTML without its tags, scripts and styles; Markdown without the marks
 * that do not show (emphasis, headings, quotes, links keep their text). Whitespace collapses. A quote is found in this
 * text, so a quote taken from the rendered page matches the source it came from.
 */
export function readableText(content: string, format: Format): string {
  const flat =
    format === 'html'
      ? content
          .replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, ' ')
          .replace(/<[^>]*>/g, ' ')
          .replace(/&(?:amp|lt|gt|quot|#39|nbsp);/g, (entity) => ENTITIES[entity] ?? entity)
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
  const wanted = readableText(quote, 'markdown')
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
