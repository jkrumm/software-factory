import { CASE_MAX_CHARS, caseChars, CHECKOUT_PATH, type JudgeCase } from '@software-factory/contract'
import type { AgwPort } from '../kernel/agw.ts'
import type { AgentsHead, CaseRead, CaseSubject, LastWords } from '../kernel/case-file.ts'
import { scrub } from '../kernel/scrub.ts'
import type { WorkflowName, WorkflowRequest } from '../kernel/workflows.ts'

/** Where the case comes from: the database's parts (read-only, outside any transaction) and the repo's AGENTS.md. */
export interface CaseFiles {
  read(subject: CaseSubject): Promise<CaseRead>
  agents: AgentsHead
  /** the steward's pane: the stalled lead's last words; absent, the steward's case carries none */
  lastWords?: LastWords
}

/** How much of a stalled lead's last words the steward reads. */
const PANE_CHARS = 4_000

/** The Judge's `facts`, the Issue as filed: agw refuses more. */
const JUDGE_FACTS_MAX = 8_000
/** A checkout path agw takes: plain path characters, at most this long. */
const CHECKOUT_MAX = 500

/** What a judgment request is about, as the case file reads it; null for a workflow that takes no case (Spec screen, hygiene). */
function subjectOf<N extends WorkflowName>(name: N, request: WorkflowRequest<N>): CaseSubject | null {
  switch (name) {
    case 'judge': {
      const judged = request as WorkflowRequest<'judge'>
      return { judge: 'judge', decision: judged.decision, repo: judged.repo }
    }
    case 'steward': {
      const stall = request as WorkflowRequest<'steward'>
      return { judge: 'steward', issue: stall.issue, attempt: stall.attempt }
    }
    case 'settle':
      return { judge: 'triage', issue: (request as WorkflowRequest<'settle'>).issue.id }
    case 'amend':
      return { judge: 'triage', repo: (request as WorkflowRequest<'amend'>).repo }
    case 'queue':
      return { judge: 'queue', repo: (request as WorkflowRequest<'queue'>).repo }
    case 'screen': {
      const repo = (request as WorkflowRequest<'screen'>).signal.repo
      return repo ? { judge: 'screen', repo } : null
    }
    case 'errandScreen':
      return { judge: 'errand', issue: (request as WorkflowRequest<'errandScreen'>).issue.id }
    case 'errandNeeded':
      return { judge: 'errandNeeded', errand: (request as WorkflowRequest<'errandNeeded'>).errand.id }
    default:
      return null
  }
}

/** A case with its empty parts left out, so a judge is told only of what there is. */
function compact(value: JudgeCase): JudgeCase {
  const out: JudgeCase = {}
  if (value.issue && (value.issue.text || value.issue.facts)) out.issue = value.issue
  if (value.ownerNotes?.length) out.ownerNotes = value.ownerNotes
  if (value.repo && (value.repo.project || value.repo.agents)) out.repo = value.repo
  if (value.open?.length) out.open = value.open
  if (value.plan) out.plan = value.plan
  if (value.precedents?.length) out.precedents = value.precedents
  if (value.pane) out.pane = value.pane
  return out
}

/**
 * The case under the cap (`CASE_MAX_CHARS`): agw refuses a longer one, never cuts it, so the factory leaves out what matters
 * least first: the oldest open Issues, then the oldest precedents, then the tail of the plan, of AGENTS.md and of the facts.
 */
export function fitCase(value: JudgeCase): JudgeCase {
  const fitted: JudgeCase = structuredClone(value)
  const over = () => caseChars(fitted) - CASE_MAX_CHARS
  while (over() > 0 && fitted.open?.length) fitted.open.pop()
  while (over() > 0 && fitted.precedents?.length) fitted.precedents.pop()
  const shorten = (text: string | undefined): string => (text ? text.slice(0, Math.max(0, text.length - over())) : '')
  if (over() > 0 && fitted.plan) fitted.plan = shorten(fitted.plan)
  if (over() > 0 && fitted.repo) fitted.repo.agents = shorten(fitted.repo.agents)
  if (over() > 0 && fitted.issue) fitted.issue.facts = shorten(fitted.issue.facts)
  while (over() > 0 && fitted.ownerNotes?.length) fitted.ownerNotes.shift()
  if (over() > 0 && fitted.pane) fitted.pane = shorten(fitted.pane)
  return compact(fitted)
}

interface BuiltCase {
  case: JudgeCase
  /** the repo's main checkout, when the factory knows it and agw can be told of it */
  checkout: string | null
}

/**
 * The case file of one judgment: the database's parts, the repo's brief (its project and the head of AGENTS.md from the
 * main checkout) and the parts the caller already holds (`own`, the steward's pane), which win. Scrubbed and fitted.
 */
async function buildCase(files: CaseFiles, subject: CaseSubject, own: JudgeCase = {}): Promise<BuiltCase> {
  const read = await files.read(subject)
  const { project, ...parts } = read.case
  let agents = ''
  if (read.checkout) {
    const head = await files.agents(read.checkout)
    if (head.ok) agents = scrub(head.value)
    else console.error(`case file: AGENTS.md of ${read.repo ?? '?'} could not be read: ${head.error.detail}`)
  }
  const checkout =
    read.checkout && read.checkout.length <= CHECKOUT_MAX && CHECKOUT_PATH.test(read.checkout) ? read.checkout : null
  let pane = ''
  if (read.transcript && files.lastWords) {
    const words = await files.lastWords(read.transcript, PANE_CHARS)
    if (words.ok) pane = scrub(words.value ?? '')
  }
  return {
    case: fitCase({ ...parts, repo: { project: project ?? '', agents }, ...(pane ? { pane } : {}), ...own }),
    checkout,
  }
}

/** The request with its case; the Judge's also gets the Issue as filed (`facts`) and the checkout it reads with its tools. */
function withCase<N extends WorkflowName>(name: N, request: WorkflowRequest<N>, built: BuiltCase): WorkflowRequest<N> {
  if (name !== 'judge') return { ...request, case: built.case }
  const judged = request as WorkflowRequest<'judge'>
  const filed = built.case.issue
  const facts =
    judged.facts ??
    (filed ? scrub([filed.text, filed.facts].filter(Boolean).join('\n\n')).slice(0, JUDGE_FACTS_MAX) : undefined)
  const checkout = judged.checkout ?? built.checkout ?? undefined
  return {
    ...judged,
    case: built.case,
    ...(facts ? { facts } : {}),
    ...(checkout ? { checkout } : {}),
  } as WorkflowRequest<N>
}

/**
 * The agw port with the case file: every judgment request (`subjectOf`) is sent with what the factory holds about it. The
 * case is read when the call is made, so never inside a transaction (the port's own rule). A case that cannot be read is
 * left out and said on stderr: the judgment goes ahead on the request alone, as it did before the case file.
 */
export function casedAgw(inner: AgwPort, files: CaseFiles): AgwPort {
  return {
    async run(name, request, key) {
      const subject = subjectOf(name, request)
      if (!subject) return inner.run(name, request, key)
      const own = (request as { case?: JudgeCase }).case
      const built = await buildCase(files, subject, own).catch((error: unknown) => {
        console.error(`case file: ${name} ${key}: ${error instanceof Error ? error.message : String(error)}`)
        return null
      })
      return inner.run(name, built ? withCase(name, request, built) : request, key)
    },
  }
}
