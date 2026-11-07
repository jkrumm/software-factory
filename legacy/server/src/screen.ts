/**
 * Reading Claude Code's screen: the guard for a terminal that reports no status. hc cannot say whether such an agent sits at
 * its prompt; the screen can, and a dialog or a running turn never looks like the empty input box.
 */

const RULE = /^\s*─{3,}/
const PROMPT_LINE = /^\s*❯(?!\s*\d+[.)])/
/** The spinner line of a running turn, drawn just above the box. */
const RUNNING = /esc to interrupt/i
/** What a dialog shows in or below its box. Never looked for above the box: that is the conversation, and it may say anything. */
const DIALOG = /Esc to cancel|Enter to confirm|Do you want to/i

function box(screen: string): { lines: string[]; after: string[] } | undefined {
  const lines = screen.split('\n')
  const rules = lines.flatMap((line, i) => (RULE.test(line) ? [i] : []))
  const [top, bottom] = rules.slice(-2)
  if (top === undefined || bottom === undefined) return undefined
  return { lines: lines.slice(top + 1, bottom), after: lines.slice(bottom + 1) }
}

/**
 * The text in Claude Code's input box: what sits between the last two horizontal rule lines, without the `❯` prompt. Empty when
 * the box is empty or the screen shows no box (a dialog, a start in progress).
 */
export function inputBoxText(screen: string): string {
  const found = box(screen)
  if (!found) return ''
  return found.lines.join('\n').replace(/^\s*❯/, '').trim()
}

/**
 * Whether the screen shows an agent at its input box, ready to take Enter (`pressOnly`: its text is already in the box) or text
 * (an empty box). A dialog (a numbered choice, a confirm line), a running turn (`esc to interrupt`) and a screen with no box are
 * not a prompt: when in doubt nothing is typed.
 */
export function atPrompt(screen: string, options: { pressOnly?: boolean } = {}): boolean {
  const found = box(screen)
  if (!found) return false
  const [first = ''] = found.lines
  if (!PROMPT_LINE.test(first)) return false
  if (RUNNING.test(screen.split('\n').slice(-12).join('\n'))) return false
  // The first box line is what sits in the input (a note may say anything); a dialog's own text is on the lines after it.
  if (DIALOG.test([...found.lines.slice(1), ...found.after].join('\n'))) return false
  return options.pressOnly === true || inputBoxText(screen) === ''
}
