import { statfs } from 'node:fs/promises'
import { basename } from 'node:path'
import type { SnapshotProc } from '../../domains/capacity/classes.ts'
import type { HostSnapshotReader } from '../../domains/capacity/ports.ts'
import type { TextRunner } from './process.ts'
import type { TopSnapshot } from './top.ts'

/** What `ps -Eww -Ao pid=,ppid=,user=,command=` says of a process; the command line itself is dropped here. */
export interface CommandFacts {
  ppid: number
  user: string
  exe: string
  name: string
  session: string | null
  slot: string | null
  slotActive: boolean
  vm: string | null
}

const PS_LINE = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(\S.*?)\s*$/
const SESSION = /(?:^|\s)FACTORY_SESSION=(lead-\d+-\d+)(?:\s|$)/
const SLOT_ACTIVE = /(?:^|\s)FACTORY_SLOT_ACTIVE=1(?:\s|$)/
// the program itself, run as `factory slot run ...` or `bun <path>/factory slot run ...`: never a shell or a prompt quoting it
const SLOT_HOLDER = /^(?:\S*bun\s+)?(?:\S*\/)?factory slot run(?:\s+--name\s+(.+?))?\s+--\s/
// a bundle's executable keeps its spaces (`Google Chrome Helper (Renderer)`) up to the first option or, with no option,
// the first word of the environment `-E` appends (`NAME=value`)
const BUNDLE_EXE = /^(\/.*?\.app\/Contents\/MacOS\/[^/]+?)(?=\s+-|\s+[A-Za-z_][A-Za-z0-9_]*=|\s*$)/
const LIMA = /\/_lima\/(?!_)([^/\s]+)\//
const LIMA_NETWORK = /\/_lima\/_networks\//

/** The Lima instance a command line or an open file names (`.../_lima/<instance>/...`); the shared network is `network`. */
export function limaInstance(text: string): string | null {
  const match = LIMA.exec(text)
  if (match?.[1]) return match[1]
  return LIMA_NETWORK.test(text) ? 'network' : null
}

/** The executable a command line starts with: a bundle path with its spaces, else the first word. */
export function exeOf(command: string): string {
  return BUNDLE_EXE.exec(command)?.[1] ?? command.split(/\s+/)[0] ?? ''
}

/**
 * The rows of `ps -Eww -Ao pid=,ppid=,user=,command=` (macOS `-E` appends the environment of the user's own processes):
 * per pid the user, the executable and its name, `FACTORY_SESSION`, whether it holds or runs in a test slot (and the
 * slot's name), and the Lima instance it names. A line that does not parse is skipped.
 */
export function parseCommandPs(output: string): Map<number, CommandFacts> {
  const facts = new Map<number, CommandFacts>()
  for (const line of output.split('\n')) {
    const match = PS_LINE.exec(line)
    if (!match) continue
    const command = match[4] ?? ''
    const exe = exeOf(command)
    const holder = SLOT_HOLDER.exec(command)
    facts.set(Number(match[1]), {
      ppid: Number(match[2]),
      user: match[3] ?? '',
      exe,
      name: basename(exe) || '?',
      session: SESSION.exec(command)?.[1] ?? null,
      slot: holder ? (holder[1]?.trim() ?? '') : null,
      slotActive: SLOT_ACTIVE.test(command),
      vm: limaInstance(command),
    })
  }
  return facts
}

/** `launchctl list`: the label of every job launchd runs with a pid (`PID Status Label`). */
export function parseLaunchctl(output: string): Map<number, string> {
  const labels = new Map<number, string>()
  for (const line of output.split('\n')) {
    const match = /^\s*(\d+)\s+\S+\s+(\S+)\s*$/.exec(line)
    if (match?.[2]) labels.set(Number(match[1]), match[2])
  }
  return labels
}

/** `lsof -nP -p <pids> -Fpn`: the Lima instance whose files each process holds open (a VM's disk). */
export function parseLsofInstances(output: string): Map<number, string> {
  const instances = new Map<number, string>()
  let pid: number | null = null
  for (const line of output.split('\n')) {
    if (line.startsWith('p')) pid = Number(line.slice(1)) || null
    else if (line.startsWith('n') && pid !== null && !instances.has(pid)) {
      const instance = limaInstance(line.slice(1))
      if (instance !== null) instances.set(pid, instance)
    }
  }
  return instances
}

/** The program name of a Virtualization.framework VM process: Lima's `vz` VMs run in one each. */
export const VM_PROCESS = 'com.apple.Virtualization.VirtualMachine'

/**
 * The minute's processes as the class rules take them: `top`'s rows (the footprint and CPU of every process it listed),
 * joined with the command facts, the launchd labels and the working directories. A process top listed and ps did not
 * keeps top's parent and no user.
 */
export function joinSnapshot(input: {
  top: TopSnapshot
  commands: ReadonlyMap<number, CommandFacts>
  labels: ReadonlyMap<number, string>
  cwds: ReadonlyMap<number, string>
  vms: ReadonlyMap<number, string>
}): SnapshotProc[] {
  const procs: SnapshotProc[] = []
  for (const [pid, row] of input.top.rows) {
    const facts = input.commands.get(pid)
    procs.push({
      pid,
      ppid: facts?.ppid ?? row.ppid ?? 0,
      footprintKib: row.kib,
      cpuMs: row.cpuMs,
      name: facts?.name ?? (pid === 0 ? 'kernel_task' : '?'),
      user: facts?.user ?? null,
      exe: facts?.exe ?? null,
      label: input.labels.get(pid) ?? null,
      session: facts?.session ?? null,
      slot: facts?.slot ?? null,
      slotActive: facts?.slotActive ?? false,
      vm: input.vms.get(pid) ?? facts?.vm ?? null,
      cwd: input.cwds.get(pid) ?? null,
    })
  }
  return procs
}

export interface HostSnapshotOptions {
  /** the minute's `top`, cached with the lead costs' (`hostWatch.topSnapshot`) */
  top: () => Promise<TopSnapshot | null>
  /** the minute's directories, shared with the lead costs (`sharedCwds`) */
  cwds: () => Promise<Map<number, string> | null>
  runner: TextRunner
  psBin: string
  launchctlBin: string
  lsofBin: string
  sysctlBin: string
  /** a path on the volume whose free space is a host signal (the swap volume) */
  vmVolume: string
}

/**
 * The class snapshot's reading: `top` (required: without it there is no snapshot), then, each optional, the command
 * facts of one `ps -Eww`, the launchd labels, the directories, the Lima instance of each VM process (one `lsof` on those
 * pids), the memory pressure level and the compressor's memory (`sysctl`), and the swap volume's free space. The CPU the
 * helpers took (through the shared runner, since the last reading) is the collector's cost.
 */
export function hostSnapshot(options: HostSnapshotOptions): HostSnapshotReader {
  const run = (cmd: string[], partial = false) => options.runner.run(cmd, { partial })
  return {
    async read() {
      // all asked at once: the shared top and lsof of the pass are joined, not repeated
      const [top, psText, launchctlText, cwds, sysctlText, vmFreeGib] = await Promise.all([
        options.top(),
        run([options.psBin, '-Eww', '-Ao', 'pid=,ppid=,user=,command=']),
        run([options.launchctlBin, 'list']),
        options.cwds().catch(() => null),
        run([options.sysctlBin, '-n', 'kern.memorystatus_vm_pressure_level', 'vm.compressor_bytes_used']),
        freeGib(options.vmVolume),
      ])
      if (top === null) {
        options.runner.takeCpuMs()
        return null
      }
      // without the command facts, the labels or the directories the class rules would put whole trees in the wrong
      // class: the minute keeps its signals and stores no classes
      const complete = psText !== null && launchctlText !== null && cwds !== null
      const commands = psText === null ? new Map<number, CommandFacts>() : parseCommandPs(psText)
      const vmPids = [...commands].filter(([, facts]) => facts.name === VM_PROCESS).map(([pid]) => pid)
      const lsofText =
        !complete || vmPids.length === 0
          ? null
          : await run([options.lsofBin, '-nP', '-p', vmPids.join(','), '-Fpn'], true)
      const [pressure, compressor] = (sysctlText ?? '').trim().split('\n').map(Number)
      return {
        procs: complete
          ? joinSnapshot({
              top,
              commands,
              labels: parseLaunchctl(launchctlText),
              cwds,
              vms: lsofText === null ? new Map() : parseLsofInstances(lsofText),
            })
          : null,
        processes: top.processes,
        cpuIdlePct: top.cpuIdlePct,
        pressureLevel: pressure !== undefined && [1, 2, 4].includes(pressure) ? pressure : null,
        compressorMib:
          compressor !== undefined && Number.isFinite(compressor) && compressor >= 0
            ? Math.round(compressor / 1024 ** 2)
            : null,
        vmFreeGib,
        collectorCpuMs: options.runner.takeCpuMs(),
      }
    },
  }
}

/** Free space of the volume holding `path`, GiB with one decimal; null when it cannot be read. */
export async function freeGib(path: string): Promise<number | null> {
  try {
    const stats = await statfs(path)
    return Math.round(((stats.bavail * stats.bsize) / 1024 ** 3) * 10) / 10
  } catch {
    return null
  }
}
