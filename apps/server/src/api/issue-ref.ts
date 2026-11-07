import { idOf, type IssueId } from '../kernel/ids.ts'

/** `issue_12`, or the bare number the owner says ("Issue 12"): the one way a route reads an Issue it was handed. */
export function issueRef(text: string): IssueId | null {
  return idOf('issue', /^[1-9][0-9]*$/.test(text) ? `issue_${text}` : text)
}
