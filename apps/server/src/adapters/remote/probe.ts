/**
 * The VPS as the step placement sees it (issue 1793): one `ssh <target>` every 30 s at most, started by the placement's own
 * read and never awaited by it, so a slow or gone VPS never holds a `factory slot run` call. The answer is the newest
 * reading; an unreachable VPS keeps the old one, which ages past `REMOTE_READING_MAX_AGE_MS` and sends no step there.
 * The same call removes a step container whose holder is gone (a `factory slot run` killed with its ssh still up).
 */
import type { RemoteHostProbe, RemoteProbeAnswer } from '../../domains/capacity/ports.ts'
import { TRIM_EVERY_MS } from '../../domains/capacity/remote.ts'
import { helperEnv, type RunProcess, runHelper } from '../intake/process.ts'
import { trimScript } from './trim.ts'

/** How often the VPS is asked at most. */
const PROBE_EVERY_MS = 30_000
/** One probe's process timeout. */
const PROBE_TIMEOUT_MS = 15_000
/** A container younger than this may belong to a holder whose first renewal has not come yet. */
const REAP_AFTER_MS = 120_000
/** The retention pass walks a cache of 150 000 files and removes whole trees: minutes at most. */
const TRIM_TIMEOUT_MS = 300_000

/** The label every step container carries: its slot id (`factory.step`) and its start in epoch seconds (`factory.started`). */
const STEP_LABEL = 'factory.step'
const STARTED_LABEL = 'factory.started'

const SCRIPT = [
  'nproc',
  'cat /proc/loadavg',
  "grep -E '^(MemTotal|MemAvailable):' /proc/meminfo",
  'df -B1 --output=size,used "$HOME" | tail -1',
  'echo "psi-memory $(head -1 /sys/fs/cgroup/system.slice/memory.pressure 2>/dev/null)"',
  'echo "psi-io $(head -1 /sys/fs/cgroup/system.slice/io.pressure 2>/dev/null)"',
  'echo "copies $(cd "$HOME" && ls -d factory-steps/*/[0-9]* 2>/dev/null | tr \'\\n\' \' \')"',
  `docker ps --filter label=${STEP_LABEL} --format 'step {{.Label "${STEP_LABEL}"}} {{.Label "${STARTED_LABEL}"}}'`,
].join('; ')

/** The probe's output as a reading, or null when a figure is missing. */
export function parseProbe(stdout: string, at: Date): RemoteProbeAnswer | null {
  const lines = stdout.split('\n').map((line) => line.trim())
  const cores = Number(lines[0])
  const load1 = Number(lines[1]?.split(/\s+/)[0])
  const kib = (key: string): number => Number(/(\d+)/.exec(lines.find((l) => l.startsWith(`${key}:`)) ?? '')?.[1])
  const ramMib = Math.round(kib('MemTotal') / 1024)
  const availableMib = Math.round(kib('MemAvailable') / 1024)
  const disk = lines.find((l) => /^\d+\s+\d+$/.test(l))?.split(/\s+/)
  const diskSizeBytes = Number(disk?.[0])
  const diskUsedBytes = Number(disk?.[1])
  const figures = [cores, load1, ramMib, availableMib, diskSizeBytes, diskUsedBytes]
  if (figures.some((n) => !Number.isFinite(n)) || cores <= 0 || diskSizeBytes <= 0) return null
  const copies = (
    lines
      .find((l) => l.startsWith('copies'))
      ?.slice('copies'.length)
      .trim() ?? ''
  )
    .split(/\s+/)
    .filter((dir) => dir !== '')
  const steps = lines
    .filter((l) => l.startsWith('step '))
    .flatMap((l) => {
      const [, id, started] = l.split(/\s+/)
      // the id becomes a container name in a shell line: only the CLI's own form (pid, dash, uuid) is taken
      return id && /^[A-Za-z0-9-]{1,100}$/.test(id) ? [{ id, startedMs: Number(started) * 1000 || 0 }] : []
    })
  const pressure = (key: string): number | null => {
    const match = /avg10=(\d+(?:\.\d+)?)/.exec(lines.find((l) => l.startsWith(`${key} `)) ?? '')
    return match ? Number(match[1]) : null
  }
  return {
    reading: {
      at,
      cores,
      load1,
      ramMib,
      availableMib,
      diskSizeBytes,
      diskUsedBytes,
      memoryPressure: pressure('psi-memory'),
      ioPressure: pressure('psi-io'),
    },
    copies,
    steps,
  }
}

/** A probe of `target` over ssh; `live` is the slot ids that hold a VPS slot now, so a container of any other is removed. */
export function sshProbe(input: {
  target: string
  run?: RunProcess
  now?: () => Date
  log?: (line: string) => void
}): RemoteHostProbe {
  const run = input.run ?? runHelper
  const now = input.now ?? (() => new Date())
  const ssh = ['ssh', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=5', input.target]
  let answer: RemoteProbeAnswer | null = null
  let askedAt = 0
  let inFlight = false
  let trimmedAt = 0
  let trimming = false
  // the step host's retention (`trim.ts`), apart from the probe so a long walk never ages the reading past its limit; the
  // script itself does nothing while a step container runs
  const trim = async (): Promise<void> => {
    const result = await run([...ssh, trimScript({ stepLabel: STEP_LABEL })], TRIM_TIMEOUT_MS, helperEnv())
    // stdout and stderr arrive joined: the script's own lines are the ones that start with `trim:`
    const lines = result.stdout.trim().split('\n')
    const said = lines.filter((line) => line.startsWith('trim:'))
    if (result.exit !== 0) {
      input.log?.(`step host trim failed (exit ${result.exit ?? 'timeout'}): ${said.at(-1) ?? lines.at(-1) ?? ''}`)
      return
    }
    for (const line of said) if (!line.includes('removed 0 idle slot copies and 0 bun cache entries')) input.log?.(line)
  }
  const refresh = async (live: ReadonlySet<string> | null): Promise<void> => {
    const result = await run([...ssh, SCRIPT], PROBE_TIMEOUT_MS, helperEnv())
    const parsed = result.exit === 0 ? parseProbe(result.stdout, now()) : null
    if (parsed === null) {
      input.log?.(`remote probe of the VPS failed (exit ${result.exit ?? 'timeout'})`)
      return
    }
    answer = parsed
    if (!trimming && parsed.steps.length === 0 && now().getTime() - trimmedAt >= TRIM_EVERY_MS) {
      trimming = true
      trimmedAt = now().getTime()
      void trim().finally(() => {
        trimming = false
      })
    }
    // no live set read from the slots yet (the first call after a start): nothing is known to be orphaned
    if (live === null) return
    const t = now().getTime()
    const orphans = parsed.steps.filter((s) => !live.has(s.id) && t - s.startedMs > REAP_AFTER_MS)
    if (orphans.length === 0) return
    const names = orphans.map((s) => `factory-step-${s.id}`)
    input.log?.(`removing ${names.length} step container(s) whose slot is gone: ${names.join(' ')}`)
    await run([...ssh, `docker rm -f ${names.join(' ')} >/dev/null 2>&1; true`], PROBE_TIMEOUT_MS, helperEnv())
  }
  return {
    latest(live) {
      const t = now().getTime()
      if (!inFlight && t - askedAt >= PROBE_EVERY_MS) {
        inFlight = true
        askedAt = t
        void refresh(live === null ? null : new Set(live)).finally(() => {
          inFlight = false
        })
      }
      return answer
    },
  }
}
