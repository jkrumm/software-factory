// The two lookups every module of the package uses where a key or index must exist (a leaf: it imports nothing).

/** The entry for a key the caller knows is present; a missing one throws. */
export function required<T>(record: Record<string, T>, key: string): T {
  const value = record[key]
  if (value === undefined) throw new Error(`no entry for '${key}'`)
  return value
}

/** The entry at an index the caller knows is in range; a missing one throws. */
export function requiredAt<T>(list: readonly T[], index: number): T {
  const value = list[index]
  if (value === undefined) throw new Error(`no entry at ${index}`)
  return value
}
