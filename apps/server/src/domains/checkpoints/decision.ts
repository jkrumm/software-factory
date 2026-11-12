import type { Id } from '../../kernel/ids.ts'
import { err, ok, type Result } from '../../kernel/result.ts'
import { scrub } from '../../kernel/scrub.ts'

export { scrub }

export type DecisionId = Id<'decision'>

/** The steps of settling a Decision, in the order they are tried (`docs/architecture.md` §Loops and agw). */
export const STEPS = ['policy', 'judge', 'default', 'owner'] as const
export type StepName = (typeof STEPS)[number]

/** Who settled a Decision: a step, or the orchestrator answering for the owner (never a step of its own). */
export const SETTLERS = [...STEPS, 'orchestrator'] as const
export type Settler = (typeof SETTLERS)[number]

/** What one option costs and whether it can be taken back. A default is only ever a reversible option. */
export interface DecisionOption {
  label: string
  reversible: boolean
  cost: string
}

/** What happens with no answer. `default` is an option's label, taken after `waitMinutes`; both or neither. */
export interface NoAnswer {
  consequence: string
  default: string | null
  waitMinutes: number | null
}

/** The Decision as the lead writes it: a form, and every field is required (`docs/language.md`, Decision). */
export interface DecisionForm {
  question: string
  recommendation: string
  checked: string
  options: DecisionOption[]
  noAnswer: NoAnswer
}

/** The Judge is called up to this many times; a Decision reaches the owner unjudged only after the last one failed. */
export const JUDGE_MAX_TRIES = 3
/** The wait after a failed Judge call before the next try. */
export const JUDGE_BACKOFF_MS = 5 * 60_000

export const MAX_OPTIONS = 10
export const MAX_TEXT = 4000
export const MAX_WAIT_MINUTES = 7 * 24 * 60

/** A form that is not complete: the fields that are missing or wrong, each named as the lead wrote it. */
export interface MissingFields {
  kind: 'missing_field'
  fields: string[]
  detail: string
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const text = (value: unknown): string | null => (typeof value === 'string' && value.trim() !== '' ? value.trim() : null)

/**
 * Reads a Decision form. A form with a missing field is refused with every such field named, so the lead fixes it in one
 * go: `recommendation`, `options[1].cost`, `noAnswer.consequence`.
 */
export function readDecisionForm(raw: unknown): Result<DecisionForm, MissingFields> {
  const problems: string[] = []
  const body = isRecord(raw) ? raw : {}
  const need = (name: string, value: unknown): string => {
    const found = text(value)
    if (found === null) problems.push(name)
    else if (found.length > MAX_TEXT) problems.push(`${name} (longer than ${MAX_TEXT} characters)`)
    return found ?? ''
  }

  const question = need('question', body.question)
  const recommendation = need('recommendation', body.recommendation)
  const checked = need('checked', body.checked)

  const options: DecisionOption[] = []
  const rawOptions = Array.isArray(body.options) ? body.options : []
  if (rawOptions.length < 2) problems.push('options (at least two)')
  if (rawOptions.length > MAX_OPTIONS) problems.push(`options (at most ${MAX_OPTIONS})`)
  for (const [i, rawOption] of rawOptions.slice(0, MAX_OPTIONS).entries()) {
    const option = isRecord(rawOption) ? rawOption : {}
    const label = need(`options[${i}].label`, option.label)
    const cost = need(`options[${i}].cost`, option.cost)
    if (typeof option.reversible !== 'boolean') problems.push(`options[${i}].reversible`)
    options.push({ label, cost, reversible: option.reversible === true })
  }
  const labels = options.map((option) => option.label.toLowerCase()).filter(Boolean)
  if (new Set(labels).size !== labels.length) problems.push('options (two have the same label)')

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
    problems.push(`recommendation (not one of the options: it is the label of one, ${labelList})`)
  }

  const rawNo = isRecord(body.noAnswer) ? body.noAnswer : {}
  const consequence = need('noAnswer.consequence', rawNo.consequence)
  const fallback = text(rawNo.default)
  let waitMinutes: number | null = null
  if (rawNo.waitMinutes !== undefined && rawNo.waitMinutes !== null) {
    const wait = rawNo.waitMinutes
    if (typeof wait !== 'number' || !Number.isInteger(wait) || wait < 1 || wait > MAX_WAIT_MINUTES) {
      problems.push(`noAnswer.waitMinutes (a whole number from 1 to ${MAX_WAIT_MINUTES})`)
    } else waitMinutes = wait
  }
  let chosen: string | null = null
  if (fallback !== null) {
    const option = find(fallback)
    if (!option)
      problems.push(`noAnswer.default (not one of the options: it is the label of a reversible one, ${labelList})`)
    else if (!option.reversible)
      problems.push(`noAnswer.default (${option.label} is not reversible: only a reversible option is a default)`)
    else chosen = option.label
    if (waitMinutes === null) problems.push('noAnswer.waitMinutes (a default needs the wait before it is taken)')
  } else if (waitMinutes !== null) {
    problems.push('noAnswer.default (a wait names the option taken when it ends)')
  }

  if (problems.length > 0) {
    return err({
      kind: 'missing_field',
      fields: problems,
      detail: `a Decision needs: ${problems.join('; ')}. Nothing was raised: ask again with every field.`,
    })
  }
  return ok({
    question,
    recommendation: recommended?.label ?? recommendation,
    checked,
    options,
    noAnswer: { consequence, default: chosen, waitMinutes },
  })
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
export function optionOf(form: Pick<DecisionForm, 'options'>, answer: string): string | null {
  const wanted = answer.trim().toLowerCase()
  return form.options.find((option) => option.label.toLowerCase() === wanted)?.label ?? null
}

/** A rule in a project's `project.yaml` that settles a recurring Decision: a phrase of the question and the option it takes. */
export interface PolicyRule {
  /** matched against the question, ignoring case */
  when: string
  /** the label of the option to take */
  answer: string
  /** why the owner decided this once and for all */
  reason: string
}

export interface PolicyMatch {
  answer: string
  rule: PolicyRule
}

/** The first rule whose phrase the question contains and whose answer is one of the options; the rest are skipped. */
export function matchPolicy(rules: readonly PolicyRule[], form: DecisionForm): PolicyMatch | null {
  const question = form.question.toLowerCase()
  for (const rule of rules) {
    if (rule.when.trim() === '' || !question.includes(rule.when.trim().toLowerCase())) continue
    const answer = optionOf(form, rule.answer)
    if (answer) return { answer, rule }
  }
  return null
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

/** The Judge's verdict, already parsed: it settles (`answer`) or hands the Decision on (`owner`). */
export interface JudgeVerdict {
  verdict: 'answer' | 'owner'
  answer: string
  reason: string
  source: string
}

export type Guarded = { ok: true; answer: string; source: string } | { ok: false; why: string }

/**
 * The factory's checks on a Judge `answer`, after the workflow: the answer is exactly one of the options, it names a
 * source, and it is not an option that cannot be taken back (an irreversible option is the owner's, or a standing
 * policy's, never the Judge's).
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

/** A Decision answered before, shown to the Judge as precedent. `worthAsking` is the owner's flag, null while unset. */
export interface Precedent {
  question: string
  answer: string
  settledBy: Settler
  worthAsking: boolean | null
  repo: string
}

/** What `factory-ask` is given: scrubbed and cut, never a path or a secret. */
export interface JudgeInput {
  decision: string
  repo: string
  issue: string
  question: string
  recommendation: string
  checked: string
  options: DecisionOption[]
  noAnswer: NoAnswer
  precedents: Precedent[]
}

const MAX_JUDGE_TEXT = 2000

const cut = (value: string): string => scrub(value).slice(0, MAX_JUDGE_TEXT)

/** A repo as the Judge is told of it: its name, never the path it lives at. */
export const repoName = (repo: string): string => repo.split('/').filter(Boolean).pop() ?? 'repo'

export function judgeInputOf(input: {
  decision: DecisionId
  repo: string
  issue: string
  form: DecisionForm
  precedents: readonly Precedent[]
}): JudgeInput {
  const { form } = input
  return {
    decision: input.decision,
    repo: repoName(input.repo),
    issue: cut(input.issue),
    question: cut(form.question),
    recommendation: cut(form.recommendation),
    checked: cut(form.checked),
    options: form.options.map((option) => ({ ...option, label: cut(option.label), cost: cut(option.cost) })),
    noAnswer: { ...form.noAnswer, consequence: cut(form.noAnswer.consequence) },
    precedents: input.precedents.map((p) => ({
      ...p,
      repo: repoName(p.repo),
      question: cut(p.question),
      answer: cut(p.answer),
    })),
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
