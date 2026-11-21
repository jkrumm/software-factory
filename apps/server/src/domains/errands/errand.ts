import type { Id } from '../../kernel/ids.ts'
import { type Host, HOSTS, hostOf } from '../../kernel/hands.ts'
import { err, ok, type Result } from '../../kernel/result.ts'
import { WORKFLOWS } from '../../kernel/workflows.ts'
import type { ErrandScreenAnswer, ErrandScreenRequest } from '@software-factory/contract'
import type { MissingFields } from '../../kernel/missing-fields.ts'
import { NEED_KEY_RE } from './match.ts'
import { isApprovalCommand, namesPhysical, namesSecret, type Need, needByRule } from './need.ts'
import { STATED_NEEDS, type StatedNeed } from './triage.ts'

export type ErrandId = Id<'errand'>

export interface ErrandInput {
  summary: string
  detail: string | null
}

/** An Errand as a lead raises it: also what it tried before it asked for a person's hands. */
export interface ErrandRaised extends ErrandInput {
  tried: string
  /** a shell command that exits 0 while the Errand is still needed, for what a machine can observe; null when there is none */
  check: string | null
  /** the command the owner runs on his MacBook, pushed to it as a dialog as soon as it reaches him; null when there is none */
  command: string | null
  /** where the hands must be; the MacBook when there is a command and none is named, null otherwise (read from the words) */
  host: Host | null
  /** the lead's own name for the need (`--need-key`): another open Errand of the repo under the same name is the same Errand; null when it gave none */
  needKey: string | null
  /** what the lead says it needs from the owner (`--need`); required */
  need: StatedNeed
}

const MAX_SUMMARY = 200
const MAX_DETAIL = 4000
const MAX_TRIED = 2000
const MAX_CHECK = 2000

/** Reads an Errand: one line for the owner, and the steps his hands must take. */
export function readErrand(raw: unknown): Result<ErrandRaised, MissingFields> {
  const body = typeof raw === 'object' && raw !== null && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {}
  const problems: string[] = []
  const summary = typeof body.summary === 'string' ? body.summary.trim() : ''
  if (summary === '') problems.push('summary')
  if (summary.length > MAX_SUMMARY) problems.push(`summary (longer than ${MAX_SUMMARY} characters)`)
  const detail = typeof body.detail === 'string' && body.detail.trim() !== '' ? body.detail.trim() : null
  if (detail !== null && detail.length > MAX_DETAIL) problems.push(`detail (longer than ${MAX_DETAIL} characters)`)
  const tried = typeof body.tried === 'string' ? body.tried.trim() : ''
  if (tried === '') problems.push('tried (what you ran or checked before asking for a person\'s hands: --tried "...")')
  if (tried.length > MAX_TRIED) problems.push(`tried (longer than ${MAX_TRIED} characters)`)
  const check = typeof body.check === 'string' && body.check.trim() !== '' ? body.check.trim() : null
  if (check !== null && check.length > MAX_CHECK) problems.push(`check (longer than ${MAX_CHECK} characters)`)
  const command = typeof body.cmd === 'string' && body.cmd.trim() !== '' ? body.cmd.trim() : null
  if (command !== null && command.length > MAX_CHECK) problems.push(`cmd (longer than ${MAX_CHECK} characters)`)
  const named = typeof body.host === 'string' && body.host.trim() !== '' ? body.host.trim() : null
  if (named !== null && !(HOSTS as readonly string[]).includes(named))
    problems.push(`host (one of ${HOSTS.join(', ')})`)
  const needKey = typeof body.needKey === 'string' && body.needKey.trim() !== '' ? body.needKey.trim() : null
  if (needKey !== null && !NEED_KEY_RE.test(needKey))
    problems.push('needKey (a short lowercase name: a-z, 0-9, . _ : / -, at most 80 characters)')
  const stated = typeof body.need === 'string' ? body.need.trim() : ''
  const need = (STATED_NEEDS as readonly string[]).includes(stated) ? (stated as StatedNeed) : null
  if (need === null)
    problems.push(
      'need (what it needs from the owner, one of secret, hands or place: --need secret|hands|place; secret is 1Password, a biometric or a password, hands a device, a portal or a physical step, place a command that must run on his MacBook)',
    )
  if (problems.length > 0 || need === null) {
    return err({ kind: 'missing_field', fields: problems, detail: `an Errand needs: ${problems.join(', ')}` })
  }
  return ok({
    summary,
    detail,
    tried,
    check,
    command,
    host: (named as Host | null) ?? (command === null ? null : 'macbook'),
    needKey,
    need,
  })
}

interface HostClass {
  name: string
  /** the summary and detail, lowercased, name this class */
  names: RegExp
  /** the lead's `tried` shows the class was already worked through; absent, nothing does */
  settledBy?: RegExp
  /** the Errand's own shape settles the class, whatever its words say; absent, nothing does */
  settled?: (input: ErrandRaised) => boolean
  /** the route to take instead */
  route: string
}

/**
 * What the host does for a lead, found by what an Errand names (the burn-in of 2026-11-07..10: five of nine Errands
 * were not hands). A turn-away at raise costs a refused call; one at the screen costs the Issue its wait.
 */
const HOST_CLASSES: readonly HostClass[] = [
  {
    name: 'a door token or a door route',
    names: /\bdoor (?:token|route)|\broute-set\b|\bmonitor routes?\b|\bhyperdx\b.*\broutes?\b/,
    route:
      'mint a token with `factory door token new <source>` (offline, on the host) and set a route into your own repo with `factory door route-set --source <s> --monitor <m> --repo <your repo> --issue <id>`; a route into another repo is that repo\'s lead\'s: `factory signal file --from agent:<your repo> --repo <that repo> --title "..." --text "..."`',
  },
  {
    name: 'an install',
    names:
      /\b(?:brew|apt(?:-get)?)\s+install\b|\binstall(?:ing|s)?\b.*\b(?:exiftool|magick|imagemagick|ffmpeg|poppler|tesseract)\b|\b(?:exiftool|magick|imagemagick|ffmpeg|poppler|tesseract)\b.*\binstall/,
    route:
      'an install is a Makefile target of the repo that needs it (`brew install` through it, run with `make -C <worktree> <target>`); add the target, run it, and ship',
  },
  {
    name: 'a sudo step',
    names: /\bsudo\b/,
    settledBy: /without sudo|no sudo|non-sudo|user-level/,
    // the mini's sudo password is the owner's and MacBook-only: a root step the lead cannot avoid is his command on his MacBook
    settled: (input) => input.command !== null && input.host === 'macbook',
    route:
      "first look for a way without root (brew, a user-level launchd agent, a path under the home directory, a Makefile target) and run it; if none exists, raise the Errand with the command the owner runs on his MacBook (`--cmd '<the sudo command>' --host macbook`, as `sudo -S` with the password piped in on stdin: the dialog has no terminal, so a bare `sudo` or `ssh -t` is refused). The mini's sudo password is deliberately MacBook-only: never read it with `op` or `secrets-run`",
  },
  {
    name: 'a verdict pointer for a Report',
    names:
      /\bverdict\b.*\bpointer\b|\bpointer\b.*\bverdict\b|\bneeds you\b.*\b(?:not|n't|never)\b.*\b(?:show|appear|list)|\b(?:does not|doesn't|did not|didn't)\s+(?:show|appear)\b.*\bneeds you\b/,
    route:
      'a Report that does not show in Needs you is a defect of the factory, not a person\'s hands: `factory signal file --from agent:<your repo> --repo software-factory --title "..." --text "the Report id, what Needs you shows"`, and ship',
  },
]

/** An Errand that asks a person for what the host does for the lead: the refusal says which class and the route to take. */
export function refuseHostClass(input: ErrandRaised): string | null {
  const text = `${input.summary}\n${input.detail ?? ''}`.toLowerCase()
  const tried = input.tried.toLowerCase()
  for (const host of HOST_CLASSES) {
    if (!host.names.test(text) || host.settledBy?.test(tried) || host.settled?.(input)) continue
    return `an Errand is for a person's hands, and ${host.name} is not: ${host.route}. Nothing was raised.`
  }
  return null
}

/** `ssh` options that take their value as the next word. */
const SSH_VALUE_FLAGS = new Set('bcDEeFIiJLlmOopQRSWw'.split('').map((flag) => `-${flag}`))

/** Whether a command allocates a TTY over ssh (`-t`, `-tt`, `-nt`, `-o RequestTTY=yes|force`): the dialog has none to give. */
function sshAllocatesTty(command: string): boolean {
  for (const call of command.matchAll(/(?:^|[\s;&|(`'"])ssh(?=\s)([^;&|\n`'")]*)/g)) {
    const words = (call[1] ?? '').trim().split(/\s+/).filter(Boolean)
    for (let at = 0; at < words.length; at++) {
      const word = words[at] ?? ''
      if (!word.startsWith('-')) break
      if (/^-[A-Za-z]*t[A-Za-z]*$/.test(word)) return true
      if (word === '-o' && /^RequestTTY=(?:yes|force)$/i.test(words[at + 1] ?? '')) return true
      if (SSH_VALUE_FLAGS.has(word)) at++
    }
  }
  return false
}

/** `sudo` options that take their value as the next word. */
const SUDO_VALUE_FLAGS = new Set('ughpCrtTU'.split('').map((flag) => `-${flag}`))

/** Whether a command runs `sudo` that would ask for a password on a terminal: no `-S` (stdin) or `-n` (never ask). */
function interactiveSudo(command: string): boolean {
  for (const call of command.matchAll(/(?<![\w-])sudo(?![\w-])((?:\s[^;&|'"`\n]*)?)/g)) {
    const words = (call[1] ?? '').trim().split(/\s+/).filter(Boolean)
    let quiet = false
    for (let at = 0; at < words.length; at++) {
      const word = words[at] ?? ''
      if (!word.startsWith('-') || word === '--') break
      if (word === '--stdin' || word === '--non-interactive' || /^-[A-Za-z]*[Sn][A-Za-z]*$/.test(word)) quiet = true
      if (SUDO_VALUE_FLAGS.has(word)) at++
    }
    if (!quiet) return true
  }
  return false
}

const NO_TTY_ROUTE =
  'pipe the password on local stdin into `sudo -S`, which needs no terminal: `op read "op://Private/<ref>/password" --account <account> | ssh <host> \'sudo -S <cmd>\'` (docs: dotfiles `docs/global-reference.md` §Sudo on a server), and run it through `hc run` where it must outlive the dialog'

/**
 * A command the owner's dialog cannot run: it runs without a terminal, so `ssh -t` fails ("not a tty") and a `sudo` with no
 * `-S` asks for a password nobody can type (burn-in 2026-11-15: two Errands reached him with a command that could not run).
 * Null when it can; the refusal names the way that does.
 */
export function refuseUndialogable(input: ErrandRaised): string | null {
  const { command } = input
  if (command === null) return null
  if (sshAllocatesTty(command))
    return `the command allocates a terminal over ssh (\`-t\`), and the dialog runs it with none: it would fail with "not a tty". Drop \`-t\`: ${NO_TTY_ROUTE}. Nothing was raised.`
  if (interactiveSudo(command))
    return `the command runs \`sudo\` without \`-S\`, which asks for a password on a terminal the dialog does not have: ${NO_TTY_ROUTE}. Nothing was raised.`
  return null
}

/** A request a lead queued with `ask-human.sh` while it raised its Errand: the Errand is then a sentence the desk cannot push. */
export interface QueuedAsk {
  id: string
  text: string
  cmd: string | null
}

/** The refusal of an Errand with no command beside a request the same lead queued: the verb to use instead. */
export function refuseQueuedAsk(queued: readonly QueuedAsk[]): string {
  const [first] = queued
  const shown = first?.cmd ? ` (\`${first.cmd.slice(0, 160)}\`)` : ''
  return `you queued ask-human request ${first?.id ?? '?'}${shown}, and an Errand with no command beside it cannot be pushed to the MacBook when the owner is back. Raise the Errand with the command and the host: \`factory errand raise <id> --attempt <n> --summary "..." --tried "..." --cmd '<the command he runs>' --host macbook\`, retire the queued request (\`ask-human.sh resolve ${first?.id ?? '<id>'} --as superseded --note "raised as an Errand"\`) and queue no second request beside an Errand. Nothing was raised.`
}

/** Failed calls of the screen before the Errand reaches the owner unscreened; the wait between them. */
export const ERRAND_SCREEN_MAX_TRIES = WORKFLOWS.errandScreen.retry.tries
export const ERRAND_SCREEN_BACKOFF_MS = WORKFLOWS.errandScreen.retry.backoffMs

const REASON_MAX = 300

/** Commands a token can run: the first word of a code span, a fenced block line or a `$ ` line. */
const COMMAND_WORDS: readonly string[] = [
  'gh',
  'git',
  'curl',
  'wget',
  'op',
  'secrets-run',
  'factory',
  'agw',
  'rd',
  'make',
  'bun',
  'npm',
  'npx',
  'ssh',
  'scp',
  'rsync',
  'docker',
  'psql',
  'kubectl',
  'tailscale',
  'launchctl',
  'systemctl',
]

/**
 * Words that ask for his click, his answer or his eyes without naming a device or a portal. They only keep an Errand from this
 * rule: a need is never read from them (`needByRule` reads `namesPhysical`), so the need routing stays as it was.
 */
const ASKS_HIM = /\b(?:press|dialog|permission prompt|approve|watch|laptop|sim)\b/

const TURN_AWAY_BY_RULE =
  "That is a command a token can run: run it yourself (secrets-run for credentials, gh for GitHub), and raise an Errand only for a person's hands. Never the mini's sudo password: it is MacBook-only, so a root step is an Errand with --cmd and --host macbook."

/** The command lines of the text: inline-code spans, fenced-block lines and `$ ` lines, each trimmed. */
function commandLines(text: string): string[] {
  const lines: string[] = []
  for (const span of text.matchAll(/`([^`\n]+)`/g)) lines.push((span[1] ?? '').trim())
  let fenced = false
  for (const line of text.split('\n')) {
    if (line.trim().startsWith('```')) {
      fenced = !fenced
      continue
    }
    const shell = /^\s*\$ (.+)$/.exec(line)
    if (shell) lines.push((shell[1] ?? '').trim())
    else if (fenced) lines.push(line.trim())
  }
  return lines
}

/**
 * The deterministic first look: an Errand that is only a command a token can run is turned away before any model is
 * asked. Conservative on purpose: a word that names a person's hands (`namesPhysical`), a secret only he has or a place for
 * his hands (`hostOf`) keeps it, and a false positive only bounces a note to the lead.
 */
export function screenByRule(input: ErrandInput): { verdict: 'turn_away'; reason: string } | null {
  const text = `${input.summary}\n${input.detail ?? ''}`.toLowerCase()
  if (namesPhysical(text) || namesSecret(text) || hostOf(text) !== 'any' || ASKS_HIM.test(text)) return null
  const named = commandLines(text).some((line) => {
    const first = line.split(/\s+/)[0] ?? ''
    return COMMAND_WORDS.includes(first)
  })
  return named ? { verdict: 'turn_away', reason: TURN_AWAY_BY_RULE } : null
}

/**
 * An Errand whose shape settles what it needs, so no model is asked and no token is offered the work: a command for the
 * mini that asks only his yes (`approval`), or a step on his MacBook that names a secret only he has (1Password, a biometric,
 * the mini's sudo password, which is MacBook-only: `dotfiles/docs/global-reference.md` §Sudo on a server; the screen model does
 * not know that policy and would turn it away with a note that points at the password). Decided by the shape (a command, its
 * host, the words), not by the lead's wording; null leaves the rest to the screen.
 */
export function screenByNeed(input: ErrandInput & { command: string | null; host: Host | null }): {
  need: Need
  note: string
} | null {
  if (input.command === null) return null
  const need = needByRule(input)
  if (need === 'approval')
    return { need, note: "an approval: only the owner's yes is missing, and its command runs on the mini" }
  if (need === 'secret' && input.host === 'macbook')
    return {
      need,
      note: "a step only the owner can take: it names a secret (1Password, a biometric, the mini's sudo password) on his MacBook",
    }
  return null
}

/** A pull request or merge request named in the text: its URL, else `#<number>` after the words that name one. */
const PR_URL = /https?:\/\/[^\s)>\]"'`]+\/(?:pull|-\/merge_requests)\/\d+/i
const PR_NUMBER = /\b(?:pr|pull request|mr|merge request)\s*#?(\d+)\b|\bpull\/(\d+)\b/i
/** What the Errand asks of the owner about it: approve it, merge it (an admin merge), or bypass the review rule. */
const REVIEW_ASK =
  /\bapprov(?:e|es|ed|al|ing)\b|\badmin[- ]?merge|\bbypass(?:ing)?\b|\bmerge\b|\bsquash\b|\bsign[- ]?off\b|\blgtm\b|\brequired review|\breview rule/

/**
 * A pull request's review is the reviewer's, not the owner's. An Errand that asks the owner to approve or merge a named pull
 * request, or to bypass its review rule, is turned back (the burn-in of 2026-11-13: the owner was asked to approve his own
 * work account's pull request in a work repo, which GitHub refuses, and to bypass the team's review). The Issue waits on the
 * pull request instead: the `reviews` loop wakes it when the reviewer acts. The ask is the summary: a detail that only names a
 * pull request as the step after the owner's ("only then merge PR 335") is context, so a portal setting that precedes a merge
 * still reaches him. Null when the text names no pull request or the summary asks for something else; a text with no number is left to the screen and the lead brief (`factory issue defer --review`).
 */
export function screenByReview(input: ErrandInput): { review: string; reason: string } | null {
  const text = `${input.summary}\n${input.detail ?? ''}`
  if (!REVIEW_ASK.test(input.summary.toLowerCase())) return null
  const url = PR_URL.exec(text)?.[0]
  const number = PR_NUMBER.exec(text)
  const review = url ?? (number ? `#${number[1] ?? number[2]}` : null)
  if (review === null) return null
  return {
    review,
    reason: `A pull request's review is a reviewer's, not the owner's: he cannot approve a pull request his own account opened, and a review rule is never bypassed, so this is not a person's hands. The Issue now waits on the review of ${review}: the factory polls it every 15 minutes and tells you when it is approved, gets changes requested or a new review comment, merges or closes. Next time use \`factory issue defer --review <url>\` instead of an Errand.`,
  }
}

/**
 * The Errand as the screen is shown it: its own words, and the command, the machine and the need as fields of their own
 * (`ErrandScreenRequest`). `detail` is the Errand's own unless a recheck puts its events beside it. The machine is the one
 * the command runs on: the MacBook (the mini has no way onto it, which the screen's instructions say, agw's
 * `factory-errand`), or the mini for an approval, whose command the server runs there on the owner's yes.
 */
export function errandScreenFields(
  errand: {
    id: string
    summary: string
    detail: string | null
    command: string | null
    host: Host | null
    need: Need | null
  },
  detail: string | null = errand.detail,
): ErrandScreenRequest['errand'] {
  return {
    id: errand.id,
    summary: errand.summary,
    detail,
    command: errand.command,
    host:
      errand.command !== null && isApprovalCommand(errand.command)
        ? 'mini'
        : errand.host === 'macbook'
          ? 'macbook'
          : null,
    need: errand.need,
  }
}

export type ErrandScreenChecked =
  | { action: 'pass'; note: string }
  | { action: 'turn_away'; reason: string }
  /** an answer that cannot be acted on: counted as a failed call */
  | { action: 'refused'; why: string }

/** The answer is held to its shape before anything is done: a turn-away needs a reason the lead can act on. */
export function checkErrandScreen(answer: ErrandScreenAnswer): ErrandScreenChecked {
  const reason = answer.reason.trim().slice(0, REASON_MAX)
  if (answer.verdict === 'pass') return { action: 'pass', note: reason }
  if (answer.verdict === 'turn_away' && reason !== '') return { action: 'turn_away', reason }
  return { action: 'refused', why: 'a turn-away without a reason' }
}
