import { afterAll, beforeAll, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const LIB = join(import.meta.dir, '..', 'cutover', 'core-stop.sh')

let dir = ''
let bin = ''
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'core-stop-'))
  bin = join(dir, 'bin')
  await mkdir(bin)
})
afterAll(async () => {
  await rm(dir, { recursive: true, force: true })
})

async function run(script: string): Promise<{ code: number; out: string }> {
  const proc = Bun.spawn(['bash', '-c', `source ${LIB}; ${script}`], {
    env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ''}` },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [out, err, code] = await Promise.all([proc.stdout.text(), proc.stderr.text(), proc.exited])
  return { code, out: `${out}${err}`.trim() }
}

/** A `launchctl` that prints a job with the given pid, and logs bootout / kickstart. */
const fakeLaunchctl = (pid: number | null) =>
  writeFile(
    join(bin, 'launchctl'),
    `#!/bin/bash
echo "$*" >> ${dir}/launchctl.log
case "$1" in
  print) ${pid === null ? 'exit 113' : `printf '\\tstate = running\\n\\tpid = ${pid}\\n'`} ;;
esac
`,
    { mode: 0o755 },
  )

test('reap kills, by PID, a process that outlives its grace, and says so', async () => {
  // ignores SIGTERM, like the stuck server did
  const result = await run(`
    bash -c 'trap "" TERM; while :; do sleep 1; done' >/dev/null 2>&1 & stuck=$!
    sleep 0.3
    reap 1 $stuck
    wait $stuck 2>/dev/null
    kill -0 $stuck 2>/dev/null && echo "STILL ALIVE" || echo "gone"`)
  expect(result.out).toContain('is still alive after 1s')
  expect(result.out).toContain('ignored SIGTERM: kill -9')
  expect(result.out).toEndWith('gone')
}, 15_000)

test('reap leaves alone a process that ends within the grace, and kills nothing it was not given', async () => {
  const result = await run(`
    sleep 600 >/dev/null 2>&1 & bystander=$!
    sleep 0.2 >/dev/null 2>&1 & quick=$!
    reap 5 $quick
    kill -0 $bystander 2>/dev/null && echo "bystander alive"; kill $bystander`)
  expect(result.out).toContain('ended on its own')
  expect(result.out).not.toContain('kill ')
  expect(result.out).toContain('bystander alive')
}, 15_000)

test('core_pids reads the job and its children from launchctl print; an unloaded job has none', async () => {
  await fakeLaunchctl(null)
  expect((await run('echo "[$(core_pids)]"')).out).toBe('[]')
  const job = Bun.spawn(['bash', '-c', 'sleep 600 & wait'], { stdout: 'ignore', stderr: 'ignore' })
  await Bun.sleep(400)
  await fakeLaunchctl(job.pid)
  const pids = (await run('core_pids')).out.split('\n')
  expect(pids[0]).toBe(String(job.pid))
  expect(pids.length).toBeGreaterThanOrEqual(2)
  for (const pid of pids.slice(1)) process.kill(Number(pid))
  job.kill()
})

test('core_stop boots the job out, then kills by PID only a process that survived', async () => {
  const parent = Bun.spawn(['bash', '-c', 'trap "" TERM; while :; do sleep 1; done'], {
    stdout: 'ignore',
    stderr: 'ignore',
  })
  await Bun.sleep(300)
  await fakeLaunchctl(parent.pid)
  const result = await run('core_stop 1')
  expect(result.out).toContain(`PIDs before the stop: ${parent.pid}`)
  expect(result.out).toContain(`PID ${parent.pid} is still alive after 1s`)
  await parent.exited
  expect(parent.killed || parent.exitCode !== null || parent.signalCode !== null).toBe(true)
  const log = await Bun.file(join(dir, 'launchctl.log')).text()
  expect(log).toContain('bootout gui/')
})

test('run as a script under bash, the functions work and a stranger name is refused', async () => {
  const parent = Bun.spawn(['bash', '-c', 'trap "" TERM; while :; do sleep 1; done'], {
    stdout: 'ignore',
    stderr: 'ignore',
  })
  await Bun.sleep(300)
  await fakeLaunchctl(parent.pid)
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH ?? ''}` }
  const stop = Bun.spawn(['bash', LIB, 'core_stop', '1'], { env, stdout: 'pipe', stderr: 'pipe' })
  const out = await new Response(stop.stdout).text()
  expect(out).toContain(`PIDs before the stop: ${parent.pid}`)
  expect(out).toContain(`PID ${parent.pid} is still alive after 1s`)
  await parent.exited
  const stranger = Bun.spawn(['bash', LIB, 'rm', '-rf'], { env, stdout: 'pipe', stderr: 'pipe' })
  expect(await stranger.exited).toBe(2)
}, 20_000)

test('core_restart kickstarts and then reaps the old PIDs', async () => {
  const parent = Bun.spawn(['bash', '-c', 'trap "" TERM; while :; do sleep 1; done'], {
    stdout: 'ignore',
    stderr: 'ignore',
  })
  await Bun.sleep(300)
  await fakeLaunchctl(parent.pid)
  const result = await run('core_restart 1')
  expect(result.out).toContain(`PID ${parent.pid} is still alive`)
  await parent.exited
  expect(await Bun.file(join(dir, 'launchctl.log')).text()).toContain('kickstart -k gui/')
})
