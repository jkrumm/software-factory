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

/** How long a head waits on the owner, with work behind it, before the planning pass files a Replan for it. */
export const OWNER_WAIT_MS = 2 * 3_600_000

/** What an owner wait is: an open Decision, a Spec or Concept under his review (an owner gate's), or an Errand. */
export type OwnerWaitKind = 'decision' | 'review' | 'errand'

/**
 * The chain head a stalled Replan was filed for: a timed wait with Issues behind it, or a wait on the owner (a Decision, a
 * Spec under review, an Errand) with Issues or plan rows behind it.
 */
export interface StalledHead {
  issue: string
  title: string
  since: string
  /** a timed wait: when the clock wakes the head; null for an owner wait */
  until: string | null
  /** an owner wait: what the owner is asked, by kind, id and title */
  owner?: { kind: OwnerWaitKind; id: string; title: string } | undefined
  /** the open Issues that wait behind it, directly or through other Issues */
  held: number
  /** each of them with what it waits on directly: the real blockers, which are not always the head */
  heldIssues: readonly { issue: string; after: readonly string[] }[]
  /** the plan rows not yet filed that wait behind it (`project:key`), each with what it waits on directly */
  heldRows?: readonly { row: string; after: readonly string[] }[] | undefined
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
/** The held Issues a brief lists; a long chain is read with `factory issue show`. */
const HELD_LISTED = 20

export const replanTitle = (project: string): string => `Replan: ${project}`

const PLAYBOOK = `Playbook:
1. Read docs/plan.yaml in your worktree (the format: docs/plan.md in the factory repo; \`factory issue schema\` and \`factory project show <project>\`, which prints every row with its state and why). Run \`factory project show <project>\`, \`factory issue list\` and \`factory issue show\` for the open and recently closed Issues of this repo to see their edges and waits.
2. Decide what should change: new, changed or dropped plan rows, \`after\` edges to add or remove, Issues to cancel, Issues to re-file (a cancel plus a new plan row).
3. Raise every non-obvious choice as a Decision with \`factory issue ask\` BEFORE you submit.
4. Write the proposal as a Spec (\`factory artifact submit <id> --attempt <n> --kind spec --title ... --content @file.md\`): Build lists the changes (at most eight lines), Decided gives each change's row key or Issue id and its reason, a line each, and the exact edits go into \`<details>\` blocks (the Spec's text outside them is at most 4000 characters). If nothing should change, submit no Spec: close (below). End the Spec with one fenced \`replan\` block that states the changes as data: \`\`\`replan {"plan":["<row key added, changed or dropped>"],"free":["<row key whose only change is a removed after>"],"edges":{"add":[...],"remove":[...]},"cancel":[...]} \`\`\` (edges and cancel in the shape of step 5). A row whose only change is an \`after\` entry taken out goes in \`free\`, never in \`plan\`; any other change to it goes in \`plan\`. The factory's rules read it: a proposal with an empty \`plan\` that cancels nothing (it only frees rows or adds and removes edges, such as freeing an Issue that waits behind a stalled one) is settled by rule and you apply it at once; anything else goes to the owner.
5. When there is a Looks good verdict, or the factory settled it by rule (each arrives as a note), apply it. Edit docs/plan.yaml through the project's normal ship path (a PR if the project requires one: the standing orders' ship path, \`factory land\`, then deploy). Apply edge changes and cancellations with \`factory issue replan <id> --attempt <n> --body '<json>'\`, shape {"edges":{"add":[{"issue":"issue_7","after":["issue_5"]}],"remove":[{"issue":"issue_7","after":["issue_5"]}]},"cancel":[{"issue":"issue_9","reason":"..."}]}. The server files new plan rows itself once the plan merges.
6. Ship: state each acceptance line. A verdict of Changes means revise the Spec.
Do not touch Issues outside this repo. A proposal with no change is valid: close with \`factory issue close ... --outcome done --reason "no plan change needed"\`.`

/**
 * Of the Issues a Replan's call changes, those it may not: unknown, filed for another repo, or the Replan itself. An
 * edge's dependent must also be open; a cancel target may be closed (the cancel then reports it, so a replayed call
 * is answered rather than refused). One exception frees: a removed edge's dependent may belong to another repo when
 * every Issue it waits after is an Issue of the Replan's own project (a stalled head of this project holds a dependent
 * of another one; removing the edge only frees it), and an unknown or closed head still refuses.
 */
export function outsideProject(input: {
  replan: IssueId
  /** the repo text of the Replan's project */
  repo: string
  /** dependents of added edges */
  dependents: readonly IssueId[]
  /** removed edges: the dependent and the Issues it no longer waits after */
  removals: readonly { issue: IssueId; after: readonly IssueId[] }[]
  cancels: readonly IssueId[]
  known: ReadonlyMap<IssueId, { repo: string; state: 'open' | 'closed' }>
}): IssueId[] {
  const outside = (issue: IssueId, needsOpen: boolean): boolean => {
    const found = input.known.get(issue)
    return issue === input.replan || !found || found.repo !== input.repo || (needsOpen && found.state !== 'open')
  }
  const own = (issue: IssueId): boolean => !outside(issue, false)
  const removed = (edge: { issue: IssueId; after: readonly IssueId[] }): boolean => {
    const found = input.known.get(edge.issue)
    if (edge.issue === input.replan || found?.state !== 'open') return true
    return found.repo !== input.repo && !(edge.after.length > 0 && edge.after.every(own))
  }
  const bad = [
    ...input.dependents.filter((i) => outside(i, true)),
    ...input.removals.filter(removed).map((edge) => edge.issue),
    ...input.cancels.filter((i) => outside(i, false)),
  ]
  return [...new Set(bad)]
}

/** What the Replan's lead reads first: the facts as `name: value` lines, then the playbook. */
export function replanNote(input: ReplanInput): string {
  const ask = input.ask ? cleanText(input.ask).slice(0, ASK_MAX) : ''
  const lines = [`Replan of project ${input.project}.`, `trigger: ${input.trigger}`]
  if (ask) lines.push(`ask: ${ask}`)
  if (input.stalled) {
    const head = input.stalled
    const rows = head.heldRows ?? []
    lines.push(
      `stalled head: ${head.issue}`,
      `title: ${JSON.stringify(cleanText(head.title).slice(0, TITLE_MAX))}`,
      `wait since: ${head.since}`,
      head.owner
        ? `waits on the owner: ${OWNER_WAIT_WORDS[head.owner.kind]} ${head.owner.id}, ${JSON.stringify(cleanText(head.owner.title).slice(0, TITLE_MAX))}`
        : `wait until: ${head.until ?? 'not stated'}`,
      `waiting behind it: ${head.held} (directly or through other Issues)`,
    )
    if (rows.length > 0) lines.push(`plan rows waiting behind it: ${rows.length} (not yet filed)`)
    for (const held of head.heldIssues.slice(0, HELD_LISTED))
      lines.push(`waiting issue: ${held.issue}, waits directly on ${held.after.join(', ') || 'nothing stored'}`)
    if (head.heldIssues.length > HELD_LISTED) lines.push(`(${head.heldIssues.length - HELD_LISTED} more not listed)`)
    for (const held of rows.slice(0, HELD_LISTED))
      lines.push(`waiting row: ${held.row}, after ${held.after.join(', ') || 'nothing stored'}`)
    if (rows.length > HELD_LISTED) lines.push(`(${rows.length - HELD_LISTED} more rows not listed)`)
  }
  for (const held of input.held ?? [])
    lines.push(
      `held row: ${held.row} (after_needs shipped), held by ${held.by.map((b) => `${b.row} (${b.issue} closed ${b.outcome})`).join(', ')}`,
    )
  if (input.held?.length)
    lines.push(
      'held rows shipped nothing to build on: decide per row to re-file the dropped row, point the row at a replacement, remove the edge or set after_needs closed, or drop the row.',
    )
  return [lines.join('\n'), ...(input.stalled?.owner ? [OWNER_PLAYBOOK] : []), PLAYBOOK].join('\n\n')
}

const OWNER_WAIT_WORDS: Record<OwnerWaitKind, string> = {
  decision: 'the Decision',
  review: 'his review of',
  errand: 'the Errand',
}

/** Read before the playbook when the head waits on the owner: a gate holds what needs its answer, and only that. */
const OWNER_PLAYBOOK = `The head waits on the owner. A gate holds what needs its answer; free the rest.
- For each direct dependent (an Issue or row whose after names the head), write one line in the Spec: whether it needs the owner's answer or the head's output, and why.
- A dependent is freed when its work stands under every answer the owner can give and a revert undoes it. Everything else stays held: when in doubt, it waits.
- Free an Issue with an edge removal (\`edges.remove\`); free a plan row by taking the head out of its \`after\` and naming the row in \`free\`. A proposal that only frees is settled by rule and applied at once; the plan edit ships through the project's ship path.
- Never change the head, its question or a dependent's content in this Replan: that is the owner's answer to give.`
