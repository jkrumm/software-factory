/**
 * A repo's lead cap that binds while seats idle (docs/decisions.md, NL48). A `leads:` or a lane cap is a claim about a resource
 * the repo cannot share; the throughput loop checks it against what was measured. When the cap is the reason an Issue of the
 * repo stays queued for an hour or more while the accounts have allowance idle, the loop files one signal on the repo: the cap, the
 * comment beside it, and the measured figures for the resource that comment names. The default fix is to remove the cap, or to
 * raise it to what the figures allow. No I/O here.
 */
import { capReasonOf, DEFAULT_LEADS, type CapReason } from '@software-factory/contract/project'
import { BINDING_MINUTES } from '../../kernel/throughput-limits.ts'

/** What the repo's merge windows over the last week measured (`factory.merge_windows`): how often, how long held, how long waited for. */
export interface MergeWindowFigures {
  days: number
  windows: number
  holdMedianMinutes: number
  waitMedianMinutes: number
}

/** The measured figures a cap's comment may be about; null where nothing was measured. */
export interface CapFigures {
  /** the worktrees measured for the repo: how many attempts, their 80th percentile and the largest, MiB */
  worktrees: { attempts: number; p80Mib: number; largestMib: number } | null
  /** the free and total disk now, MiB */
  disk: { freeMib: number; totalMib: number } | null
  /** a lead's memory outside test slots over the last week: the 80th percentile of the attempts' peaks, MiB */
  lead: { attempts: number; p80Mib: number } | null
  mergeWindows: MergeWindowFigures | null
}

/** One repo's cap that kept Issues queued while seats idled, over the window. */
export interface CapFact {
  project: string
  /** the lane whose cap binds; null: the repo's `leads` */
  lane: string | null
  /** the cap's number in force now */
  cap: number
  /** the comment beside the cap in project.yaml; null: none, or the file could not be read */
  comment: string | null
  /** the minutes of the window in which an Issue of the repo was queued for this cap while an account seat sat idle */
  bindingMinutes: number
  /** the distinct Issues that waited */
  issues: number
  /** the median of the idle allowance (the leads the accounts may run less those running) in those minutes */
  idleAllowance: number
  hours: number
  figures: CapFigures
}

/** The caps that bound for an hour or more and are still set below the default: a cap already lifted is nothing to challenge. */
export const bindingCaps = (facts: readonly CapFact[]): CapFact[] =>
  facts.filter((f) => f.cap < DEFAULT_LEADS && f.bindingMinutes >= BINDING_MINUTES)

const gib = (mib: number): string => `${Math.round((mib / 1024) * 10) / 10} GiB`
const minutes = (value: number): string => `${Math.round(value * 10) / 10} min`

/** What the cap is called: `leads: 2`, or `lanes.apple.leads: 1`. */
export const capName = (fact: Pick<CapFact, 'lane' | 'cap'>): string =>
  fact.lane === null ? `leads: ${fact.cap}` : `lanes.${fact.lane}.leads: ${fact.cap}`

/** The title names the cap for the lead; the cap and the repo are the finding's key: one cap, one open signal. */
export const capTitle = (fact: Pick<CapFact, 'lane' | 'cap' | 'project'>): string =>
  `The lead cap \`${capName(fact)}\` of ${fact.project} binds while seats idle`

function figureLines(reason: CapReason, f: CapFigures): string[] {
  const disk: string[] = []
  if (f.worktrees) {
    const free = f.disk ? `; the host has ${gib(f.disk.freeMib)} free of ${gib(f.disk.totalMib)}` : ''
    disk.push(
      `- Disk: a worktree with its build output measured ${gib(f.worktrees.p80Mib)} (p80 of ${f.worktrees.attempts} attempts), the largest ${gib(f.worktrees.largestMib)}${free}`,
    )
  }
  const merge: string[] = []
  if (f.mergeWindows) {
    const w = f.mergeWindows
    merge.push(
      `- Merge windows: ${w.windows} in ${w.days} days, held a median ${minutes(w.holdMedianMinutes)}, waited for a median ${minutes(w.waitMedianMinutes)} (\`factory merge-lock\` serialises them whatever the cap)`,
    )
  }
  const memory: string[] = f.lead
    ? [
        `- Memory: a lead outside test slots peaked at ${gib(f.lead.p80Mib)} (p80 of ${f.lead.attempts} attempts); admission fits it against the free memory`,
      ]
    : []
  switch (reason) {
    case 'disk':
      return disk.length > 0 ? disk : ['- Disk: no worktree of this repo has been measured yet']
    case 'merge':
      return merge.length > 0 ? merge : ['- Merge windows: none recorded in the last week']
    case 'deploy':
      return ['- Deploy queue: `factory deploy-lock` serialises it whatever the cap', ...merge]
    default:
      return [...disk, ...memory, ...merge]
  }
}

/** The signal's text for a binding cap: the cap and its comment, how long and how often it held Issues back, the figures, and the default fix. */
export function capText(fact: CapFact): string {
  const { reason, hint } = capReasonOf(fact.comment)
  const lane = fact.lane === null ? '' : ` of lane ${fact.lane}`
  const lines = [
    `\`${capName(fact)}\`${lane} in project.yaml kept ${fact.issues} Issue${fact.issues === 1 ? '' : 's'} of ${fact.project} queued for a claim for ${Math.round(fact.bindingMinutes)} of the last ${fact.hours} hours while a median ${fact.idleAllowance} account seat${fact.idleAllowance === 1 ? '' : 's'} sat idle.`,
    '',
    `Its comment: ${fact.comment ?? 'none'}`,
    '',
    'Measured for the resource it names:',
    ...figureLines(reason, fact.figures),
    '',
    hint
      ? `The comment names a resource the factory already holds: ${hint}.`
      : 'Static caps are claims about resources and are re-checked against measurements (NL48): only host resources and real chains hold work back.',
    'Default fix: remove the cap from project.yaml, or raise it to what the figures above allow, and say in its comment which measured resource it stands for.',
  ]
  return lines.join('\n')
}
