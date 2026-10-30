import type { Clock } from "./clock.ts";
import { HerdrTabOutput } from "./schemas.ts";

export interface StartInput {
  key: string;
  repo: string;
  prompt: string;
}

export interface StartResult {
  session: string;
  /** adapter invocations this start took, retries included */
  attempts: number;
}

/** Starts one agent session. Implementations must be idempotent per `key`. */
export interface Runner {
  start(input: StartInput): Promise<StartResult>;
}

/** The runner gave up: `permanent` for a refusal that retrying cannot fix, otherwise retries ran out. */
export class RunnerError extends Error {
  constructor(
    message: string,
    readonly permanent: boolean,
    readonly attempts: number,
  ) {
    super(message);
    this.name = "RunnerError";
  }
}

export const EXIT_PERMANENT = 2;
export const EXIT_NAME_EXISTS = 3;

export interface RetryPolicy {
  retries: number;
  baseMs: number;
  capMs: number;
}

export const DEFAULT_RETRY: RetryPolicy = { retries: 5, baseMs: 500, capMs: 8_000 };

/** Capped exponential backoff before retry number `retry` (1-based): base, 2*base, 4*base, ... up to cap. */
export const backoffMs = (policy: RetryPolicy, retry: number): number =>
  Math.min(policy.capMs, policy.baseMs * 2 ** (retry - 1));

interface ProcessResult {
  exitCode: number;
  stdout: string;
}

export interface HerdrRunnerOptions {
  /** the command to run, normally `HERDR_BIN` */
  bin: string;
  clock: Clock;
  retry?: RetryPolicy;
}

/**
 * Starts a herdr tab named after the spawn key. Non-zero exits are retried with backoff, except exit 2
 * (permanent) and exit 3 (the name exists, so an earlier attempt already started it: success).
 */
export class HerdrRunner implements Runner {
  private readonly retry: RetryPolicy;

  constructor(private readonly options: HerdrRunnerOptions) {
    this.retry = options.retry ?? DEFAULT_RETRY;
  }

  async start(input: StartInput): Promise<StartResult> {
    for (let attempt = 1; ; attempt++) {
      const result = await this.run(input, attempt);

      if (result.exitCode === 0) return { session: this.session(result.stdout, undefined, attempt), attempts: attempt };
      if (result.exitCode === EXIT_NAME_EXISTS) {
        return { session: this.session(result.stdout, input.key, attempt), attempts: attempt };
      }
      if (result.exitCode === EXIT_PERMANENT) {
        throw new RunnerError(`herdr refused ${input.key} (exit ${EXIT_PERMANENT})`, true, attempt);
      }
      if (attempt > this.retry.retries) {
        throw new RunnerError(`herdr exit ${result.exitCode} for ${input.key} after ${attempt} attempts`, false, attempt);
      }
      await this.options.clock.sleep(backoffMs(this.retry, attempt));
    }
  }

  private async run(input: StartInput, attempt: number): Promise<ProcessResult> {
    try {
      const proc = Bun.spawn([this.options.bin, "tab", "create", "--name", input.key, "--cwd", input.repo], {
        stdout: "pipe",
        stderr: "ignore",
      });
      const [stdout, exitCode] = await Promise.all([proc.stdout.text(), proc.exited]);
      return { exitCode, stdout };
    } catch (cause) {
      throw new RunnerError(`cannot execute ${this.options.bin}: ${String(cause)}`, true, attempt);
    }
  }

  /** The pane from stdout; `fallback` stands in when the name already existed and stdout carries none. */
  private session(stdout: string, fallback: string | undefined, attempts: number): string {
    try {
      return HerdrTabOutput.parse(JSON.parse(stdout)).pane;
    } catch {
      if (fallback !== undefined) return fallback;
      throw new RunnerError(`herdr printed no pane: ${stdout.slice(0, 200)}`, true, attempts);
    }
  }
}
