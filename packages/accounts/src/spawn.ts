// Process adapters: a spawn with a deadline that really returns, and a detached, unwaited one that logs to the keepalive log.
import { spawnSync } from 'node:child_process'
import { closeSync, mkdirSync, openSync } from 'node:fs'
import { dirname } from 'node:path'
import { keepaliveLogPath } from './paths.ts'
import type { SpawnResult, Spawner } from './ports.ts'

/**
 * `spawnSync` with a deadline that actually returns. Node's `timeout` kills only the direct child; a helper it
 * spawned (claude's, ssh's mux master) keeps the capture pipe open, so `spawnSync` waits for it, unbounded: the
 * keepalive's 2026-11-12 09:58 run sat 900 s on one such call until jobrun killed it. Here the command runs in its
 * own process group under a perl alarm that KILLs the whole group, so the pipes close with it. Exit 124 = deadline,
 * 127 = the command did not start; both come back as `error` like a plain spawnSync would report them.
 * perl because macOS ships no timeout(1) (same wrapper as claude_bounded in scripts/lib/claude-auth-check.sh).
 */
const BOUND_PERL = `my $s = shift; my $pid = fork; defined $pid or exit 125;
if (!$pid) { setpgrp(0, 0); exec { $ARGV[0] } @ARGV or exit 127 }
$SIG{ALRM} = sub { kill "KILL", -$pid; waitpid $pid, 0; exit 124 };
alarm $s; waitpid $pid, 0;
exit($? & 127 ? 128 + ($? & 127) : $? >> 8);`
export function boundedSpawnSync(
  cmd: string,
  args: string[],
  o: { env?: Record<string, string | undefined>; timeoutMs: number },
): SpawnResult {
  const secs = Math.max(1, Math.ceil(o.timeoutMs / 1000))
  const r = spawnSync('/usr/bin/perl', ['-e', BOUND_PERL, String(secs), cmd, ...args], {
    env: o.env,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: o.timeoutMs + 5_000,
    killSignal: 'SIGKILL',
  })
  const out = { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' }
  if (r.error) return { ...out, error: { code: (r.error as Error & { code?: string }).code, message: r.error.message } } // the wrapper itself failed or overran
  if (r.status === 124)
    return {
      ...out,
      status: null,
      error: { code: 'ETIMEDOUT', message: `${cmd} timed out after ${secs}s (process group killed)` },
    }
  if (r.status === 127 && !out.stdout)
    return { ...out, status: null, error: { code: 'ENOENT', message: `spawn ${cmd} failed to start` } }
  return out
}

export const spawner: Spawner = (cmd, args, { env, timeoutMs }) => boundedSpawnSync(cmd, args, { env, timeoutMs })

/** Run a command detached and unwaited; its stdout/stderr append to the keepalive log (a failure there used to vanish). */
export function spawnDetached(cmd: string[]): void {
  let fd: number | null = null
  try {
    mkdirSync(dirname(keepaliveLogPath()), { recursive: true })
    fd = openSync(keepaliveLogPath(), 'a')
  } catch {
    // an unwritable log must not stop the child: fall back to discarding its output
  }
  try {
    const out = fd ?? 'ignore'
    Bun.spawn(cmd, { stdio: ['ignore', out, out], detached: true }).unref()
  } finally {
    if (fd !== null) closeSync(fd)
  }
}
