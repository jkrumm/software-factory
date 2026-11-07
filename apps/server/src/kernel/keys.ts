declare const brand: unique symbol

/**
 * A deterministic key: the same parts give the same key in every process, so a replayed tick, call or event finds what
 * the first one stored and does nothing twice. Effects, events, pane names and prompt ids are all keys.
 */
export type Key = string & { readonly [brand]: 'key' }

/** `%` and `:` inside a part are escaped, so two different part lists never make the same key. */
const escapePart = (part: string): string => part.replaceAll('%', '%25').replaceAll(':', '%3A')

/** The one way to build a key: its parts joined by `:`. A part is a non-empty string or a whole number. */
export function key(...parts: readonly (string | number)[]): Key {
  if (parts.length === 0) throw new Error('a key needs at least one part')
  return parts
    .map((part) => {
      if (typeof part === 'number' && !Number.isSafeInteger(part)) throw new Error(`a key part must be whole: ${part}`)
      const text = String(part)
      if (text === '') throw new Error('a key part must not be empty')
      return escapePart(text)
    })
    .join(':') as Key
}

/** A key read back from storage or a request, as given. */
export const keyOf = (text: string): Key | null => (text === '' ? null : (text as Key))
