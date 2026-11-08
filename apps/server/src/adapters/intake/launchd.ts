import { cleanText, MAX_TITLE_CHARS, storable } from '@software-factory/contract'
import type { Received } from '../../domains/intake/model.ts'
import type { IntakeSink, ProjectSignals } from '../../domains/intake/ports.ts'
import type { Clock } from '../../kernel/clock.ts'
import { runProcess } from './process.ts'
import type { RunProcess } from './process.ts'

const PRINT_TIMEOUT_MS = 10_000
/** A label is an argument of `launchctl`, never a path or a shell word; anything else in a project.yaml is skipped. */
const LABEL = /^[A-Za-z0-9._-]+$/

export interface LaunchdPollerDeps {
  sink: IntakeSink
  projects: ProjectSignals
  /** the user whose `gui/<uid>` domain is read (the server's own) */
  uid: number
  run?: RunProcess
  log?: (line: string) => void
  /** not read here; accepted so the three pollers share one shape */
  clock?: Clock
}

/** What `launchctl print` said about one job, as far as the intake reads it. */
interface Job {
  /** `running`, `not running`, … */
  state: string | undefined
  /** the last exit code; undefined for a job that never exited */
  exitCode: number | undefined
  runs: number
}

/** The state line, the runs line and the exit line of `launchctl print gui/<uid>/<label>`; the output is data and nothing else is read. */
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

function receivedOf(
  repo: string,
  label: string,
  status: 'down' | 'up',
  event: string,
  title: string,
  facts: unknown,
): Received {
  const clean = cleanText(title.slice(0, MAX_TITLE_CHARS))
  return {
    signal: {
      source: 'launchd',
      kind: 'alert',
      origin: 'infrastructure',
      trust: 'machine',
      repo,
      fingerprint: `launchd:${label}`,
      title: clean,
      text: clean,
      link: null,
      madeBy: null,
      probe: false,
    },
    alert: { subject: label, event, status, facts: storable(facts) },
  }
}

/**
 * The failed launchd job source: a project whose `signals:` lists `launchd` labels has exactly those labels read, in the
 * server's own `gui/<uid>` domain, and nothing else on the machine. A job that exited non-zero and is not running is
 * `down`; one that is running or last exited 0 is `up`, sent only while its subject is open; a job that never exited, or
 * is not loaded, says nothing. The output of `launchctl` is data: only its numbers are kept.
 */
export function launchdPoller(deps: LaunchdPollerDeps): { enabled: boolean; pass(): Promise<void> } {
  const log = deps.log ?? ((line: string) => console.error(line))
  const run = deps.run ?? runProcess

  async function read(label: string): Promise<Job | undefined> {
    try {
      const done = await run(['launchctl', 'print', `gui/${deps.uid}/${label}`], PRINT_TIMEOUT_MS)
      if (done.exit === 0) return parseJob(done.stdout)
      log(`launchd intake: ${label} could not be read (exit ${done.exit ?? 'timeout'})`)
    } catch {
      log(`launchd intake: ${label} could not be read`)
    }
    return undefined
  }

  async function receivedFor(repo: string, label: string, isOpen: boolean): Promise<Received | undefined> {
    const job = await read(label)
    if (!job) return undefined
    const running = job.state === 'running'
    // Not running and never exited: it never ran (or is not up yet), which says nothing either way.
    if (job.exitCode === undefined && !running) return undefined
    if (job.exitCode !== undefined && job.exitCode !== 0 && !running) {
      return receivedOf(
        repo,
        label,
        'down',
        `down:exit${job.exitCode}@runs${job.runs}`,
        `Failed launchd job "${label}" (exit ${job.exitCode})`,
        { label, exitCode: job.exitCode, runs: job.runs, ...(job.state ? { state: job.state } : {}) },
      )
    }
    if (!isOpen) return undefined
    return receivedOf(repo, label, 'up', `up@runs${job.runs}`, `Launchd job "${label}" is healthy`, {
      label,
      runs: job.runs,
      ...(job.exitCode === undefined ? {} : { exitCode: job.exitCode }),
      ...(job.state ? { state: job.state } : {}),
    })
  }

  async function pass(): Promise<void> {
    const polled = await deps.projects.polled()
    if (!polled.ok) {
      log(`launchd intake: projects unknown (${polled.error.kind})`)
      return
    }
    // A work repo hears the owner only (NL18): nothing of it is read.
    const targets = polled.value.filter((project) => !project.work && project.launchd.length > 0)
    if (targets.length === 0) return
    const known = await deps.sink.subjects('launchd', '')
    if (!known.ok) log(`launchd intake: open jobs unknown (${known.error.kind})`)
    const open = new Set(known.ok ? known.value.filter((s) => s.open).map((s) => s.subject) : [])

    let skipped = false
    for (const project of targets) {
      const labels = [...new Set(project.launchd)]
      const plain = labels.filter((label) => LABEL.test(label))
      if (plain.length < labels.length) skipped = true
      for (const label of plain) {
        const received = await receivedFor(project.repo, label, open.has(label))
        if (!received) continue
        const answer = await deps.sink.receive(received)
        if (!answer.ok) log(`launchd intake: ${label} not filed (${answer.error.kind})`)
      }
    }
    if (skipped) log('launchd intake: a label that is not a plain name is skipped')
  }

  return { enabled: true, pass }
}
