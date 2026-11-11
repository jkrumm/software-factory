import { type IssueId, issueId } from '../../kernel/ids.ts'

/** A repo's main checkout as the steward reads it: the branch (null: detached HEAD), the default branch (null: unknown), the tracked paths with uncommitted changes. */
export interface MainCheckoutLook {
  branch: string | null
  defaultBranch: string | null
  dirty: string[]
}

export type MainCheckoutKind = 'branch' | 'dirty' | 'both'

export interface MainCheckoutFinding {
  kind: MainCheckoutKind
  branch: string | null
  defaultBranch: string | null
  dirty: string[]
  /** the branch state and clean/dirty only: a change in which paths are dirty is not a new finding */
  fingerprint: string
  text: string
}

/** A finding as the health line tells it: one per repo with a live lead. */
export interface MainCheckoutLine {
  repo: string
  text: string
  since: Date
  /** the live Issues of the repo (the line is as visible as the first) */
  issues: IssueId[]
  /** the one lead the checkout can be named to (its branch is that lead's branch), the one that was noted; null: the owner's surface only */
  noted: IssueId | null
  kind: MainCheckoutKind
  fingerprint: string
}

const SHOWN_PATHS = 3

/**
 * The live lead a main checkout can be named to: its branch is a lead branch (`factory/<n>-<attempt>`) of one of the repo's
 * live Issues. A default or another branch, a detached HEAD and dirty paths name no session (the owner and the plan-owning
 * session also work there), so they stay on the health line and reach no lead.
 */
export function checkoutOwner(finding: Pick<MainCheckoutFinding, 'branch'>, live: readonly IssueId[]): IssueId | null {
  // `leadBranch` in `domains/leads/names.ts` makes these names; a domain reads no other, so the shape is repeated here.
  const match = finding.branch === null ? null : /^factory\/([1-9][0-9]*)-[1-9][0-9]*$/.exec(finding.branch)
  const owner = match?.[1] ? issueId(Number(match[1])) : null
  return owner && live.includes(owner) ? owner : null
}

/**
 * A main checkout is shared: a lead works in its own worktree. Off its default branch (when that is known) or holding
 * tracked uncommitted changes is where a lead's work went astray. A clean checkout on the default branch is no finding.
 */
export function judgeMainCheckout(look: MainCheckoutLook): MainCheckoutFinding | null {
  const off = look.defaultBranch !== null && look.branch !== look.defaultBranch
  const dirty = look.dirty.length > 0
  if (!off && !dirty) return null
  const kind: MainCheckoutKind = off && dirty ? 'both' : off ? 'branch' : 'dirty'
  const where = look.branch === null ? 'a detached HEAD' : `branch ${look.branch}`
  const parts: string[] = []
  if (off) parts.push(`it is on ${where}, not the default branch ${look.defaultBranch}`)
  if (dirty) {
    const shown = look.dirty.slice(0, SHOWN_PATHS).join(', ')
    const more = look.dirty.length > SHOWN_PATHS ? `, and ${look.dirty.length - SHOWN_PATHS} more` : ''
    parts.push(`it has uncommitted changes to tracked files (${shown}${more})`)
  }
  return {
    kind,
    branch: look.branch,
    defaultBranch: look.defaultBranch,
    dirty: look.dirty,
    fingerprint: `${look.branch ?? 'detached'}:${dirty ? 'dirty' : 'clean'}`,
    text: `The repo's main checkout is shared and a lead's work belongs in its own worktree, yet ${parts.join(' and ')}. If a lead did this, move the work into your worktree and restore the main checkout. If this is the owner's own work in progress, ignore this note.`,
  }
}
