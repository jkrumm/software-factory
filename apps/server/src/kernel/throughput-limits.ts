/** The figures the throughput loop's reads and rules share (`domains/loops/throughput.ts`, `read/throughput-loop.ts`). */

/** The days before a ranking window a project's slot-minutes per closed Issue are compared with. */
export const BASELINE_DAYS = 14
/** A step whose 90th percentile peak is over this many MiB is over budget when the project sets none. */
export const DEFAULT_PEAK_MIB = 2048
/** A process that grew by this much between its first and last notable minute grew without bound. */
export const PROCESS_GROWTH_MIB = 1024
/**
 * Programs whose footprint is mostly shared memory they map, so it rises to a fixed bound and stays: a database server's
 * processes each count the `shared_buffers` pages they touched (2 GiB on the mini: the io workers, checkpointer and writer
 * of one cluster read 1.7 to 2.1 GiB, 2026-11-14). Growth of such a process is not a leak, and neither growth rule reads it;
 * the class rows count a cluster's mapping once (`classRows`).
 */
const SHARED_MEMORY_PROGRAMS: ReadonlySet<string> = new Set(['postgres'])
/** Whether a process name is one of those programs; a child that sets its process title (`postgres: io worker 0`) is named `postgres:`. */
export const isSharedMemoryProgram = (name: string): boolean => SHARED_MEMORY_PROGRAMS.has(name.replace(/:$/, ''))
/**
 * The macOS kernel's own process (pid 0). Its footprint is the kernel's wired and compressed memory, which rises and
 * falls with the host's memory pressure (2.8 to 8.8 GiB within 46 minutes, 2026-11-16): a symptom, not a leak, and nothing
 * a lead can shrink. `swap_growth` and the pressure level read the pressure itself; neither growth rule reads this process.
 */
export const isKernelTask = (name: string): boolean => name === 'kernel_task'
/** The runs of a day a budget is judged on: fewer than this many is too few to say. */
export const MIN_FAST_RUNS = 3
export const MIN_FAIL_RUNS = 5
/** The project the queue's wait is filed on (the queue is the factory's), and a process of no repo. */
export const QUEUE_PROJECT = 'software-factory'

/** The tenant class's budget when `FACTORY_TENANT_BUDGET_MIB` is not set: what the dotfiles program aims at with its work profile up. */
export const DEFAULT_TENANT_BUDGET_MIB = 6144
/** The repo that owns the host's configuration, where a tenant finding is filed when `FACTORY_TENANT_PROJECT` is not set. */
export const DEFAULT_TENANT_PROJECT = 'dotfiles'
/** A tenant whose 24 h average footprint is this far above its own median of the 14 days before has grown. */
export const TENANT_GROWTH_MIB = 1024
/** The hours the regression rule averages a tenant over, and the buckets of that length its median is taken from. */
export const TENANT_DAY_HOURS = 24
/** A tenant's median is read only from this many buckets of sampled hours: fewer is too short a past to call growth. */
export const MIN_TENANT_BASELINE_DAYS = 7
/** The memory one test slot holds (the default step budget): the excess of a tenant is turned into slot-minutes by it. */
export const SLOT_MEMORY_MIB = DEFAULT_PEAK_MIB

/**
 * The queue waits the throughput loop ranks, by the interval kinds each counts (`domains/capacity/waits.ts`): the minutes
 * Issues waited for host memory (the host's reading, or a repo's lead not fitting the free memory), for an account (its
 * window closed, or its lead cap), for a repo's claim, for a lane's cap. A wait behind an `after` edge, a stopped line, a
 * Spec at the owner, a drain, the boot grace or the load is no cost a lead can cut and is left out.
 */
export const WAIT_SUBJECTS = {
  memory: ['memory', 'memory_fit'],
  account: ['window', 'cap'],
  claim: ['claim'],
  lane: ['lane'],
} as const
export type WaitSubject = keyof typeof WAIT_SUBJECTS
export const waitSubjectOf = (kind: string): WaitSubject | null =>
  (Object.keys(WAIT_SUBJECTS) as WaitSubject[]).find((s) => (WAIT_SUBJECTS[s] as readonly string[]).includes(kind)) ??
  null

/**
 * The hours a binding lead cap is read over (the day since the daily pass before), and the minutes of them in which it kept an
 * Issue queued with a seat idle that make a finding (NL48). A cap lifted since is no finding: the cap in force is checked.
 */
export const CAP_WINDOW_HOURS = 24
export const BINDING_MINUTES = 60

/** The queue interval kind of the memory gate's lead-fit refusal (what a repo's lead is learned to take); the host's reading is `memory`. */
export const MEMORY_FIT_KIND = 'memory_fit'

/** The interval kinds that are no cost of the factory: an `after` edge, a line stopped by an incident, a Spec at the owner. */
export const OWNED_ELSEWHERE_KINDS = ['chain', 'line', 'finalizing', 'spec', 'unknown_project'] as const
