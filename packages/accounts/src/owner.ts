// The adapters behind the registry's host block (host.ts): the peer machine over ssh (and its herdr-core), the re-login ask
// command, the wake check's push and notification. None runs without the block; the code is the dotfiles picker's, as it was.
import { spawn, spawnSync } from 'node:child_process'
import { closeSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { type HealthRow, type PendingAsk, type gradeMachine, healthSignature } from './health.ts'
import type { HostPeer, ReloginCandidate } from './policy.ts'
import { cacheDir, keepaliveLogPath } from './paths.ts'
import { renderCommand, shQuote } from './host.ts'
import { boundedSpawnSync, spawnDetached } from './spawn.ts'

export const HOME_BIN = '$HOME/.local/bin/claude-account'
export const PENDING_SH = `for f in "$HOME"/.local/state/human-queue/*.req; do [ -e "$f" ] && grep -q claude-relogin "$f" || continue; b="\${f%.req}"; [ -e "$b.res" ] || echo "$(basename "$b") $(stat -f %m "$f")"; done`
export const SSH_OPTS = ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=5']
export const sshBin = () => process.env.CLAUDE_ACCOUNTS_SSH ?? 'ssh' // test seam: ssh reads the real ~/.ssh/config whatever $HOME says
const PEER_USAGE_TIMEOUT_MS = 20_000

/** The peer's `claude-account usage --json` (a pure file read there: it never refreshes, so no loop). Throws when unreachable or garbled. */
export function fetchPeerUsage(peer: HostPeer): unknown {
  const r = boundedSpawnSync(
    sshBin(),
    [...SSH_OPTS, ...peer.ssh, peerCmd(peer, 'usage', `${peer.bin ?? HOME_BIN} usage --json`)],
    { timeoutMs: PEER_USAGE_TIMEOUT_MS },
  )
  if (r.error || r.status !== 0)
    throw new Error(`ssh ${peer.ssh.join(' ')} failed (${r.error?.message ?? `rc=${r.status}`})`)
  return JSON.parse(r.stdout)
}

/** A peer whose key runs fixed verbs only (word-split, no shell syntax) gets the verb; any other peer takes the shell command. */
const FIXED_VERBS = { usage: 'account-usage', snapshot: 'account-snapshot', core: 'account-snapshot-core' } as const
function peerCmd(peer: HostPeer, verb: keyof typeof FIXED_VERBS, shellCmd: string): string {
  return peer.fixedVerbs ? FIXED_VERBS[verb] : shellCmd
}

const peerScript = (bin: string) => `${bin} usage --json; echo '@@'; ${bin} expiry --json; echo '@@'; ${PENDING_SH}`
export const PEER_SCRIPT = peerScript(HOME_BIN)

export const parseJson = (t: string) => {
  try {
    return JSON.parse(t)
  } catch {
    return null
  }
}
export function pendingFrom(text: string, nowMs: number): PendingAsk[] {
  return text.split('\n').flatMap((l) => {
    const [, id, secs] = /^([0-9T-]+) (\d+)$/.exec(l.trim()) ?? []
    return id && secs ? [{ id, ageMs: nowMs - Number(secs) * 1000 }] : []
  })
}
const hcBin = () => process.env.CLAUDE_ACCOUNTS_HC ?? 'hc' // test seam, like CLAUDE_ACCOUNTS_SSH
const hcOk = (args: string[]) => spawnSync(hcBin(), args, { encoding: 'utf8', timeout: 5_000 })
/**
 * Why a core and not ssh: an ssh session cannot read the mini's login Keychain (rc=36); the core is a launchd GUI-session
 * child and can. Two ways to reach the peer's: (1) this machine's core lists the peer connected (`hc exec --on`), else
 * (2) one ssh hop to the peer and that machine's own core (`hc exec` there). Neither ever starts a core: (1) asks
 * `server status` first, (2) checks launchd on the peer before it runs `hc` (an `hc` call starts a stray core otherwise).
 */
export function peerViaCore(peer: HostPeer, nowMs: number) {
  const name = peer.name
  const status = hcOk(['server', 'status', '--json'])
  if (status.error || status.status !== 0) return null
  const ls = hcOk(['machine', 'ls', '--json'])
  if (ls.error || ls.status !== 0) return null
  const machines = (parseJson(ls.stdout) as { machines?: { name: string; state: string }[] } | null)?.machines ?? []
  if (!machines.some((m) => m.name === name && m.state === 'connected')) return null
  const script = `PATH="$HOME/.local/bin:/opt/homebrew/bin:$PATH"; export PATH; ${peerScript(peer.bin ?? HOME_BIN)}`
  const r = spawnSync(hcBin(), ['exec', '--on', name, '--timeout', '30', 'sh', '-c', script], {
    encoding: 'utf8',
    timeout: 35_000,
  })
  if (r.error || !r.stdout.includes('@@\n')) return null
  return parseSnapshot(r.stdout, nowMs)
}
/** (2) of the above: ssh to the peer, then its own core. null when the hop, the core (lib/core-up.sh: not up) or the read fails. */
export function peerViaItsCore(peer: HostPeer, nowMs: number) {
  const script = `PATH="$HOME/.local/bin:/opt/homebrew/bin:$PATH"; export PATH; ${peerScript(peer.bin ?? HOME_BIN)}`
  const remote = `PATH="$HOME/.local/bin:/opt/homebrew/bin:$PATH"; export PATH; bash "$HOME/SourceRoot/dotfiles/scripts/lib/core-up.sh" >/dev/null 2>&1 || exit 99; hc exec --timeout 30 sh -c ${shQuote(script)}`
  const r = spawnSync(sshBin(), [...SSH_OPTS, ...peer.ssh, peerCmd(peer, 'core', remote)], {
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
  peer: HostPeer | null,
  nowMs: number,
): ReturnType<typeof parseSnapshot> & { via?: 'core' | 'ssh' } {
  if (!peer) {
    const r = spawnSync('sh', ['-c', PEER_SCRIPT.replaceAll(HOME_BIN, `"${process.execPath}" "${process.argv[1]}"`)], {
      encoding: 'utf8',
      timeout: 30_000,
    })
    return r.status !== 0 && !r.stdout
      ? { usage: null, expiry: null, pending: null, pendingIds: [] as PendingAsk[] }
      : parseSnapshot(r.stdout, nowMs)
  }
  const viaCore = peer.herdrCore ? (peerViaCore(peer, nowMs) ?? peerViaItsCore(peer, nowMs)) : null
  if (viaCore) return { ...viaCore, via: 'core' }
  const r = spawnSync(
    sshBin(),
    [...SSH_OPTS, ...peer.ssh, peerCmd(peer, 'snapshot', peerScript(peer.bin ?? HOME_BIN))],
    {
      encoding: 'utf8',
      timeout: 30_000,
    },
  )
  if (r.status !== 0 && !r.stdout)
    return { usage: null, expiry: null, pending: null, pendingIds: [] as PendingAsk[], via: 'ssh' }
  return { ...parseSnapshot(r.stdout, nowMs), via: 'ssh' }
}

export function spawnLogged(cmd: string, args: string[]) {
  const fd = openSync(keepaliveLogPath(), 'a')
  spawn(cmd, args, { detached: true, stdio: ['ignore', fd, fd] }).unref()
  closeSync(fd)
}
/** Runs the `notify` command of the wake block ({message}) when the picture of non-ok rows changed, at most once per 12 h for the same one. */
export function notifyIfChanged(rows: HealthRow[], nowMs: number, notify: string) {
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
  spawnSync('sh', ['-c', renderCommand(notify, { message: bad.slice(0, 200) })])
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

/** The `reloginAsk` command of the host block ({id}, {reason}), started detached: whatever asks the human is the command's business. */
export const reloginAsk = (command: string) => (c: ReloginCandidate) =>
  spawnDetached(['sh', '-c', renderCommand(command, { id: c.id, reason: c.reason })])
