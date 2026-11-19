import { chmod, mkdir, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

/** One account of the fake picker: the readings the host would show for it. */
export interface AccountRow {
  id: string
  /** null: the account has no 5-hour window (an Ultra seat) */
  five_hour?: number | null
  seven_day?: number
  enabled?: boolean
}

const dir = (bin: string): string => join(bin, 'host')

const SYSCTL = (host: string) => `#!/bin/sh
case "$2" in
  hw.pagesize) echo 16384;;
  vm.page_pageable_internal_count) printf '600000\n5648\n16384\n';;
  vm.compressor.swapper.swapouts_total) cat "${host}/swapouts";;
  hw.memsize) echo 34359738368;;
  kern.boottime) echo "{ sec = $(( $(date +%s) - 86400 )), usec = 0 } a day ago";;
  vm.loadavg) echo "{ $(cat "${host}/load") 0.50 0.50 }";;
  vm.swapusage) echo "total = 40960.00M  used = $(cat "${host}/swapused").00M  free = 1.00M  (encrypted)";;
esac
`

/**
 * `vm_stat`'s wired and compressor pages. With the pageable and purgeable counts of `sysctl` above, memory in use is
 * 744,352 pages of 16 KiB: about 11 GiB of 32.
 */
const VM_STAT = `#!/bin/sh
echo "Mach Virtual Memory Statistics: (page size of 16384 bytes)"
echo "Pages wired down:                             100000."
echo "Pages occupied by compressor:                  50000."
`

/** `ps -Ao pid=,ppid=,pcpu=,rss=,comm=` of a believable busy host: paths, a name with spaces, rss in KiB. */
const PS_ROWS = `    1     0   0.1    12288 /sbin/launchd
  412     1  96.4  2411520 /Applications/Google Chrome.app/Contents/MacOS/Google Chrome
  733     1  41.2  1843200 /opt/tools/bin/bun
  901     1  28.7   987136 /usr/local/bin/postgres
 1204     1  17.3  3145728 /Applications/Claude Code.app/Contents/MacOS/claude
 1318     1  12.9   524288 /opt/homebrew/bin/node
 1422     1   8.4   262144 /usr/bin/ssh
 1533     1   5.6  1572864 /Applications/Xcode.app/Contents/MacOS/Xcode
 1647     1   2.1   131072 /usr/sbin/mDNSResponder
 1750     1   0.3   819200 /System/Library/CoreServices/WindowServer
`

/**
 * The host's `ps` in three shapes: the capacity reading (`ps.txt`), the reaper's table with the environment appended
 * (`-Eww`, `ps-env.txt`; a file `ps-env.fail` makes it fail) and the age of one pid (`-o etime= -p`: a day, always older than a test's row).
 */
const PS = (host: string) => `#!/bin/sh
case "$*" in
  *-Eww*) [ -e "${host}/ps-env.fail" ] && exit 1; cat "${host}/ps-env.txt";;
  *etime=*) echo "1-00:00:00";;
  *) cat "${host}/ps.txt";;
esac
`

/** `lsof -nP -a -d cwd -Fpn`: the directories in `lsof.txt`; a file `lsof.fail` makes it fail. */
const LSOF = (host: string) => `#!/bin/sh
[ -e "${host}/lsof.fail" ] && exit 1
cat "${host}/lsof.txt"
`

/** `top -l 1 -n <count> -stats pid,ppid,mem,time`: the rows of `top.txt` under top's own header; a file `top.fail` makes it fail. */
const TOP = (host: string) => `#!/bin/sh
[ -e "${host}/top.fail" ] && exit 1
printf 'Processes: 10 total\\n\\nPID    MEM  \\n'
cat "${host}/top.txt"
`

/** `launchctl list`: no job the class rules would name, so the real host's labels never reach a scenario. */
const LAUNCHCTL = `#!/bin/sh
printf 'PID\\tStatus\\tLabel\\n'
`

/** The server's view of the fake host: `sysctl`, the accounts' own files (registry, cache, modes: where `packages/accounts` reads them) and an immediate memory sample. */
export const hostEnv = (bin: string): Record<string, string> => ({
  FACTORY_SYSCTL_BIN: join(dir(bin), 'sysctl'),
  FACTORY_PS_BIN: join(dir(bin), 'ps'),
  FACTORY_VM_STAT_BIN: join(dir(bin), 'vm_stat'),
  FACTORY_LSOF_BIN: join(dir(bin), 'lsof'),
  FACTORY_TOP_BIN: join(dir(bin), 'top'),
  FACTORY_LAUNCHCTL_BIN: join(dir(bin), 'launchctl'),
  FACTORY_VM_VOLUME: dir(bin),
  FACTORY_MEMORY_SAMPLE_MS: '0',
  CLAUDE_ACCOUNTS_REGISTRY: join(dir(bin), 'registry.json'),
  CLAUDE_ACCOUNTS_CACHE_DIR: join(dir(bin), 'cache'),
  CLAUDE_ACCOUNTS_MODES: join(dir(bin), 'modes.json'),
  CLAUDE_ACCOUNTS_HISTORY: join(dir(bin), 'history'),
  CLAUDE_ACCOUNTS_PICKS: join(dir(bin), 'picks.jsonl'),
})

/** The rows each world's accounts were last set to: a sample is renewed from them (`renewSamples`). */
const current = new Map<string, AccountRow[]>()

/** The server may read a file while it is written: replace it whole. */
async function writeAtomic(path: string, text: string): Promise<void> {
  const temp = `${path}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`
  await writeFile(temp, text)
  await rename(temp, path)
}

/**
 * The picker used to sample at every poll: a call of the world's CLI is a later sample of the same readings, which is what frees an
 * account whose 5-hour window is hot for a new lead. The files of `packages/accounts` are only as new as their last write, so the
 * world renews them before each call.
 */
export async function renewSamples(bin: string): Promise<void> {
  const rows = current.get(bin)
  if (rows) await setAccounts(bin, rows)
}

/**
 * What the accounts read as from now on, in the files `packages/accounts` reads: a sample per account (taken now, so a later
 * call is a later sample, which is what frees an account for a new lead), and the registry the leads start under. The
 * default account of the registry is a disabled one of its own, so no row reads the host's own `~/.claude.json`.
 */
export async function setAccounts(bin: string, rows: AccountRow[]): Promise<void> {
  const host = dir(bin)
  const cache = join(host, 'cache')
  await mkdir(cache, { recursive: true })
  for (const name of await readdir(cache)) {
    // only a sample of an account no longer listed: another call's temp file is mid-write
    if (name.endsWith('.sample.json') && !rows.some((row) => name === `${row.id}.sample.json`))
      await rm(join(cache, name), { force: true })
  }
  current.set(bin, rows)
  const nowMs = Date.now()
  const now = Math.floor(nowMs / 1000)
  for (const row of rows) {
    const five = row.five_hour === undefined ? 10 : row.five_hour
    await writeAtomic(
      join(cache, `${row.id}.sample.json`),
      JSON.stringify({
        s: five,
        s_reset: five === null ? null : now + 3600,
        s_ts: five === null ? null : nowMs,
        w: row.seven_day ?? 20,
        w_reset: now + 3 * 86_400,
        w_ts: nowMs,
        src: 'statusline',
      }),
    )
  }
  await writeAtomic(
    join(host, 'registry.json'),
    JSON.stringify({
      version: 2,
      accounts: {
        spare: { dir: null, plan: 'max5x', homeLanes: ['interactive'], enabled: false },
        ...Object.fromEntries(
          rows.map((row) => [
            row.id,
            {
              dir: join(host, 'accounts', row.id),
              // a plan with no 5-hour window is an Ultra seat
              plan: row.five_hour === null ? 'ultra' : 'max5x',
              homeLanes: ['bulk'],
              enabled: row.enabled ?? true,
            },
          ]),
        ),
      },
      fable: null,
      drain: null,
    }),
  )
}

/** What the host's 1-minute load reads; a world starts at an idle 0.5 whatever the real machine is doing. */
export async function setLoad(bin: string, load: number): Promise<void> {
  await writeFile(join(dir(bin), 'load'), String(load))
}

/** One process of the fake host: its parent, its resident memory and its working directory. */
export interface FakeProcess {
  pid: number
  ppid: number
  rssKib: number
  /** what `top` lists for it (physical footprint); a process left without one is not in `top.txt` */
  footprintKib?: number
  cwd: string
  command?: string
}

/**
 * What `ps`, `lsof` and `top` answer from now on: the default busy host plus these processes; `lsofFails` makes `lsof`
 * exit 1 and `topFails` makes `top` exit 1.
 */
export async function setProcesses(
  bin: string,
  processes: FakeProcess[],
  options: { lsofFails?: boolean; topFails?: boolean } = {},
): Promise<void> {
  const host = dir(bin)
  const rows = processes.map((p) => `${p.pid} ${p.ppid} 0.0 ${p.rssKib} ${p.command ?? '/opt/tools/bin/bun'}`)
  await writeFile(join(host, 'ps.txt'), `${PS_ROWS}${rows.join('\n')}\n`)
  await writeFile(join(host, 'lsof.txt'), processes.map((p) => `p${p.pid}\nn${p.cwd}\n`).join(''))
  await writeFile(
    join(host, 'top.txt'),
    processes
      .flatMap((p) => (p.footprintKib === undefined ? [] : [`${p.pid}  ${p.ppid}  ${p.footprintKib}K  00:01.00\n`]))
      .join(''),
  )
  await rm(join(host, 'lsof.fail'), { force: true })
  await rm(join(host, 'top.fail'), { force: true })
  if (options.lsofFails) await writeFile(join(host, 'lsof.fail'), '')
  if (options.topFails) await writeFile(join(host, 'top.fail'), '')
}

/** One process in the reaper's table: its pid, age ("mm:ss" form) and the environment words appended to its command. */
export interface SessionProcess {
  pid: number
  /** its parent; `1` when not said */
  ppid?: number
  etime?: string
  command?: string
  env?: string[]
}

/** What the reaper's `ps -Eww` answers from now on; `psFails` makes it exit 1. */
export async function setSessionProcesses(
  bin: string,
  processes: SessionProcess[],
  options: { psFails?: boolean } = {},
): Promise<void> {
  const host = dir(bin)
  const rows = processes.map((p) =>
    `${p.pid} ${p.ppid ?? 1} ${p.etime ?? '30:00'} ${p.command ?? '/bin/sleep 300'} ${(p.env ?? []).join(' ')}`.trimEnd(),
  )
  await writeFile(join(host, 'ps-env.txt'), `    1     0 10-00:00:00 /sbin/launchd\n${rows.join('\n')}\n`)
  await rm(join(host, 'ps-env.fail'), { force: true })
  if (options.psFails) await writeFile(join(host, 'ps-env.fail'), '')
}

/** What the host's memory reads. */
export async function setMemory(bin: string, input: { swapUsedMb: number; swapouts?: number }): Promise<void> {
  const host = dir(bin)
  await writeFile(join(host, 'swapused'), String(input.swapUsedMb))
  await writeFile(join(host, 'swapouts'), String(input.swapouts ?? 1000))
}

/** Puts the fakes in the world's bin directory: one account `me`, plenty of memory. */
export async function installHost(bin: string): Promise<void> {
  const host = dir(bin)
  await Bun.$`mkdir -p ${host}`.quiet()
  const sysctl = join(host, 'sysctl')
  await writeFile(sysctl, SYSCTL(host))
  await writeFile(join(host, 'ps'), PS(host))
  await writeFile(join(host, 'lsof'), LSOF(host))
  await writeFile(join(host, 'top'), TOP(host))
  await writeFile(join(host, 'launchctl'), LAUNCHCTL)
  await chmod(join(host, 'launchctl'), 0o755)
  await writeFile(join(host, 'vm_stat'), VM_STAT)
  await chmod(join(host, 'vm_stat'), 0o755)
  await chmod(join(host, 'ps'), 0o755)
  await chmod(join(host, 'lsof'), 0o755)
  await chmod(join(host, 'top'), 0o755)
  await setProcesses(bin, [])
  await setSessionProcesses(bin, [])
  await chmod(sysctl, 0o755)
  await setAccounts(bin, [{ id: 'me' }])
  await setMemory(bin, { swapUsedMb: 1024 })
  await setLoad(bin, 0.5)
}
