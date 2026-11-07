import type { SQL } from 'bun'
import { CannotExecute, childEnv, EXIT_TIMEOUT, runProcess } from '../exec.ts'
import { RepoRefused } from '../repos.ts'
import { createSignalIssueIn, type PendingRule, type Signal } from './signals.ts'

/** Pending rows one pass looks at. */
const BATCH = 20
/** A runbook claimed and not recorded (a crash) is looked at again after this: its timeout and a margin. */
const RUNBOOK_LEASE_MS = 150_000
const RUNBOOK_TIMEOUT_MS = 120_000
const TAIL = 500

export interface SettleDeps {
  /** the process runner; the tests' fake */
  run?: typeof runProcess
  repoRoots: readonly string[]
}

interface PendingRow {
  source: string
  subject: string
  repo: string
  signal: Signal
  rule: PendingRule
  attempts: number
  results: unknown[]
}

const tail = (text: string): string => text.trim().slice(-TAIL)

/** Whether the project's Makefile has `restart`; no Makefile at all means every target is assumed (the make contract's convention). */
async function hasRestart(tx: SQL, repo: string): Promise<boolean> {
  const [row]: { make_targets: { makefile?: boolean; restart?: boolean } | null }[] = await tx`
    SELECT make_targets FROM factory.projects
    WHERE repo = ${repo} OR starts_with(${repo}, repo || '/')
    ORDER BY length(repo) DESC LIMIT 1`
  const targets = row?.make_targets
  if (!targets) return false
  return targets.makefile === false || targets.restart === true
}

/**
 * The tick's settle pass (design §4 "Intake"): for each pending `down` whose time has come, run the rule's runbook (outside any
 * transaction) or, with none left to run, file the Issue. One query when nothing is due. Returns the errors for the next tick's result.
 */
async function settlePass(sql: SQL, deps: SettleDeps, now: () => Date): Promise<string[]> {
  const due: { source: string; subject: string }[] = await sql`
    SELECT source, subject FROM factory.intake_pending WHERE due_at <= ${now()} ORDER BY due_at, source, subject LIMIT ${BATCH}`
  const errors: string[] = []
  for (const { source, subject } of due) {
    try {
      await settleOne(sql, deps, now, source, subject)
    } catch (error) {
      errors.push(`settle ${source}:${subject}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  return errors
}

async function settleOne(sql: SQL, deps: SettleDeps, now: () => Date, source: string, subject: string): Promise<void> {
  // (a) Claim the run, or file: one short transaction, no port.
  const claimed = await sql.begin(async (tx): Promise<{ repo: string; rule: PendingRule } | undefined> => {
    const at = now()
    const [row]: PendingRow[] = await tx`
      SELECT source, subject, repo, signal, rule, attempts, results FROM factory.intake_pending
      WHERE source = ${source} AND subject = ${subject} AND due_at <= ${at} FOR UPDATE SKIP LOCKED`
    if (!row) return undefined
    const { rule } = row
    const reason = !rule.runbook
      ? 'no runbook'
      : row.attempts >= rule.max
        ? 'attempts spent'
        : (await hasRestart(tx, row.repo))
          ? undefined
          : 'no restart target'
    if (reason === undefined) {
      await tx`
        UPDATE factory.intake_pending SET attempts = attempts + 1, due_at = ${new Date(at.getTime() + RUNBOOK_LEASE_MS)}
        WHERE source = ${source} AND subject = ${subject}`
      return { repo: row.repo, rule }
    }
    // Nothing left to try and no `up` since: the Issue. A refusal (the repo moved into IuRoot) drops the row, never retries forever.
    const results = [...row.results, { at: at.toISOString(), skipped: reason }]
    try {
      await tx.savepoint(async (inner) => {
        await createSignalIssueIn(
          inner,
          { ...row.signal, status: 'down', repo: row.repo },
          { repoRoots: deps.repoRoots, now: at },
          { graceMs: rule.grace_ms, attempts: row.attempts, results },
        )
      })
    } catch (error) {
      if (!(error instanceof RepoRefused)) throw error
      console.error('intake refused', { source, subject, reason: error.message })
    }
    await tx`DELETE FROM factory.intake_pending WHERE source = ${source} AND subject = ${subject}`
    return undefined
  })
  if (!claimed) return

  // (b) The runbook, outside any transaction.
  const run = deps.run ?? runProcess
  let exit: number
  let output: string
  try {
    const done = await run(
      ['sh', '-c', 'exec make -C "$1" restart 2>&1', 'sh', claimed.repo],
      RUNBOOK_TIMEOUT_MS,
      childEnv({ GIT_TERMINAL_PROMPT: '0' }),
      undefined,
      { group: true },
    )
    exit = done.exitCode
    output = done.exitCode === EXIT_TIMEOUT ? `did not finish in ${RUNBOOK_TIMEOUT_MS / 1000} s` : done.stdout
  } catch (error) {
    if (!(error instanceof CannotExecute)) throw error
    exit = EXIT_TIMEOUT
    output = error.message
  }

  // (c) Record it; the grace starts over from the end of the run. A row an `up` deleted meanwhile stays gone.
  const entry = { at: now().toISOString(), exit, tail: tail(output) }
  await sql`
    UPDATE factory.intake_pending
    SET results = results || ${JSON.stringify([entry])}::text::jsonb, due_at = ${new Date(now().getTime() + claimed.rule.grace_ms)}
    WHERE source = ${source} AND subject = ${subject}`
}

/**
 * Runs the settle pass behind the tick's back: a runbook may take up to two minutes and must hold nothing. `kick` starts one pass when
 * none is running and never throws; a pass's errors are logged and handed to the next tick (`takeErrors`). `settled` waits for the
 * pass in flight (the tests and the shutdown).
 */
export class Settler {
  private running: Promise<void> | undefined
  private errors: string[] = []

  constructor(
    private readonly deps: SettleDeps,
    private readonly sql: SQL,
    private readonly now: () => Date,
  ) {}

  kick(): void {
    if (this.running) return
    this.running = settlePass(this.sql, this.deps, this.now)
      .then((errors) => {
        for (const line of errors) console.error('settle', line)
        this.errors.push(...errors)
      })
      .catch((error: unknown) => {
        const line = `settle: ${error instanceof Error ? error.message : String(error)}`
        console.error(line)
        this.errors.push(line)
      })
      .finally(() => {
        this.running = undefined
      })
  }

  /** The errors of the passes since the last call. */
  takeErrors(): string[] {
    return this.errors.splice(0)
  }

  async settled(): Promise<void> {
    await this.running
  }
}
