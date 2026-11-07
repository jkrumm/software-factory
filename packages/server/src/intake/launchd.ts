import { cleanText, MAX_TITLE_CHARS, storable } from '@software-factory/contract'
import type { SQL } from 'bun'
import { childEnv, runProcess } from '../exec.ts'
import { vetIntakeRepo } from '../issues/create.ts'
import { fileSignalIn, type Signal } from '../issues/signals.ts'
import { RepoRefused } from '../repos.ts'

/** The first pass comes this long after boot, so the tick's first minute is not shared with a process spawn per label. */
const FIRST_PASS_MS = 30_000
const PRINT_TIMEOUT_MS = 10_000
/** A label is an argument of `launchctl`, never a path or a shell word; anything else in a manifest is skipped. */
const LABEL = /^[A-Za-z0-9._-]+$/

export interface LaunchdIntakeDeps {
  sql: SQL
  now: () => Date
  roots: readonly string[]
  /** the user whose `gui/<uid>` domain is read (the server's own) */
  uid: number
  /** the spacing of two passes (`FACTORY_LAUNCHD_POLL`) */
  everyMs: number
  /** the tests' fake */
  run?: typeof runProcess
}

interface Target {
  repo: string
  labels: string[]
}

/** What `launchctl print` said about one job, as far as the intake reads it. */
interface Job {
  /** `running`, `not running`, … */
  state: string | undefined
  /** the last exit code; undefined for a job that never exited */
  exitCode: number | undefined
  runs: number
}

/** The two top-level lines and the exit line of `launchctl print gui/<uid>/<label>`; the output is data and nothing else is read. */
export function parseJob(output: string): Job {
  const state = /^\tstate = (.+)$/m.exec(output)?.[1]?.trim()
  const exit = /^\tlast exit code = (\d+)\b/m.exec(output)?.[1]
  const runs = /^\truns = (\d+)$/m.exec(output)?.[1]
  return {
    state,
    exitCode: exit === undefined ? undefined : Number(exit),
    runs: runs === undefined ? 0 : Number(runs),
  }
}

const errorOf = (error: unknown): string => (error instanceof Error ? error.message : String(error))

/**
 * The failed launchd job source (design §4 "Intake"): a project whose manifest has `signals.launchd: [labels]` has exactly those
 * labels read, in the server's own `gui/<uid>` domain, and nothing else on the machine. A job that exited non-zero is `down`, one that is
 * running or last exited 0 is `up`; a job that never exited, or is not loaded, says nothing. Self-paced like `GithubIntake`: the tick
 * calls `kick`, a pass starts only `everyMs` after the last, one at a time. Everything is read first (the process runner, outside any
 * transaction), then each signal is filed in a transaction of its own through `fileSignalIn`, whose heal rules, dedup and IuRoot refusal
 * apply. The output of `launchctl` is data: only its numbers are kept.
 */
export class LaunchdIntake {
  private nextAt: number
  private running: Promise<void> | undefined

  constructor(private readonly deps: LaunchdIntakeDeps) {
    this.nextAt = deps.now().getTime() + FIRST_PASS_MS
  }

  kick(): void {
    if (this.running) return
    const at = this.deps.now().getTime()
    if (at < this.nextAt) return
    this.nextAt = at + this.deps.everyMs
    this.running = this.pass()
      .catch((error: unknown) => console.error('launchd intake', { error: errorOf(error) }))
      .finally(() => {
        this.running = undefined
      })
  }

  async settled(): Promise<void> {
    await this.running
  }

  private async pass(): Promise<void> {
    const signals: Signal[] = []
    for (const target of await this.targets()) {
      const open = await this.openSubjects(target.labels)
      for (const label of target.labels) {
        const signal = await this.signalOf(target.repo, label, open.has(label))
        if (signal) signals.push(signal)
      }
    }
    for (const signal of signals) {
      try {
        await this.deps.sql.begin((tx) =>
          fileSignalIn(tx, signal, { repoRoots: this.deps.roots, now: this.deps.now() }),
        )
      } catch (error) {
        console.error('launchd intake', { subject: signal.subject, error: errorOf(error) })
      }
    }
  }

  /** The projects that opted in, whose repo the intake may file in, and the labels of theirs that are safe to pass on. */
  private async targets(): Promise<Target[]> {
    const rows: { repo: string; labels: string[] }[] = await this.deps.sql`
      SELECT repo, ARRAY(SELECT jsonb_array_elements_text(manifest->'signals'->'launchd')) AS labels FROM factory.projects
      WHERE NOT paused AND jsonb_typeof(manifest->'signals'->'launchd') = 'array' ORDER BY name`
    const targets: Target[] = []
    for (const row of rows) {
      try {
        await vetIntakeRepo('launchd', row.repo, this.deps.roots)
      } catch (error) {
        if (error instanceof RepoRefused) continue
        throw error
      }
      const labels = [...new Set(row.labels)].filter((label) => LABEL.test(label))
      if (labels.length < new Set(row.labels).size)
        console.error('launchd intake: a label that is not a plain name is skipped')
      if (labels.length > 0) targets.push({ repo: row.repo, labels })
    }
    return targets
  }

  /** The labels with an Issue that is not closed or a `down` waiting to settle: a healthy job is sent only while one of these is open. */
  private async openSubjects(labels: readonly string[]): Promise<Set<string>> {
    const rows: { subject: string }[] = await this.deps.sql`
      SELECT d.monitor AS subject FROM factory.door_issues d JOIN factory.issues i ON i.id = d.issue_id
      WHERE d.source = 'launchd' AND i.state <> 'closed'
      UNION
      SELECT subject FROM factory.intake_pending WHERE source = 'launchd'`
    const named = new Set(labels)
    return new Set(rows.map((row) => row.subject).filter((subject) => named.has(subject)))
  }

  private async read(label: string): Promise<Job | undefined> {
    const run = this.deps.run ?? runProcess
    try {
      const done = await run(['launchctl', 'print', `gui/${this.deps.uid}/${label}`], PRINT_TIMEOUT_MS, childEnv())
      if (done.exitCode === 0) return parseJob(done.stdout)
      console.error('launchd intake: a job could not be read', { label, exitCode: done.exitCode })
    } catch (error) {
      console.error('launchd intake: a job could not be read', { label, error: errorOf(error) })
    }
    return undefined
  }

  private async signalOf(repo: string, label: string, isOpen: boolean): Promise<Signal | undefined> {
    const job = await this.read(label)
    if (job?.exitCode === undefined) return undefined
    if (job.exitCode !== 0 && job.state !== 'running') {
      return {
        source: 'launchd',
        subject: label,
        event: `down:exit${job.exitCode}@runs${job.runs}`,
        status: 'down',
        title: cleanText(`Failed launchd job "${label}" (exit ${job.exitCode})`.slice(0, MAX_TITLE_CHARS)),
        facts: storable({ label, exitCode: job.exitCode, runs: job.runs, ...(job.state ? { state: job.state } : {}) }),
        repo,
      }
    }
    if (!isOpen) return undefined
    return {
      source: 'launchd',
      subject: label,
      event: `up@runs${job.runs}`,
      status: 'up',
      title: cleanText(`Launchd job "${label}" is healthy`.slice(0, MAX_TITLE_CHARS)),
      facts: storable({ label, exitCode: job.exitCode, runs: job.runs, ...(job.state ? { state: job.state } : {}) }),
      repo,
    }
  }
}
