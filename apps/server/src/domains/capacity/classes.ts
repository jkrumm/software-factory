import { type WorktreeRef, worktreeOwners } from './leadcost.ts'

/** Who a process works for (`migrations/1022_host_classes.sql`). */
export const PROCESS_CLASSES = ['lead', 'step', 'tenant', 'factory', 'system', 'owner', 'other'] as const
export type ProcessClass = (typeof PROCESS_CLASSES)[number]

/** One process of the minute's `top`, with what `ps`, `lsof` and `launchctl` said about it. */
export interface SnapshotProc {
  pid: number
  ppid: number
  /** top's MEM: the physical footprint */
  footprintKib: number
  /** the CPU time it has used since it started; null when top did not say */
  cpuMs: number | null
  /** the program's name (no arguments) */
  name: string
  /** the owning user; null when ps did not list the process */
  user: string | null
  /** the executable's path as the command line starts (a bundle path with its spaces); null when unknown */
  exe: string | null
  /** the launchd label of a job launchd started (in the user's domain); null otherwise */
  label: string | null
  /** `FACTORY_SESSION` of the process's environment (`lead-<issue>-<attempt>`) */
  session: string | null
  /** set on a `factory slot run` holder: its `--name` */
  slot: string | null
  /** `FACTORY_SLOT_ACTIVE=1` in its environment: it runs inside a held slot */
  slotActive: boolean
  /** the Lima (Colima) instance its command line or open files name */
  vm: string | null
  /** the working directory; null when lsof did not say */
  cwd: string | null
}

export interface ClassedProc {
  pid: number
  ppid: number
  name: string
  footprintKib: number
  /** the CPU time used since the last snapshot; null when there was none */
  cpuMs: number | null
  class: ProcessClass
  repo: string | null
  tenant: string | null
  issue: number | null
  step: string | null
}

export interface ClassInput {
  procs: readonly SnapshotProc[]
  /** the attempts' worktrees, live or recently ended */
  worktrees: readonly WorktreeRef[]
  /** the server's own pid: its launchd job is the factory */
  selfPid: number
  /** directories whose processes, and their jobs, are the factory's (its release) */
  factoryDirs: readonly string[]
  /** the CPU each pid used since the last snapshot */
  cpuSince: ReadonlyMap<number, number | null>
}

const SESSION = /^lead-(\d+)-(\d+)$/
const SYSTEM_PATH = /^\/(System|usr\/libexec|usr\/sbin|usr\/bin|sbin|bin)\//
const APP_BUNDLE = /^\/(?!System\/).*?\.app\/Contents\//
const LEAD_PREFIX = /^factory-\d+-\d+ /

const inside = (cwd: string, dir: string): boolean => cwd === dir || cwd.startsWith(`${dir.replace(/\/+$/, '')}/`)

/** A slot run's name as the step costs read it: a lead's `factory-<issue>-<attempt> ` prefix is dropped. */
export const stepName = (slot: string): string => slot.replace(LEAD_PREFIX, '')

const isSystemUser = (user: string | null): boolean => user === 'root' || (user?.startsWith('_') ?? false)

/**
 * Gives every process of a snapshot its class, first rule that holds:
 *
 * 1. `step`: a `factory slot run` holder, everything under it, and any process with `FACTORY_SLOT_ACTIVE=1`; its repo and
 *    Issue are the lead's it runs under.
 * 2. `lead`: the tree of an attempt's worktree (`worktreeOwners`, the lead cost's rule), or a process whose
 *    `FACTORY_SESSION` names an attempt (a browser reparented to launchd), with everything under it.
 * 3. `factory`: the launchd job the server runs in, and every job with a process working in the factory's directories.
 * 4. By the launchd job (the ancestor launchd started): a Lima VM, its helpers and anything naming its instance are the
 *    tenant `vm:<instance>`; pid 0 and 1, root and `_` users, and jobs whose program is under `/System`, `/usr`, `/bin`
 *    or `/sbin` or labelled `com.apple.` are `system`; an application (labelled `application.`, or an unlabelled app
 *    bundle outside `/System`: Chrome, Obsidian, the owner's terminals in Herdr) is the `owner`'s; any other labelled job
 *    (a LaunchAgent) is the tenant of its label.
 * 5. `other`: what is left (an orphan with no label).
 */
export function assignClasses(input: ClassInput): ClassedProc[] {
  const byPid = new Map(input.procs.map((proc) => [proc.pid, proc]))
  const children = new Map<number, number[]>()
  for (const proc of input.procs) {
    if (proc.pid !== proc.ppid) children.set(proc.ppid, [...(children.get(proc.ppid) ?? []), proc.pid])
  }
  const descendants = (roots: Iterable<number>): Set<number> => {
    const seen = new Set<number>()
    const stack = [...roots]
    while (stack.length > 0) {
      const pid = stack.pop() as number
      if (seen.has(pid)) continue
      seen.add(pid)
      stack.push(...(children.get(pid) ?? []))
    }
    return seen
  }
  /** the launchd job a process belongs to: its last ancestor below pid 1 (itself when launchd is its parent or unknown) */
  const jobOf = (pid: number): number => {
    let current = pid
    for (let hops = 0; hops < 256; hops += 1) {
      const proc = byPid.get(current)
      if (!proc || proc.ppid <= 1 || !byPid.has(proc.ppid)) return current
      current = proc.ppid
    }
    return current
  }

  // leads: the worktree trees, then the session roots
  const owners = worktreeOwners(input.procs, input.worktrees)
  const attempts = new Map(input.worktrees.map((w, index) => [`${w.issue}-${w.attempt}`, index]))
  const sessionLead = new Map<number, { index: number | null; issue: number }>()
  for (const proc of input.procs) {
    const match = proc.session === null ? null : SESSION.exec(proc.session)
    if (!match || owners.has(proc.pid)) continue
    const index = attempts.get(`${match[1]}-${match[2]}`) ?? null
    for (const pid of descendants([proc.pid])) {
      if (!owners.has(pid) && !sessionLead.has(pid)) sessionLead.set(pid, { index, issue: Number(match[1]) })
    }
  }
  const leadOf = (pid: number): { repo: string | null; issue: number | null } | null => {
    const index = owners.get(pid)
    if (index !== undefined) {
      const worktree = input.worktrees[index]
      return worktree ? { repo: worktree.repo, issue: worktree.issue } : null
    }
    const session = sessionLead.get(pid)
    if (!session) return null
    const worktree = session.index === null ? undefined : input.worktrees[session.index]
    return { repo: worktree?.repo ?? null, issue: worktree?.issue ?? session.issue }
  }

  // steps: each holder's tree carries its name; a process inside a held slot whose holder is not seen has none
  const steps = new Map<number, string | null>()
  for (const proc of input.procs) {
    if (proc.slot === null) continue
    const name = stepName(proc.slot) || null
    for (const pid of descendants([proc.pid])) if (!steps.has(pid)) steps.set(pid, name)
  }
  for (const proc of input.procs) if (proc.slotActive && !steps.has(proc.pid)) steps.set(proc.pid, null)

  // the factory's jobs
  const factoryJobs = new Set<number>([jobOf(input.selfPid)])
  for (const proc of input.procs) {
    if (proc.cwd !== null && input.factoryDirs.some((dir) => inside(proc.cwd as string, dir))) {
      factoryJobs.add(jobOf(proc.pid))
    }
  }

  const byJob = (proc: SnapshotProc, job: SnapshotProc | undefined): Pick<ClassedProc, 'class' | 'tenant'> => {
    const vm = proc.vm ?? job?.vm ?? null
    if (vm !== null) return { class: 'tenant', tenant: `vm:${vm}` }
    if (proc.pid <= 1 || isSystemUser(proc.user)) return { class: 'system', tenant: null }
    if (!job) return { class: 'other', tenant: null }
    if (job.pid <= 1 || isSystemUser(job.user)) return { class: 'system', tenant: null }
    const label = job.label
    const app = job.exe !== null && APP_BUNDLE.test(job.exe)
    if (label?.startsWith('application.') || (app && !label)) return { class: 'owner', tenant: null }
    if (label?.startsWith('com.apple.') || (job.exe !== null && SYSTEM_PATH.test(job.exe))) {
      return { class: 'system', tenant: null }
    }
    return label ? { class: 'tenant', tenant: label } : { class: 'other', tenant: null }
  }

  return input.procs.map((proc) => {
    const base = {
      pid: proc.pid,
      ppid: proc.ppid,
      name: proc.name,
      footprintKib: proc.footprintKib,
      cpuMs: input.cpuSince.get(proc.pid) ?? null,
    }
    const lead = leadOf(proc.pid)
    if (steps.has(proc.pid)) {
      return {
        ...base,
        class: 'step',
        repo: lead?.repo ?? null,
        tenant: null,
        issue: lead?.issue ?? null,
        step: steps.get(proc.pid) ?? null,
      }
    }
    if (lead) return { ...base, class: 'lead', repo: lead.repo, tenant: null, issue: lead.issue, step: null }
    const job = jobOf(proc.pid)
    if (factoryJobs.has(job)) return { ...base, class: 'factory', repo: null, tenant: null, issue: null, step: null }
    return { ...base, ...byJob(proc, byPid.get(job)), repo: null, issue: null, step: null }
  })
}

/** One row of `host_class_samples`: a class, repo, tenant, Issue and step summed over a minute. */
export interface ClassRow {
  class: ProcessClass
  repo: string | null
  tenant: string | null
  issue: number | null
  step: string | null
  footprintMib: number
  /** null when no process of the row had a CPU figure */
  cpuMs: number | null
  procs: number
}

/** The processes with their classes summed per class, repo, tenant, Issue and step, largest first. */
export function classRows(procs: readonly ClassedProc[]): ClassRow[] {
  const rows = new Map<string, ClassRow & { kib: number }>()
  for (const proc of procs) {
    const key = JSON.stringify([proc.class, proc.repo, proc.tenant, proc.issue, proc.step])
    const row = rows.get(key) ?? {
      class: proc.class,
      repo: proc.repo,
      tenant: proc.tenant,
      issue: proc.issue,
      step: proc.step,
      footprintMib: 0,
      cpuMs: null,
      procs: 0,
      kib: 0,
    }
    row.kib += proc.footprintKib
    row.procs += 1
    if (proc.cpuMs !== null) row.cpuMs = (row.cpuMs ?? 0) + proc.cpuMs
    rows.set(key, row)
  }
  return [...rows.values()]
    .map(({ kib, ...row }) => ({ ...row, footprintMib: Math.round(kib / 1024) }))
    .sort((a, b) => b.footprintMib - a.footprintMib || b.procs - a.procs)
}

/** What the collector remembers between snapshots: each pid's CPU time and its footprints of the last ten minutes. */
export interface SnapshotMemory {
  at: number | null
  cpu: ReadonlyMap<number, number>
  sizes: ReadonlyMap<number, readonly { at: number; kib: number }[]>
}

export const emptySnapshotMemory = (): SnapshotMemory => ({ at: null, cpu: new Map(), sizes: new Map() })

/**
 * The CPU each process used since the last snapshot: the difference of its cumulative time; a pid not seen before (or
 * whose time went down: a reused pid) counts its whole time. Null for every process at the first snapshot.
 */
export function cpuSince(procs: readonly SnapshotProc[], memory: SnapshotMemory): Map<number, number | null> {
  const used = new Map<number, number | null>()
  for (const proc of procs) {
    if (memory.at === null || proc.cpuMs === null) {
      used.set(proc.pid, null)
      continue
    }
    const before = memory.cpu.get(proc.pid)
    used.set(proc.pid, before === undefined || before > proc.cpuMs ? proc.cpuMs : proc.cpuMs - before)
  }
  return used
}

export const NOTABLE_TOP = 15
const LARGE_KIB = 1024 * 1024
const GROWTH_KIB = 200 * 1024
const GROWTH_WINDOW_MS = 10 * 60_000

export interface NotableProc extends ClassedProc {
  why: 'top' | 'large' | 'growth'
  /** growth over the last ten minutes, MiB; null unless `why` is growth */
  grownMib: number | null
}

/** The processes worth keeping by name: the 15 largest, any over 1 GiB, any grown by 200 MiB within ten minutes. */
export function notableProcs(procs: readonly ClassedProc[], memory: SnapshotMemory, at: number): NotableProc[] {
  const largest = new Set(
    [...procs]
      .sort((a, b) => b.footprintKib - a.footprintKib || a.pid - b.pid)
      .slice(0, NOTABLE_TOP)
      .map((proc) => proc.pid),
  )
  const notable: NotableProc[] = []
  for (const proc of procs) {
    const earliest = (memory.sizes.get(proc.pid) ?? []).find((size) => at - size.at <= GROWTH_WINDOW_MS)
    const grown = earliest === undefined ? 0 : proc.footprintKib - earliest.kib
    if (grown >= GROWTH_KIB) notable.push({ ...proc, why: 'growth', grownMib: Math.round(grown / 1024) })
    else if (proc.footprintKib >= LARGE_KIB) notable.push({ ...proc, why: 'large', grownMib: null })
    else if (largest.has(proc.pid)) notable.push({ ...proc, why: 'top', grownMib: null })
  }
  return notable.sort((a, b) => b.footprintKib - a.footprintKib || a.pid - b.pid)
}

/** The memory after a snapshot: every pid's CPU time and its footprints within the growth window. */
export function remember(procs: readonly SnapshotProc[], memory: SnapshotMemory, at: number): SnapshotMemory {
  const cpu = new Map<number, number>()
  const sizes = new Map<number, { at: number; kib: number }[]>()
  for (const proc of procs) {
    if (proc.cpuMs !== null) cpu.set(proc.pid, proc.cpuMs)
    const before = (memory.sizes.get(proc.pid) ?? []).filter((size) => at - size.at < GROWTH_WINDOW_MS)
    // a pid whose CPU time went down is a new process: its old sizes are someone else's
    const reused = proc.cpuMs !== null && (memory.cpu.get(proc.pid) ?? 0) > proc.cpuMs
    sizes.set(proc.pid, [...(reused ? [] : before), { at, kib: proc.footprintKib }])
  }
  return { at, cpu, sizes }
}
