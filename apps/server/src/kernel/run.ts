/**
 * The result of a command run for an Errand (pushed to the MacBook by `ask-human.sh`, or an Errand's own check), and what
 * the factory keeps of its output: the first lines and the last lines, because the reason for a failure is usually at the
 * top and the end of a long output says how it stopped.
 */

export const RUN_STATUSES = ['failed', 'timeout', 'running'] as const
export type RunStatus = (typeof RUN_STATUSES)[number]

/** An unsuccessful run as it came back. `exit` is null when the run has none (still running, killed). */
export interface RunFailure {
  status: RunStatus
  exit: number | null
  output: string
}

/** The exit code `timeout(1)` ends a run with. */
export const EXIT_TIMED_OUT = 124

export const HEAD_LINES = 20
export const TAIL_LINES = 20
/** A line longer than this is cut; the two halves together never pass 4 KiB each. */
const LINE_MAX = 400
const HALF_MAX = 4000

export interface HeadTail {
  head: string
  /** empty when the whole output fits in the head */
  tail: string
  /** lines left out between the two */
  cut: number
}

const clip = (lines: readonly string[]): string => {
  const text = lines.map((line) => (line.length > LINE_MAX ? `${line.slice(0, LINE_MAX)}…` : line)).join('\n')
  return text.length > HALF_MAX ? `${text.slice(0, HALF_MAX)}…` : text
}

/** The first and the last lines of an output; an output that fits in both is kept whole, in the head. */
export function headTail(output: string): HeadTail {
  const lines = output.replace(/\r\n/g, '\n').trimEnd().split('\n')
  if (lines.length === 1 && lines[0] === '') return { head: '', tail: '', cut: 0 }
  if (lines.length <= HEAD_LINES + TAIL_LINES) return { head: clip(lines), tail: '', cut: 0 }
  return {
    head: clip(lines.slice(0, HEAD_LINES)),
    tail: clip(lines.slice(-TAIL_LINES)),
    cut: lines.length - HEAD_LINES - TAIL_LINES,
  }
}

/** The two halves as one text for a note: the head, a marker for what was left out, the tail. */
export function joinHeadTail({ head, tail, cut }: HeadTail): string {
  if (tail === '') return head
  return `${head}\n… ${cut} lines left out …\n${tail}`
}

export const outputNote = (output: string): string => joinHeadTail(headTail(output))

/** The first line that says what went wrong: an error-looking one if the head has it, else the first one with text. */
export function firstErrorLine(head: string): string {
  const lines = head
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '')
  const found = lines.find((line) =>
    /\b(error|fail(ed|ure)?|denied|refused|not found|cannot|can't|fatal|panic)\b/i.test(line),
  )
  return (found ?? lines[0] ?? 'no output').slice(0, 200)
}

/**
 * The failure a done request carries, if it carries one: an explicit `run` result, or the words `ask-human.sh` wrote
 * before it sent one (`ran on the MacBook and failed (exit 2): <output>`). A success, or a request with no result, is none.
 */
export function runFailureOf(input: {
  run?: { status: 'done' | RunStatus; exit?: number | null | undefined; output?: string | undefined } | undefined
  note: string | null
}): RunFailure | null {
  const { run } = input
  if (run) {
    const exit = run.exit ?? null
    const status: RunStatus | null =
      run.status === 'running'
        ? 'running'
        : run.status === 'timeout' || exit === EXIT_TIMED_OUT
          ? 'timeout'
          : run.status === 'failed' || (exit !== null && exit !== 0)
            ? 'failed'
            : null
    return status ? { status, exit, output: run.output ?? input.note ?? '' } : null
  }
  const legacy = /^ran on the MacBook and failed \(exit (\d+|\?)\):?\s*/.exec(input.note ?? '')
  if (!legacy || input.note === null) return null
  const exit = legacy[1] === '?' ? null : Number(legacy[1])
  return { status: exit === EXIT_TIMED_OUT ? 'timeout' : 'failed', exit, output: input.note.slice(legacy[0].length) }
}

/** The line Needs-you shows for an Errand whose run came back unsuccessful. */
export function triedLine(run: { status: RunStatus; exit: number | null; head: string; attempts: number }): string {
  const what = run.status === 'running' ? 'still running' : run.status === 'timeout' ? 'timed out' : 'failed'
  const times = run.attempts > 1 ? ` (${run.attempts} tries)` : ''
  return `tried, ${what}${times}: ${firstErrorLine(run.head)}`
}

/** The desk pass runs at least this often, whether or not the owner came back; the read of an Errand's next check says it too. */
export const DESK_EVERY_MS = 6 * 3_600_000

/** What a check whose command was not found leaves as check_note, before the line that says what was not found. */
export const CHECK_BROKEN_NOTE = 'the check is broken'

/** What an owner's done leaves as check_note when its check says the request is still needed. */
export const STILL_NEEDED_NOTE = 'marked done but the check says still needed'

/** What a check that answered "not needed" is quoted as: its exit, then its output on the same line or, when it has several, below. */
export const exitedNote = (exit: number | null, output: string): string => {
  if (output === '') return `its check exited ${exit}`
  return `its check exited ${exit}${output.includes('\n') ? ':\n' : ': '}${outputNote(output)}`
}
