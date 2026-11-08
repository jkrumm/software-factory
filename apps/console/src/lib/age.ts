const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

/** An age in plain words: "just now", "4 min ago", "3 h ago", "2 d ago". */
export function ageWords(ms: number): string {
  if (ms < MINUTE) return 'just now'
  if (ms < HOUR) return `${Math.floor(ms / MINUTE)} min ago`
  if (ms < DAY) return `${Math.floor(ms / HOUR)} h ago`
  return `${Math.floor(ms / DAY)} d ago`
}
