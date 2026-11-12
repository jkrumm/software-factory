import { describe, expect, test } from 'bun:test'
import { join } from 'node:path'

const DEPLOY = join(import.meta.dir, '..', 'deploy.sh')

/**
 * Sources deploy.sh (which runs nothing then), replaces the launchd-facing steps with stubs and runs `restart_until_healthy`.
 * `healthyOn` is the attempt (1-based) at which the stub service answers; 0 never.
 */
async function restart(healthyOn: number, attempts: number): Promise<{ code: number; out: string; err: string }> {
  const script = `
    source "${DEPLOY}"
    n=0; stops=0
    start_service() { n=$((n + 1)); return 0; }
    wait_healthy() { (( ${healthyOn} > 0 && n >= ${healthyOn} )); }
    stop_service() { stops=$((stops + 1)); return 0; }
    tail_logs() { :; }
    restart_until_healthy /rel aaaa 5; rc=$?
    echo "starts=$n stops=$stops"
    exit $rc`
  const proc = Bun.spawn(['bash', '-c', script], {
    env: { ...process.env, RESTART_ATTEMPTS: String(attempts), RESTART_PAUSE_SECS: '0' },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  return { code, out: out.trim(), err }
}

describe('restart_until_healthy', () => {
  test('a release healthy at once is started once', async () => {
    const { code, out } = await restart(1, 3)
    expect(code).toBe(0)
    expect(out).toBe('starts=1 stops=0')
  })

  test('a start that fails once (a lock timeout) is stopped and started again', async () => {
    const { code, out, err } = await restart(2, 3)
    expect(code).toBe(0)
    expect(out).toBe('starts=2 stops=1')
    expect(err).toContain('attempt 1 of 3')
  })

  test('a release that never answers is tried RESTART_ATTEMPTS times, then fails', async () => {
    const { code, out } = await restart(0, 3)
    expect(code).toBe(1)
    expect(out).toBe('starts=3 stops=2')
  })
})

/** Sources deploy.sh, stubs `load_avg` with the given readings in turn (the last repeats) and runs `wait_calm_host`. */
async function calm(loads: number[], env: Record<string, string>): Promise<{ code: number; out: string; err: string }> {
  const script = `
    source "${DEPLOY}"
    readings=(${loads.join(' ')}); counter=$(mktemp); echo 0 > "$counter"
    load_avg() { # a subshell call: the count lives in a file
      local i; i=$(<"$counter"); echo $((i + 1)) > "$counter"
      echo "\${readings[$i]:-\${readings[\${#readings[@]}-1]}}"
    }
    sleep() { :; }
    wait_calm_host; rc=$?
    echo "reads=$(<"$counter")"
    exit $rc`
  const proc = Bun.spawn(['bash', '-c', script], { env: { ...process.env, ...env }, stdout: 'pipe', stderr: 'pipe' })
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  return { code, out: out.trim(), err }
}

describe('wait_calm_host', () => {
  const env = { LOAD_MAX: '96', LOAD_WAIT_SECS: '30', LOAD_POLL_SECS: '10' }

  test('a calm host passes at once', async () => {
    const { code, out } = await calm([20], env)
    expect(code).toBe(0)
    expect(out).toContain('reads=1')
  })

  test('a loaded host is waited for until the load falls', async () => {
    const { code, out } = await calm([250, 200, 90], env)
    expect(code).toBe(0)
    expect(out).toContain('reads=3')
  })

  test('a host that stays loaded refuses after LOAD_WAIT_SECS', async () => {
    const { code, err } = await calm([250], env)
    expect(code).toBe(1)
    expect(err).toContain('stayed above 96')
  })

  test('LOAD_MAX=0 turns the gate off', async () => {
    const { code, out } = await calm([250], { ...env, LOAD_MAX: '0' })
    expect(code).toBe(0)
    expect(out).toContain('reads=0')
  })
})
