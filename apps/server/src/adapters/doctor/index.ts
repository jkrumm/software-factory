import { type DoctorReader, type DoctorReading, DOCTOR_TIMEOUT_MS, doctorDue } from '../../domains/capacity/doctor.ts'
import { exec, withStderr } from '../hygiene/git.ts'
import { CannotExecute, EXIT_TIMEOUT } from '../hc/process.ts'

/** The most lines of one doctor's output a reading keeps: the rest is a doctor that says too much. */
const MAX_LINES = 20

const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;?]*[A-Za-z]`, 'g')

/** `make`'s own words about a failed recipe are noise beside the doctor's lines. */
const MAKE_NOISE = /^(?:g?make(?:\[\d+\])?:\s|\*\*\*)/

/** The doctor's output as its lines: ANSI stripped, blanks and make's own error lines dropped. */
function linesOf(output: string): string[] {
  return output
    .replace(ANSI, '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '' && !MAKE_NOISE.test(line))
    .slice(0, MAX_LINES)
}

export interface DoctorOptions {
  /** the `make` to run; the tests put a fake here */
  make?: string
  timeoutMs?: number
  now: () => Date
}

interface Held {
  command: string
  /** `null`: the doctor could not be run; asked again after the red interval, so a hang is not paid every pass */
  reading: DoctorReading | null
  at: Date
}

/**
 * Runs a project's doctor (`make <target>` in the project's own checkout, a read-only command of seconds) and keeps the
 * last reading per project in memory: a red one stands for `DOCTOR_RED_RECHECK_MS`, a green one for `DOCTOR_GREEN_RECHECK_MS`,
 * and a restart asks again. One run per project at a time. Exit 0 is green, any other exit red with the output's lines; a
 * `make` that cannot start, a timeout, or a checkout whose Makefile has no such target is `null`: not a reading of the host.
 */
export function createDoctorReader(options: DoctorOptions): DoctorReader {
  const make = options.make ?? 'make'
  const timeoutMs = options.timeoutMs ?? DOCTOR_TIMEOUT_MS
  const held = new Map<string, Held>()
  const running = new Map<string, Promise<DoctorReading | null>>()

  async function run(project: string, repo: string, command: string): Promise<DoctorReading | null> {
    const reading = await ask(repo, command)
    held.set(project, { command, reading, at: options.now() })
    return reading
  }

  async function ask(repo: string, command: string): Promise<DoctorReading | null> {
    const target = command.replace(/^make /, '')
    let result: Awaited<ReturnType<typeof exec>>
    try {
      result = await exec(withStderr([make, target]), timeoutMs, repo)
    } catch (error) {
      if (error instanceof CannotExecute) return null
      throw error
    }
    if (result.exitCode === EXIT_TIMEOUT || result.exitCode === 126 || result.exitCode === 127) return null
    if (result.exitCode !== 0 && /No rule to make target/.test(result.stdout)) return null
    return {
      ok: result.exitCode === 0,
      lines: result.exitCode === 0 ? [] : linesOf(result.stdout),
      at: options.now(),
    }
  }

  return {
    async read({ project, repo, command }) {
      const last = held.get(project)
      if (
        last?.command === command &&
        !doctorDue({ ok: last.reading?.ok ?? false, lines: [], at: last.at }, options.now())
      ) {
        return last.reading
      }
      const inFlight = running.get(project)
      if (inFlight) return inFlight
      const started = run(project, repo, command).finally(() => running.delete(project))
      running.set(project, started)
      return started
    },
  }
}
