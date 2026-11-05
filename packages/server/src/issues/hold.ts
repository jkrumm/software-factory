import { basename } from 'node:path'
import { defaultManifest, type MakeTargets, type ProjectManifest } from '@software-factory/contract'
import type { SQL } from 'bun'
import type { Clock } from '../clock.ts'
import { CannotExecute, childEnv, EXIT_TIMEOUT, runProcess } from '../exec.ts'
import { projectOfPath } from '../projects/claims.ts'
import { getProject } from '../projects/store.ts'
import { type Effect, type EffectPorts, Waiting } from './effects.ts'
import type { Derived } from './evidence.ts'
import { enqueue } from './inbox.ts'
import type { OffTick } from './offtick.ts'
import { deployedHolds } from './origin.ts'
import { markEvent } from './shared.ts'

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
   * Set where the deployed version must hold what was shipped (`deploy.mode: make`, a change that deploys): the `origin/<default>` the
   * ship found, which it must hold; or why there is none, which is red. Unset is a change that deploys nothing.
   */
  version?: { landedAt: string } | { problem: string }
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

/** The red line where the Makefile has no `version`: it is a probe, so the lead neither adds nor edits it. */
export const NO_TARGET_LINE =
  'no `make version` target: it is a probe, so the owner adds it (it prints the deployed commit sha) and a lead does not: `factory issue block` with this reason'

const VERSION_TIMEOUT_MS = 30_000
const SHA = /^[0-9a-f]{7,64}$/
const STDERR_MARK = '\n--stderr--\n'
/**
 * make's own top-level line for a target it does not have (or no Makefile at all), read under `LC_ALL=C`: `make: *** …`, never a sub-make's
 * `make[1]: *** …`, and never with the `[version] Error` line a recipe that failed (a nested make that printed those words) is followed by.
 */
const NO_VERSION_TARGET =
  /^make: \*\*\* (?:No rule to make target\s+[`'\u2018"]version['\u2019"]|No targets specified and no makefile found)/im
const RECIPE_FAILED = /^make: \*\*\* \[.*\] Error/m
/**
 * stdout is what `make version` prints and nothing else; stderr is caught by the shell through the pipe (no file to leave behind when a
 * kill cannot be trapped) and shown, with a marker, only when it failed.
 */
// Started as a top-level make whatever started this server: an inherited MAKELEVEL prefixes its lines `make[n]:`, and MAKEFLAGS could carry `-n`.
const VERSION_SCRIPT = `unset MAKELEVEL MAKEFLAGS MFLAGS MAKEOVERRIDES MAKE_TERMOUT MAKE_TERMERR\nexec 3>&1
err=$(make --no-print-directory -s -C "$1" version 2>&1 1>&3 3>&-)
st=$?
if [ "$st" -ne 0 ]; then printf '%s' '${STDERR_MARK}'; printf '%s' "$err" | tail -c ${MAX_DETAIL_CHARS}; fi
exit "$st"`

/**
 * `make version` (the deployed commit, which must hold where the work landed), `make verify` in the repo, the deployed checkout, and an
 * HTTP GET per probe. Every one runs, the version check red or not: the lead sees every signal. None of them writes the checkout.
 */
export class MakeAndProbes implements Proof {
  constructor(private readonly options: { run?: typeof runProcess } = {}) {}

  async run({ repo, makeVerify, version, probes }: ProofInput, signal?: AbortSignal): Promise<HoldCheck[]> {
    const deployed = version ? [await this.version(repo, version, signal)] : []
    const checks = await Promise.all(probes.map((probe) => this.probe(probe, signal)))
    const verify = makeVerify ? [await this.makeVerify(repo, signal)] : []
    return [...deployed, ...verify, ...checks]
  }

  private async version(
    repo: string,
    version: NonNullable<ProofInput['version']>,
    signal?: AbortSignal,
  ): Promise<HoldCheck> {
    const name = 'deployed version'
    const red = (detail: string): HoldCheck => ({ name, ok: false, detail })
    if ('problem' in version) return red(version.problem)
    const run = this.options.run ?? runProcess
    try {
      // Always run it: a read of the Makefile cannot see a target an include built by variable names, and only make knows it has none.
      const done = await run(
        ['sh', '-c', VERSION_SCRIPT, 'sh', repo],
        VERSION_TIMEOUT_MS,
        childEnv({ GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' }),
        undefined,
        { group: true, signal },
      )
      if (done.exitCode === EXIT_TIMEOUT) return red(`make version did not finish in ${VERSION_TIMEOUT_MS / 1000} s`)
      if (done.exitCode !== 0) {
        // The script adds the marker and the end of stderr only on a failure.
        const [printed = '', stderr = ''] = done.stdout.split(STDERR_MARK)
        if (NO_VERSION_TARGET.test(stderr) && !RECIPE_FAILED.test(stderr)) return red(NO_TARGET_LINE)
        const said = [
          printed.trim() && `stdout: ${tail(printed.trim())}`,
          stderr.trim() && `stderr: ${tail(stderr.trim())}`,
        ].filter(Boolean)
        return red(`make version exit ${done.exitCode}${said.length > 0 ? `: ${said.join(' / ')}` : ''}`)
      }
      const printed = done.stdout.trim()
      if (!SHA.test(printed))
        return red(`make version printed ${JSON.stringify(tail(printed))}: one line, the deployed commit sha`)
      return { name, ...(await deployedHolds(repo, printed, version.landedAt, { run: this.options.run, signal })) }
    } catch (error) {
      // Neither make nor git failing to answer is a retry: the lead is told, with the other checks beside it.
      return red(error instanceof Error ? error.message : String(error))
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
 * What the deployed version must hold, for a ship under `deploy.mode: make` that changed something that deploys: the `origin/<default>`
 * the ship found. Closed on every gap: no ship of this attempt on record, nothing derived on it, no landed commit, or no project at hold
 * time (the ship says the project deployed something, and the hold no longer knows how) is a reason, red. Only a ship whose commits
 * require no evidence (docs, tests) skips it.
 */
async function versionCheck(
  sql: SQL,
  issueId: number,
  attempt: number,
  project: { mode: string } | undefined,
): Promise<ProofInput['version']> {
  // First, so that no gap below can hide it: a hold that no longer knows its project cannot say what its deploy should have shown.
  if (!project)
    return { problem: 'the project is not known at hold time, so what its deploy should have shown is not either' }
  const [row]: { derived: Derived | null }[] = await sql`
    SELECT payload->'derived' AS derived FROM factory.issue_inbox
    WHERE issue_id = ${issueId} AND kind = 'ship' AND result = 'applied' AND (payload->>'attempt')::int = ${attempt}
    ORDER BY id DESC LIMIT 1`
  const derived = row?.derived
  if (project.mode !== 'make') return undefined
  if (!row) return { problem: `no ship of attempt ${attempt} is on record to check the deployed version against` }
  if (!derived) return { problem: 'the ship came without its commits derived: nothing says what it changed' }
  if (derived.required?.length === 0) return undefined
  if (!derived.landedAt)
    return { problem: 'the ship recorded no landed commit on origin to check the deployed version against' }
  return { landedAt: derived.landedAt }
}

/** What the proof of an Issue's hold checks: its repo's `make verify`, the deployed version where its ship deployed something, and the manifest's probes. */
export async function proofInputOf(
  sql: SQL,
  issue: { id: number; repo: string; attempt: number },
): Promise<ProofInput> {
  const owner = await projectOfPath(sql, issue.repo)
  const project = owner ? await getProject(sql, owner.name) : undefined
  const targets: MakeTargets | null = project?.makeTargets ?? null
  const manifest = project?.manifest ?? defaultManifest(basename(issue.repo))
  const version = await versionCheck(sql, issue.id, issue.attempt, project ? manifest.deploy : undefined)
  return { repo: issue.repo, makeVerify: targets?.verify === true, version, probes: manifest.deploy.probes }
}

/** The key of the second check of a hold: the first red one asks for it, and only a red second one is a regression. */
export const rerunKey = (verifyKey: string): string => `${verifyKey}:rerun`

/**
 * The check after the hold, off the tick (`make verify` can take minutes): `verified` when every check passes. A red first check is not
 * yet an answer: it files a second `verify` effect (`<key>:rerun`, once) and a line in the Issue's events, because a flaky probe or a
 * deploy still settling must not send a lead back to work. Only a red second check is a `regression` naming its hold, which goes back to
 * the same lead. The answers are keyed by the hold, and a check whose answer is filed already, or whose hold is over, runs nothing: a
 * crash anywhere replays to one answer.
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

  const checks = await proof.run(await proofInputOf(sql, { ...issue, id: issueId }), signal)
  // A check the server killed on its way down says nothing about production: the next server asks again.
  if (signal.aborted) throw new Waiting('the server is stopping')
  // A check takes minutes: a stop or a regression may have ended the hold since.
  if (!(await current())) return
  const green = checks.every((check) => check.ok)
  if (!green && effect.payload?.rerun !== true) {
    const now = clock.now()
    await sql.begin(async (tx) => {
      await markEvent(tx, issueId, `verify_red:${issueId}:${hold}`, 'verify_red', now, { hold, checks })
      await tx`
        INSERT INTO factory.issue_effects (issue_id, key, kind, payload, created_at)
        VALUES (${issueId}, ${rerunKey(effect.key)}, 'verify', ${{ ...effect.payload, rerun: true }}, ${now})
        ON CONFLICT (key) DO NOTHING`
    })
    return
  }
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
