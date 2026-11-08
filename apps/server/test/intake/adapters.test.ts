import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileProjectSignals, stubProjectSignals } from '../../src/adapters/intake/projects.ts'
import { makeRestartRunbook } from '../../src/adapters/intake/runbook.ts'
import { selfPaced } from '../../src/adapters/intake/schedule.ts'
import { everyMs, loadIntakeEnv } from '../../src/adapters/intake/settings.ts'
import { infraTopology } from '../../src/adapters/intake/topology.ts'
import { parseInfra } from '../../src/domains/intake/infra.ts'

let dir: string | undefined
afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true })
  dir = undefined
})

describe('settings', () => {
  test('a duration is ms, s, m, h or off', () => {
    expect([everyMs('500ms'), everyMs('30s'), everyMs('5m'), everyMs('2h'), everyMs('off'), everyMs('soon')]).toEqual([
      500,
      30_000,
      300_000,
      7_200_000,
      null,
      undefined,
    ])
  })

  test('the defaults, and one message naming every bad key', () => {
    const env = loadIntakeEnv({ HOME: '/home/x' })
    expect(env).toMatchObject({
      sourceRoot: '/home/x/SourceRoot',
      incidentWindowMs: 30 * 60_000,
      fingerprintWindowMs: 24 * 60 * 60_000,
      github: { token: null, everyMs: 300_000, backlog: false },
      beszel: { everyMs: 60_000 },
      settleEveryMs: 10_000,
    })
    expect(() => loadIntakeEnv({ FACTORY_GITHUB_POLL: 'often', FACTORY_INCIDENT_WINDOW_MIN: '0' })).toThrow(
      /FACTORY_GITHUB_POLL.*FACTORY_INCIDENT_WINDOW_MIN|FACTORY_INCIDENT_WINDOW_MIN.*FACTORY_GITHUB_POLL/,
    )
  })
})

describe('projects', () => {
  test('the stub knows no project', async () => {
    expect(await stubProjectSignals.find('argo')).toEqual({ ok: true, value: null })
  })

  test('a project file lists what each hears; configuring github or launchd lists it', async () => {
    dir = await mkdtemp('/tmp/factory-projects-')
    const path = join(dir, 'p.json')
    await writeFile(
      path,
      JSON.stringify({
        projects: [
          { repo: 'argo', github: { label: 'factory', checks: true }, launchd: ['com.example.job'] },
          { repo: 'chat', work: true },
        ],
      }),
    )
    const projects = fileProjectSignals(path)
    const argo = await projects.find('argo')
    expect(argo.ok && argo.value?.sources.toSorted()).toEqual(['checks', 'github', 'launchd'])
    const chat = await projects.find('chat')
    expect(chat.ok && chat.value).toMatchObject({ work: true, sources: [], heal: [] })
    expect(await projects.find('nowhere')).toEqual({ ok: true, value: null })
  })

  test('a missing or bad file is an error, never an empty list', async () => {
    dir = await mkdtemp('/tmp/factory-projects-')
    expect(await fileProjectSignals(join(dir, 'none.json')).polled()).toMatchObject({
      ok: false,
      error: { kind: 'unreadable' },
    })
    const bad = join(dir, 'bad.json')
    await writeFile(bad, JSON.stringify({ projects: [{ repo: 'x', unknown: 1 }] }))
    expect(await fileProjectSignals(bad).find('x')).toMatchObject({ ok: false })
  })
})

describe('topology', () => {
  test("a host's repo is on that host", async () => {
    const infra = parseInfra(JSON.stringify({ hosts: { vps: { repo: 'vps' }, homelab: { repo: 'homelab' } } }))
    const loaded = await infraTopology(infra).load()
    expect(loaded.ok && [loaded.value.hostOfRepo.get('vps'), loaded.value.hosts.has('homelab')]).toEqual(['vps', true])
  })
})

describe('the runbook', () => {
  test('a repo with no restart target is skipped with a reason; one with it runs once', async () => {
    const calls: string[][] = []
    const lacking = makeRestartRunbook({
      sourceRoot: '/root',
      run: (command) => {
        calls.push([...command])
        return Promise.resolve({ exit: 2, stdout: 'No rule' })
      },
    })
    expect(await lacking.run({ repo: 'argo', runbook: 'make restart' })).toEqual({
      ok: true,
      value: { ran: false, reason: 'no restart target' },
    })
    expect(calls).toHaveLength(1)

    const answers = [
      { exit: 0, stdout: '' },
      { exit: 3, stdout: 'boom\n' },
    ]
    const has = makeRestartRunbook({
      sourceRoot: '/root',
      run: () => Promise.resolve(answers.shift() ?? { exit: 0, stdout: '' }),
    })
    expect(await has.run({ repo: 'argo', runbook: 'make restart' })).toEqual({
      ok: true,
      value: { ran: true, exit: 3, tail: 'boom' },
    })
  })

  test('a runbook that does not finish is reported, not thrown', async () => {
    const answers = [
      { exit: 0, stdout: '' },
      { exit: null, stdout: '' },
    ]
    const slow = makeRestartRunbook({
      sourceRoot: '/root',
      run: () => Promise.resolve(answers.shift() ?? { exit: 0, stdout: '' }),
    })
    const done = await slow.run({ repo: 'argo', runbook: 'make restart' })
    expect(done.ok && done.value.ran && done.value.exit).toBe(-1)
  })
})

describe('selfPaced', () => {
  test('a pass still running when the next is due is skipped; a failing pass does not stop the schedule', async () => {
    let started = 0
    const lines: string[] = []
    let release: () => void = () => undefined
    const stop = selfPaced(
      'probe',
      10,
      async () => {
        started++
        if (started === 1) await new Promise<void>((resolve) => (release = resolve))
        if (started === 2) throw new Error('boom')
      },
      { firstMs: 5, log: (line) => lines.push(line) },
    )
    await Bun.sleep(60)
    expect(started).toBe(1)
    release()
    await Bun.sleep(60)
    expect(started).toBeGreaterThanOrEqual(3)
    expect(lines).toEqual(['probe: boom'])
    await stop()
    const after = started
    await Bun.sleep(40)
    expect(started).toBe(after)
  })
})
