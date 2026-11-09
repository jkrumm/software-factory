declare const brand: unique symbol

/** An id of one kind: an `Id<'issue'>` is not a string, and not an `Id<'event'>`. A domain names its own kinds. */
export type Id<K extends string> = string & { readonly [brand]: K }

/** `issue_<n>`: an Issue is a number, as the owner and every surface say it ("Issue 286"). */
export type IssueId = Id<'issue'>
export type EventId = Id<'event'>

/** The Issue of number `n`; the work store takes `n` from a Postgres sequence. */
export function issueId(n: number): IssueId {
  if (!Number.isSafeInteger(n) || n < 1) throw new Error(`an Issue number is a whole number from 1: ${n}`)
  return `issue_${n}` as IssueId
}

/** The number in an Issue id, for "Issue 286" and pane names. */
export const issueNumber = (id: IssueId): number => Number(id.slice('issue_'.length))

const LEAD_BRANCH = /^factory\/([1-9][0-9]*)-[1-9][0-9]*$/

/** The Issue number a lead's branch name carries; null for any other name. */
export function leadBranchIssue(branch: string): number | null {
  const match = LEAD_BRANCH.exec(branch)
  return match?.[1] ? Number(match[1]) : null
}

/** Where new ids come from (events and the like; an Issue's number comes from the work store), a port so a test can make them in order. An id is `<kind>_<unique part>`. */
export interface IdSource {
  next<K extends string>(kind: K): Id<K>
}

const ID = /^([a-z][a-z0-9]*)_([A-Za-z0-9-]+)$/

/** An id read back from storage or a request; null when it is not an id of that kind. */
export function idOf<K extends string>(kind: K, text: string): Id<K> | null {
  const match = ID.exec(text)
  return match?.[1] === kind ? (text as Id<K>) : null
}

/** Time-ordered ids (UUIDv7), so an id sorts roughly by when it was made. */
export const systemIds: IdSource = {
  next: <K extends string>(kind: K) => `${kind}_${Bun.randomUUIDv7()}` as Id<K>,
}

/** `issue_1`, `issue_2`, `event_1`, ...: one counter per kind, for tests. */
export function sequentialIds(): IdSource {
  const counters = new Map<string, number>()
  return {
    next: <K extends string>(kind: K) => {
      const n = (counters.get(kind) ?? 0) + 1
      counters.set(kind, n)
      return `${kind}_${n}` as Id<K>
    },
  }
}

/** `issue_12`, or the bare number the owner says ("Issue 12"): the one way a route reads an Issue it was handed. */
export function issueRef(text: string): IssueId | null {
  return idOf('issue', /^[1-9][0-9]*$/.test(text) ? `issue_${text}` : text)
}
