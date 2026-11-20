import type { Host } from '../../kernel/hands.ts'

/**
 * What an Errand needs from the owner, said once and stored (`factory.errands.need`), because the answer decides where it
 * shows and whether it may page him at all:
 *
 * - `secret`: 1Password, a biometric, the mini's sudo password. Only he has it, only on his MacBook: a MacBook dialog.
 * - `hands`: a device, hardware, a portal, a visual check. A MacBook dialog when it carries a command, else Needs you.
 * - `approval`: only his yes, and the command runs on the mini. Needs you shows the command and an Approve button; the
 *   server runs it (`runApproved`). Never a MacBook dialog.
 * - `place`: must run on the MacBook, no secret. Needs you shows the command to copy; the desk pass does not push it as a
 *   dialog (his button "Push what waits to my MacBook" still does).
 */
export const NEEDS = ['secret', 'hands', 'approval', 'place'] as const
export type Need = (typeof NEEDS)[number]

export interface NeedInput {
  summary: string
  detail: string | null
  command: string | null
  host: Host | null
}

/**
 * A call of the 1Password CLI: `op` and one of its verbs, global flags (`--account acct`) allowed in between. On the mini
 * `op` hangs on a biometric prompt and only the refs of `headless.refs` are cached for `secrets-run`, so a command that runs
 * `op` is run on his MacBook, by him (issue 1664: `op item get … | ssh box …` was turned away as agent-doable).
 */
const OP_CALL =
  '\\bop\\s+(?:--?[\\w-]+(?:=\\S+)?\\s+(?:(?!--?\\w)\\S+\\s+)?)*(?:read|signin|signout|run|item|document|inject|whoami|account|vault|user|group|connect|events-api|plugin|service-account)\\b'

/** A secret only he has: 1Password, a biometric, the sudo password, the secrets reseal. */
const SECRET = new RegExp(
  `\\bsudo(?:ers)?\\b|\\b1password\\b|\\bbiometric\\b|\\btouch id\\b|\\bface id\\b|\\bsecrets-(?:seed|reseal)\\b|\\bop:\\/\\/|${OP_CALL}|\\bkeychain password\\b|\\bpassphrase\\b|\\bpassword\\b`,
  'i',
)

/** Whether the text names a secret only he has (1Password, a biometric, sudo, a password or passphrase, the reseal). */
export const namesSecret = (text: string): boolean => SECRET.test(text)

/** A physical step or a visual look: a device, hardware, a portal, a click in a page. The one list of the words that decide a need (`needByRule`) and that keep an Errand from the rule screen (`screenByRule`). */
const PHYSICAL =
  /\b(?:device|phone|iphone|ipad|tap|click|portal|dashboard|browser|sign in|log in|login|captcha|2fa|otp|qr|plug|cable|hardware|physical|router|bulb|light|button|app store|testflight|visual)\b/i

/** Whether the words (not a command) name a physical step or a look: a device, hardware, a portal, a click. */
export const namesPhysical = (text: string): boolean => PHYSICAL.test(text)

/** A command addressed to the mini over ssh: the command is the part after the host, and it runs there. */
const SSH_MINI = /^\s*ssh\s+(?:-\S+\s+(?:\S+\s+)?)*mini\s+([\s\S]+)$/

/** The deploy gate's release of a commit: whoever types it, it is one yes of the owner's. */
const GATE_RELEASE = /\bdeploy-release\b|\bgate\.py\s+release\b|\bgate\s+release\b/i

/** The command as the mini runs it: `ssh <alias> 'x'` is `x` there. Null when the command is not addressed to the mini. */
export function miniPart(command: string): string | null {
  return SSH_MINI.exec(command)?.[1]?.trim() ?? null
}

/** A command that runs on the mini and asks of the owner only his yes. */
export function isApprovalCommand(command: string): boolean {
  if (SECRET.test(command)) return false
  return miniPart(command) !== null || GATE_RELEASE.test(command)
}

/**
 * The need an Errand's shape settles, or null when only its words can say (the need the lead stated decides then, and `hands`
 * is the default). A command decides first: a secret word anywhere keeps it his (`secret`), a command addressed to the
 * mini or the gate's release is an `approval`, any other command for the MacBook that names no physical step is `place`.
 */
export function needByRule(input: NeedInput): Need | null {
  const text = `${input.summary}\n${input.detail ?? ''}\n${input.command ?? ''}`
  if (SECRET.test(text)) return 'secret'
  if (input.command !== null) {
    if (isApprovalCommand(input.command)) return 'approval'
    if (input.host === 'iphone' || input.host === 'portal' || PHYSICAL.test(`${input.summary}\n${input.detail ?? ''}`))
      return 'hands'
    if (input.host === 'macbook') return 'place'
    return null
  }
  if (input.host === 'iphone' || input.host === 'portal' || PHYSICAL.test(text)) return 'hands'
  return null
}

/**
 * The need to store: the rule's, else the one the lead stated, else `hands`. Only the rule makes an `approval` (the server
 * runs what it vouches for: a lead's word is not enough), and a stated `place` needs a command to place.
 */
export function needOf(input: NeedInput, stated?: Need | null): Need {
  const byRule = needByRule(input)
  if (byRule !== null) return byRule
  if (stated === 'secret' || stated === 'hands') return stated
  if (stated === 'place' && input.command !== null) return 'place'
  return 'hands'
}

/**
 * A command addressed to the mini as the shell on the mini runs it: ssh joins its arguments with spaces and hands the line to the login
 * shell, so the part after the host is shell text, quotes included. Run here, that is `eval` of the same text.
 */
export function miniShellLine(command: string): string {
  const inner = miniPart(command)
  return inner === null ? command : `eval "set -- ${inner.replace(/(["\\$`])/g, '\\$1')}"; sh -c "$*"`
}

/**
 * The one `place` command the factory runs itself: the MacBook's dotfiles brought level with the public repo, optionally
 * followed by `make herdr-app-setup` (the MacBook's own sync verb runs the make targets its pulled range touched, so the
 * line says the same thing). Anything else, a flag or another word included, stays on Needs you.
 */
const SYNC_COMMAND =
  /^git -C (?:~|\$HOME)\/SourceRoot\/dotfiles pull --ff-only(?:\s*(?:&&|;)\s*make (?:-C (?:~|\$HOME)\/SourceRoot\/dotfiles )?herdr-app-setup)?$/

/** Whether a command is exactly the dotfiles sync (whitespace aside). */
export const isSyncCommand = (command: string): boolean => SYNC_COMMAND.test(command.replace(/\s+/g, ' ').trim())

/** Runs of a pushed or approved command that came back unsuccessful before it is no longer offered unchanged. */
export const MAX_RUN_TRIES = 2

/**
 * What the lead or the asker is told when the pushed command ran (exit 0) and the Errand's check still says the step is
 * needed: the command is not pushed again (a second run may repeat a side effect), and the next one must be safe to repeat.
 */
export const ranStillNeededNote = (checkLine: string): string =>
  `its command ran on the MacBook (exit 0) and its check still says the step is needed${checkLine === '' ? '' : ` (${checkLine})`}; the command was not pushed again. Look at what it did, then raise it again with a command that is safe to repeat (look before create) and a check that exits 0 only on positive evidence that the step is missing, never \`! <cmd>\`, which reads any error as "needed" (a new \`--call\` id for an Errand, the same key for a request)`

/** What the lead or the asker is told when its command failed twice. */
export const failedTwiceNote = (head: string): string =>
  `its command failed ${MAX_RUN_TRIES} times${head === '' ? '' : ` (${head})`} and was not offered a third time unchanged: raise it again with a corrected command (a new \`--call\` id for an Errand, the same key for a request)`
