/**
 * An Errand the MacBook's gate ran by itself: `ask-human.sh push` sends the command to the gate's `auto-run` verb first (dotfiles
 * Issue 2393), and a granted catalogue class runs with no dialog. The close comes back through the orchestrator's done with this
 * evidence, which is the whole contract between the two repos: `ask-human: auto-run class <class>, ...`.
 */
export const AUTO_RUN_EVIDENCE = 'ask-human: auto-run class '

/** The stored note of an Errand closed with that evidence (`finishErrand` prefixes the delegate's evidence). */
export const AUTO_RUN_NOTE = `confirmed by ${AUTO_RUN_EVIDENCE}`

/** A class name: lowercase words joined by hyphens, ended by any character that cannot belong to one, or the end. */
const CLASS = '[a-z0-9][a-z0-9-]*'

/**
 * The stored note of an auto-run close as a Postgres regex: the one predicate the KPI and the since band read with, so they agree
 * with `autoRunClassOf` (the lead's note) on what an auto-run is.
 */
export const AUTO_RUN_NOTE_PATTERN = `^${AUTO_RUN_NOTE}${CLASS}([^a-z0-9-]|$)`

const CLASS_NAME = new RegExp(`^(${CLASS})(?![a-z0-9-])`)

/** The class an auto-run close names, or null when the evidence is something else. */
export function autoRunClassOf(evidence: string | null | undefined): string | null {
  const text = evidence?.trim() ?? ''
  if (!text.startsWith(AUTO_RUN_EVIDENCE)) return null
  return CLASS_NAME.exec(text.slice(AUTO_RUN_EVIDENCE.length))?.[1] ?? null
}
