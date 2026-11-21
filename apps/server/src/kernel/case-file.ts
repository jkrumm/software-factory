import type { JudgeCase } from '@software-factory/contract'
import type { PortError, Result } from './result.ts'

/**
 * The judges of the factory that take the case file (agw's `factory-case.ts`): the Judge, the steward, triage, the queue,
 * the screen of quarantined signals and the two Errand screens. The Spec screen and the hygiene judge take none.
 */
export type CaseJudge = 'judge' | 'steward' | 'triage' | 'queue' | 'screen' | 'errand' | 'errandNeeded'

/**
 * What a judgment is about, as its request names it: an Issue, a Decision or an Errand (whose Issue and repo the read
 * finds), or only a repo (a signal not yet an Issue, a repo's queue).
 */
export interface CaseSubject {
  judge: CaseJudge
  repo?: string | null
  issue?: string | null
  decision?: string | null
  errand?: string | null
  /** the steward's stall names its attempt: its lead's transcript is where the pane is read */
  attempt?: number | null
}

/** What the database holds of a case; the repo's AGENTS.md is read from its checkout afterwards, outside any transaction. */
export interface CaseRead {
  /** the repo's project name, once the subject named or led to one */
  repo: string | null
  /** the repo's main checkout, as the planning sync last read it; null when the factory has not read the project */
  checkout: string | null
  /** the transcript of the subject attempt's lead session (the steward's subject only); null when none was reported */
  transcript: string | null
  case: Omit<JudgeCase, 'repo' | 'pane'> & { project?: string }
}

/** The head of a repo's AGENTS.md on its default branch, read from the main checkout; empty when it has none. */
export type AgentsHead = (checkout: string) => Promise<Result<string, PortError>>

/** A lead session's last words, newest last, at most `max` characters; null when it said nothing readable. */
export type LastWords = (transcript: string, max: number) => Promise<Result<string | null, PortError>>
