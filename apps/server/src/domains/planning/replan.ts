import { cleanText } from '@software-factory/contract'
import type { IssueId } from '../../kernel/ids.ts'

export const REPLAN_TRIGGERS = ['owner', 'stalled', 'held'] as const
export type ReplanTrigger = (typeof REPLAN_TRIGGERS)[number]

/** A plan row held behind `after` rows that closed without shipping (`after_needs: shipped`), for a `held` Replan. */
export interface HeldRow {
  /** `project:key` */
  row: string
  /** the `after` rows that closed without shipping: `project:key`, Issue, outcome */
  by: readonly { row: string; issue: string; outcome: string }[]
}

/** The chain head a stalled Replan was filed for: a timed wait with Issues behind it. */
export interface StalledHead {
  issue: string
  title: string
  since: string
  until: string
  /** the open Issues that wait behind it */
  held: number
}

export interface ReplanInput {
  project: string
  trigger: ReplanTrigger
  ask?: string | undefined
  stalled?: StalledHead | undefined
  /** the rows a `held` Replan was filed for */
  held?: readonly HeldRow[] | undefined
}

const ASK_MAX = 2000
/** A head's title can come from an alert's text: quoted and clipped, it stays one line of data. */
const TITLE_MAX = 200

export const replanTitle = (project: string): string => `Replan: ${project}`

const PLAYBOOK = `Playbook:
1. Read docs/plan.yaml in your worktree (the format: docs/plan.md in the factory repo; \`factory issue schema\` and \`factory project show <project>\`, which prints every row with its state and why). Run \`factory project show <project>\`, \`factory issue list\` and \`factory issue show\` for the open and recently closed Issues of this repo to see their edges and waits.
2. Decide what should change: new, changed or dropped plan rows, \`after\` edges to add or remove, Issues to cancel, Issues to re-file (a cancel plus a new plan row).
3. Raise every non-obvious choice as a Decision with \`factory issue ask\` BEFORE you submit.
4. Write the proposal as a Spec (\`factory artifact submit <id> --attempt <n> --kind spec --title ... --content @file.md\`): one section per change with the row key or Issue id, the reason and the exact edit. List "no change" explicitly if nothing should change.
5. When the verdict is Looks good or With notes (it arrives as a note), apply it. Edit docs/plan.yaml through the project's normal ship path (a PR if the project requires one: the standing orders' ship path, rebase, push, CI green on that head, \`make merge-guard\`, merge, deploy). Apply edge changes and cancellations with \`factory issue replan <id> --attempt <n> --body '<json>'\`, shape {"edges":{"add":[{"issue":"issue_7","after":["issue_5"]}],"remove":[{"issue":"issue_7","after":["issue_5"]}]},"cancel":[{"issue":"issue_9","reason":"..."}]}. The server files new plan rows itself once the plan merges.
6. Ship: state each acceptance line. A verdict of Changes means revise the Spec.
Do not touch Issues outside this repo. A proposal with no change is valid: close with \`factory issue close ... --outcome done --reason "no plan change needed"\`.`

/**
 * Of the Issues a Replan's call changes, those it may not: unknown, filed for another repo, or the Replan itself. An
 * edge's dependent must also be open; a cancel target may be closed (the cancel then reports it, so a replayed call
 * is answered rather than refused).
 */
export function outsideProject(input: {
  replan: IssueId
  /** the repo text of the Replan's project */
  repo: string
  dependents: readonly IssueId[]
  cancels: readonly IssueId[]
  known: ReadonlyMap<IssueId, { repo: string; state: 'open' | 'closed' }>
}): IssueId[] {
  const outside = (issue: IssueId, needsOpen: boolean): boolean => {
    const found = input.known.get(issue)
    return issue === input.replan || !found || found.repo !== input.repo || (needsOpen && found.state !== 'open')
  }
  const bad = [...input.dependents.filter((i) => outside(i, true)), ...input.cancels.filter((i) => outside(i, false))]
  return [...new Set(bad)]
}

/** What the Replan's lead reads first: the facts as `name: value` lines, then the playbook. */
export function replanNote(input: ReplanInput): string {
  const ask = input.ask ? cleanText(input.ask).slice(0, ASK_MAX) : ''
  const lines = [`Replan of project ${input.project}.`, `trigger: ${input.trigger}`]
  if (ask) lines.push(`ask: ${ask}`)
  if (input.stalled) {
    const head = input.stalled
    lines.push(
      `stalled head: ${head.issue}`,
      `title: ${JSON.stringify(cleanText(head.title).slice(0, TITLE_MAX))}`,
      `wait since: ${head.since}`,
      `wait until: ${head.until}`,
      `waiting behind it: ${head.held}`,
    )
  }
  for (const held of input.held ?? [])
    lines.push(
      `held row: ${held.row} (after_needs shipped), held by ${held.by.map((b) => `${b.row} (${b.issue} closed ${b.outcome})`).join(', ')}`,
    )
  if (input.held?.length)
    lines.push(
      'held rows shipped nothing to build on: decide per row to re-file the dropped row, point the row at a replacement, remove the edge or set after_needs closed, or drop the row.',
    )
  return [lines.join('\n'), PLAYBOOK].join('\n\n')
}
