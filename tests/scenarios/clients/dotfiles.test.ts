import { existsSync, readFileSync } from 'node:fs'
import { chmod, copyFile, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { TOKENS } from '../harness.ts'
import { call, startClientsWorld, type VerbsWorld } from './support.ts'

/**
 * Group B, the dotfiles: its real scripts and hooks run with `factory` on PATH being the new CLI. The dotfiles repo is a
 * read-only reference here (CI has none): each test is skipped when its file is absent. A scratch HOME holds the shim, the
 * stubs the dotfiles' own suites use for everything that is not the factory (the Herdr core's `hc`, the account picker), and
 * `SourceRoot` as a link to the world's repo root, so `rd issue <repo>` files a path the server accepts.
 */
const DOTFILES = join(process.env.DOTFILES_DIR ?? join(homedir(), 'SourceRoot', 'dotfiles'))
const RD = join(DOTFILES, 'scripts', 'remote-dev.sh')
const ASK_HUMAN = join(DOTFILES, 'scripts', 'ask-human.sh')
const TEST_SLOT = join(DOTFILES, 'hooks', 'test-slot.ts')
const REVIEW_GUARD = join(DOTFILES, 'hooks', 'review-bypass-guard.ts')
const FAKE_HC = join(DOTFILES, 'scripts', 'remote-dev-fake-hc.sh')
const HOOKS = join(import.meta.dir, '..', '..', '..', 'integrations', 'claude-code', 'hooks.json')
const CLI = join(import.meta.dir, '..', '..', '..', 'apps', 'cli', 'bin', 'factory.ts')

const have = (...files: string[]) =>
  files.every((file) => existsSync(file)) && Bun.which('jq') !== null && Bun.which('bash') !== null
const rdTest = test.skipIf(!have(RD, FAKE_HC))

let v: VerbsWorld
let scratch = ''
let home = ''
let state = ''
let shimDir = ''
let baseEnv: Record<string, string> = {}

/** PATH without any directory that holds a real `factory`: only the shim answers. */
const cleanPath = (process.env.PATH ?? '')
  .split(':')
  .filter((dir) => !existsSync(join(dir, 'factory')))
  .join(':')

interface Ran {
  code: number
  out: string
  err: string
}

async function sh(argv: string[], env: Record<string, string> = {}, stdin = ''): Promise<Ran> {
  const proc = Bun.spawn(argv, {
    cwd: scratch,
    env: { ...baseEnv, ...env },
    stdin: new Blob([stdin]),
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [out, err, code] = await Promise.all([proc.stdout.text(), proc.stderr.text(), proc.exited])
  return { code, out, err }
}

const rd = (args: string[], env: Record<string, string> = {}, stdin = '') => sh(['bash', RD, ...args], env, stdin)

beforeAll(async () => {
  v = await startClientsWorld()
  scratch = await mkdtemp('/tmp/factory-dotfiles-')
  home = join(scratch, 'home')
  state = join(scratch, 'state')
  shimDir = join(home, '.local', 'bin')
  const stubs = join(scratch, 'bin')
  await mkdir(shimDir, { recursive: true })
  await mkdir(state, { recursive: true })
  await mkdir(stubs, { recursive: true })
  await mkdir(join(home, 'SourceRoot', 'dotfiles', 'scripts'), { recursive: true })
  await mkdir(join(scratch, 'xdg', 'secrets'), { recursive: true })
  // The dev-host marker the script reads, so every host call runs locally.
  await writeFile(join(scratch, 'xdg', 'secrets', 'backend'), 'cache\n')
  const write = async (path: string, body: string) => {
    await writeFile(path, body)
    await chmod(path, 0o755)
  }
  await write(join(shimDir, 'factory'), `#!/bin/sh\nexec "${process.execPath}" "${CLI}" "$@"\n`)
  // rd resolves the owner's token through `secrets-run run --env-file=… -- factory …`; here FACTORY_TOKEN is already set.
  await write(
    join(shimDir, 'secrets-run'),
    '#!/usr/bin/env bash\n[ "$1" = run ] || exit 2\nshift\nwhile [ "$#" -gt 0 ] && [ "$1" != -- ]; do shift; done\nshift\nexec "$@"\n',
  )
  await write(join(shimDir, 'claude-account'), '#!/usr/bin/env bash\necho "unset CLAUDE_CONFIG_DIR"\n')
  await write(join(home, 'SourceRoot', 'dotfiles', 'scripts', 'claude-pretrust.sh'), '#!/usr/bin/env bash\nexit 0\n')
  await write(
    join(stubs, 'ps'),
    '#!/usr/bin/env bash\necho "    1 /x/Herdr Core.app/Contents/MacOS/herdr-core --hc-launchd /tmp/hc-launchd-1/ready"\n',
  )
  await write(join(stubs, 'nc'), '#!/usr/bin/env bash\nexit 0\n')
  if (existsSync(FAKE_HC)) await copyFile(FAKE_HC, join(shimDir, 'hc'))
  await chmod(join(shimDir, 'hc'), 0o755).catch(() => {})
  // `SourceRoot` of the scratch HOME is the world's repo root: `example` is a git repo inside the roots.
  await rm(join(home, 'SourceRoot', 'example'), { force: true })
  await symlink(join(v.w.root, 'example'), join(home, 'SourceRoot', 'example'))
  baseEnv = {
    PATH: `${shimDir}:${stubs}:${cleanPath}`,
    HOME: home,
    XDG_CONFIG_HOME: join(scratch, 'xdg'),
    STATE: state,
    PS_BIN: join(stubs, 'ps'),
    RD_FACTORY_POLL_S: '0',
    FACTORY_URL: v.w.server.url,
    FACTORY_TOKEN: TOKENS.owner,
    FACTORY_SOCKET: join(v.w.world.bin, 'hook.sock'),
    FACTORY_SPOOL_DIR: join(v.w.world.bin, 'spool'),
    CLAUDE_EFFORT_TABLE: join(DOTFILES, 'config', 'claude-effort.json'),
    LC_ALL: 'C',
  }
}, 60_000)

afterAll(async () => {
  await v.stop()
  await rm(scratch, { recursive: true, force: true })
})

const resetState = async () => {
  await rm(state, { recursive: true, force: true })
  await mkdir(state, { recursive: true })
  await writeFile(join(state, 'calls.log'), '')
  await writeFile(join(state, 'terminals.json'), '[]')
}

describe('rd', () => {
  // scripts/remote-dev.sh:75: `factory role get '<role>' --format json`, parsed at remote-dev.sh:79 (.role, .tier, .effort)
  const ROLES = {
    lead: ['sonnet', 'high'],
    implementer: ['sonnet', 'high'],
    verifier: ['haiku', 'high'],
    reviewer: ['sonnet', 'medium'],
    Explore: ['haiku', 'high'],
  } as const

  for (const [role, [tier, effort]] of Object.entries(ROLES)) {
    test(`factory role get ${role} prints exactly {role, tier, effort}`, async () => {
      const got = await call(v, ['role', 'get', role, '--format', 'json'], 'owner')
      expect(got.code).toBe(0)
      expect(got.json).toEqual({ role, tier, effort })
    })

    rdTest(`rd work --role ${role} resolves ${tier}/${effort} through the real CLI`, async () => {
      await resetState()
      const ran = await rd(['work', 'example', '--role', role])
      expect(ran.err + ran.out).not.toContain('unavailable')
      const run = JSON.parse(readFileSync(join(state, 'runs.jsonl'), 'utf8').trim().split('\n')[0] ?? '{}') as {
        env?: Record<string, string>
        argv?: string[]
      }
      expect(run.env?.FACTORY_ROLE).toBe(role)
      const argv = (run.argv ?? []).join(' ')
      expect(argv).toContain(tier)
      expect(argv).toContain(effort)
    })
  }

  test('an unknown role is error.kind not_found on stderr, exit 4', async () => {
    const got = await call(v, ['role', 'get', 'nobody', '--format', 'json'], 'owner')
    expect(got.code).toBe(4)
    expect(got.error?.kind).toBe('not_found')
  })

  rdTest('rd work --role nobody stops with exit 2 and starts nothing', async () => {
    await resetState()
    const ran = await rd(['work', 'example', '--role', 'nobody'])
    expect(ran.code).toBe(2)
    expect(ran.err).toContain("unknown role 'nobody'")
    expect(existsSync(join(state, 'runs.jsonl'))).toBe(false)
  })

  // scripts/remote-dev.sh:913: factory issue new --repo <path> --title … [--after N]… [--key K] --facts -   (JSON on stdin)
  rdTest('rd issue files an Issue with facts on stdin, an --after and a --key; the same key files once', async () => {
    const first = await rd(['issue', 'example', 'Seed the cache', '--key', 'rd-1'], {})
    expect(first.code).toBe(0)
    const seed = (JSON.parse(first.out) as { issue: string }).issue
    expect(seed).toMatch(/^issue_\d+$/)

    const filed = await rd(
      [
        'issue',
        'example',
        'Warm the cache after seeding',
        '--facts',
        '-',
        '--after',
        seed.slice('issue_'.length),
        '--key',
        'rd-2',
      ],
      {},
      '{"host":"mini","count":3}',
    )
    expect(filed.err).toBe('')
    expect(filed.code).toBe(0)
    const body = JSON.parse(filed.out) as { issue: string; state: string; filed: boolean }
    expect(body).toMatchObject({ state: 'settling', filed: true })
    const [edge] = await v.w.world.db
      .sql`SELECT count(*)::int AS n FROM factory.issue_events WHERE issue_id = ${body.issue} AND kind = 'filed'`
    expect((edge as { n: number }).n).toBe(1)

    const again = await rd(['issue', 'example', 'Warm the cache after seeding', '--key', 'rd-2'])
    expect(JSON.parse(again.out)).toMatchObject({ issue: body.issue, filed: false })
  })

  rdTest('rd issue for a repo outside the roots passes the CLI exit code through (422 is usage, 2)', async () => {
    const bad = await rd(['issue', 'nosuchrepo', 'x'])
    expect(bad.code).not.toBe(0)
  })

  // scripts/remote-dev.sh:924: factory issue list "$@"
  rdTest('rd issues lists the cards', async () => {
    const listed = await rd(['issues'])
    expect(listed.code).toBe(0)
    const cards = (JSON.parse(listed.out) as { issues: { ref: string; title: string }[] }).issues
    expect(cards.map((card) => card.title)).toContain('Seed the cache')
  })

  // scripts/remote-dev.sh:836-847: factory session note "$key" "$text"; a definite not_found falls back to hc send
  rdTest(
    'rd say notes a current lead through the factory and falls back to hc for a session that is no lead',
    async () => {
      const issue = await v.w.admitted('a lead to talk to')
      await v.w.tick()
      const key = `lead-${issue.slice('issue_'.length)}-1`
      const agent = (name: string, label: string, address: string) => ({
        address,
        name,
        cwd: v.w.repo,
        argv: ['claude'],
        status: { app: 'claude-code', state: 'idle' },
        labels: { 'factory.key': label },
      })
      await resetState()
      await writeFile(
        join(state, 'terminals.json'),
        JSON.stringify([agent(key, key, 't5'), agent('worker', 'worker', 't6')]),
      )

      const noted = await rd(['say', key, 'go on with the second part'])
      expect(noted.code).toBe(0)
      expect(noted.out).toContain('noted: the factory holds it')
      const events = await v.events(issue, 'noted')
      expect(events.some((event) => JSON.stringify(event.payload).includes('second part'))).toBe(true)

      const direct = await rd(['say', 'worker', 'hello there'])
      expect(direct.err).toContain("the factory has no session 'worker'")
      expect(readFileSync(join(state, 'calls.log'), 'utf8')).toContain('send -- t6 hello there')
    },
  )

  // devhost health: `factory health` (remote-dev.sh:435) answers exit 0 on a healthy server
  rdTest('factory health is exit 0 and prints the Health body', async () => {
    const health = await sh(['factory', 'health'])
    expect(health.code).toBe(0)
    expect(JSON.parse(health.out)).toMatchObject({ status: 'ok', version: 'scenario' })
  })
})

describe('ask-human', () => {
  // scripts/ask-human.sh:680: factory session note "$session" "$msg" --id "ask-human-$id"; the pane has the agent token
  test.skipIf(!have(ASK_HUMAN))(
    'its delivery note reaches the lead once; a repeat with the same --id is one note',
    async () => {
      const issue = await v.w.admitted('a lead that asked the human')
      await v.w.tick()
      const session = `lead-${issue.slice('issue_'.length)}-1`
      const env = { FACTORY_TOKEN: TOKENS.agent, FACTORY_SESSION: session }
      const msg = 'human queue: "approve the deploy" was approved (approved)'
      const before = v.w.terminals().at(-1)?.sent.length ?? 0

      const first = await sh(['factory', 'session', 'note', session, msg, '--id', 'ask-human-abc'], env)
      expect(first.code).toBe(0)
      const again = await sh(['factory', 'session', 'note', session, msg, '--id', 'ask-human-abc'], env)
      expect(again.code).toBe(0)
      await v.w.tick()
      const typed = (v.w.terminals().at(-1)?.sent ?? [])
        .slice(before)
        .filter((text) => text.includes('approve the deploy'))
      expect(typed).toHaveLength(1)
    },
  )

  test.skipIf(!have(ASK_HUMAN))('the sweep itself delivers through the shim (HUMAN_QUEUE_FACTORY)', async () => {
    const issue = await v.w.admitted('a lead that waits for the human queue')
    await v.w.tick()
    const session = `lead-${issue.slice('issue_'.length)}-1`
    const queue = join(scratch, 'xstate', 'human-queue')
    await mkdir(queue, { recursive: true })
    const id = '20260101T000000-1'
    await writeFile(join(queue, `${id}.req`), JSON.stringify({ text: 'ship the sweep note?', session }))
    await writeFile(join(queue, `${id}.res`), JSON.stringify({ status: 'approved', resolvedAs: 'yes' }))
    const before = v.w.terminals().at(-1)?.sent.length ?? 0
    const ran = await sh(['bash', ASK_HUMAN, 'reap'], {
      FACTORY_TOKEN: TOKENS.agent,
      FACTORY_SESSION: session,
      XDG_STATE_HOME: join(scratch, 'xstate'),
    })
    expect(ran.code).toBe(0)
    expect(existsSync(join(queue, `${id}.notified`))).toBe(true)
    await v.w.tick()
    const typed = (v.w.terminals().at(-1)?.sent ?? []).slice(before).join('\n')
    expect(typed).toContain('ship the sweep note?')
  })
})

describe('hooks', () => {
  const slotHook = (command: string, cwd: string) =>
    sh(['bun', TEST_SLOT], {}, JSON.stringify({ tool_name: 'Bash', tool_input: { command }, cwd }))

  const rewritten = async (command: string, cwd: string): Promise<string> => {
    const out = await slotHook(command, cwd)
    expect(out.code).toBe(0)
    return (JSON.parse(out.out) as { hookSpecificOutput: { updatedInput: { command: string } } }).hookSpecificOutput
      .updatedInput.command
  }

  // hooks/test-slot.ts:209: factory slot run --name '<repo> <runner>' -- env … -c '<command>'
  test.skipIf(!have(TEST_SLOT))(
    'test-slot rewrites make test to factory slot run; it runs in a slot and passes the exit code',
    async () => {
      const dir = join(scratch, 'slotted')
      await mkdir(dir, { recursive: true })
      await writeFile(
        join(dir, 'Makefile'),
        `test:\n\t-@factory capacity get > ${join(dir, 'held.json')}\n\t@echo slotted-output\n\t@exit 7\n`,
      )
      const command = await rewritten('make test', dir)
      expect(command).toContain('factory slot run --name')

      const ran = await sh(['sh', '-c', `cd ${dir} && ${command}`], {})
      expect(ran.out).toContain('slotted-output')
      expect(ran.code).toBe(2) // make's own code for a failed recipe, passed through the slot
      // the slot was held while the command ran, and is free after it
      const during = JSON.parse(readFileSync(join(dir, 'held.json'), 'utf8')) as { slots: { held: { name: string }[] } }
      expect(during.slots.held.map((slot) => slot.name)).toEqual(['slotted make test'])
      const after = await call(v, ['capacity', 'get'])
      expect((after.json as { slots: { held: unknown[] } }).slots.held).toEqual([])
    },
  )

  test.skipIf(!have(TEST_SLOT))(
    'with no token the slot call is 401 and slot run still runs the command (open on an outage)',
    async () => {
      const dir = join(scratch, 'slotted')
      const command = await rewritten('make test', dir)
      const ran = await sh(['sh', '-c', `cd ${dir} && ${command}`], { FACTORY_TOKEN: '' })
      expect(ran.out).toContain('slotted-output')
      expect(ran.code).toBe(2) // make's own code for a failed recipe, passed through the slot
      const lines = ran.err.trim().split('\n').filter(Boolean)
      expect(lines.length).toBeGreaterThanOrEqual(1)
      expect(lines.join(' ')).toMatch(/slot|factory|auth|401/i)
    },
  )

  // hooks/review-bypass-guard.ts:52 names `factory issue ask`
  test.skipIf(!have(REVIEW_GUARD))('review-bypass-guard names factory issue ask, which exists', async () => {
    expect(readFileSync(REVIEW_GUARD, 'utf8')).toContain('factory issue ask')
    const help = await call(v, ['issue', 'ask', '--help'], 'none')
    expect(help.code).toBe(0)
  })

  // integrations/claude-code/hooks.json: `[ -n "$FACTORY_SESSION" ] && command -v factory >/dev/null && factory hook <event>; exit 0`
  const EVENTS = ['session-start', 'user-prompt-submit', 'stop', 'stop-failure', 'notification', 'session-end'] as const
  const INPUT: Record<(typeof EVENTS)[number], Record<string, unknown>> = {
    'session-start': { source: 'startup', session_id: 'dot-1' },
    'user-prompt-submit': { session_id: 'dot-1', prompt: 'go' },
    stop: { stop_hook_active: false },
    'stop-failure': { error: 'rate_limit' },
    notification: { notification_type: 'idle_prompt' },
    'session-end': { reason: 'other' },
  }

  test.skipIf(!have(HOOKS))(
    'each hook command of integrations/claude-code/hooks.json runs: stdout empty, exit 0, the server recorded it',
    async () => {
      const issue = await v.w.admitted('a lead whose hooks fire')
      await v.w.tick()
      const session = `lead-${issue.slice('issue_'.length)}-1`
      const settings = JSON.parse(readFileSync(HOOKS, 'utf8')) as {
        hooks: Record<string, { hooks: { command: string }[] }[]>
      }
      const commands = Object.values(settings.hooks)
        .flat()
        .flatMap((entry) => entry.hooks.map((hook) => hook.command))
      for (const event of EVENTS) {
        const command = commands.find((text) => text.includes(`factory hook ${event};`))
        expect(command).toBeDefined()
        const ran = await sh(['sh', '-c', command ?? ''], { FACTORY_SESSION: session }, JSON.stringify(INPUT[event]))
        // Stop exits 2 only for a send-back (a lead that still has work stopped), with the reason on stderr.
        const sendBack = event === 'stop' && ran.code === 2
        expect({ event, code: sendBack ? 0 : ran.code, out: ran.out }).toEqual({ event, code: 0, out: '' })
        if (sendBack) expect(ran.err.trim()).not.toBe('')
      }
      // the guard: no FACTORY_SESSION, nothing happens and nothing is printed
      const none = await sh(
        ['sh', '-c', commands.find((text) => text.includes('factory hook stop;')) ?? 'exit 9'],
        {},
        '{}',
      )
      expect(none).toEqual({ code: 0, out: '', err: '' })

      const spooled = readFileSync(join(v.w.spool, `${session}.jsonl`), 'utf8')
        .trim()
        .split('\n')
      const kinds = spooled.map((line) => (JSON.parse(line) as { kind: string }).kind)
      // the Stop of a lead that still has work is answered as a send-back and is not spooled
      expect(kinds).toEqual(['session_started', 'turn_started', 'limit_stop', 'prompt_idle', 'session_ended'])
      await v.w.tick()
      const read = await call(v, ['read', 'session', session])
      expect(read.code).toBe(0)
      expect(read.json).toMatchObject({ id: session, issue: Number(issue.slice('issue_'.length)) })
    },
  )
})
