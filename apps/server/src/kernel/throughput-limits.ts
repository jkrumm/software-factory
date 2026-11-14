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
 * of one cluster read 1.7 to 2.1 GiB, 2026-11-14). Growth of such a process is not a leak, and neither growth rule reads it.
 */
export const SHARED_MEMORY_PROGRAMS: ReadonlySet<string> = new Set(['postgres'])
/** The runs of a day a budget is judged on: fewer than this many is too few to say. */
export const MIN_FAST_RUNS = 3
export const MIN_FAIL_RUNS = 5
/** The project the queue's wait is filed on (the queue is the factory's), and a process of no repo. */
export const QUEUE_PROJECT = 'software-factory'
