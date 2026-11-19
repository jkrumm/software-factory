// add, verify and remove on a temporary HOME with a stub claude binary: no registry, no host block, no network.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveMachine } from '../src/index.ts'
import { OWNER_HOST } from './owner-host.ts'

const CLI = join(import.meta.dir, '..', 'bin', 'claude-account.ts')
let home = ''
let bin = ''
let state: string // the stub's switches: files that exist = behaviour

const put = (path: string, body: string) => {
  writeFileSync(path, `#!/bin/sh\n${body}\n`)
  chmodSync(path, 0o755)
}
const flag = (name: string, on: boolean) =>
  on ? writeFileSync(join(state, name), '') : rmSync(join(state, name), { force: true })

beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), 'ca-onboard-'))
  bin = join(home, 'bin')
  state = join(home, 'state')
  mkdirSync(bin)
  mkdirSync(state)
  // claude auth status: logged in unless the switch says otherwise; it leaves a fresh usage cache in the account's own .claude.json
  put(
    join(bin, 'claude'),
    `[ -e "${state}/loggedout" ] && { echo '{"loggedIn":false}'; exit 0; }
[ -e "${state}/nocache" ] && { echo '{"loggedIn":true}'; exit 0; }
f="${'$'}{CLAUDE_CONFIG_DIR:-${'$'}HOME}/.claude.json"
now=${'$'}(date +%s)000
reset=${'$'}(date -u -v+3d +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u -d '+3 days' +%Y-%m-%dT%H:%M:%SZ)
echo "{\\"cachedUsageUtilization\\":{\\"fetchedAtMs\\":${'$'}now,\\"utilization\\":{\\"five_hour\\":{\\"utilization\\":12,\\"resets_at\\":\\"${'$'}reset\\"},\\"seven_day\\":{\\"utilization\\":30,\\"resets_at\\":\\"${'$'}reset\\"}}}}" > "${'$'}f"
echo '{"loggedIn":true}'`,
  )
  // the login item: a plan tier, no token (so the usage endpoint is never called)
  put(
    join(bin, 'security'),
    `tier=default_claude_max_5x; [ -e "${state}/ultra" ] && tier=default_claude_max_20x
echo "{\\"claudeAiOauth\\":{\\"refreshTokenExpiresAt\\":${'$'}(( ( ${'$'}(date +%s) + 30*86400 ) * 1000 )),\\"expiresAt\\":1,\\"rateLimitTier\\":\\"${'$'}tier\\"}}"`,
  )
  put(join(bin, 'ssh'), 'exit 255')
})
afterAll(() => rmSync(home, { recursive: true, force: true }))

const env = (extra: Record<string, string> = {}) => {
  const e: Record<string, string> = {
    ...(process.env as Record<string, string>),
    HOME: home,
    CLAUDE_ACCOUNTS_CACHE_DIR: join(home, 'cache'),
    CLAUDE_ACCOUNTS_PICKS: join(home, 'picks.jsonl'),
    CLAUDE_ACCOUNTS_MODES: join(home, 'modes.json'),
    CLAUDE_ACCOUNTS_SECURITY_BIN: join(bin, 'security'),
    CLAUDE_ACCOUNTS_SSH: join(bin, 'ssh'),
    PATH: `${bin}:${process.env.PATH}`,
  }
  delete (e as Record<string, string | undefined>).CLAUDE_ACCOUNTS_REGISTRY
  delete (e as Record<string, string | undefined>).CLAUDE_CONFIG_DIR
  return { ...e, ...extra }
}
const cli = (args: string[], extra: Record<string, string> = {}) => {
  const r = Bun.spawnSync(['bun', CLI, ...args], { env: env(extra), stdout: 'pipe', stderr: 'pipe', cwd: home })
  return { rc: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() }
}
const registryFile = () => join(home, '.config', 'claude-accounts', 'registry.json')
const registry = () => JSON.parse(readFileSync(registryFile(), 'utf8'))

describe('a new user: nothing to a first pick with two accounts, no host block', () => {
  test('add: the first account takes the default dir; the entry is disabled and the login command is printed', () => {
    const r = cli(['add', 'main', '--plan', 'ultra'])
    expect(r.rc, r.err).toBe(0)
    expect(r.out).toContain('claude auth login')
    expect(r.out).toContain('claude-account verify main --enable')
    expect(registry()).toEqual({
      accounts: { main: { dir: null, plan: 'ultra', homeLanes: ['interactive', 'headless'], enabled: false } },
    })
    expect(registry().accounts.main.units).toBeUndefined() // units come from the plan table
  })

  test('a disabled account takes no work', () => {
    expect(cli(['pick', '--lane', 'interactive']).out.trim()).toBe('unset CLAUDE_CONFIG_DIR') // the picker's last resort, not a rank
    expect(cli(['rank', '--lane', 'interactive']).out.trim()).toBe('')
  })

  test('verify fails while logged out and changes nothing, even with --enable', () => {
    flag('loggedout', true)
    flag('ultra', true)
    const r = cli(['verify', 'main', '--enable'])
    expect(r.rc).toBe(1)
    expect(r.out).toContain('FAIL')
    expect(r.out).toContain('claude auth login')
    expect(registry().accounts.main.enabled).toBe(false)
  })

  test('verify rejects a login whose plan is not the registered one', () => {
    flag('loggedout', false)
    flag('ultra', false) // the login item says max, the registry ultra
    const r = cli(['verify', 'main', '--enable'])
    expect(r.rc).toBe(1)
    expect(r.out).toMatch(/plan\s+FAIL the login is max .* registry says ultra/)
    expect(registry().accounts.main.enabled).toBe(false)
  })

  test('verify --enable: login, plan and a sample pass, the account is enabled and pickable', () => {
    flag('ultra', true)
    expect(cli(['verify', 'main']).out).toContain('claude-account verify main --enable') // without the flag: told, not enabled
    expect(registry().accounts.main.enabled).toBe(false)
    const r = cli(['verify', 'main', '--enable'])
    expect(r.rc, r.out + r.err).toBe(0)
    expect(r.out).toMatch(/login\s+ok/)
    expect(r.out).toMatch(/plan\s+ok/)
    expect(r.out).toMatch(/sample\s+ok\s+weekly 30%/)
    expect(registry().accounts.main.enabled).toBe(true)
    expect(cli(['pick', '--lane', 'interactive', '--dry']).out.trim()).toBe('unset CLAUDE_CONFIG_DIR')
    expect(cli(['rank', '--lane', 'interactive']).out).toContain('1. main')
  })

  test('the second account: its own dir, the bulk lane, created on disk; rank takes it in for bulk only after verify', () => {
    flag('ultra', false)
    const r = cli(['add', 'second', '--plan', 'max'])
    expect(r.rc, r.err).toBe(0)
    expect(r.out).toContain(`CLAUDE_CONFIG_DIR='${join(home, '.claude-second')}' claude auth login`)
    expect(existsSync(join(home, '.claude-second'))).toBe(true)
    expect(registry().accounts.second).toEqual({
      dir: '~/.claude-second',
      plan: 'max',
      homeLanes: ['bulk'],
      enabled: false,
    })
    expect(cli(['rank', '--lane', 'bulk']).out).not.toContain('second')
    expect(cli(['verify', 'second', '--enable']).rc).toBe(0)
    expect(cli(['env', 'second']).out).toContain(`export CLAUDE_CONFIG_DIR='${join(home, '.claude-second')}'`)
    expect(cli(['rank', '--lane', 'bulk']).out).toContain('second')
  })

  test("verify never counts the old cache sample of a removed account as this run's", () => {
    // a sample an earlier login left in the cache under this id (a removed account's stays) must not pass; the new login has no usage cache of its own
    flag('nocache', true)
    const r = cli(['add', 'again', '--plan', 'max'])
    expect(r.rc).toBe(0)
    writeFileSync(
      join(home, 'cache', 'again.sample.json'),
      JSON.stringify({ s: 5, w: 5, s_reset: null, w_reset: null, s_ts: Date.now(), w_ts: Date.now(), src: 'old' }),
    )
    const v = cli(['verify', 'again', '--enable'])
    flag('nocache', false)
    expect(v.rc).toBe(1)
    expect(v.out).toMatch(/sample\s+FAIL/)
    expect(JSON.parse(readFileSync(registryFile(), 'utf8')).accounts.again.enabled).toBe(false)
  })

  test('remove: disabled, out of rank, names what stays; a second run changes nothing', () => {
    const r = cli(['remove', 'second'])
    expect(r.rc, r.err).toBe(0)
    expect(r.out).toContain('second: disabled')
    for (const what of ['registry', 'config dir', 'login', 'cache', 'history']) expect(r.out).toContain(what)
    expect(r.out).toContain(join(home, '.claude-second'))
    expect(registry().accounts.second.enabled).toBe(false)
    expect(cli(['rank', '--lane', 'bulk']).out).not.toContain('second')
    const again = cli(['remove', 'second'])
    expect(again.rc).toBe(0)
    expect(again.out).toContain('already disabled')
  })

  test('add refuses a duplicate id, a bad id, a bad plan, a shared dir and ~/.claude', () => {
    const err = (args: string[]) => {
      const r = cli(args)
      expect(r.rc, args.join(' ')).toBe(2)
      return r.err
    }
    expect(err(['add', 'main', '--plan', 'max'])).toContain('already in the registry')
    expect(err(['add', 'a b', '--plan', 'max'])).toContain('not an account id')
    expect(err(['add', 'spill', '--plan', 'max'])).toContain('reserved')
    expect(err(['add', 'x', '--plan', 'max5x'])).toContain('--plan must be one of')
    expect(err(['add', 'x', '--plan', 'max', '--dir', '~/.claude-second'])).toContain('second already uses')
    expect(err(['add', 'x', '--plan', 'max', '--dir', '~/.claude'])).toContain('default account')
    expect(err(['add', 'x'])).toContain('usage: claude-account add')
    expect(Object.keys(registry().accounts)).toEqual(['main', 'second', 'again'])
  })

  test('a registry the add would break is never written', () => {
    const before = readFileSync(registryFile(), 'utf8')
    const bad = cli(['add', 'x', '--plan', 'max', '--lanes', 'a b'])
    expect(bad.rc).toBe(2)
    expect(readFileSync(registryFile(), 'utf8')).toBe(before)
  })

  test('without a host block no adapter runs: no ssh, no ask', () => {
    const sshLog = join(home, 'ssh.log')
    put(join(bin, 'ssh'), `echo "$@" >> "${sshLog}"; exit 255`)
    flag('loggedout', true)
    cli(['refresh', '--all'])
    const h = cli(['health'])
    flag('loggedout', false)
    put(join(bin, 'ssh'), 'exit 255')
    expect(existsSync(sshLog)).toBe(false)
    expect(h.out).not.toContain('NOTE')
    expect(h.out).toContain('claude auth login') // the repair hint is this machine's own login command
  })
})

describe('the host block', () => {
  test('this machine: a fitting match wins over an entry without one, whatever the order; no fit, no peer', () => {
    const host = {
      machines: [
        { name: 'any', peer: { name: 'p', ssh: ['p'] } },
        { match: 'build', name: 'build' },
      ],
    }
    expect(resolveMachine(host, 'Build-01').name).toBe('build')
    expect(resolveMachine(host, 'laptop').name).toBe('any')
    expect(resolveMachine({ machines: [{ match: 'x', name: 'x' }] }, 'laptop')).toMatchObject({
      name: 'laptop',
      peer: null,
      configured: false,
    })
    expect(resolveMachine(undefined, 'Host.example').name).toBe('host')
  })

  test('a malformed host block is refused with the field named', () => {
    const f = join(home, 'bad-host.json')
    writeFileSync(
      f,
      JSON.stringify({
        host: { machines: [{ name: 'x', peer: { name: 'y', ssh: [] } }] },
        accounts: registry().accounts,
      }),
    )
    const r = cli(['usage'], { CLAUDE_ACCOUNTS_REGISTRY: f })
    expect(r.rc).toBe(2)
    expect(r.err).toContain('machines[0].peer: ssh must be a list of ssh arguments')
  })

  test('afterAdd runs once for the new account with its id, dir and plan', () => {
    const f = join(home, 'host-registry.json')
    const marker = join(home, 'after-add.log')
    writeFileSync(
      f,
      JSON.stringify({
        host: { ...OWNER_HOST, afterAdd: `echo {id} {plan} "$CLAUDE_ACCOUNT_DIR" >> ${marker}` },
        accounts: registry().accounts,
      }),
    )
    const r = cli(['add', 'third', '--plan', 'max'], { CLAUDE_ACCOUNTS_REGISTRY: f })
    expect(r.rc, r.err).toBe(0)
    expect(readFileSync(marker, 'utf8').trim()).toBe(`third max ${join(home, '.claude-third')}`)
    // a failing command leaves the account registered and says so
    writeFileSync(
      f,
      JSON.stringify({ host: { afterAdd: 'exit 7' }, accounts: JSON.parse(readFileSync(f, 'utf8')).accounts }),
    )
    const bad = cli(['add', 'fourth', '--plan', 'max'], { CLAUDE_ACCOUNTS_REGISTRY: f })
    expect(bad.rc).toBe(1)
    expect(bad.err).toContain('afterAdd')
    expect(JSON.parse(readFileSync(f, 'utf8')).accounts.fourth.enabled).toBe(false)
  })

  test('the registry file a symlink points at is the one written, the link stays', () => {
    const real = join(home, 'shared.json')
    writeFileSync(real, JSON.stringify({ note: 'kept', accounts: registry().accounts }))
    const link = join(home, 'link.json')
    Bun.spawnSync(['ln', '-s', real, link])
    expect(cli(['add', 'viaLink', '--plan', 'max'], { CLAUDE_ACCOUNTS_REGISTRY: link }).rc).toBe(0)
    expect(Bun.spawnSync(['test', '-L', link]).exitCode).toBe(0)
    const saved = JSON.parse(readFileSync(real, 'utf8'))
    expect(saved.note).toBe('kept') // keys the package does not know stay
    expect(saved.accounts.viaLink.enabled).toBe(false)
  })
})
