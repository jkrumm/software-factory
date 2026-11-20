/**
 * What a refusal was, in a class that does not change with the commit, the branch or the Issue it named. Friction counts
 * a refusal by this class: the stored text is full of shas and paths, so the text itself is a new key on nearly every
 * row (72 of 90 ship-refusal keys of the week to 2026-11-20 held a sha) and never adds up to a count the loop can judge.
 *
 * The class is read from the stored text, which is the only record there is (`issue_events.detail`,
 * `quality_ships.detail`): a rule here is the one place that ties a producer's wording to its class, and
 * `refusal-class.test.ts` builds the texts from the producers that export them, so a reworded refusal fails there.
 * Pure.
 */

interface Rule {
  id: string
  /** the class in words, after "was refused:" */
  words: string
  /** what the stored text looks like */
  match: RegExp
}

const RULES: readonly Rule[] = [
  // the ship gate and the ship verb (domains/quality/gate.ts, domains/quality/watch.ts, app/quality-ship.ts, adapters/quality/git.ts)
  { id: 'review_gate_retired', words: 'the review gate that is gone', match: /^ship refused, review / },
  { id: 'no_commit_named', words: 'it named no merged commit', match: /^ship refused: ship names no merged commit/ },
  {
    id: 'commits_unreadable',
    words: 'the commits could not be read',
    match: /^ship refused: the commits could not be read/,
  },
  {
    id: 'checkout_unreadable',
    words: "the lead's checkout could not be read",
    match: /^ship refused: the lead's checkout could not be read/,
  },
  {
    id: 'commit_not_pushed',
    words: 'a commit is not in the repo: push it first',
    match: /^ship refused: commit \S+ is not in .*: push it first/,
  },
  {
    id: 'no_default_branch',
    words: 'the repo has no origin default branch',
    match: /^ship refused: .* has no origin default branch/,
  },
  {
    id: 'commit_not_on_base',
    words: 'a commit is not on the default branch: merge it first',
    match: /^ship refused: commit \S+ is not on \S+: merge it first/,
  },
  {
    id: 'branch_not_on_base',
    words: "the lead's branch holds work that is not on the default branch",
    match: /^ship refused: \S+ holds work that is not on \S+: merge it/,
  },
  {
    id: 'commit_older_than_cut',
    words: 'a commit is older than the attempt',
    match: /^ship refused: commit \S+ is older than this attempt/,
  },
  {
    id: 'deployed_lacks_commit',
    words: 'the deployed version does not hold the commit: deploy first',
    match: /^ship refused: deployed \S+ does not hold|Deploy first \(`make deploy`/,
  },
  {
    id: 'ci_still_red',
    words: "the default branch's CI is still red",
    match: /^ship refused: the default branch's CI is still red/,
  },
  {
    id: 'alert_still_down',
    words: 'an alert that regressed the last ship is still down',
    match: /^ship refused: an alert regressed your last ship and is still down/,
  },
  {
    id: 'spec_owed',
    words: 'the Issue carries a checkpoint and no Spec was submitted',
    match: /^ship refused: this Issue carries the checkpoint/,
  },
  {
    id: 'annotations_undisposed',
    words: "the owner's annotations have no disposition",
    match: /^(ship|close) refused: \d+ annotation\(s\) of the owner/,
  },

  // the work table (domains/work/table.ts): a lead verb refused while the Issue waits, or in a state that does not take it
  { id: 'waits_for_errand', words: 'the Issue waits for an Errand', match: /^it waits for an Errand/ },
  {
    id: 'waits_for_decision',
    words: 'the Issue waits for the answer to a Decision',
    match: /^it waits for the answer to a Decision/,
  },
  {
    id: 'waits_for_verdict',
    words: 'the Issue waits for the verdict on an artifact',
    match: /^it waits for the verdict on an artifact/,
  },
  {
    id: 'waits_for_external_review',
    words: "the Issue waits on someone else's review",
    match: /^it waits on the review of/,
  },
  {
    id: 'waits_for_dependency',
    words: 'the Issue waits for other Issues to close',
    match: /^it (is already waiting for|waits for .+ to close, so)/,
  },
  { id: 'waits_stalled', words: 'the Issue is stalled: the steward ends that', match: /^it waits \(/ },
  {
    id: 'waits_for_answer',
    words: 'the Issue waits for an answer that ends before a move up',
    match: /^it waits for a \w+: that ends with its answer first/,
  },
  {
    id: 'wake_of_answer_wait',
    words: 'a wait that ends with its answer was woken',
    match: /^an? \w+ wait ends with its answer, not a wake/,
  },
  { id: 'closed', words: 'the Issue is closed', match: /^it is closed( already)?\b/ },
  { id: 'closed_long_ago', words: 'the Issue closed more than 30 days ago', match: /^closed more than 30 days ago/ },
  { id: 'watch_is_on', words: 'the Issue shipped and its watch is on', match: /^it shipped: the watch is on/ },
  { id: 'not_closed', words: 'the Issue is not closed', match: /^it is not closed/ },
  { id: 'not_queued', words: 'the Issue is not queued', match: /^triage is not done: it is not queued/ },
  { id: 'no_lead_yet', words: 'no lead works the Issue yet', match: /^no lead works it yet/ },
  {
    id: 'healed_not_for_lead',
    words: 'a lead reported healed, or the factory closed a worked Issue',
    match: /^(a lead works it: healed is for|healed is the factory)/,
  },
  {
    id: 'wrong_reporter',
    words: "the verb is not the sender's to report",
    match: /is the (lead|steward|factory)'s to report/,
  },
  {
    id: 'closed_for_old_attempt',
    words: 'a close was filed for an attempt that is over',
    match: /^closed was filed for attempt \d+/,
  },
]

export interface RefusalClass {
  id: string
  words: string
}

/** A hex run of 7 or more characters: a sha. */
const SHA = /\b[0-9a-f]{7,40}\b/gi

/** The text of a refusal no rule knows, without what varies from one to the next (shas, paths, branches, ids, numbers). */
function generic(text: string): string {
  return text
    .replace(SHA, '<sha>')
    .replace(/\b(issue|decision|errand|artifact|signal)_[0-9A-Za-z][0-9A-Za-z_-]*/gi, '<id>')
    .replace(/\bfactory\/\d+-\d+/g, '<branch>')
    .replace(/(^|\s)\/[^\s:]+/g, '$1<path>')
    .replace(/\d+/g, 'N')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60)
}

/** The class of a stored refusal text; a text no rule knows is its own class by its wording alone, never by what it names. */
export function refusalClass(detail: string | null): RefusalClass {
  if (detail === null || detail.trim() === '') return { id: 'no_reason_given', words: 'no reason was given' }
  const text = detail.trim()
  const rule = RULES.find((candidate) => candidate.match.test(text))
  if (rule) return { id: rule.id, words: rule.words }
  const words = generic(text)
  return { id: `other:${words}`, words }
}
