import type { Ci, Proof, ProofInput } from '../../domains/quality/ports.ts'
import { condense } from '../../domains/quality/output.ts'
import { type Check, ciCheck, NO_VERSION_TARGET } from '../../domains/quality/watch.ts'
import { err, ok, portError, type Result } from '../../kernel/result.ts'
import { type CheckoutSync, deployedHolds, inScratchWorktree, syncCheckout } from './git.ts'
import { CannotExecute, childEnv, EXIT_STOPPED, EXIT_TIMEOUT, type Run, runProcess } from './process.ts'

const MAKE_TIMEOUT_MS = 10 * 60_000
const VERSION_TIMEOUT_MS = 30_000
const PROBE_TIMEOUT_MS = 15_000
/** What of a check's output is kept: the failing part (`condense`), and for `make version` the end of a short output. */
const MAX_DETAIL_CHARS = 1_500

const tail = (text: string): string => (text.length > MAX_DETAIL_CHARS ? `…${text.slice(-MAX_DETAIL_CHARS)}` : text)

const SHA = /^[0-9a-f]{7,64}$/
const STDERR_MARK = '\n--stderr--\n'
/**
 * make's own top-level line for a target it does not have (or no Makefile at all), read under `LC_ALL=C`: `make: *** …`,
 * never a sub-make's `make[1]: *** …`, and never with the `Error` line a recipe that failed is followed by.
 */
const NO_VERSION_RULE =
  /^make: \*\*\* (?:No rule to make target\s+[`'‘"]version['’"]|No targets specified and no makefile found)/im
const RECIPE_FAILED = /^make: \*\*\* \[.*\] Error/m
/**
 * stdout is what `make version` prints and nothing else; stderr is caught by the shell through the pipe and shown, with
 * a marker, only when it failed. Started as a top-level make whatever started this server: an inherited MAKELEVEL
 * prefixes its lines `make[n]:`, and MAKEFLAGS could carry `-n`.
 */
const VERSION_SCRIPT = `unset MAKELEVEL MAKEFLAGS MFLAGS MAKEOVERRIDES MAKE_TERMOUT MAKE_TERMERR\nexec 3>&1
err=$(make --no-print-directory -s -C "$1" version 2>&1 1>&3 3>&-)
st=$?
if [ "$st" -ne 0 ]; then printf '%s' '${STDERR_MARK}'; printf '%s' "$err" | tail -c ${MAX_DETAIL_CHARS}; fi
exit "$st"`

/**
 * Verify: `make version` (the deployed commit, which must hold where the work landed), `make verify` in the repo, and an
 * HTTP GET per probe. Every check runs, the version check red or not, so the lead sees every signal. The only write to
 * the checkout is the first step: `syncCheckout` fast-forwards it to `origin/<default>` so that `make` reads what was
 * merged. A checkout it may not move (another branch, a tracked change, diverged) is the owner's and stays as it is:
 * `make version` and `make verify` then run in a throwaway worktree of `origin/<default>`, and only when that cannot
 * be made is the checkout a `blocked` check.
 */
export class MakeAndProbes implements Proof {
  constructor(
    private readonly options: {
      run?: Run
      sync?: (repo: string, signal: AbortSignal) => Promise<CheckoutSync>
      fetch?: typeof fetch
      /** GitHub's CI, for a project that ships by pull request; without it that check is left out */
      ci?: Ci
    } = {},
  ) {}

  async run(input: ProofInput, signal: AbortSignal): Promise<Result<Check[]>> {
    const { repo, makeVerify, makeTargets = [], version, probes, ci } = input
    const sync = makeVerify || makeTargets.length > 0 || version ? await this.sync(repo, signal) : undefined
    const [ciChecks, checks] = await Promise.all([
      this.ci(repo, ci),
      Promise.all(probes.map((probe) => this.probe(probe, signal))),
    ])
    if (signal.aborted) return err(portError('gone', 'the server is stopping'))
    if (sync?.state === 'blocked') {
      // The checkout is the owner's and is never touched: the shipped commit is read in a throwaway worktree of it.
      const { ref } = sync
      const scratch = ref
        ? await inScratchWorktree(repo, ref, (tree) => this.checks(tree, repo, input, signal), {
            run: this.options.run,
            signal,
          })
        : undefined
      if (signal.aborted) return err(portError('gone', 'the server is stopping'))
      if (!scratch)
        return ok([{ name: 'checkout', ok: false, blocked: true, detail: sync.detail }, ...ciChecks, ...checks])
      const held: Check = { name: 'checkout', ok: true, detail: `${sync.detail}; read in a scratch worktree of ${ref}` }
      return ok([held, ...scratch, ...ciChecks, ...checks])
    }
    const advanced: Check[] = sync?.state === 'advanced' ? [{ name: 'checkout', ok: true, detail: sync.detail }] : []
    const here = await this.checks(repo, repo, input, signal)
    // A check the server killed on its way down says nothing about production: the next server asks again.
    if (signal.aborted) return err(portError('gone', 'the server is stopping'))
    return ok([...advanced, ...here, ...ciChecks, ...checks])
  }

  /** `make version` and `make verify` in `tree`; git questions (does the deployed commit hold where it landed) go to `repo`. */
  private async checks(
    tree: string,
    repo: string,
    { makeVerify, makeTargets = [], version }: ProofInput,
    signal: AbortSignal,
  ): Promise<Check[]> {
    const deployed = version ? [await this.version(tree, repo, version, signal)] : []
    const verify: Check[] = []
    for (const target of [...(makeVerify ? ['verify'] : []), ...makeTargets])
      verify.push(await this.makeVerify(tree, target, signal))
    return [...deployed, ...verify]
  }

  /**
   * The default branch's CI for the exact landed commit. A CI that cannot be read is no hold on the watch: it passes with
   * the reason as its detail (the ship recorded it the same way), so a missing token never stops a project's Issues.
   */
  private async ci(repo: string, input: ProofInput['ci']): Promise<Check[]> {
    if (!input || !this.options.ci) return []
    const read = await this.options.ci.ofCommit({ repo, sha: input.landedAt })
    if (!read.ok) return [{ name: 'ci', ok: true, detail: `CI was not read: ${read.error.detail}` }]
    return [
      ciCheck(read.value, {
        sha: input.landedAt,
        mergedAt: input.mergedAt ? new Date(input.mergedAt) : null,
        now: new Date(input.now),
      }),
    ]
  }

  private async sync(repo: string, signal: AbortSignal): Promise<CheckoutSync> {
    try {
      if (this.options.sync) return await this.options.sync(repo, signal)
      return await syncCheckout(repo, { run: this.options.run, signal })
    } catch (error) {
      // A git that timed out cannot say whether the tree is the shipped one: blocked, looked at again, and the probes still report.
      return { state: 'blocked', detail: `${repo}: ${error instanceof Error ? error.message : String(error)}` }
    }
  }

  private async version(
    tree: string,
    repo: string,
    version: NonNullable<ProofInput['version']>,
    signal: AbortSignal,
  ): Promise<Check> {
    const name = 'deployed version'
    const red = (detail: string): Check => ({ name, ok: false, detail })
    if ('problem' in version) return red(version.problem)
    const run = this.options.run ?? runProcess
    try {
      // Always run it: a read of the Makefile cannot see a target an include built by variable names, and only make knows it has none.
      const done = await run(['sh', '-c', VERSION_SCRIPT, 'sh', tree], VERSION_TIMEOUT_MS, {
        env: childEnv({ GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' }),
        group: true,
        signal,
      })
      if (done.exitCode === EXIT_TIMEOUT) return red(`make version did not finish in ${VERSION_TIMEOUT_MS / 1000} s`)
      if (done.exitCode === EXIT_STOPPED) return red('the server is stopping')
      if (done.exitCode !== 0) {
        const [printed = '', stderr = ''] = done.stdout.split(STDERR_MARK)
        if (NO_VERSION_RULE.test(stderr) && !RECIPE_FAILED.test(stderr)) return red(NO_VERSION_TARGET)
        const said = [
          printed.trim() && `stdout: ${tail(printed.trim())}`,
          stderr.trim() && `stderr: ${tail(stderr.trim())}`,
        ].filter(Boolean)
        return red(`make version exit ${done.exitCode}${said.length > 0 ? `: ${said.join(' / ')}` : ''}`)
      }
      const printed = done.stdout.trim()
      if (!SHA.test(printed))
        return red(`make version printed ${JSON.stringify(tail(printed))}: one line, the deployed commit sha`)
      return {
        name,
        ...(await deployedHolds(repo, printed, version.landedAt, {
          run: this.options.run,
          signal,
          deployPaths: version.deployPaths,
        })),
      }
    } catch (error) {
      // Neither make nor git failing to answer is a retry: the lead is told, with the other checks beside it.
      return red(error instanceof Error ? error.message : String(error))
    }
  }

  private async makeVerify(repo: string, target: string, signal: AbortSignal): Promise<Check> {
    const run = this.options.run ?? runProcess
    const name = `make ${target}`
    try {
      // Its own group: a kill reaches the recipes `make` started, not `make` alone.
      const done = await run(['sh', '-c', 'exec make -C "$1" "$2" 2>&1', 'sh', repo, target], MAKE_TIMEOUT_MS, {
        env: childEnv({ GIT_TERMINAL_PROMPT: '0' }),
        group: true,
        signal,
      })
      if (done.exitCode === EXIT_TIMEOUT)
        return { name, ok: false, detail: `did not finish in ${MAKE_TIMEOUT_MS / 1000} s` }
      return {
        name,
        ok: done.exitCode === 0,
        detail: `exit ${done.exitCode}: ${condense(done.stdout.trim(), MAX_DETAIL_CHARS)}`,
      }
    } catch (error) {
      if (error instanceof CannotExecute) return { name, ok: false, detail: error.message }
      throw error
    }
  }

  private async probe({ name, http, expect }: ProofInput['probes'][number], signal: AbortSignal): Promise<Check> {
    try {
      // A redirect is an answer, and the project says which one it wants.
      const response = await (this.options.fetch ?? fetch)(http, {
        redirect: 'manual',
        signal: AbortSignal.any([AbortSignal.timeout(PROBE_TIMEOUT_MS), signal]),
      })
      await response.body?.cancel()
      return { name, ok: response.status === expect, detail: `HTTP ${response.status}, expected ${expect}` }
    } catch (error) {
      return { name, ok: false, detail: error instanceof Error ? error.message : String(error) }
    }
  }
}
