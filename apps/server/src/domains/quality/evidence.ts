import { conclusionVerdict } from '../../kernel/checks.ts'

/** `base..head`, as agw's review commands take a range. */
export interface ReviewRange {
  base: string
  head: string
}

/** What the commits a ship names are: where they landed, what they touched. Read from git, never from the lead. */
export interface CommitRead {
  /**
   * `origin/<default>` as it stood when the commits were proven landed: one sha that holds every commit named. What a
   * deployed version must hold, whatever a squash or a rebase did to the branch's own commits. Null when nothing was
   * proven landed.
   */
  landedAt: string | null
  /** the commits named, full, then what else the lead's branch holds */
  commits: string[]
  /** every path they touched */
  paths: string[]
  /** the newest committer time of the commits named */
  mergedAt: Date | null
  /** the Issue's own commits as ranges of the default branch, oldest first: what a review judges */
  reviewRanges: ReviewRange[]
}

/** One commit a review does not cover, with the review level agw says it needs. */
export interface UncoveredCommit {
  sha: string
  subject: string
  required: string
  reason?: string
}

/** What agw says of a range: the review it asks for and whether the ledger covers every commit in it. */
export interface ReviewRead {
  tier: string
  covered: boolean
  uncovered: UncoveredCommit[]
}

/** The merged commits a ship named, as evidence. */
export interface CommitsEvidence {
  commits: string[]
  landedAt: string | null
  mergedAt: string | null
  /** whether any path is one a deploy carries: docs, text and tests are not */
  deploys: boolean
  /** a sample, as `commits` is; `deploys` was worked out from all of them */
  paths: string[]
}

/**
 * The review of a ship, or the record that there was none. A review is evidence when it exists (`covered`); the others
 * are recorded with their reason, and never refuse a ship (NL23), so the friction loop can count them.
 */
export type ReviewStatus = 'covered' | 'not_required' | 'uncovered' | 'unknown'

export interface ReviewEvidence {
  status: ReviewStatus
  /** the level agw asked for; null when it was not asked */
  tier: string | null
  ranges: ReviewRange[]
  uncovered: UncoveredCommit[]
  /** why there is no review: what agw said, or why it could not be asked */
  reason: string | null
}

/** One line of the acceptance the lead states: met, or not met and why. */
export interface AcceptanceStatement {
  status: 'met' | 'not_met'
  text: string
}

/**
 * What a ship states of the Issue's acceptance, one line per criterion. Empty is the recorded absence (the ship stated
 * nothing), which the friction loop counts like an unreviewed ship. A record and a count, never a gate: `not_met` is honest.
 */
export interface AcceptanceEvidence {
  statements: AcceptanceStatement[]
}

const STATEMENT = /^\s*(not[ _]met|met)\s*:\s*(\S[\s\S]*)$/i

/** The lead's lines as statements, or the first line that is neither `met: <text>` nor `not met: <why>`. */
export function parseAcceptance(
  lines: readonly string[],
): { ok: true; evidence: AcceptanceEvidence } | { ok: false; error: string } {
  const statements: AcceptanceStatement[] = []
  for (const line of lines) {
    const found = STATEMENT.exec(line)
    if (!found?.[1] || !found[2]) {
      return {
        ok: false,
        error: `acceptance line "${line.slice(0, 80)}" must read "met: <what shows it>" or "not met: <why>"`,
      }
    }
    statements.push({ status: found[1].toLowerCase() === 'met' ? 'met' : 'not_met', text: found[2].trim() })
  }
  return { ok: true, evidence: { statements } }
}

/** One check of a run of verify, as data, whatever it printed. */
export interface CheckRecord {
  name: string
  ok: boolean
  detail: string
}

export const MAX_RECORDED = 100

const TEXT_FILE = /\.(md|mdx|txt)$/
const TEST_DIR = /(^|\/)(test|tests|__tests__)\//
const TEST_FILE = /\.(test|spec)\./

/**
 * A path no deploy carries: documents (`docs/plan.yaml` is one), text, licences, tests and the root `project.yaml`, which
 * the server reads from the default branch when it syncs projects. Mirrors `scripts/verify.sh`'s `inert_path`.
 */
export function isInert(path: string): boolean {
  return (
    path.startsWith('docs/') ||
    path === 'project.yaml' ||
    TEXT_FILE.test(path) ||
    /(^|\/)LICENSE/.test(path) ||
    /(^|\/)\.gitignore$/.test(path) ||
    TEST_DIR.test(path) ||
    TEST_FILE.test(path)
  )
}

export const deploys = (paths: readonly string[]): boolean => paths.some((path) => !isInert(path))

/** The review as evidence, from what agw answered for the ship's ranges (null: it could not be asked). */
export function reviewOf(input: {
  ranges: readonly ReviewRange[]
  read: ReviewRead | null
  /** why `read` is null */
  problem: string | null
}): ReviewEvidence {
  const ranges = [...input.ranges]
  const { read } = input
  if (!read) {
    return {
      status: 'unknown',
      tier: null,
      ranges,
      uncovered: [],
      reason: input.problem ?? 'no review was asked: none of the commits is on the default branch to review',
    }
  }
  if (read.covered) {
    return {
      status: read.tier === 'none' ? 'not_required' : 'covered',
      tier: read.tier,
      ranges,
      uncovered: [],
      reason: null,
    }
  }
  const named = read.uncovered.map((c) => `${c.sha.slice(0, 12)} ${c.subject} (needs ${c.required})`).join('; ')
  return {
    status: 'uncovered',
    tier: read.tier,
    ranges,
    uncovered: read.uncovered,
    reason: `agw does not cover the range${named ? `: ${named}` : ''}`,
  }
}

/** What CI says of one commit: never `unknown`, which is only the record of a read that failed. */
export type CiState = {
  status: 'green' | 'red' | 'running' | 'missing'
  /** the failing (or running) check's page, else the pull request's; null when there is none */
  url: string | null
  /** the failing check by name, or why there is nothing to read */
  reason: string | null
}

/** CI of the pull request a ship landed through: its number and head, and what CI said of that head. */
export type CiRead = CiState & { pr: number | null; headSha: string | null }

/**
 * The CI conclusion of the pull request a ship landed through. Recorded with its reason and never a refusal (NL23);
 * `red` and `missing` are what the friction loop counts.
 */
export interface CiEvidence {
  status: CiState['status'] | 'unknown'
  pr: number | null
  headSha: string | null
  url: string | null
  reason: string | null
}

/** One check run or commit status of a commit, as GitHub gave it. */
export interface CiLine {
  name: string
  /** `completed`, or anything else for one that has not finished */
  status: string
  conclusion: string | null
  url: string | null
}

/** Any red is red (the first failing check named), then any unfinished is running, then at least one success is green. */
export function ciStateOf(lines: readonly CiLine[]): CiState {
  const red = lines.find((line) => line.status === 'completed' && conclusionVerdict(line.conclusion) === 'red')
  if (red) return { status: 'red', url: red.url, reason: `${red.name} ${red.conclusion}` }
  const running = lines.find((line) => line.status !== 'completed')
  if (running) return { status: 'running', url: running.url, reason: `${running.name} is still running` }
  if (lines.some((line) => conclusionVerdict(line.conclusion) === 'green'))
    return { status: 'green', url: null, reason: null }
  return {
    status: 'missing',
    url: null,
    reason: lines.length === 0 ? 'no check ran' : 'no check concluded in success or failure',
  }
}

/** The ship's CI as evidence, from what the port answered (null: it could not be asked). */
export function ciOf(input: { read: CiRead | null; problem: string | null }): CiEvidence {
  const { read } = input
  if (!read)
    return {
      status: 'unknown',
      pr: null,
      headSha: null,
      url: null,
      reason: input.problem ?? 'no CI was asked: none of the commits is on the default branch',
    }
  return { status: read.status, pr: read.pr, headSha: read.headSha, url: read.url, reason: read.reason }
}
