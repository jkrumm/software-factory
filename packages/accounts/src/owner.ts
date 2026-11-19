// The owner's adapters, the defaults behind the ports until a later row makes them configurable: the peer machine over ssh
// (and its herdr-core), the re-login dialog script, the wake check's notification. Ported as they are from the dotfiles picker.
import { spawn, spawnSync } from 'node:child_process'
import { closeSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir, hostname } from 'node:os'
import { dirname, join } from 'node:path'
import { type HealthRow, type PendingAsk, type gradeMachine, healthSignature } from './health.ts'
import type { ReloginCandidate } from './policy.ts'
import { cacheDir, keepaliveLogPath } from './paths.ts'
import { boundedSpawnSync, spawnDetached } from './spawn.ts'

export const HOME_BIN = '$HOME/.local/bin/claude-account'
export const PENDING_SH = `for f in "$HOME"/.local/state/human-queue/*.req; do [ -e "$f" ] && grep -q claude-relogin "$f" || continue; b="\${f%.req}"; [ -e "$b.res" ] || echo "$(basename "$b") $(stat -f %m "$f")"; done`
/** The other machine: the mini reaches the MacBook over `ssh iumac`, the MacBook the mini over `ssh mini`. */
export function peerMachine() {
  const onMini = /mini/i.test(hostname())
  return {
    onMini,
    local: onMini ? 'mini' : 'macbook',
    peer: onMini ? { name: 'macbook', ssh: ['iumac'] } : { name: 'mini', ssh: ['mini'] },
  }
}
export const SSH_OPTS = ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=5']
export const sshBin = () => process.env.CLAUDE_ACCOUNTS_SSH ?? 'ssh' // test seam: ssh reads the real ~/.ssh/config whatever $HOME says
const PEER_USAGE_TIMEOUT_MS = 20_000

/** The peer's `claude-account usage --json` (a pure file read there: it never refreshes, so no loop). Throws when unreachable or garbled. */
export function fetchPeerUsage(): unknown {
  const r = boundedSpawnSync(
    sshBin(),
    [...SSH_OPTS, ...peerMachine().peer.ssh, peerCmd(peerMachine().peer.name, 'usage', `${HOME_BIN} usage --json`)],
    { timeoutMs: PEER_USAGE_TIMEOUT_MS },
  )
  if (r.error || r.status !== 0)
    throw new Error(`ssh ${peerMachine().peer.ssh.join(' ')} failed (${r.error?.message ?? `rc=${r.status}`})`)
  return JSON.parse(r.stdout)
}

/** The MacBook's key runs fixed verbs only (word-split, no shell syntax); the mini takes the shell command as before. */
const MACBOOK_VERBS = { usage: 'account-usage', snapshot: 'account-snapshot', core: 'account-snapshot-core' } as const
function peerCmd(peerName: string, verb: keyof typeof MACBOOK_VERBS, shellCmd: string): string {
  return peerName === 'macbook' ? MACBOOK_VERBS[verb] : shellCmd
}

export const PEER_SCRIPT = `${HOME_BIN} usage --json; echo '@@'; ${HOME_BIN} expiry --json; echo '@@'; ${PENDING_SH}`

export const parseJson = (t: string) => {
  try {
    return JSON.parse(t)
  } catch {
    return null
  }
}
export function pendingFrom(text: string, nowMs: number): PendingAsk[] {
  return text.split('\n').flatMap((l) => {
    const m = /^([0-9T-]+) (\d+)$/.exec(l.trim())
    return m ? [{ id: m[1], ageMs: nowMs - Number(m[2]) * 1000 }] : []
  })
}
const hcBin = () => process.env.CLAUDE_ACCOUNTS_HC ?? 'hc' // test seam, like CLAUDE_ACCOUNTS_SSH
const hcOk = (args: string[]) => spawnSync(hcBin(), args, { encoding: 'utf8', timeout: 5_000 })
const shq = (v: string) => `'${v.replaceAll("'", `'\\''`)}'`
/**
 * Why a core and not ssh: an ssh session cannot read the mini's login Keychain (rc=36); the core is a launchd GUI-session
 * child and can. Two ways to reach the peer's: (1) this machine's core lists the peer connected (`hc exec --on`), else
 * (2) one ssh hop to the peer and that machine's own core (`hc exec` there). Neither ever starts a core: (1) asks
 * `server status` first, (2) checks launchd on the peer before it runs `hc` (an `hc` call starts a stray core otherwise).
 */
export function peerViaCore(name: string, nowMs: number) {
  const status = hcOk(['server', 'status', '--json'])
  if (status.error || status.status !== 0) return null
  const ls = hcOk(['machine', 'ls', '--json'])
  if (ls.error || ls.status !== 0) return null
  const machines = (parseJson(ls.stdout) as { machines?: { name: string; state: string }[] } | null)?.machines ?? []
  if (!machines.some((m) => m.name === name && m.state === 'connected')) return null
  const script = `PATH="$HOME/.local/bin:/opt/homebrew/bin:$PATH"; export PATH; ${PEER_SCRIPT}`
  const r = spawnSync(hcBin(), ['exec', '--on', name, '--timeout', '30', 'sh', '-c', script], {
    encoding: 'utf8',
    timeout: 35_000,
  })
  if (r.error || !r.stdout.includes('@@\n')) return null
  return parseSnapshot(r.stdout, nowMs)
}
/** (2) of the above: ssh to the peer, then its own core. null when the hop, the core (lib/core-up.sh: not up) or the read fails. */
export function peerViaItsCore(ssh: string[], nowMs: number, peerName = 'mini') {
  const script = `PATH="$HOME/.local/bin:/opt/homebrew/bin:$PATH"; export PATH; ${PEER_SCRIPT}`
  const remote = `PATH="$HOME/.local/bin:/opt/homebrew/bin:$PATH"; export PATH; bash "$HOME/SourceRoot/dotfiles/scripts/lib/core-up.sh" >/dev/null 2>&1 || exit 99; hc exec --timeout 30 sh -c ${shq(script)}`
  const r = spawnSync(sshBin(), [...SSH_OPTS, ...ssh, peerCmd(peerName, 'core', remote)], {
    encoding: 'utf8',
    timeout: 40_000,
  })
  if (r.error || r.status !== 0 || !r.stdout.includes('@@\n')) return null
  return parseSnapshot(r.stdout, nowMs)
}
export function parseSnapshot(stdout: string, nowMs: number): Snapshot {
  const [u = '', e = '', q = ''] = stdout.split('@@\n')
  const pending = pendingFrom(q, nowMs)
  return { usage: parseJson(u), expiry: parseJson(e), pending, pendingIds: pending }
}
/** One machine's `usage`, `expiry` and pending asks via a shell (local sh, or the peer's core, else ssh); null usage = unreachable. */
export function machineSnapshot(
  argv: string[] | null,
  nowMs: number,
  peerName?: string,
): ReturnType<typeof parseSnapshot> & { via?: 'core' | 'ssh' } {
  if (!argv) {
    const r = spawnSync('sh', ['-c', PEER_SCRIPT.replaceAll(HOME_BIN, `"${process.execPath}" "${process.argv[1]}"`)], {
      encoding: 'utf8',
      timeout: 30_000,
    })
    return r.status !== 0 && !r.stdout
      ? { usage: null, expiry: null, pending: null, pendingIds: [] as PendingAsk[] }
      : parseSnapshot(r.stdout, nowMs)
  }
  const viaCore = peerName ? (peerViaCore(peerName, nowMs) ?? peerViaItsCore(argv, nowMs, peerName)) : null
  if (viaCore) return { ...viaCore, via: 'core' }
  const r = spawnSync(sshBin(), [...SSH_OPTS, ...argv, peerCmd(peerName ?? 'mini', 'snapshot', PEER_SCRIPT)], {
    encoding: 'utf8',
    timeout: 30_000,
  })
  if (r.status !== 0 && !r.stdout)
    return { usage: null, expiry: null, pending: null, pendingIds: [] as PendingAsk[], via: 'ssh' }
  return { ...parseSnapshot(r.stdout, nowMs), via: 'ssh' }
}

export function spawnLogged(cmd: string, args: string[]) {
  const fd = openSync(keepaliveLogPath(), 'a')
  spawn(cmd, args, { detached: true, stdio: ['ignore', fd, fd] }).unref()
  closeSync(fd)
}
export function notifyIfChanged(rows: HealthRow[], nowMs: number) {
  const sig = healthSignature(rows)
  const stamp = join(cacheDir(), 'health-notified.json')
  const prev = parseJson(
    (() => {
      try {
        return readFileSync(stamp, 'utf8')
      } catch {
        return ''
      }
    })(),
  ) as { sig?: string; ts?: number } | null
  if (!sig || (prev?.sig === sig && nowMs - (prev.ts ?? 0) < 12 * 3600_000)) return
  const bad = rows
    .filter((r) => r.state !== 'ok')
    .map((r) => `${r.machine}/${r.id}: ${r.detail}`)
    .join('; ')
  spawnSync('osascript', [
    '-e',
    `display notification ${JSON.stringify(bad.slice(0, 200))} with title "Claude sessions" subtitle "open Tinycast > Claude usage to fix"`,
  ])
  try {
    mkdirSync(dirname(stamp), { recursive: true })
    writeFileSync(stamp, JSON.stringify({ sig, ts: nowMs }))
  } catch {
    // suppressing a repeat is best-effort
  }
}

type Graded = Parameters<typeof gradeMachine>[1]
export type Snapshot = {
  usage: Graded['usage']
  expiry: Graded['expiry']
  pending: PendingAsk[] | null
  pendingIds: PendingAsk[]
}

/** The dialog script of a re-login ask (the `ReloginAsk` port): started detached, the dialog is the human's click. */
export function reloginAsk(c: ReloginCandidate): void {
  const script =
    process.env.CLAUDE_ACCOUNTS_RELOGIN ?? join(homedir(), 'SourceRoot', 'dotfiles', 'scripts', 'claude-relogin.sh')
  spawnDetached(['bash', script, c.id, '--ask', '--reason', c.reason])
}
