/** A name as words: lowercase letters and digits, everything else separates (`MacMini Drift - Push` is macmini, drift, push). */
const wordsOf = (name: string): string[] =>
  name
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)

/** A project name shorter than this is too common a word to place a monitor by. */
const MIN_NAME = 4

/**
 * The project a monitor's name says it belongs to: the project whose name, with its separators gone, is a run of the
 * monitor's words joined (`weather-orb` is the words `weather` `orb` or the one word `weatherorb`). The longest such name
 * wins; two projects tied for the longest, or none, is no answer. Deterministic, so a replayed pass places a monitor
 * where the first one did.
 */
export function placeByName(monitor: string, projects: readonly string[]): string | null {
  const words = wordsOf(monitor)
  if (words.length === 0) return null
  const runs = new Set<string>()
  for (let from = 0; from < words.length; from++) {
    let run = ''
    for (let to = from; to < words.length; to++) {
      run += words[to]
      runs.add(run)
    }
  }
  let best: { name: string; length: number } | null = null
  let tied = false
  for (const name of projects) {
    const compact = wordsOf(name).join('')
    if (compact.length < MIN_NAME || !runs.has(compact)) continue
    if (!best || compact.length > best.length) {
      best = { name, length: compact.length }
      tied = false
    } else if (compact.length === best.length && name !== best.name) {
      tied = true
    }
  }
  return best && !tied ? best.name : null
}
