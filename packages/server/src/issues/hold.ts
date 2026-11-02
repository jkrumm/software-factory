import { basename } from 'node:path'
import { defaultManifest, type MakeTargets, type ProjectManifest } from '@software-factory/contract'
import type { SQL } from 'bun'
import type { Clock } from '../clock.ts'
import { CannotExecute, childEnv, EXIT_TIMEOUT, runProcess } from '../exec.ts'
import { makeTargetsOf } from '../projects/make.ts'
import { projectOfPath } from '../projects/claims.ts'
import { getProject } from '../projects/store.ts'
import { type Effect, type EffectPorts, Waiting } from './effects.ts'
import type { Derived } from './evidence.ts'
import { enqueue } from './inbox.ts'
import type { OffTick } from './offtick.ts'
import { deployedHolds } from './origin.ts'

/** One check of the proof: pass or fail, never averaged. `detail` is data, whatever the check printed. */
export interface HoldCheck {
  name: string
  ok: boolean
  detail: string
}

export interface ProofInput {
  repo: string
  /** the make contract says the repo has `make verify` */
  makeVerify: boolean
  /**
   * Set where the deployed version must hold what was shipped (`deploy.mode: make`, a change that deploys): the commits it must hold.
   * None is red, never skipped.
   */
  version?: { shipped: readonly string[] }
  probes: ProjectManifest['deploy']['probes']
}

/** A port, called outside any transaction. */
export interface Proof {
  /** `signal`: the server is stopping, nothing of the check may outlive it, and what it answers then says nothing */
  run(input: ProofInput, signal?: AbortSignal): Promise<HoldCheck[]>
}

const MAKE_TIMEOUT_MS = 10 * 60_000
const PROBE_TIMEOUT_MS = 15_000
/** What of a check's output is kept: the end, where a failure says what failed. */
const MAX_DETAIL_CHARS = 1_500

const tail = (text: string): string => (text.length > MAX_DETAIL_CHARS ? `…${text.slice(-MAX_DETAIL_CHARS)}` : text)

const VERSION_TIMEOUT_MS = 30_000
const SHA = /^[0-9a-f]{7,64}$/

/**
 * `make version` (the deployed commit, which must hold the shipped ones), `make verify` in the repo, the deployed checkout, and an HTTP
 * GET per probe. Every one runs, the version check red or not: the lead sees every signal. None of them writes the checkout.
 */
export class MakeAndProbes implements Proof {
  constructor(private readonly options: { run?: typeof runProcess } = {}) {}

  async run({ repo, makeVerify, version, probes }: ProofInput, signal?: AbortSignal): Promise<HoldCheck[]> {
    const deployed = version ? [await this.version(repo, version.shipped, signal)] : []
    const checks = await Promise.all(probes.map((probe) => this.probe(probe, signal)))
    const verify = makeVerify ? [await this.makeVerify(repo, signal)] : []
    return [...deployed, ...verify, ...checks]
  }

  private async version(repo: string, shipped: readonly string[], signal?: AbortSignal): Promise<HoldCheck> {
    const name = 'deployed version'
    const red = (detail: string): HoldCheck => ({ name, ok: false, detail })
    if (shipped.length === 0) return red('no shipped commit is on record to check the deployed version against')
    // A static read of the Makefile, not of the stored contract: the target may have come with this very change.
    if (!(await makeTargetsOf(repo)).version) return red('add `make version`: the deployed commit sha')
    const run = this.options.run ?? runProcess
    try {
      const done = await run(
        ['make', '--no-print-directory', '-s', '-C', repo, 'version'],
        VERSION_TIMEOUT_MS,
        childEnv({ GIT_TERMINAL_PROMPT: '0' }),
        undefined,
        { group: true, signal },
      )
      if (done.exitCode === EXIT_TIMEOUT) return red(`make version did not finish in ${VERSION_TIMEOUT_MS / 1000} s`)
      const printed = done.stdout.trim()
      if (done.exitCode !== 0) return red(`make version exit ${done.exitCode}: ${tail(printed)}`)
      if (!SHA.test(printed))
        return red(`make version printed ${JSON.stringify(tail(printed))}: one line, the deployed commit sha`)
      return { name, ...(await deployedHolds(repo, printed, shipped, { run: this.options.run, signal })) }
    } catch (error) {
      if (error instanceof CannotExecute) return red(error.message)
      throw error
    }
  }

  private async makeVerify(repo: string, signal?: AbortSignal): Promise<HoldCheck> {
    const run = this.options.run ?? runProcess
    const name = 'make verify'
    try {
      const done = await run(
        ['sh', '-c', 'exec make -C "$1" verify 2>&1', 'sh', repo],
        MAKE_TIMEOUT_MS,
        childEnv({ GIT_TERMINAL_PROMPT: '0' }),
        undefined,
        // Its own group: a kill reaches the recipes `make` started, not `make` alone.
        { group: true, signal },
      )
      if (done.exitCode === EXIT_TIMEOUT)
        return { name, ok: false, detail: `did not finish in ${MAKE_TIMEOUT_MS / 1000} s` }
      return { name, ok: done.exitCode === 0, detail: `exit ${done.exitCode}: ${tail(done.stdout.trim())}` }
    } catch (error) {
      if (error instanceof CannotExecute) return { name, ok: false, detail: error.message }
      throw error
    }
  }

  private async probe({ name, http, expect }: ProofInput['probes'][number], signal?: AbortSignal): Promise<HoldCheck> {
    try {
      // A redirect is an answer, and the manifest says which one it wants.
      const timeout = AbortSignal.timeout(PROBE_TIMEOUT_MS)
      const response = await fetch(http, {
        redirect: 'manual',
        signal: signal ? AbortSignal.any([timeout, signal]) : timeout,
      })
      await response.body?.cancel()
      return { name, ok: response.status === expect, detail: `HTTP ${response.status}, expected ${expect}` }
    } catch (error) {
      return { name, ok: false, detail: error instanceof Error ? error.message : String(error) }
    }
  }
}

/**
 * How long after the server starts no check runs. A restart is a deploy, and `make deploy` writes what `make verify` compares and
 * restarts the door only once `/health` answers: a hold that ended meanwhile, this repo's above all, would read the deploy as a regression.
 */
export const VERIFY_SETTLE_MS = 2 * 60_000

export interface HoldDeps {
  sql: SQL
  clock: Clock
  proof: Proof
  offTick: OffTick
  /** no check before this: `VERIFY_SETTLE_MS` after the start */
  settledAt?: Date
}

/**
 * What the deployed version must hold, when the ship that started this hold changed something that deploys under `deploy.mode: make`:
 * the commits the lead named (the merge commit of a squash), else every commit `derive` found. None is an empty list, which the check
 * reds. A ship with nothing derived on it came before the evidence gate: nothing is known of it, and it is held as it was.
 */
async function versionCheck(sql: SQL, issueId: number, attempt: number): Promise<ProofInput['version']> {
  const [row]: { derived: Derived | null }[] = await sql`
    SELECT payload->'derived' AS derived FROM factory.issue_inbox
    WHERE issue_id = ${issueId} AND kind = 'ship' AND result = 'applied' AND (payload->>'attempt')::int = ${attempt}
    ORDER BY id DESC LIMIT 1`
  const derived = row?.derived
  if (!derived || derived.required.length === 0) return undefined
  const named = derived.reported ?? []
  return { shipped: named.length > 0 ? named : (derived.commits ?? []) }
}

/**
 * The check after the hold, off the tick (`make verify` can take minutes): `verified` when every check passes, else a `regression`
 * naming its hold, which goes back to the same lead. Both are keyed by the hold, and a check whose answer is filed already, or whose hold
 * is over, runs nothing: a crash anywhere replays to one answer.
 */
async function verifyHold({ sql, clock, proof }: HoldDeps, effect: Effect, signal: AbortSignal): Promise<void> {
  const issueId = effect.issueId
  const hold = Number(effect.payload?.hold)
  const current = async () => {
    const [row]: { state: string; hold: number; repo: string; attempt: number }[] =
      await sql`SELECT state, hold, repo, attempt FROM factory.issues WHERE id = ${issueId}`
    return row?.state === 'watching' && row.hold === hold ? row : undefined
  }
  const issue = await current()
  if (!issue) return
  const greenKey = `verified:${issueId}:${hold}`
  const redKey = `regression:${issueId}:${hold}`
  const [answered] = await sql`SELECT 1 FROM factory.issue_inbox WHERE key IN ${sql([greenKey, redKey])}`
  if (answered) return

  const owner = await projectOfPath(sql, issue.repo)
  const project = owner ? await getProject(sql, owner.name) : undefined
  const targets: MakeTargets | null = project?.makeTargets ?? null
  const manifest = project?.manifest ?? defaultManifest(basename(issue.repo))
  const version = manifest.deploy.mode === 'make' ? await versionCheck(sql, issueId, issue.attempt) : undefined
  const checks = await proof.run(
    { repo: issue.repo, makeVerify: targets?.verify === true, version, probes: manifest.deploy.probes },
    signal,
  )
  // A check the server killed on its way down says nothing about production: the next server asks again.
  if (signal.aborted) throw new Waiting('the server is stopping')
  // A check takes minutes: a stop or a regression may have ended the hold since.
  if (!(await current())) return
  const green = checks.every((check) => check.ok)
  await enqueue(sql, {
    issueId,
    key: green ? greenKey : redKey,
    kind: green ? 'verified' : 'regression',
    at: clock.now(),
    payload: {
      hold,
      checks,
      // What the owner's line says of a regression.
      ...(green
        ? {}
        : {
            title: `${checks
              .filter((check) => !check.ok)
              .map((check) => check.name)
              .join(', ')} failed`,
          }),
    },
  })
}

export function holdPorts(deps: HoldDeps): Pick<EffectPorts, 'verify'> {
  return {
    verify: async (effect) => {
      if (deps.settledAt && deps.clock.now() < deps.settledAt) throw new Waiting('the server has only just started')
      await deps.offTick.run(effect.key, (signal) => verifyHold(deps, effect, signal))
    },
  }
}
