import { chmod, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

/** One account of the fake picker: the readings the host would show for it. */
export interface AccountRow {
  id: string
  five_hour?: number
  seven_day?: number
  enabled?: boolean
}

const dir = (bin: string): string => join(bin, 'host')

const SYSCTL = (host: string) => `#!/bin/sh
case "$2" in
  hw.pagesize) echo 16384;;
  vm.compressor.swapper.swapouts_total) cat "${host}/swapouts";;
  hw.memsize) echo 34359738368;;
  vm.swapusage) echo "total = 40960.00M  used = $(cat "${host}/swapused").00M  free = 1.00M  (encrypted)";;
esac
`

/** `ps -Ao pid=,pcpu=,rss=,comm=` of a believable busy host: paths, a name with spaces, rss in KiB. */
const PS = `#!/bin/sh
cat <<'EOT'
    1   0.1    12288 /sbin/launchd
  412  96.4  2411520 /Applications/Google Chrome.app/Contents/MacOS/Google Chrome
  733  41.2  1843200 /opt/tools/bin/bun
  901  28.7   987136 /usr/local/bin/postgres
 1204  17.3  3145728 /Applications/Claude Code.app/Contents/MacOS/claude
 1318  12.9   524288 /opt/homebrew/bin/node
 1422   8.4   262144 /usr/bin/ssh
 1533   5.6  1572864 /Applications/Xcode.app/Contents/MacOS/Xcode
 1647   2.1   131072 /usr/sbin/mDNSResponder
 1750   0.3   819200 /System/Library/CoreServices/WindowServer
EOT
`

const PICKER = (host: string) => `#!/bin/sh
cat "${host}/accounts.json"
`

/** The server's view of the fake host: the picker, `sysctl`, the account registry and an immediate memory sample. */
export const hostEnv = (bin: string): Record<string, string> => ({
  FACTORY_CLAUDE_ACCOUNT_BIN: join(dir(bin), 'claude-account'),
  FACTORY_SYSCTL_BIN: join(dir(bin), 'sysctl'),
  FACTORY_PS_BIN: join(dir(bin), 'ps'),
  FACTORY_MEMORY_SAMPLE_MS: '0',
  FACTORY_ACCOUNTS_FILE: join(dir(bin), 'registry.json'),
})

/** What the picker answers from now on (read at the next poll: `factory capacity refresh`), and the registry the leads start under. */
export async function setAccounts(bin: string, rows: AccountRow[]): Promise<void> {
  const host = dir(bin)
  const now = Math.floor(Date.now() / 1000)
  await writeFile(
    join(host, 'accounts.json'),
    JSON.stringify({
      accounts: rows.map((row) => ({
        id: row.id,
        enabled: row.enabled ?? true,
        auth_ok: true,
        five_hour: row.five_hour ?? 10,
        seven_day: row.seven_day ?? 20,
        five_hour_resets_at: now + 3600,
        seven_day_resets_at: now + 3 * 86_400,
        // sampled at the poll itself: a later poll is a later sample, which is what frees an account for a new lead
        age_s: 0,
        exhausted_until: null,
      })),
    }),
  )
  await writeFile(
    join(host, 'registry.json'),
    JSON.stringify({ accounts: Object.fromEntries(rows.map((row) => [row.id, { dir: null }])) }),
  )
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
  const picker = join(host, 'claude-account')
  const sysctl = join(host, 'sysctl')
  await writeFile(picker, PICKER(host))
  await writeFile(sysctl, SYSCTL(host))
  await writeFile(join(host, 'ps'), PS)
  await chmod(join(host, 'ps'), 0o755)
  await chmod(picker, 0o755)
  await chmod(sysctl, 0o755)
  await setAccounts(bin, [{ id: 'me' }])
  await setMemory(bin, { swapUsedMb: 1024 })
}
