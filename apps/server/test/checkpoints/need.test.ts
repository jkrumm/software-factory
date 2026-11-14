import { describe, expect, test } from 'bun:test'
import { isApprovalCommand, miniPart, miniShellLine, needByRule, needOf } from '../../src/domains/checkpoints/need.ts'
import { pushQueue } from '../../src/domains/checkpoints/desk.ts'
import type { ErrandRecord } from '../../src/domains/checkpoints/ports.ts'

/**
 * The seven days before 2026-11-14: the 15 Errands that carried a MacBook command and reached the owner, as the filing of this
 * Issue sorted them. A: his hands or a secret only he has. B: a place to run, no secret. C: only his yes, and the command runs on
 * the mini. D: the repeats (the reseal and the sudoers install were raised again and again).
 */
interface Seen {
  id: string
  summary: string
  command: string
  host: 'macbook'
  /** what the filing says it really needed */
  class: 'A' | 'B' | 'C'
}

const reseal = "cd ~/SourceRoot/dotfiles && hc run --timeout 900 'make secrets-seed'"
const sudoers = 'sudo make -C ~/SourceRoot/dotfiles sudoers-install'
const week: Seen[] = [
  ...[1, 2, 3, 4, 5].map((n): Seen => ({
    id: `reseal-${n}`,
    summary: 'Reseal the mini secrets cache',
    command: reseal,
    host: 'macbook',
    class: 'A',
  })),
  ...[1, 2, 3, 4].map((n): Seen => ({
    id: `sudoers-${n}`,
    summary: 'Install the sudoers rule for the host',
    command: sudoers,
    host: 'macbook',
    class: 'A',
  })),
  {
    id: 'bulb',
    summary: 'The hallway bulb does not respond: power-cycle it',
    command: 'home doctor',
    host: 'macbook',
    class: 'A',
  },
  {
    id: 'dotfiles',
    summary: 'Pull dotfiles and link Herdr glance on the MacBook',
    command: 'cd ~/SourceRoot/dotfiles && git pull && make link-herdr-glance',
    host: 'macbook',
    class: 'B',
  },
  {
    id: 'ntfy',
    summary: 'Install NtfyMac.app on the MacBook',
    command: 'brew install --cask ntfymac',
    host: 'macbook',
    class: 'B',
  },
  {
    id: 'gate-make',
    summary: "Release the colleague's commit 78088f16",
    command: "ssh mini 'make -C ~/IuRoot/epos-tool-athena deploy-release SHA=78088f16'",
    host: 'macbook',
    class: 'C',
  },
  {
    id: 'gate-py',
    summary: "Release the colleague's commit 78088f16 through the gate",
    command: "ssh mini 'python3 ~/gate/gate.py release 78088f16'",
    host: 'macbook',
    class: 'C',
  },
  {
    id: 'gate-standalone',
    summary: "Release the colleague's commit 78088f16",
    command: 'make -C ~/IuRoot/epos-tool-athena deploy-release SHA=78088f16',
    host: 'macbook',
    class: 'C',
  },
]

const record = (seen: Seen, need: ReturnType<typeof needOf>): ErrandRecord =>
  ({
    id: seen.id,
    summary: seen.summary,
    detail: null,
    command: seen.command,
    host: seen.host,
    doneAt: null,
    reachedOwnerAt: new Date('2026-11-10T08:00:00Z'),
    raisedAt: new Date('2026-11-10T08:00:00Z'),
    pushedAt: null,
    runStatus: null,
    runAttempts: 0,
    source: 'ask-human',
    need,
  }) as unknown as ErrandRecord

describe('the seven-day replay of the 15 command Errands', () => {
  const classed = week.map((seen) => ({ seen, need: needOf({ ...seen, detail: null }) }))

  test('there are 15, and each is classed by its shape alone', () => {
    expect(week).toHaveLength(15)
    for (const { seen, need } of classed) {
      const expected = seen.class === 'C' ? 'approval' : seen.class === 'B' ? 'place' : need
      expect({ id: seen.id, need }).toEqual({ id: seen.id, need: expected })
      if (seen.class === 'A') expect(['secret', 'hands']).toContain(need)
    }
  })

  test('the owner coming back is paged on the MacBook for class A only', () => {
    const open = classed.map(({ seen, need }) => record(seen, need))
    const pushed = pushQueue(open, new Date('2026-11-14T08:00:00Z'), true).map((errand) => String(errand.id))
    const classA = week.filter((seen) => seen.class === 'A').map((seen) => seen.id)
    expect(pushed.toSorted()).toEqual(classA.toSorted())
    // his own button also pushes the places to run, and still never an approval
    const button = pushQueue(open, new Date('2026-11-14T08:00:00Z'), true, { includePlace: true }).map((errand) =>
      String(errand.id),
    )
    expect(button.toSorted()).toEqual([...classA, 'dotfiles', 'ntfy'].toSorted())
    expect(button.filter((id) => id.startsWith('gate'))).toEqual([])
  })

  test('a command that failed twice is not offered a third time unchanged', () => {
    const seen = week[0]
    if (!seen) throw new Error('no fixture')
    const failed = { ...record(seen, 'secret'), runAttempts: 2, runStatus: 'failed' } as unknown as ErrandRecord
    expect(pushQueue([failed], new Date('2026-11-14T08:00:00Z'), true)).toEqual([])
  })
})

describe('what an Errand needs, by its shape', () => {
  test('a secret word beats everything, an approval is a command for the mini that names none', () => {
    expect(
      needByRule({ summary: 'x', detail: null, command: "ssh mini 'sudo launchctl kickstart x'", host: 'macbook' }),
    ).toBe('secret')
    expect(needByRule({ summary: 'Unlock 1Password', detail: null, command: null, host: null })).toBe('secret')
    expect(
      needByRule({ summary: 'x', detail: null, command: "ssh mini 'make deploy-release SHA=1'", host: 'macbook' }),
    ).toBe('approval')
    expect(isApprovalCommand("ssh -o BatchMode=yes mini 'make x'")).toBe(true)
    expect(isApprovalCommand('make x')).toBe(false)
  })

  test('a device or a portal is hands; a bare command for the MacBook is a place; the rest is left to the model, then hands', () => {
    expect(needByRule({ summary: 'Plug in the phone', detail: null, command: null, host: null })).toBe('hands')
    expect(needByRule({ summary: 'Rotate the key', detail: null, command: null, host: 'portal' })).toBe('hands')
    expect(
      needByRule({ summary: 'Install the app', detail: null, command: 'brew install --cask x', host: 'macbook' }),
    ).toBe('place')
    expect(needByRule({ summary: 'Something', detail: null, command: null, host: null })).toBeNull()
    expect(needOf({ summary: 'Something', detail: null, command: null, host: null })).toBe('hands')
    // the model may say secret or hands; it never makes an approval, and a place needs a command
    expect(needOf({ summary: 'Something', detail: null, command: null, host: null }, 'approval')).toBe('hands')
    expect(needOf({ summary: 'Something', detail: null, command: null, host: null }, 'place')).toBe('hands')
    expect(needOf({ summary: 'Something', detail: null, command: 'x', host: 'any' }, 'place')).toBe('place')
  })
})

describe('a command addressed to the mini runs there as the shell there would run it', () => {
  const run = async (command: string): Promise<string> => {
    const done = Bun.spawn(['sh', '-c', miniShellLine(command)], { stdout: 'pipe', stderr: 'pipe' })
    return (await new Response(done.stdout).text()).trim()
  }

  test('ssh mini takes its quotes off, and a command with no host is itself', async () => {
    expect(miniPart("ssh mini 'echo hi there'")).toBe("'echo hi there'")
    expect(await run("ssh mini 'echo hi there'")).toBe('hi there')
    expect(await run('ssh mini \'printf %s "a b" && echo "$((1 + 2))"\'')).toBe('a b3')
    expect(await run('echo plain')).toBe('plain')
    expect(miniShellLine('make x')).toBe('make x')
  })
})
