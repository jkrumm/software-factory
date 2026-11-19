// The host block of the registry (docs/accounts.md §The host block): which machine this is, who its peer is, and the commands
// that stand in for what only one person's machines have. No block = one machine with plain logins; nothing below runs.
import { hostname } from 'node:os'
import type { HostConfig, HostMachine, HostPeer, HostWake } from './policy.ts'
import { required } from './required.ts'

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const isStr = (v: unknown): v is string => typeof v === 'string' && v.length > 0
const strList = (v: unknown): v is string[] => Array.isArray(v) && v.length > 0 && v.every(isStr)

/** The host block of a registry, checked; a string answer is what is wrong with it. Unknown keys are ignored like everywhere else. */
export function parseHost(raw: unknown): HostConfig | string {
  if (!isObj(raw)) return 'must be an object'
  const out: HostConfig = {}
  for (const k of ['reloginAsk', 'reloginFix', 'afterAdd'] as const) {
    if (raw[k] === undefined) continue
    if (!isStr(raw[k])) return `${k} must be a command string`
    out[k] = raw[k]
  }
  if (raw.machines !== undefined) {
    if (!Array.isArray(raw.machines)) return 'machines must be a list'
    const machines: HostMachine[] = []
    for (const [i, m] of raw.machines.entries()) {
      const at = `machines[${i}]`
      if (!isObj(m) || !isStr(m.name)) return `${at}: name is required`
      if (m.match !== undefined) {
        if (!isStr(m.match)) return `${at}: match must be a regex string`
        try {
          new RegExp(m.match, 'i')
        } catch {
          return `${at}: match is not a valid regex`
        }
      }
      const peer = m.peer === undefined ? undefined : parsePeer(m.peer)
      if (typeof peer === 'string') return `${at}.peer: ${peer}`
      const wake = m.wake === undefined ? undefined : parseWake(m.wake)
      if (typeof wake === 'string') return `${at}.wake: ${wake}`
      machines.push({
        ...(m.match !== undefined ? { match: m.match } : {}),
        name: m.name,
        ...(peer ? { peer } : {}),
        ...(wake ? { wake } : {}),
      })
    }
    out.machines = machines
  }
  return out
}

function parsePeer(v: unknown): HostPeer | string {
  if (!isObj(v) || !isStr(v.name)) return 'name is required'
  if (!strList(v.ssh)) return 'ssh must be a list of ssh arguments'
  if (v.bin !== undefined && !isStr(v.bin)) return 'bin must be a string'
  for (const k of ['fixedVerbs', 'herdrCore'] as const)
    if (v[k] !== undefined && typeof v[k] !== 'boolean') return `${k} must be true or false`
  return {
    name: v.name,
    ssh: v.ssh,
    ...(v.bin !== undefined ? { bin: v.bin } : {}),
    ...(v.fixedVerbs !== undefined ? { fixedVerbs: v.fixedVerbs === true } : {}),
    ...(v.herdrCore !== undefined ? { herdrCore: v.herdrCore === true } : {}),
  }
}

function parseWake(v: unknown): HostWake | string {
  if (!isObj(v)) return 'must be an object'
  for (const k of ['push', 'notify'] as const)
    if (v[k] !== undefined && !isStr(v[k])) return `${k} must be a command string`
  return {
    ...(v.push !== undefined ? { push: v.push as string } : {}),
    ...(v.notify !== undefined ? { notify: v.notify as string } : {}),
  }
}

export interface Machine {
  name: string
  peer: HostPeer | null
  wake: HostWake | null
  /** A machine entry of the host block fits this host. */
  configured: boolean
}

/** This machine: the host block's first entry that fits the hostname (or has no `match`), else the hostname itself with no peer. */
export function resolveMachine(host: HostConfig | undefined, host_: string = hostname()): Machine {
  const list = host?.machines ?? []
  const m =
    list.find((e) => e.match !== undefined && new RegExp(e.match, 'i').test(host_)) ??
    list.find((e) => e.match === undefined)
  if (m) return { name: m.name, peer: m.peer ?? null, wake: m.wake ?? null, configured: true }
  return { name: (host_.split('.')[0] ?? '').toLowerCase() || 'local', peer: null, wake: null, configured: false }
}

export const shQuote = (v: string) => `'${v.replaceAll("'", `'\\''`)}'`

/** A hint template ({placeholders} filled as they are: the text is shown, never run). */
export const fillHint = (template: string, vars: Record<string, string>) =>
  template.replace(/\{([a-zA-Z]+)\}/g, (whole, k: string) => (Object.hasOwn(vars, k) ? required(vars, k) : whole))

/** A command template with every {placeholder} replaced by the shell-quoted value; an unknown placeholder is left as it is. */
export const renderCommand = (template: string, vars: Record<string, string>) =>
  template.replace(/\{([a-zA-Z]+)\}/g, (whole, k: string) =>
    Object.hasOwn(vars, k) ? shQuote(required(vars, k)) : whole,
  )
