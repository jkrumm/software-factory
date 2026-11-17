/**
 * What a project's doctor said about this host: `doctor: make doctor` in its `project.yaml` is a read-only command that
 * exits 0 when the host can run the project and otherwise exits non-zero with one line per missing prerequisite and its fix.
 */
export interface DoctorReading {
  /** false: the doctor exited non-zero, so the host cannot run the project */
  ok: boolean
  /** one line per missing prerequisite (the doctor's output tail); empty when `ok` */
  lines: readonly string[]
  /** when the command ran */
  at: Date
}

/** The doctor's lines a refusal or a skip names: no more than this many, the rest counted. */
const DOCTOR_LINES_SHOWN = 4

/** How long a red reading stands before the doctor runs again: the owner fixing the host opens the project within it. */
export const DOCTOR_RED_RECHECK_MS = 5 * 60_000

/** How long a green reading stands: the host changes slowly (a disk unmounted, a tool removed) and the doctor takes seconds. */
export const DOCTOR_GREEN_RECHECK_MS = 60 * 60_000

/** The longest the doctor may run; a hang is the doctor's defect, not a red host. */
export const DOCTOR_TIMEOUT_MS = 60_000

/** Whether the doctor must run again: it never ran, or its reading is older than its kind allows. */
export function doctorDue(last: DoctorReading | undefined, now: Date): boolean {
  if (!last) return true
  const age = now.getTime() - last.at.getTime()
  return age >= (last.ok ? DOCTOR_GREEN_RECHECK_MS : DOCTOR_RED_RECHECK_MS)
}

/** The doctor's lines for one sentence: the first few joined with `; `, the rest counted. */
export function describeDoctor(lines: readonly string[]): string {
  const shown = lines.slice(0, DOCTOR_LINES_SHOWN).join('; ')
  const more = lines.length - DOCTOR_LINES_SHOWN
  return more > 0 ? `${shown}; and ${more} more` : shown
}

/** The refusal a red doctor gives a lead of `project`. */
export const doctorMessage = (project: string, reading: DoctorReading): string =>
  `${project} cannot run on this host${reading.lines.length > 0 ? `: ${describeDoctor(reading.lines)}` : ' (its doctor exited non-zero)'}`

/**
 * A project's doctor, asked outside any transaction. `read` answers the last reading while it stands and runs the command
 * when it is due; `null`: the project declares none, or the command could not be run (a missing `make`, a Makefile with no
 * `doctor` target, a timeout), and the host is taken as able, as every other reading that fails.
 */
export interface DoctorReader {
  read(input: { project: string; repo: string; command: string }): Promise<DoctorReading | null>
}
