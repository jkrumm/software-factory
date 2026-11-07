declare const brand: unique symbol

/** An id of one kind: an `Id<'issue'>` is not a string, and not an `Id<'event'>`. A domain names its own kinds. */
export type Id<K extends string> = string & { readonly [brand]: K }

export type IssueId = Id<'issue'>
export type EventId = Id<'event'>

/** Where new ids come from, a port so a test can make them in order. An id is `<kind>_<unique part>`. */
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
