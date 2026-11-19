// Parity with the dotfiles CLI (the live one): the same fixture registry, cache and clock go through both, every verb and
// every lane, and stdout and the exit code must be identical. Where the dotfiles checkout exists (the mini) the test runs
// both; everywhere (CI) the package is held to test/fixtures/parity-golden.json, what the dotfiles CLI printed.
// Refresh the golden file after a deliberate change of the contract: UPDATE_PARITY_GOLDEN=1 bun test packages/accounts/test/parity.test.ts
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

const NOW = 1_800_000_000_000
const H = 3600
export const PACKAGE_CLI = join(import.meta.dir, '..', 'bin', 'claude-account.ts')
export const GOLDEN = join(import.meta.dir, 'fixtures', 'parity-golden.json')
export const DOTFILES_CLI =
  process.env.CLAUDE_ACCOUNT_DOTFILES_CLI ?? join(homedir(), 'SourceRoot', 'dotfiles', 'scripts', 'claude-account.ts')
export const haveDotfiles = existsSync(DOTFILES_CLI)

type Account = { dir: string | null; plan: string; homeLanes: string[]; enabled: boolean }
const accounts = (): Record<string, Account> => ({
  iu: { dir: null, plan: 'ultra', homeLanes: ['interactive', 'headless'], enabled: true },
  me: { dir: '/home/x/.claude-me', plan: 'max5x', homeLanes: ['bulk'], enabled: true },
  me2: { dir: '/home/x/.claude-me2', plan: 'max', homeLanes: ['bulk', 'batch:*'], enabled: true },
})
const registries: Record<string, unknown> = {
  plain: { accounts: accounts() },
  modes: { accounts: accounts(), fable: 'iu', drain: ['me2'] },
  oneoff: { accounts: { ...accounts(), me: { ...accounts().me, enabled: false } } },
}

const sample = (s: number | null, w: number, wResetH: number, ageS = 60) => ({
  s,
  w,
  s_reset: s === null ? null : NOW / 1000 + 3 * H,
  w_reset: NOW / 1000 + wResetH * H,
  s_ts: s === null ? null : NOW - ageS * 1000,
  w_ts: NOW - ageS * 1000,
  src: 'oauth',
})
type Cache = Record<string, Record<string, unknown>>
const caches: Record<string, Cache> = {
  calm: {
    // an endpoint limit set without a scoped limit: iu (the v1 Fable account in `modes`) is not due for one, and its budget is unknown (v1)
    'iu.sample.json': { ...sample(null, 12, 100), limits: [], limits_ts: NOW - 60_000 },
    'me.sample.json': sample(10, 30, 120),
    'me2.sample.json': sample(5, 11, 150),
  },
  expiring: {
    'iu.sample.json': sample(null, 80, 32),
    'me.sample.json': sample(4, 54, 46),
    'me2.sample.json': sample(85, 11, 130),
  },
  walled: {
    'iu.sample.json': sample(null, 97, 20),
    'me.sample.json': sample(95, 40, 90),
    'me2.sample.json': sample(10, 100, 60, 400),
    'me2.exhausted.json': { until: NOW / 1000 + 600 },
    'me.auth.json': { failed: true, ts: NOW - 3600_000 },
  },
}
const lanes = ['interactive', 'headless', 'bulk', 'lead', 'batch:7', 'unknown-lane']

let root = ''
const stubs = () => {
  const bin = join(root, 'bin')
  mkdirSync(bin, { recursive: true })
  const put = (name: string, body: string) => {
    writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`)
    chmodSync(join(bin, name), 0o755)
  }
  put('claude', `echo '{"loggedIn":true}'`)
  put('ssh', 'exit 255')
  put('relogin', `echo "$@" >> "${join(root, 'asks.log')}"`)
  const blob = JSON.stringify({
    claudeAiOauth: {
      accessToken: 'T',
      refreshToken: 'R',
      expiresAt: NOW + 3600_000,
      refreshTokenExpiresAt: NOW + 5 * 86400_000,
      rateLimitTier: 'default_claude_max_5x',
    },
  })
  writeFileSync(join(root, 'kc.json'), blob)
  put('security', `cat "${join(root, 'kc.json')}"`)
  return bin
}

export interface Case {
  name: string
  registry: string
  cache: string
  args: string[]
  env?: Record<string, string>
  state?: boolean
}
export const cases: Case[] = []
for (const registry of Object.keys(registries)) {
  for (const cache of Object.keys(caches)) {
    for (const lane of lanes) {
      cases.push({
        name: `pick --dry --why ${lane} [${registry}/${cache}]`,
        registry,
        cache,
        args: ['pick', '--lane', lane, '--dry', '--why'],
      })
      cases.push({
        name: `rank --json ${lane} [${registry}/${cache}]`,
        registry,
        cache,
        args: ['rank', '--lane', lane, '--json'],
      })
    }
    cases.push({ name: `rank text [${registry}/${cache}]`, registry, cache, args: ['rank', '--lane', 'bulk'] })
    for (const v of [
      ['usage'],
      ['usage', '--json'],
      ['expiry'],
      ['expiry', '--json'],
      ['expiry', '--json', '--ids', 'me'],
      ['account'],
      ['account', '--badge'],
      ['fable'],
      ['env', 'iu'],
      ['env', 'me2'],
      ['env', 'nope'],
    ])
      cases.push({ name: `${v.join(' ')} [${registry}/${cache}]`, registry, cache, args: v })
    cases.push({
      name: `account in a registered dir [${registry}/${cache}]`,
      registry,
      cache,
      args: ['account', '--badge'],
      env: { CLAUDE_CONFIG_DIR: '/home/x/.claude-me2' },
    })
    cases.push({
      name: `account in an unknown dir [${registry}/${cache}]`,
      registry,
      cache,
      args: ['account'],
      env: { CLAUDE_CONFIG_DIR: '/nowhere' },
    })
  }
}
// a real (non-dry) pick on fresh samples: one candidate at most per lane in the single-account registry, the fixed random source elsewhere
for (const lane of lanes)
  cases.push({
    name: `pick ${lane} [oneoff/calm]`,
    registry: 'oneoff',
    cache: 'calm',
    args: ['pick', '--lane', lane],
    state: true,
  })
for (const registry of ['plain', 'modes'])
  cases.push({
    name: `pick bulk [${registry}/calm] with the fixed random source`,
    registry,
    cache: 'calm',
    args: ['pick', '--lane', 'bulk', '--why'],
    state: true,
  })
cases.push(
  {
    name: 'pick with an unreadable registry',
    registry: 'missing',
    cache: 'calm',
    args: ['pick', '--lane', 'bulk', '--why'],
  },
  { name: 'usage with an unreadable registry', registry: 'missing', cache: 'calm', args: ['usage'] },
  {
    name: 'record then read',
    registry: 'plain',
    cache: 'calm',
    args: ['record', '--account', 'me', '--s', '33', '--s-reset', '1800000999', '--w', '44'],
    state: true,
  },
  {
    name: 'record an ultra account keeps no session half',
    registry: 'plain',
    cache: 'calm',
    args: ['record', '--account', 'iu', '--s', '33', '--w', '44', '--w-reset', '1800100000'],
    state: true,
  },
  {
    name: 'record an unknown account',
    registry: 'plain',
    cache: 'calm',
    args: ['record', '--account', 'nope', '--s', '1'],
    state: true,
  },
  {
    name: 'exhausted',
    registry: 'plain',
    cache: 'calm',
    args: ['exhausted', '--account', 'me', '--until', '1800000999'],
    state: true,
  },
  {
    name: 'exhausted without until',
    registry: 'plain',
    cache: 'calm',
    args: ['exhausted', '--account', 'me'],
    state: true,
  },
  {
    name: 'refresh --all, logged in, no Keychain token',
    registry: 'plain',
    cache: 'calm',
    args: ['refresh', '--all'],
    state: true,
  },
  {
    name: 'refresh --all on stale samples',
    registry: 'plain',
    cache: 'stale',
    args: ['refresh', '--all'],
    state: true,
  },
  { name: 'refresh --ids me', registry: 'plain', cache: 'stale', args: ['refresh', '--ids', 'me'], state: true },
  { name: 'unknown verb', registry: 'plain', cache: 'calm', args: ['frobnicate'] },
  { name: 'latest without a transcript', registry: 'plain', cache: 'calm', args: ['latest', '/nowhere/proj'] },
  { name: 'latest', registry: 'plain', cache: 'calm', args: ['latest', '/work/proj'] },
  { name: 'session', registry: 'plain', cache: 'calm', args: ['session', 'sess-1'] },
  { name: 'session unknown', registry: 'plain', cache: 'calm', args: ['session', 'sess-2'] },
)
caches.stale = {
  'iu.sample.json': sample(null, 12, 100, 3 * 3600),
  'me.sample.json': sample(10, 30, 120, 3 * 3600),
  'me2.sample.json': sample(5, 11, 150, 3 * 3600),
}

/** Runs `f` over the items, a few at a time, results in order. */
export const pool = async <T, R>(items: T[], f: (x: T) => Promise<R>, width = 8): Promise<R[]> => {
  const out: R[] = new Array(items.length)
  let next = 0
  await Promise.all(
    Array.from({ length: width }, async () => {
      while (next < items.length) {
        const i = next++
        out[i] = await f(items[i])
      }
    }),
  )
  return out
}

/** Every file under a directory, relative path to content, sorted: the state a stateful verb left behind. */
const tree = (dir: string): Record<string, string> => {
  const out: Record<string, string> = {}
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const p = join(d, e.name)
      if (e.isDirectory()) walk(p)
      else if (!/\.claim$|\.tmp$/.test(e.name)) out[p.slice(dir.length + 1)] = readFileSync(p, 'utf8')
    }
  }
  if (existsSync(dir)) walk(dir)
  return out
}

export const run = async (cli: string, c: Case) => {
  const caseDir = mkdtempSync(join(root, 'run-'))
  const cacheDir = join(caseDir, 'cache')
  mkdirSync(cacheDir)
  for (const [f, body] of Object.entries(caches[c.cache] ?? {})) writeFileSync(join(cacheDir, f), JSON.stringify(body))
  const registry = join(root, `registry-${c.registry}.json`)
  const bin = join(root, 'bin')
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    HOME: join(root, 'home'),
    CLAUDE_ACCOUNTS_REGISTRY: registry,
    CLAUDE_ACCOUNTS_CACHE_DIR: cacheDir,
    CLAUDE_ACCOUNTS_PICKS: join(caseDir, 'picks.jsonl'),
    CLAUDE_ACCOUNTS_SECURITY_BIN: join(bin, 'security'),
    CLAUDE_ACCOUNTS_SSH: join(bin, 'ssh'),
    CLAUDE_ACCOUNTS_RELOGIN: join(bin, 'relogin'),
    PATH: `${bin}:${process.env.PATH}`,
    PARITY_NOW: String(NOW),
    ...c.env,
  }
  delete (env as Record<string, string | undefined>).CLAUDE_CONFIG_DIR
  if (c.env?.CLAUDE_CONFIG_DIR) env.CLAUDE_CONFIG_DIR = c.env.CLAUDE_CONFIG_DIR
  const p = Bun.spawn(['bun', '--preload', join(import.meta.dir, 'fixtures', 'fixed-clock.ts'), cli, ...c.args], {
    env,
    stdout: 'pipe',
    stderr: 'pipe',
    cwd: caseDir,
  })
  const [out, rc] = await Promise.all([new Response(p.stdout).text(), p.exited])
  const result: { rc: number | null; out: string; state?: Record<string, string> } = { rc, out }
  if (c.state)
    result.state = {
      ...tree(cacheDir),
      ...(existsSync(join(caseDir, 'picks.jsonl'))
        ? { 'picks.jsonl': readFileSync(join(caseDir, 'picks.jsonl'), 'utf8') }
        : {}),
    }
  return result
}

export type Result = Awaited<ReturnType<typeof run>>

/** The additive fields of registry v2 (docs/accounts.md §usage --json, §Samples): the v1 CLI has none of them. */
const ADDITIVE_ROW = ['mode', 'mode_override', 'limits', 'weekly_scoped_shares']
const ADDITIVE_SAMPLE = ['limits', 'scoped_shares', 'limits_ts']
const strip = (o: Record<string, unknown>, keys: string[]) => {
  for (const k of keys) delete o[k]
  return o
}

/** A result as the v1 CLI shows it: the additive fields of `usage --json` rows and of sample files removed, nothing else touched. */
export function v1View(c: Case, r: Result): Result {
  let out = r.out
  if (c.args[0] === 'usage' && c.args.includes('--json') && r.rc === 0) {
    const j = JSON.parse(out) as { accounts: Record<string, unknown>[] }
    j.accounts.forEach((row) => strip(row, ADDITIVE_ROW))
    out = `${JSON.stringify(j, null, 2)}\n`
  }
  const state =
    r.state &&
    Object.fromEntries(
      Object.entries(r.state).map(([f, body]) => [
        f,
        f.endsWith('.sample.json') ? JSON.stringify(strip(JSON.parse(body), ADDITIVE_SAMPLE)) : body,
      ]),
    )
  return { ...r, out, ...(state ? { state } : {}) }
}

/** Creates the fixture root (stubs, registries, a transcript and a hook log). Call removeFixtures() when done. */
export function setupFixtures(): void {
  root = mkdtempSync(join(tmpdir(), 'parity-'))
  stubs()
  for (const [name, body] of Object.entries(registries))
    writeFileSync(join(root, `registry-${name}.json`), JSON.stringify(body))
  const home = join(root, 'home')
  mkdirSync(join(home, '.claude', 'logs'), { recursive: true })
  writeFileSync(
    join(home, '.claude', 'logs', '2027-01-15.jsonl'),
    `${JSON.stringify({ event: 'session_env', data: { session: 'sess-1', account: 'me2' } })}\n`,
  )
  mkdirSync(join(home, '.claude', 'projects', '-work-proj'), { recursive: true })
  writeFileSync(join(home, '.claude', 'projects', '-work-proj', 'aaaa-1111.jsonl'), '')
}

export function removeFixtures(): void {
  if (root) rmSync(root, { recursive: true, force: true })
}
