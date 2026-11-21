import {
  specHeadText,
  DECISION_CLASSES,
  DECISION_LIMITS,
  EXHIBIT_KINDS,
  type DecisionClass,
  type Exhibit,
} from '@software-factory/contract'
import type { Id } from '../../kernel/ids.ts'
import type { MissingFields } from '../../kernel/missing-fields.ts'
import { err, ok, type Result } from '../../kernel/result.ts'
import { scrub } from '../../kernel/scrub.ts'
import { WORKFLOWS } from '../../kernel/workflows.ts'

export { scrub }

export type DecisionId = Id<'decision'>

/**
 * The steps of answering a Decision, in the order they are tried (`docs/architecture.md` §Loops and agw). `policy` is
 * history: no step of that name runs any more, but stored rows (and the database constraints) still hold it.
 */
export const STEPS = ['policy', 'judge', 'default', 'owner'] as const
export type StepName = (typeof STEPS)[number]

/** Who answered a Decision: a step, or the orchestrator answering for the owner (never a step of its own). */
export const ANSWERERS = [...STEPS, 'orchestrator'] as const
export type Answerer = (typeof ANSWERERS)[number]

/** What one option leads to and costs, and whether it can be taken back. A default is only ever a reversible option. */
export interface DecisionOption {
  label: string
  /** what gets built if it is chosen; null on a Decision asked before the form had it */
  leadsTo: string | null
  reversible: boolean
  /** what changing it later costs */
  cost: string
}

/** What happens with no answer. `default` is an option's label, taken after `waitMinutes`; both or neither. */
export interface NoAnswer {
  consequence: string
  default: string | null
  waitMinutes: number | null
}

/**
 * The Decision as the lead writes it: a class, one question, two to four options, one optional exhibit, and the Spec behind it
 * (`docs/language.md`, Decision). `class` and `whyYours` are null only on a Decision asked before they existed.
 */
export interface DecisionForm {
  class: DecisionClass | null
  whyYours: string | null
  question: string
  recommendation: string
  checked: string
  options: DecisionOption[]
  exhibit: Exhibit | null
  /** the Spec the question belongs to */
  artifact: string | null
  noAnswer: NoAnswer
}

export { JUDGE_MAX_TRIES } from '../../kernel/judge-tries.ts'
/** The wait after a failed Judge call before the next try. */
export const JUDGE_BACKOFF_MS = WORKFLOWS.judge.retry.backoffMs

const L = DECISION_LIMITS
const MAX_STEWARD_OPTIONS = 10
const MAX_WAIT_MINUTES = 7 * 24 * 60

/** A steward's Decision is about a stall, not a choice for the owner: the class and the line stand in for what it cannot say. */
const STEWARD_WHY = 'The lead cannot go on and no rule of the steward decides it.'

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const text = (value: unknown): string | null => (typeof value === 'string' && value.trim() !== '' ? value.trim() : null)

const classList = DECISION_CLASSES.join(' | ')

/** The distinct node ids of a Mermaid figure: what `diagramNodes` limits. Header, style and comment lines name none. */
export function mermaidNodes(source: string): number {
  const ids = new Set<string>()
  const edge = /\s*(?:<?-->?|<?==+>?|-\.+->?|--[^\s>|-][^>|]*?-+>?)\s*(?:\|[^|]*\|)?\s*/
  for (const raw of source.split(/\r?\n|;/)) {
    const line = raw.trim()
    if (
      line === '' ||
      /^(%%|flowchart\b|graph\b|stateDiagram|sequenceDiagram|classDiagram|erDiagram|subgraph\b|end$|direction\b|style\b|classDef\b|class\b|linkStyle\b|title\b)/i.test(
        line,
      )
    ) {
      const participant = /^(?:participant|actor)\s+([A-Za-z_][\w-]*)/i.exec(line)
      if (participant?.[1]) ids.add(participant[1])
      continue
    }
    for (const segment of line.split(edge)) {
      for (const part of segment.split('&')) {
        const id = /^\s*([A-Za-z_][\w-]*)/.exec(part)?.[1]
        if (id) ids.add(id)
      }
    }
  }
  return ids.size
}

type Problems = (problem: string) => void

/** A text of at most `max` characters on one line, or null (the problem is reported by name). */
function bounded(
  problem: Problems,
  name: string,
  value: unknown,
  max: number,
  opts: { oneLine?: boolean } = {},
): string {
  const found = text(value)
  if (found === null) {
    problem(name)
    return ''
  }
  if (found.length > max) problem(`${name} (${found.length} characters: at most ${max})`)
  else if (opts.oneLine && /\r|\n/.test(found)) problem(`${name} (one line, not several)`)
  return found
}

/**
 * The exhibit of a form: absent, or one object whose kind says how the change is shown, held to the limits of its kind. Every
 * violation is named at once, by its path (`exhibit.today[1]`).
 */
function readExhibit(
  problem: Problems,
  raw: unknown,
  context: { labels: readonly string[]; artifact: string | null },
): Exhibit | null {
  if (raw === undefined || raw === null) return null
  if (!isRecord(raw)) {
    problem('exhibit (a JSON object with a kind)')
    return null
  }
  const kind = raw.kind
  const strings = (name: string, value: unknown, min: number, max: number, each: number): string[] => {
    const list = Array.isArray(value) ? value : []
    if (list.length < min || list.length > max)
      problem(`${name} (${min === max ? min : `${min} to ${max}`} lines, got ${list.length})`)
    return list.slice(0, max).map((line, i) => bounded(problem, `${name}[${i}]`, line, each))
  }
  const optionOf = (name: string, value: unknown): string => {
    const label = text(value)
    if (label === null || !context.labels.some((candidate) => candidate.toLowerCase() === label.toLowerCase())) {
      problem(`${name} (not one of the options: ${context.labels.join(' | ')})`)
      return label ?? ''
    }
    return context.labels.find((candidate) => candidate.toLowerCase() === label.toLowerCase()) ?? label
  }
  const everyOption = (name: string, used: readonly string[]) => {
    const missing = context.labels.filter((label) => !used.includes(label))
    if (used.length !== new Set(used).size || missing.length > 0)
      problem(`${name} (one for each option, once: missing ${missing.join(' | ') || 'none, one is repeated'})`)
  }

  switch (kind) {
    case 'before_after':
      return {
        kind,
        today: strings('exhibit.today', raw.today, 1, L.exhibitLines, L.exhibitLine),
        after: strings('exhibit.after', raw.after, 1, L.exhibitLines, L.exhibitLine),
      }
    case 'pictures': {
      if (context.artifact === null) problem('exhibit.pictures (needs --artifact: the Spec the pictures are from)')
      const list = Array.isArray(raw.pictures) ? raw.pictures : []
      const pictures = list.map((entry, i) => {
        const item = isRecord(entry) ? entry : {}
        const image = bounded(problem, `exhibit.pictures[${i}].image`, item.image, 2000)
        if (image !== '' && !/^https:\/\/\S+$/.test(image))
          problem(`exhibit.pictures[${i}].image (an https link, as written in the Spec)`)
        return { option: optionOf(`exhibit.pictures[${i}].option`, item.option), image }
      })
      everyOption(
        'exhibit.pictures',
        pictures.map((picture) => picture.option),
      )
      return { kind, pictures }
    }
    case 'diagram': {
      const caption = bounded(problem, 'exhibit.caption', raw.caption, L.exhibitLine, { oneLine: true })
      const mermaid = bounded(problem, 'exhibit.mermaid', raw.mermaid, L.diagramChars)
      const nodes = mermaidNodes(mermaid)
      if (nodes > L.diagramNodes) problem(`exhibit.mermaid (${nodes} nodes: at most ${L.diagramNodes})`)
      return { kind, caption, mermaid }
    }
    case 'table': {
      const criteria = strings('exhibit.criteria', raw.criteria, 1, L.tableCriteria, L.tableCriterion)
      const list = Array.isArray(raw.rows) ? raw.rows : []
      const rows = list.map((entry, i) => {
        const item = isRecord(entry) ? entry : {}
        const cells = Array.isArray(item.cells) ? item.cells : []
        if (cells.length !== criteria.length)
          problem(`exhibit.rows[${i}].cells (one per criterion: ${criteria.length}, got ${cells.length})`)
        return {
          option: optionOf(`exhibit.rows[${i}].option`, item.option),
          cells: cells
            .slice(0, L.tableCriteria)
            .map((cell, j) => bounded(problem, `exhibit.rows[${i}].cells[${j}]`, cell, L.tableCell)),
        }
      })
      everyOption(
        'exhibit.rows',
        rows.map((row) => row.option),
      )
      return { kind, criteria, rows }
    }
    case 'numbers': {
      const list = Array.isArray(raw.figures) ? raw.figures : []
      if (list.length < 1 || list.length > L.figures) problem(`exhibit.figures (1 to ${L.figures}, got ${list.length})`)
      const figures = list.slice(0, L.figures).map((entry, i) => {
        const item = isRecord(entry) ? entry : {}
        return {
          label: bounded(problem, `exhibit.figures[${i}].label`, item.label, L.figureLabel),
          value: bounded(problem, `exhibit.figures[${i}].value`, item.value, L.figureValue),
          unit: bounded(problem, `exhibit.figures[${i}].unit`, item.unit, L.figureUnit),
        }
      })
      return { kind, figures }
    }
    default:
      problem(`exhibit.kind (one of ${EXHIBIT_KINDS.join(' | ')}; prose is not an exhibit)`)
      return null
  }
}

/**
 * Reads a Decision form. A form that breaks a rule is refused with every violation named, so the lead fixes it in one go:
 * `class`, `options[1].leadsTo`, `exhibit.today[0]`, `noAnswer.consequence`. A steward's Decision (`by: 'steward'`) is about a
 * stall: it is held to the text cap only, and the class, the line and each option's `leadsTo` are filled from what it has.
 */
export function readDecisionForm(
  raw: unknown,
  opts: { by?: 'lead' | 'steward' } = {},
): Result<DecisionForm, MissingFields> {
  const problems: string[] = []
  const problem: Problems = (name) => problems.push(name)
  const steward = opts.by === 'steward'
  const body = isRecord(raw) ? raw : {}

  let decisionClass: DecisionClass | null = null
  const rawClass = text(body.class)
  if (rawClass !== null && (DECISION_CLASSES as readonly string[]).includes(rawClass)) {
    decisionClass = rawClass as DecisionClass
  } else if (steward) {
    decisionClass = 'owner_fact'
  } else {
    problem(
      `class (one of ${classList}${rawClass !== null ? `; "${rawClass}" is none` : ''}). A choice in none of these classes is yours: take the default a revert undoes and write it under Decided in your Spec (the operating contract's order 2)`,
    )
  }
  const whyYours = steward
    ? (text(body.whyYours) ?? STEWARD_WHY)
    : bounded(problem, 'whyYours', body.whyYours, L.whyYours, { oneLine: true })

  const question = steward
    ? bounded(problem, 'question', body.question, L.text)
    : bounded(problem, 'question', body.question, L.question, { oneLine: true })
  if (!steward && question !== '' && !question.endsWith('?'))
    problem('question (one sentence that ends in a question mark)')
  const recommendation = bounded(problem, 'recommendation', body.recommendation, steward ? L.text : L.label)
  const checked = steward ? bounded(problem, 'checked', body.checked, L.text) : checkedOf(problem, body.checked)

  const options: DecisionOption[] = []
  const rawOptions = Array.isArray(body.options) ? body.options : []
  const [lo, hi] = [L.optionsMin, steward ? MAX_STEWARD_OPTIONS : L.optionsMax]
  if (rawOptions.length < lo) problem(`options (at least ${lo})`)
  if (rawOptions.length > hi) problem(`options (at most ${hi}, got ${rawOptions.length})`)
  for (const [i, rawOption] of rawOptions.slice(0, hi).entries()) {
    const option = isRecord(rawOption) ? rawOption : {}
    const label = bounded(problem, `options[${i}].label`, option.label, steward ? L.text : L.label, { oneLine: true })
    const cost = bounded(problem, `options[${i}].cost`, option.cost, steward ? L.text : L.cost)
    const leadsTo = steward
      ? (text(option.leadsTo) ?? cost)
      : bounded(problem, `options[${i}].leadsTo`, option.leadsTo, L.leadsTo)
    if (typeof option.reversible !== 'boolean') problem(`options[${i}].reversible`)
    options.push({ label, leadsTo, cost, reversible: option.reversible === true })
  }
  const labels = options.map((option) => option.label.toLowerCase()).filter(Boolean)
  if (new Set(labels).size !== labels.length) problem('options (two have the same label)')

  const find = (label: string) => options.find((option) => option.label.toLowerCase() === label.toLowerCase())
  const recommended = find(recommendation)
  const labelList =
    labels.length > 0
      ? `the options are: ${options
          .map((option) => option.label)
          .filter(Boolean)
          .join(' | ')}`
      : 'no option has a label yet'
  if (recommendation !== '' && !recommended) {
    problem(
      `recommendation (not one of the options: it is the label of one, exactly as in options and case ignored, not a sentence about it; ${labelList})`,
    )
  }

  const artifact = text(body.artifact)
  const exhibit = readExhibit(problem, body.exhibit, { labels: options.map((option) => option.label), artifact })

  const rawNo = isRecord(body.noAnswer) ? body.noAnswer : {}
  const consequence = bounded(problem, 'noAnswer.consequence', rawNo.consequence, L.text)
  const fallback = text(rawNo.default)
  let waitMinutes: number | null = null
  if (rawNo.waitMinutes !== undefined && rawNo.waitMinutes !== null) {
    const wait = rawNo.waitMinutes
    if (typeof wait !== 'number' || !Number.isInteger(wait) || wait < 1 || wait > MAX_WAIT_MINUTES) {
      problem(`noAnswer.waitMinutes (a whole number from 1 to ${MAX_WAIT_MINUTES})`)
    } else waitMinutes = wait
  }
  let chosen: string | null = null
  if (fallback !== null) {
    const option = find(fallback)
    if (!option) problem(`noAnswer.default (not one of the options: it is the label of a reversible one, ${labelList})`)
    else if (!option.reversible)
      problem(`noAnswer.default (${option.label} is not reversible: only a reversible option is a default)`)
    else chosen = option.label
    if (waitMinutes === null) problem('noAnswer.waitMinutes (a default needs the wait before it is taken)')
  } else if (waitMinutes !== null) {
    problem('noAnswer.default (a wait names the option taken when it ends)')
  }

  if (problems.length > 0) {
    return err({
      kind: 'missing_field',
      fields: problems,
      detail: `a Decision needs: ${problems.join('; ')}. Nothing was raised: ask again with every field.${
        problems.some((p) => p.startsWith('recommendation'))
          ? ` --recommendation is the label of one option, exactly as in --options and case ignored (--recommendation "<label>"), not a sentence about it.`
          : ''
      }`,
    })
  }
  return ok({
    class: decisionClass,
    whyYours: whyYours === '' ? null : whyYours,
    question,
    recommendation: recommended?.label ?? recommendation,
    checked,
    options,
    exhibit,
    artifact,
    noAnswer: { consequence, default: chosen, waitMinutes },
  })
}

/** `checked`: at most three lines of 160 characters; a blank line is no line. */
function checkedOf(problem: Problems, value: unknown): string {
  const found = text(value)
  if (found === null) {
    problem('checked')
    return ''
  }
  const lines = found.split(/\r?\n/).filter((line) => line.trim() !== '')
  if (lines.length > L.checkedLines) problem(`checked (${lines.length} lines: at most ${L.checkedLines})`)
  for (const [i, line] of lines.entries()) {
    if (line.length > L.checkedLine)
      problem(`checked line ${i + 1} (${line.length} characters: at most ${L.checkedLine})`)
  }
  return lines.join('\n')
}

/**
 * Labels that are no choice: "keep waiting", "wait for review", "do nothing", "hold". A label that goes on to a plan
 * ("Wait for Issue 12 to land, then ship", "Hold the release and ship the hotfix instead") is not matched.
 */
const NO_OP_LABELS: readonly RegExp[] = [
  /^(?:keep|continue|stay|remain|just|simply)\b.{0,12}\b(?:waiting|wait|blocked|paused)\b/i,
  /^(?:wait(?:ing)?|do(?:ing)? nothing|no[- ]?op|no action|nothing|hold|leave (?:it )?(?:as is|open|alone))\b[^,;:]{0,30}$/i,
]

/**
 * A Decision whose recommendation or default is to keep waiting is no choice for the owner: what it waits for is a human
 * chore (approve a PR, rotate a key, click in a UI), and a chore is an Errand (`factory errand raise`). Refused at ask time
 * with the pointer; null when the form has a real option to recommend.
 */
export function refuseNoOpDefault(form: DecisionForm): string | null {
  const named = [form.recommendation, form.noAnswer.default].filter((label): label is string => label !== null)
  const offender = named.find((label) => NO_OP_LABELS.some((pattern) => pattern.test(label.trim())))
  if (offender === undefined) return null
  return `a Decision is a choice, and "${offender}" is none: waiting never resolves. If the only real answer is a person's chore (approve a PR, rotate a key, click in a UI), raise an Errand with \`factory errand raise <id> --attempt <n> --summary "..." --detail "..." --tried "..."\`; otherwise recommend an option that moves the work. Nothing was raised.`
}

/** The label of the option a free-text answer names, ignoring case; null when it names none. */
function optionOf(form: Pick<DecisionForm, 'options'>, answer: string): string | null {
  const wanted = answer.trim().toLowerCase()
  return form.options.find((option) => option.label.toLowerCase() === wanted)?.label ?? null
}

/** The option taken when the wait has run out with no answer; null while it runs, and for a Decision with no default. */
export function defaultDue(form: Pick<DecisionForm, 'noAnswer'>, askedAt: Date, now: Date): string | null {
  const { default: label, waitMinutes } = form.noAnswer
  if (label === null || waitMinutes === null) return null
  return now.getTime() >= askedAt.getTime() + waitMinutes * 60_000 ? label : null
}

/** When the default is taken; null for a Decision with none. Derived from the fact that it was asked. */
export function defaultAt(form: Pick<DecisionForm, 'noAnswer'>, askedAt: Date): Date | null {
  const { default: label, waitMinutes } = form.noAnswer
  return label === null || waitMinutes === null ? null : new Date(askedAt.getTime() + waitMinutes * 60_000)
}

/**
 * The Judge's verdict, already parsed: it answers (`answer`), hands the Decision on (`owner`), or sends it back to its lead
 * (`back`, only when the request allowed it) with a note and why: the lead's to decide (`yours`) or not ready for the owner.
 */
export interface JudgeVerdict {
  verdict: 'answer' | 'owner' | 'back'
  answer: string
  reason: string
  source: string
  note?: string | undefined
  back?: 'yours' | 'not_ready' | undefined
}

/** The most of the Judge's note the lead is typed: agw clips it to the same. */
export const BACK_NOTE_MAX = 600

export type Guarded = { ok: true; answer: string; source: string } | { ok: false; why: string }

/**
 * The factory's checks on a Judge `answer`, after the workflow: the answer is exactly one of the options, it names a
 * source, and it is not an option that cannot be taken back (an irreversible option is the owner's, never the Judge's).
 */
export function guardVerdict(form: DecisionForm, verdict: JudgeVerdict): Guarded {
  const source = verdict.source.trim()
  if (source === '') return { ok: false, why: 'the answer names no source' }
  const label = optionOf(form, verdict.answer)
  if (label === null) return { ok: false, why: 'the answer is not one of the options' }
  const option = form.options.find((candidate) => candidate.label === label)
  if (option && !option.reversible) {
    return { ok: false, why: `${label} cannot be taken back: an irreversible option is the owner's` }
  }
  return { ok: true, answer: label, source }
}

/** A Decision the owner answered before, shown to the Judge as precedent: never one the Judge, a default or the orchestrator settled. */
export interface Precedent {
  question: string
  answer: string
  settledBy: 'owner'
  repo: string
}

/**
 * What `factory-ask` is given: scrubbed and cut, never a secret. The case file, the Issue as filed (`facts`) and the
 * checkout the Judge reads with its tools are added when the call is made (`app/case-agw.ts`).
 */
export interface JudgeInput {
  decision: string
  repo: string
  issue: string
  question: string
  recommendation: string
  checked: string
  /** the label, the cost (what it leads to and what changing it later costs) and whether it can be taken back */
  options: { label: string; reversible: boolean; cost: string }[]
  noAnswer: NoAnswer
  precedents: Precedent[]
  /** the Judge may send it back to its lead: a lead's Decision on its first look only */
  sendBack?: boolean
  /** the class the lead claims; absent on a Decision asked before the class existed */
  class?: DecisionClass
  /** the head of the Spec the question belongs to (its Build and Decided); untrusted data */
  spec?: string
}

const MAX_JUDGE_TEXT = 2000
/** What agw takes of the Spec's head (`factory-ask`: 20,000); the Issue as filed is the case file's (`app/case-agw.ts`). */
const MAX_JUDGE_SPEC = 20_000

const cut = (value: string): string => scrub(value).slice(0, MAX_JUDGE_TEXT)

/** The request with the head of the Spec the question belongs to (its Build and Decided), scrubbed and cut: the Spec is a blob, read with no transaction open. */
export const withSpec = (input: JudgeInput, content: string): JudgeInput => ({
  ...input,
  spec: scrub(specHeadText(content)).slice(0, MAX_JUDGE_SPEC),
})

/** A repo as the Judge is told of it: its name, never the path it lives at. */
const repoName = (repo: string): string => repo.split('/').filter(Boolean).pop() ?? 'repo'

export function judgeInputOf(input: {
  decision: DecisionId
  repo: string
  issue: string
  form: DecisionForm
  precedents: readonly Precedent[]
  sendBack?: boolean
  spec?: string
}): JudgeInput {
  const { form } = input
  return {
    decision: input.decision,
    repo: repoName(input.repo),
    issue: cut(input.issue),
    question: cut(form.question),
    recommendation: cut(form.recommendation),
    checked: cut(form.checked),
    options: form.options.map((option) => ({
      label: cut(option.label),
      reversible: option.reversible,
      cost: cut(option.leadsTo ? `leads to: ${option.leadsTo}. Changing it later: ${option.cost}` : option.cost),
    })),
    noAnswer: { ...form.noAnswer, consequence: cut(form.noAnswer.consequence) },
    precedents: input.precedents.map((p) => ({
      ...p,
      repo: repoName(p.repo),
      question: cut(p.question),
      answer: cut(p.answer),
    })),
    ...(input.sendBack ? { sendBack: true } : {}),
    ...(form.class ? { class: form.class } : {}),
    ...(input.spec ? { spec: scrub(input.spec).slice(0, MAX_JUDGE_SPEC) } : {}),
  }
}

const STOPWORDS = new Set([
  'the',
  'and',
  'for',
  'with',
  'that',
  'this',
  'from',
  'are',
  'was',
  'not',
  'but',
  'should',
  'would',
  'could',
  'use',
  'does',
  'did',
  'has',
  'have',
  'been',
  'into',
  'than',
  'then',
  'there',
  'which',
  'what',
  'when',
  'will',
  'how',
  'any',
])

/**
 * The words of a question as a Postgres `to_tsquery` OR expression, for the precedent lookup; null when it has none. Only
 * letters and digits survive, so the text can never break the query.
 */
export function precedentTerms(question: string, max = 12): string | null {
  const words = question
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length >= 3 && !STOPWORDS.has(word))
  const unique = [...new Set(words)].slice(0, max)
  return unique.length > 0 ? unique.join(' | ') : null
}
