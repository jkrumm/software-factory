import type { Host } from '../../kernel/hands.ts'
import { normalizeCommand } from './match.ts'
import { isSyncCommand, namesPhysical, namesSecret, needByRule } from './need.ts'

/**
 * The first decision about an Errand, taken by its shape when it is raised or requested and before it can page the owner:
 * refuse it with the words to do it yourself, run it through a fixed MacBook verb, or let it reach him. Only an Errand that
 * names no secret and no physical step can be refused for being the host's work or run by a verb; a secret, sudo, a
 * passphrase or a person's hands can only reach him (or be refused for a repeat he already declined).
 */

/** What an Errand states it needs (`--need`); `approval` is only ever the rules' word, never a lead's. */
export const STATED_NEEDS = ['secret', 'hands', 'place'] as const
export type StatedNeed = (typeof STATED_NEEDS)[number]

export interface TriageInput {
  summary: string
  detail: string | null
  command: string | null
  host: Host | null
}

/** The words an Errand's shape is read from: what it says and what it runs. */
const textOf = (input: TriageInput): string => `${input.summary}\n${input.detail ?? ''}\n${input.command ?? ''}`

/** An Errand the rules of its shape say needs a secret or a person's hands: nothing here may run it or call it the host's work. */
const needsHim = (input: TriageInput): boolean => {
  const need = needByRule(input)
  return need === 'secret' || need === 'hands' || namesPhysical(`${input.summary}\n${input.detail ?? ''}`)
}

// ---------------------------------------------------------------------------------------------------------------------
// (a) a command that runs wholly on the mini, or over a keyless ssh

/** `ssh [flags] <mini|homelab|vps> <command>`: the part after the host is what runs there. */
const KEYLESS_SSH = /^\s*ssh\s+(?:-\S+\s+(?:\S+\s+)?)*(mini|homelab|vps)\s+([\s\S]+)$/
/** `hc run --on mini ...`: herdr-core's own machine link to the mini. */
const HC_ON_MINI = /^\s*hc\s+(?:\S+\s+)*--on[ =]mini\b/

/**
 * What stays his even though it runs on the mini: a restart or power-off of the host or its core, the core's update, the
 * deploy gate's release, a recursive delete, a service boot-out. His yes is the point of these, not the keys.
 */
const HIS_YES =
  /\b(?:reboot|shut ?down|power ?off|halt|planned restart|restart (?:of )?(?:the )?(?:mini|host|machine|core|herdr-core)|hc server|hc update|herdr-core-update|deploy-release|gate(?:\.py)? release|rm -rf|launchctl (?:bootout|unload|remove))\b/i

/** The command the keyless route runs, and where: the mini (`mini`, `hc ... --on mini`) or a server (`homelab`, `vps`). */
function keylessRoute(command: string): { where: string; line: string } | null {
  const ssh = KEYLESS_SSH.exec(command)
  if (ssh) return { where: ssh[1] ?? 'mini', line: (ssh[2] ?? '').trim() }
  return HC_ON_MINI.test(command) ? { where: 'mini', line: command.trim() } : null
}

/**
 * A command that runs on the mini or a server the lead reaches without a key, with no secret and no yes of his in it. The lead
 * is on the mini: it runs the part after the host itself (an ssh to the homelab or the vps is Tailscale SSH, keyless).
 */
export function refuseKeyless(input: TriageInput): string | null {
  if (input.command === null || needsHim(input) || namesSecret(textOf(input)) || HIS_YES.test(textOf(input)))
    return null
  const route = keylessRoute(input.command)
  if (route === null) return null
  const how =
    route.where === 'mini'
      ? 'you run on the mini: run it yourself, without ssh'
      : `\`ssh ${route.where}\` is Tailscale SSH and keyless from the mini: run it yourself`
  return `that command runs wholly on ${route.where === 'mini' ? 'the mini' : route.where} and asks for no secret and no yes of the owner's: ${how} (\`${route.line.slice(0, 200)}\`). An Errand is for a secret only he has, or a person's hands. Nothing was raised.`
}

// ---------------------------------------------------------------------------------------------------------------------
// (f) a command for the MacBook that only the mini has

/**
 * Commands installed on the mini only (`factory`: the dialog's command exited 127 on the MacBook, Issue 2302; `secrets-run`:
 * the headless secrets shim). A word joins this list on evidence, never on a guess: a false refusal blocks a real Errand.
 */
export const MINI_ONLY_COMMANDS: readonly string[] = ['factory', 'secrets-run']

/** The first word of every segment of a shell line (after `&&`, `||`, `;`, `|`), `VAR=value` assignments skipped. */
function commandWords(line: string): string[] {
  const words: string[] = []
  // a separator inside a quoted string (an ssh's remote command, an argument) does not start a segment; the quoted text stays,
  // so a quoted command name is still read. Best effort: an escaped quote is not told from a quote, and a miss only
  // leaves the dialog that fails with exit 127, while a false refusal would block a real Errand.
  const bare = line.replace(/'[^']*'|"[^"]*"/g, (span) => span.replace(/[&|;]/g, ' '))
  for (const segment of bare.split(/&&|\|\||;|\|/)) {
    const first = segment
      .trim()
      .split(/\s+/)
      .find((word) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(word))
    if (first) words.push(first.replace(/^["']|["']$/g, ''))
  }
  return words
}

/**
 * A command for the MacBook (or one with no host named) that runs a mini-only command: the dialog would fail with exit 127
 * and leave a second Errand behind. Refused at the raise, before any page or dialog; the lead or asker runs it on the mini.
 */
export function refuseOffMacbook(input: TriageInput): string | null {
  if (input.command === null || (input.host !== null && input.host !== 'macbook' && input.host !== 'any')) return null
  const word = commandWords(input.command).find((w) => MINI_ONLY_COMMANDS.includes(w.replace(/^.*\//, '')))
  if (word === undefined) return null
  return `\`${word}\` is installed on the mini only, so this command would fail on his MacBook (exit 127) and leave a second Errand behind. Run it on the mini yourself, or give the MacBook a command that exists there. Nothing was raised.`
}

// ---------------------------------------------------------------------------------------------------------------------
// (c) a bot check is not an Errand

const BOT_CHECK =
  /\bbot[- ]check\b|\bbot (?:wall|block|challenge)\b|\bcaptcha\b|\banti-bot\b|\b(?:cloudflare|turnstile) challenge\b|\bresearch chrome\b/i

/**
 * A request (no Issue waits on it) asking him to pass a bot check for a page: the run that met the wall reports the page as
 * blocked and goes on with other sources. An Issue that cannot be answered without the page raises an Errand of its own, which
 * this never reads.
 */
export function refuseBotCheck(input: TriageInput): string | null {
  if (!BOT_CHECK.test(textOf(input))) return null
  return 'a bot check on a page is not an Errand: report the page as blocked and go on with other sources (the Issue that cannot be answered without that page raises an Errand of its own, with --need hands). Nothing was raised.'
}

// ---------------------------------------------------------------------------------------------------------------------
// (d) an ask he declined

/** How long the same need is not asked again after the owner (or the orchestrator for him) turned it back. */
export const DECLINE_HOLD_MS = 3 * 24 * 3_600_000

/** A turn-back of the same need: when, and the note he wrote. */
export interface Declined {
  at: Date
  note: string
}

/** The refusal of a need that was turned back within the hold: his words are the lead's next instruction. */
export function refuseDeclined(declined: Declined | null, now: Date): string | null {
  if (declined === null || now.getTime() - declined.at.getTime() >= DECLINE_HOLD_MS) return null
  const days = Math.max(1, Math.round(DECLINE_HOLD_MS / 86_400_000))
  return `the owner turned this same need back ${declined.at.toISOString().slice(0, 10)}: ${JSON.stringify(declined.note.slice(0, 600))}. It is not raised again for ${days} days from then; do what the note says, or raise it with a different need if it truly changed. Nothing was raised.`
}

// ---------------------------------------------------------------------------------------------------------------------
// (e) the need is stated

/** A request with no command whose words name no secret and no physical step cannot be routed by rule: it must say what it needs. */
export function refuseUnroutable(input: TriageInput, stated: StatedNeed | null): string | null {
  if (stated !== null || input.command !== null || needByRule(input) !== null) return null
  return 'a request needs a need: pass `--need secret|hands|place` (secret: 1Password, a biometric, a password; hands: a device, a portal, a physical step or a look; place: a command that must run on his MacBook, which then also needs --command). Nothing was raised.'
}

/** `place` is a command for his MacBook: with none there is nothing to place. */
export function refuseEmptyPlace(input: TriageInput, stated: StatedNeed | null): string | null {
  if (stated !== 'place' || input.command !== null) return null
  return '`--need place` is a command that must run on his MacBook: give it with `--cmd`, or state the need as `hands` or `secret`. Nothing was raised.'
}

// ---------------------------------------------------------------------------------------------------------------------
// (b) a MacBook command a fixed verb runs for him

/**
 * The reports the gate's `report <name>` verb runs: one fixed read-only command each, mirrored by the MacBook's
 * `dotfiles/config/macbook-reports.tsv`. A command that is not exactly one of these is not a report.
 */
export const MACBOOK_REPORTS: Readonly<Record<string, string>> = {
  'smb-mounts': 'mount | grep smbfs',
  'ntfy-mac-update-check': 'ntfy-mac update --check',
}

/** `git -C ~/SourceRoot/<name> pull --ff-only` for one checkout under the owner's `~/SourceRoot`. */
const REPO_PULL = /^git -C (?:~|\$HOME)\/SourceRoot\/([a-z0-9][a-z0-9._-]*) pull --ff-only$/

/** A fixed verb of the MacBook's gate (`<verb> [<name>]` over the dedicated key): never anything but these three. */
export type MacbookVerb =
  | { verb: 'dotfiles-sync' }
  | { verb: 'report'; name: string }
  | { verb: 'repo-pull'; name: string }

/** The words that go over ssh: the verb and its one validated name. */
export const verbWords = (verb: MacbookVerb): string[] =>
  verb.verb === 'dotfiles-sync' ? [verb.verb] : [verb.verb, verb.name]

/** The MacBook verb that is exactly this command, or null. Hosts other than the MacBook (or none named) never match. */
export function macbookVerbOf(command: string | null, host: Host | null): MacbookVerb | null {
  if (command === null || (host !== null && host !== 'macbook' && host !== 'any')) return null
  const line = normalizeCommand(command)
  if (isSyncCommand(line)) return { verb: 'dotfiles-sync' }
  for (const [name, text] of Object.entries(MACBOOK_REPORTS)) if (line === text) return { verb: 'report', name }
  const pull = REPO_PULL.exec(line)
  const repo = pull?.[1]
  return repo === undefined || repo === 'dotfiles' ? null : { verb: 'repo-pull', name: repo }
}

/** The verb to run for an Errand: its command is exactly a class, and nothing in it names a secret or a person's hands. */
export function verbFor(input: TriageInput): MacbookVerb | null {
  if (namesSecret(textOf(input)) || needsHim(input)) return null
  return macbookVerbOf(input.command, input.host)
}

// ---------------------------------------------------------------------------------------------------------------------
// the whole decision, as the replay reads it

export type Triage =
  | {
      action: 'refuse'
      rule: 'declined' | 'bot_check' | 'keyless' | 'off_macbook' | 'unroutable' | 'empty_place'
      reason: string
    }
  | { action: 'run'; verb: MacbookVerb }
  | { action: 'reach' }

/**
 * What the rules say about an Errand, in the order the server applies them: the repeat he declined, a bot check (a request
 * no Issue raised), the host's own work, a verb of the MacBook, and the need that was not stated. `standalone`: a request, not
 * an Issue's Errand. Never reads a model.
 */
export function triage(
  input: TriageInput,
  context: { standalone: boolean; stated: StatedNeed | null; declined: Declined | null; now: Date },
): Triage {
  const declined = refuseDeclined(context.declined, context.now)
  if (declined) return { action: 'refuse', rule: 'declined', reason: declined }
  const bot = context.standalone ? refuseBotCheck(input) : null
  if (bot) return { action: 'refuse', rule: 'bot_check', reason: bot }
  const keyless = refuseKeyless(input)
  if (keyless) return { action: 'refuse', rule: 'keyless', reason: keyless }
  const offMacbook = refuseOffMacbook(input)
  if (offMacbook) return { action: 'refuse', rule: 'off_macbook', reason: offMacbook }
  const empty = refuseEmptyPlace(input, context.stated)
  if (empty) return { action: 'refuse', rule: 'empty_place', reason: empty }
  const unroutable = refuseUnroutable(input, context.stated)
  if (unroutable) return { action: 'refuse', rule: 'unroutable', reason: unroutable }
  const verb = verbFor(input)
  return verb ? { action: 'run', verb } : { action: 'reach' }
}
