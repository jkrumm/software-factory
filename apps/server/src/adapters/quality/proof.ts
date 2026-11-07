import type { Proof, ProofInput } from '../../domains/quality/ports.ts'
import { type Check, NO_VERSION_TARGET } from '../../domains/quality/watch.ts'
import { err, ok, portError, type Result } from '../../kernel/result.ts'
import { type CheckoutSync, deployedHolds, syncCheckout } from './git.ts'
import { CannotExecute, childEnv, EXIT_STOPPED, EXIT_TIMEOUT, type Run, runProcess } from './process.ts'

const MAKE_TIMEOUT_MS = 10 * 60_000
const VERSION_TIMEOUT_MS = 30_000
const PROBE_TIMEOUT_MS = 15_000
/** What of a check's output is kept: the end, where a failure says what failed. */
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
 * merged. A checkout it may not move (another branch, a tracked change, diverged) is a `blocked` check, and `make
 * version` and `make verify` then do not run on a stale tree.
 */
export class MakeAndProbes implements Proof {
  constructor(
    private readonly options: {
      run?: Run
      sync?: (repo: string, signal: AbortSignal) => Promise<CheckoutSync>
      fetch?: typeof fetch
    } = {},
  ) {}

  async run({ repo, makeVerify, version, probes }: ProofInput, signal: AbortSignal): Promise<Result<Check[]>> {
    const sync = makeVerify || version ? await this.sync(repo, signal) : undefined
    const checks = await Promise.all(probes.map((probe) => this.probe(probe, signal)))
    if (signal.aborted) return err(portError('gone', 'the server is stopping'))
    if (sync?.state === 'blocked')
      return ok([{ name: 'checkout', ok: false, blocked: true, detail: sync.detail }, ...checks])
    const advanced: Check[] = sync?.state === 'advanced' ? [{ name: 'checkout', ok: true, detail: sync.detail }] : []
    const deployed = version ? [await this.version(repo, version, signal)] : []
    const verify = makeVerify ? [await this.makeVerify(repo, signal)] : []
    // A check the server killed on its way down says nothing about production: the next server asks again.
    if (signal.aborted) return err(portError('gone', 'the server is stopping'))
    return ok([...advanced, ...deployed, ...verify, ...checks])
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
      const done = await run(['sh', '-c', VERSION_SCRIPT, 'sh', repo], VERSION_TIMEOUT_MS, {
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
      return { name, ...(await deployedHolds(repo, printed, version.landedAt, { run: this.options.run, signal })) }
    } catch (error) {
      // Neither make nor git failing to answer is a retry: the lead is told, with the other checks beside it.
      return red(error instanceof Error ? error.message : String(error))
    }
  }

  private async makeVerify(repo: string, signal: AbortSignal): Promise<Check> {
    const run = this.options.run ?? runProcess
    const name = 'make verify'
    try {
      // Its own group: a kill reaches the recipes `make` started, not `make` alone.
      const done = await run(['sh', '-c', 'exec make -C "$1" verify 2>&1', 'sh', repo], MAKE_TIMEOUT_MS, {
        env: childEnv({ GIT_TERMINAL_PROMPT: '0' }),
        group: true,
        signal,
      })
      if (done.exitCode === EXIT_TIMEOUT)
        return { name, ok: false, detail: `did not finish in ${MAKE_TIMEOUT_MS / 1000} s` }
      return { name, ok: done.exitCode === 0, detail: `exit ${done.exitCode}: ${tail(done.stdout.trim())}` }
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
