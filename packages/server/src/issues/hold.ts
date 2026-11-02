import { basename } from 'node:path'
import { defaultManifest, type MakeTargets, type ProjectManifest } from '@software-factory/contract'
import type { SQL } from 'bun'
import type { Clock } from '../clock.ts'
import { CannotExecute, childEnv, EXIT_TIMEOUT, runProcess } from '../exec.ts'
import { projectOfPath } from '../projects/claims.ts'
import { getProject } from '../projects/store.ts'
import type { Effect, EffectPorts } from './effects.ts'
import { enqueue } from './inbox.ts'
import type { OffTick } from './offtick.ts'

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
  probes: ProjectManifest['deploy']['probes']
}

/** A port, called outside any transaction. */
export interface Proof {
  run(input: ProofInput): Promise<HoldCheck[]>
}

const MAKE_TIMEOUT_MS = 10 * 60_000
const PROBE_TIMEOUT_MS = 15_000
/** What of a check's output is kept: the end, where a failure says what failed. */
const MAX_DETAIL_CHARS = 1_500

const tail = (text: string): string => (text.length > MAX_DETAIL_CHARS ? `…${text.slice(-MAX_DETAIL_CHARS)}` : text)

/** `make verify` in the repo, the deployed checkout, and an HTTP GET per probe. */
export class MakeAndProbes implements Proof {
  constructor(private readonly options: { run?: typeof runProcess } = {}) {}

  async run({ repo, makeVerify, probes }: ProofInput): Promise<HoldCheck[]> {
    const checks = await Promise.all(probes.map((probe) => this.probe(probe)))
    return makeVerify ? [await this.makeVerify(repo), ...checks] : checks
  }

  private async makeVerify(repo: string): Promise<HoldCheck> {
    const run = this.options.run ?? runProcess
    const name = 'make verify'
    try {
      const done = await run(
        ['sh', '-c', 'exec make -C "$1" verify 2>&1', 'sh', repo],
        MAKE_TIMEOUT_MS,
        childEnv({ GIT_TERMINAL_PROMPT: '0' }),
      )
      if (done.exitCode === EXIT_TIMEOUT)
        return { name, ok: false, detail: `did not finish in ${MAKE_TIMEOUT_MS / 1000} s` }
      return { name, ok: done.exitCode === 0, detail: `exit ${done.exitCode}: ${tail(done.stdout.trim())}` }
    } catch (error) {
      if (error instanceof CannotExecute) return { name, ok: false, detail: error.message }
      throw error
    }
  }

  private async probe({ name, http, expect }: ProofInput['probes'][number]): Promise<HoldCheck> {
    try {
      // A redirect is an answer, and the manifest says which one it wants.
      const response = await fetch(http, { redirect: 'manual', signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) })
      await response.body?.cancel()
      return { name, ok: response.status === expect, detail: `HTTP ${response.status}, expected ${expect}` }
    } catch (error) {
      return { name, ok: false, detail: error instanceof Error ? error.message : String(error) }
    }
  }
}

export interface HoldDeps {
  sql: SQL
  clock: Clock
  proof: Proof
  offTick: OffTick
}

/**
 * The check after the hold, off the tick (`make verify` can take minutes): `verified` when every check passes, else a `regression`
 * naming its hold, which goes back to the same lead. Both are keyed by the hold, and a check whose answer is filed already, or whose hold
 * is over, runs nothing: a crash anywhere replays to one answer.
 */
async function verifyHold({ sql, clock, proof }: HoldDeps, effect: Effect): Promise<void> {
  const issueId = effect.issueId
  const hold = Number(effect.payload?.hold)
  const current = async () => {
    const [row]: { state: string; hold: number; repo: string }[] =
      await sql`SELECT state, hold, repo FROM factory.issues WHERE id = ${issueId}`
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
  const checks = await proof.run({
    repo: issue.repo,
    makeVerify: targets?.verify === true,
    probes: manifest.deploy.probes,
  })
  // A check takes minutes: a stop or a regression may have ended the hold since.
  if (!(await current())) return
  const green = checks.every((check) => check.ok)
  await enqueue(sql, {
    issueId,
    key: green ? greenKey : redKey,
    kind: green ? 'verified' : 'regression',
    at: clock.now(),
    payload: { hold, checks },
  })
}

export function holdPorts(deps: HoldDeps): Pick<EffectPorts, 'verify'> {
  return { verify: (effect) => deps.offTick.run(effect.key, () => verifyHold(deps, effect)) }
}
