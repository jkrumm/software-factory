/** A name as words: lowercase letters and digits, everything else separates (`MacMini Drift - Push` is macmini, drift, push). */
const wordsOf = (name: string): string[] =>
  name
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)

/** A project name shorter than this is too common a word to place a monitor by. */
const MIN_NAME = 4

/** An abbreviation is at least this long: `agw` is a short name of agent-workflows, `aw` is anything. */
const MIN_SHORT = 3

/**
 * Whether `short` is the abbreviation of a project of two or more words: a prefix of each word, joined, the first word's
 * prefix at least two letters (`agw` is `ag` + `w` of `agent-workflows`). A single-word name is never abbreviated.
 */
function abbreviates(short: string, projectWords: readonly string[]): boolean {
  if (short.length < MIN_SHORT || projectWords.length < 2) return false
  const take = (at: number, rest: string): boolean => {
    const word = projectWords[at]
    if (word === undefined) return rest === ''
    for (let n = at === 0 ? 2 : 1; n <= Math.min(word.length, rest.length); n++) {
      if (rest.startsWith(word.slice(0, n)) && take(at + 1, rest.slice(n))) return true
    }
    return false
  }
  return take(0, short)
}

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
  if (best) return tied ? null : best.name
  // No project is named in full: the monitor's first word may be a short name of one (`agw cost > 30 USD` is agent-workflows).
  const first = words[0] ?? ''
  const short = projects.filter((name) => abbreviates(first, wordsOf(name)))
  return short.length === 1 ? (short[0] ?? null) : null
}
