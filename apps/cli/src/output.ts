export type Format = 'json' | 'plain'

const cell = (value: unknown): string => {
  if (value === null || value === undefined) return '-'
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return JSON.stringify(value)
}

const lines = (value: unknown, prefix: string): string[] => {
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    return Object.entries(value).flatMap(([key, inner]) => lines(inner, prefix ? `${prefix}.${key}` : key))
  }
  return [prefix ? `${prefix}\t${cell(value)}` : cell(value)]
}

/**
 * The plain rendering of a generated command's answer: one `key<TAB>value` line per leaf, nested keys joined by dots,
 * null as `-`; a list is one block per entry. Hand-written verbs print their own plain form.
 */
export function plain(value: unknown): string {
  if (Array.isArray(value)) return value.map((entry) => plain(entry)).join('\n')
  return lines(value, '').join('\n')
}

/** One answer on stdout: the JSON in one line, or the plain text. */
export const render = (format: Format, json: unknown, plainText: string): string =>
  `${format === 'json' ? JSON.stringify(json) : plainText}\n`
