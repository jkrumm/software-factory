import { describe, expect, test } from 'bun:test'
import { replayErrands, type ReplayRow, summarize, wronglyRun } from '../../src/domains/checkpoints/triage-replay.ts'
import {
  DECLINE_HOLD_MS,
  macbookVerbOf,
  MACBOOK_REPORTS,
  refuseBotCheck,
  refuseDeclined,
  refuseEmptyPlace,
  refuseKeyless,
  refuseUnroutable,
  triage,
  type StatedNeed,
  type TriageInput,
  verbFor,
  verbWords,
} from '../../src/domains/checkpoints/triage.ts'

const NOW = new Date('2026-11-16T12:00:00Z')

const input = (over: Partial<TriageInput> & { summary: string }): TriageInput => ({
  detail: null,
  command: null,
  host: null,
  ...over,
})

const decide = (
  over: Partial<TriageInput> & { summary: string },
  context: Partial<Parameters<typeof triage>[1]> = {},
) =>
  triage(input(over), {
    standalone: false,
    stated: 'hands',
    declined: null,
    now: NOW,
    ...context,
  })

describe('(a) a command that runs wholly on the mini or over keyless ssh is refused', () => {
  test.each([
    ["ssh mini 'make -C ~/SourceRoot/dotfiles deploy-gate-install'", 'the mini'],
    ['ssh -t mini hc run --on mini true', 'the mini'],
    ['ssh homelab docker ps', 'homelab'],
    ["ssh vps 'systemctl status caddy'", 'vps'],
    ['hc run --on mini -- factory capacity relearn', 'the mini'],
  ])('%s', (command, where) => {
    const refusal = refuseKeyless(input({ summary: 'Run it', command, host: 'macbook' }))
    expect(refusal).toContain(where)
    expect(refusal).toContain('run it yourself')
    expect(refusal).toContain('Nothing was raised')
  })

  test('his yes stays his: a reboot, a core update, the gate release, a delete', () => {
    for (const command of [
      "ssh mini 'sudo reboot'",
      'ssh mini hc update',
      "ssh mini 'make -C ~/SourceRoot/dotfiles herdr-core-update'",
      "ssh mini 'make -C ~/gate deploy-release SHA=feedbeef'",
      'ssh mini rm -rf ~/old-releases',
      "ssh mini 'launchctl bootout gui/501/x'",
    ]) {
      expect(refuseKeyless(input({ summary: 'Do it', command, host: 'macbook' }))).toBeNull()
    }
    // the planned restart is named in the words, whatever the command
    expect(
      refuseKeyless(
        input({ summary: 'The mini needs its planned restart', command: 'ssh mini uptime', host: 'macbook' }),
      ),
    ).toBeNull()
  })

  test('a secret, sudo, a passphrase or a person is never refused as the host’s work', () => {
    for (const command of [
      "ssh mini 'sudo -S make install'",
      'op read op://Private/x/password | ssh mini cat',
      "ssh homelab 'echo passphrase'",
    ])
      expect(refuseKeyless(input({ summary: 'Do it', command, host: 'macbook' }))).toBeNull()
    expect(
      refuseKeyless(input({ summary: 'Tap the button on the router', command: 'ssh mini true', host: 'macbook' })),
    ).toBeNull()
  })

  test('a MacBook command is not the host’s work', () => {
    expect(refuseKeyless(input({ summary: 'Pull', command: 'git -C ~/SourceRoot/brain pull --ff-only' }))).toBeNull()
    expect(refuseKeyless(input({ summary: 'Look at it' }))).toBeNull()
  })
})

describe('(b) a MacBook command in a fixed class runs through its verb', () => {
  test('the reports are exactly their registry commands', () => {
    for (const [name, command] of Object.entries(MACBOOK_REPORTS)) {
      expect(macbookVerbOf(command, 'macbook')).toEqual({ verb: 'report', name })
      expect(macbookVerbOf(`  ${command.replace(/ /g, '   ')} ; `, null)).toEqual({ verb: 'report', name })
    }
    expect(macbookVerbOf('mount | grep smbfs | wc -l', 'macbook')).toBeNull()
    expect(macbookVerbOf('mount', 'macbook')).toBeNull()
  })

  test('a pull is ff-only, of a checkout under ~/SourceRoot, by a plain name', () => {
    expect(macbookVerbOf('git -C ~/SourceRoot/brain pull --ff-only', 'macbook')).toEqual({
      verb: 'repo-pull',
      name: 'brain',
    })
    expect(macbookVerbOf('git -C $HOME/SourceRoot/usage-tracker pull --ff-only', null)).toEqual({
      verb: 'repo-pull',
      name: 'usage-tracker',
    })
    for (const command of [
      'git -C ~/SourceRoot/brain pull',
      'git -C ~/SourceRoot/brain pull --ff-only --rebase',
      'git -C ~/SourceRoot/brain pull --ff-only && make install',
      'git -C ~/SourceRoot/../.ssh pull --ff-only',
      'git -C ~/SourceRoot/Brain pull --ff-only',
      'git -C ~/SourceRoot/a/b pull --ff-only',
      'git -C ~/Documents/x pull --ff-only',
      'git -C ~/SourceRoot/brain pull --ff-only; rm -rf ~',
    ])
      expect(macbookVerbOf(command, 'macbook')).toBeNull()
  })

  test('the dotfiles pull stays the sync verb that runs the make targets', () => {
    expect(macbookVerbOf('git -C ~/SourceRoot/dotfiles pull --ff-only', 'macbook')).toEqual({ verb: 'dotfiles-sync' })
    expect(macbookVerbOf('git -C ~/SourceRoot/dotfiles pull --ff-only && make herdr-app-setup', 'macbook')).toEqual({
      verb: 'dotfiles-sync',
    })
  })

  test('only a command for the MacBook; the words that go over ssh are the verb and one name', () => {
    expect(macbookVerbOf('mount | grep smbfs', 'iphone')).toBeNull()
    expect(macbookVerbOf('mount | grep smbfs', 'portal')).toBeNull()
    expect(macbookVerbOf(null, 'macbook')).toBeNull()
    expect(verbWords({ verb: 'repo-pull', name: 'brain' })).toEqual(['repo-pull', 'brain'])
    expect(verbWords({ verb: 'dotfiles-sync' })).toEqual(['dotfiles-sync'])
  })

  test('a secret, a password or hands in the Errand keeps a class command from running', () => {
    const report = MACBOOK_REPORTS['smb-mounts']
    expect(verbFor(input({ summary: 'Check the mounts', command: report, host: 'macbook' }))).toEqual({
      verb: 'report',
      name: 'smb-mounts',
    })
    expect(
      verbFor(input({ summary: 'Check the mounts after the keychain password prompt', command: report })),
    ).toBeNull()
    expect(verbFor(input({ summary: 'Look at the router and press the button', command: report }))).toBeNull()
    expect(
      verbFor(input({ summary: 'Pull it', command: 'git -C ~/SourceRoot/brain pull --ff-only', host: 'iphone' })),
    ).toBeNull()
  })
})

describe('(c) a bot check is not an Errand', () => {
  test('a research handoff is refused for a request, with the route', () => {
    const text = 'agw: example.com shows a bot check the research Chrome cannot pass. Open screen share to the mini'
    const refusal = refuseBotCheck(input({ summary: text, command: 'open vnc://mini' }))
    expect(refusal).toContain('report the page as blocked')
    expect(refusal).toContain('go on with other sources')
  })

  test('only a request: an Issue’s own Errand about a page is not read by the rule', () => {
    const text = 'The vendor portal shows a captcha; the Issue cannot be answered without the page'
    expect(decide({ summary: text }, { standalone: true })).toMatchObject({ action: 'refuse', rule: 'bot_check' })
    expect(decide({ summary: text }, { standalone: false })).toEqual({ action: 'reach' })
  })

  test('words that only sound alike pass', () => {
    expect(refuseBotCheck(input({ summary: 'Open the dashboard and look at the chart' }))).toBeNull()
  })
})

describe('(d) an ask the owner declined is not raised again for a stated time', () => {
  const declined = (hoursAgo: number) => ({
    at: new Date(NOW.getTime() - hoursAgo * 3_600_000),
    note: 'Not now: the mini restarts on Sunday',
  })

  test('within the hold the refusal carries his note', () => {
    const refusal = refuseDeclined(declined(1), NOW)
    expect(refusal).toContain('Not now: the mini restarts on Sunday')
    expect(refusal).toContain('3 days')
    expect(refuseDeclined(declined(71), NOW)).not.toBeNull()
  })

  test('after the hold, or with nothing declined, the ask is raised', () => {
    expect(refuseDeclined(declined(73), NOW)).toBeNull()
    expect(refuseDeclined(declined(DECLINE_HOLD_MS / 3_600_000 + 0.01), NOW)).toBeNull()
    expect(refuseDeclined(null, NOW)).toBeNull()
  })

  test('it comes before every other rule, even for a secret ask', () => {
    expect(decide({ summary: 'Reseal', command: 'op read op://x/y/z' }, { declined: declined(2) })).toMatchObject({
      action: 'refuse',
      rule: 'declined',
    })
  })
})

describe('(e) the need is stated', () => {
  test('a request with no command, no stated need and words that say nothing is refused', () => {
    expect(refuseUnroutable(input({ summary: 'Please have a look at the thing' }), null)).toContain('--need')
    expect(refuseUnroutable(input({ summary: 'Please have a look at the thing' }), 'hands')).toBeNull()
  })

  test('a command or words the rules read need no stated need', () => {
    expect(refuseUnroutable(input({ summary: 'Run it', command: 'make deploy' }), null)).toBeNull()
    expect(refuseUnroutable(input({ summary: 'Tap the button on the router' }), null)).toBeNull()
    expect(refuseUnroutable(input({ summary: 'Enter the 1Password master password' }), null)).toBeNull()
  })

  test('a place is a command', () => {
    expect(refuseEmptyPlace(input({ summary: 'Do it' }), 'place')).toContain('--cmd')
    expect(refuseEmptyPlace(input({ summary: 'Do it', command: 'make x' }), 'place')).toBeNull()
    expect(refuseEmptyPlace(input({ summary: 'Do it' }), 'hands')).toBeNull()
  })
})

/**
 * The classes of the 88 Errands of 2026-11-08 to 2026-11-16 as the filing of this Issue sorted them, each with the answer the
 * rules must give. A secret, sudo, passphrase or hands Errand may be refused as a repeat or an empty ask, never auto-run.
 */
interface Seen {
  name: string
  input: TriageInput
  stated: StatedNeed | null
  standalone?: boolean
  expect: 'reach' | 'run' | 'keyless' | 'bot_check' | 'unroutable'
  /** the need the owner really had (the ones that need him must never run) */
  real: 'secret' | 'hands' | 'sudo' | 'passphrase' | 'none'
}

const seen: Seen[] = [
  {
    name: 'a read-only SMB mounts report',
    input: input({
      summary: 'Which smb mounts does the MacBook hold?',
      command: 'mount | grep smbfs',
      host: 'macbook',
    }),
    stated: 'place',
    expect: 'run',
    real: 'none',
  },
  {
    name: 'the ntfy-mac update check',
    input: input({ summary: 'Is a new ntfy-mac out?', command: 'ntfy-mac update --check', host: 'macbook' }),
    stated: 'place',
    expect: 'run',
    real: 'none',
  },
  {
    name: 'a pull of the owner’s own repo',
    input: input({
      summary: 'Pull brain on the MacBook',
      command: 'git -C ~/SourceRoot/brain pull --ff-only',
      host: 'macbook',
    }),
    stated: 'place',
    expect: 'run',
    real: 'none',
  },
  {
    name: 'the dotfiles pull with its targets',
    input: input({
      summary: 'Pull dotfiles on the MacBook',
      command: 'git -C ~/SourceRoot/dotfiles pull --ff-only && make -C ~/SourceRoot/dotfiles herdr-app-setup',
      host: 'macbook',
    }),
    stated: 'place',
    expect: 'run',
    real: 'none',
  },
  {
    name: 'a deploy-gate install on the mini wrapped in a dialog',
    input: input({
      summary: 'Install the deploy gate',
      command: "ssh mini 'make -C ~/SourceRoot/dotfiles deploy-gate-install'",
      host: 'macbook',
    }),
    stated: 'place',
    expect: 'keyless',
    real: 'none',
  },
  {
    name: 'a capacity relearn through hc run on the mini',
    input: input({
      summary: 'Relearn the capacity',
      command: 'hc run --on mini -- factory capacity relearn',
      host: 'macbook',
    }),
    stated: 'place',
    expect: 'keyless',
    real: 'none',
  },
  {
    name: 'a bot check handed off by research',
    input: input({
      summary: 'agw: example.com shows a bot check the research Chrome cannot pass. Open screen share to the mini',
      command: 'open vnc://mini',
      host: 'macbook',
    }),
    stated: null,
    standalone: true,
    expect: 'bot_check',
    real: 'none',
  },
  {
    name: 'an ask with no command and no need',
    input: input({ summary: 'Please have a look at the thing' }),
    stated: null,
    standalone: true,
    expect: 'unroutable',
    real: 'none',
  },
  {
    name: 'the secrets reseal',
    input: input({
      summary: 'Reseal the mini secrets cache',
      command: "cd ~/SourceRoot/dotfiles && hc run --timeout 900 'make secrets-seed'",
      host: 'macbook',
    }),
    stated: 'secret',
    expect: 'reach',
    real: 'secret',
  },
  {
    name: 'a sudoers install with his password',
    input: input({
      summary: 'Install the sudoers rule for the host',
      command: 'sudo make -C ~/SourceRoot/dotfiles sudoers-install',
      host: 'macbook',
    }),
    stated: 'secret',
    expect: 'reach',
    real: 'sudo',
  },
  {
    name: 'a sudo step over ssh to the mini',
    input: input({
      summary: 'Set the sysctl',
      command: "ssh mini 'sudo -S sysctl -w kern.maxfiles=1'",
      host: 'macbook',
    }),
    stated: 'secret',
    expect: 'reach',
    real: 'sudo',
  },
  {
    name: 'a command that reads 1Password and pipes it to a server',
    input: input({
      summary: 'Rotate the key',
      command: 'op item get x --fields password | ssh homelab tee /etc/key',
      host: 'macbook',
    }),
    stated: 'secret',
    expect: 'reach',
    real: 'secret',
  },
  {
    name: 'a key with a passphrase',
    input: input({ summary: 'Unlock the signing key; it asks for its passphrase', host: 'macbook' }),
    stated: 'secret',
    expect: 'reach',
    real: 'passphrase',
  },
  {
    name: 'a pull that also needs his keychain password',
    input: input({
      summary: 'Pull the private repo; the keychain password prompt appears',
      command: 'git -C ~/SourceRoot/brain pull --ff-only',
      host: 'macbook',
    }),
    stated: 'secret',
    expect: 'reach',
    real: 'secret',
  },
  {
    name: 'a portal step',
    input: input({ summary: 'Add the App Group in the Apple developer portal', host: 'portal' }),
    stated: 'hands',
    expect: 'reach',
    real: 'hands',
  },
  {
    name: 'a device step',
    input: input({ summary: 'Power-cycle the hallway bulb', command: 'home doctor', host: 'macbook' }),
    stated: 'hands',
    expect: 'reach',
    real: 'hands',
  },
  {
    name: 'the planned restart of the mini',
    input: input({ summary: 'Restart the mini for the planned update', command: 'ssh mini uptime', host: 'macbook' }),
    stated: 'hands',
    expect: 'reach',
    real: 'hands',
  },
  {
    name: 'a hands ask that happens to quote a report command',
    input: input({
      summary: 'Click the Allow button in the macOS prompt, then check the mounts',
      command: 'mount | grep smbfs',
      host: 'macbook',
    }),
    stated: 'hands',
    expect: 'reach',
    real: 'hands',
  },
  {
    name: 'a MacBook command with no secret outside the classes',
    input: input({
      summary: 'Install NtfyMac.app',
      command: 'make -C ~/SourceRoot/ntfy-mac install-macbook',
      host: 'macbook',
    }),
    stated: 'place',
    expect: 'reach',
    real: 'none',
  },
]

describe('a replay of the recorded classes', () => {
  for (const one of seen) {
    test(one.name, () => {
      const answer = triage(one.input, {
        standalone: one.standalone ?? false,
        stated: one.stated,
        declined: null,
        now: NOW,
      })
      const kind = answer.action === 'refuse' ? answer.rule : answer.action
      expect(kind).toBe(one.expect)
    })
  }

  test('none of the secret, sudo, passphrase or hands Errands is run or refused as the host’s work', () => {
    for (const one of seen.filter((s) => s.real !== 'none')) {
      const answer = triage(one.input, {
        standalone: one.standalone ?? false,
        stated: one.stated,
        declined: null,
        now: NOW,
      })
      expect(`${one.name}: ${answer.action}`).toBe(`${one.name}: reach`)
    }
  })
})

describe('replaying a recorded list', () => {
  const row = (over: Partial<ReplayRow> & { id: string; summary: string; raisedAt: string }): ReplayRow => ({
    issueId: 'issue_1',
    detail: null,
    command: null,
    host: null,
    need: 'hands',
    doneAt: null,
    doneNote: null,
    closedKind: null,
    closedBy: null,
    ...over,
  })
  const list: ReplayRow[] = [
    row({
      id: 'e1',
      summary: 'Which mounts?',
      command: 'mount | grep smbfs',
      host: 'macbook',
      need: 'place',
      raisedAt: '2026-11-10T10:00:00Z',
    }),
    row({
      id: 'e2',
      summary: 'Reseal',
      command: 'op read op://a/b/c',
      host: 'macbook',
      need: 'secret',
      raisedAt: '2026-11-10T11:00:00Z',
    }),
    row({
      id: 'e3',
      summary: 'Install the gate',
      command: "ssh mini 'make deploy-gate-install'",
      host: 'macbook',
      need: 'approval',
      raisedAt: '2026-11-10T12:00:00Z',
    }),
    row({
      id: 'e4',
      summary: 'Restart the mini',
      raisedAt: '2026-11-11T09:00:00Z',
      closedKind: 'turned_back',
      closedBy: 'owner',
      doneAt: '2026-11-11T09:05:00Z',
      doneNote: 'not now',
    }),
    row({ id: 'e5', summary: 'Restart the mini', raisedAt: '2026-11-12T09:00:00Z' }),
    row({ id: 'e6', summary: 'Restart the mini', raisedAt: '2026-11-20T09:00:00Z' }),
    row({ id: 'e7', summary: 'Something', need: null, issueId: null, raisedAt: '2026-11-12T10:00:00Z' }),
    row({ id: 'e8', summary: 'Add the App Group in the portal', host: 'portal', raisedAt: '2026-11-12T11:00:00Z' }),
  ]

  test('which run, which are refused and why, which still reach him', () => {
    const replayed = replayErrands(list)
    const by = Object.fromEntries(replayed.map((r) => [r.row.id, r.outcome]))
    expect(by.e1).toEqual({ kind: 'run', verb: 'report' })
    expect(by.e2).toMatchObject({ kind: 'reach' })
    // an approval wrapped in a MacBook dialog was the host's own work
    expect(by.e3).toEqual({ kind: 'refused', rule: 'keyless' })
    expect(by.e4).toMatchObject({ kind: 'reach' })
    // asked again within the hold of the owner's turn-back, and after it
    expect(by.e5).toEqual({ kind: 'refused', rule: 'declined' })
    expect(by.e6).toMatchObject({ kind: 'reach' })
    expect(by.e7).toEqual({ kind: 'refused', rule: 'unroutable' })
    expect(by.e8).toMatchObject({ kind: 'reach' })
    expect(summarize(replayed)).toMatchObject({
      total: 8,
      run: 1,
      refused: 3,
      reach: 4,
      refusedByRule: { keyless: 1, declined: 1, unroutable: 1 },
    })
  })

  test('no recorded secret or hands Errand would run', () => {
    expect(wronglyRun(replayErrands(list))).toEqual([])
    const hands = row({
      id: 'x',
      summary: 'Look at it',
      command: 'mount | grep smbfs',
      host: 'macbook',
      need: 'hands',
      raisedAt: '2026-11-10T10:00:00Z',
    })
    // a recorded hands Errand that quotes a report command is still not run by a rule that reads the words
    expect(
      wronglyRun(replayErrands([{ ...hands, summary: 'Click the Allow button in the prompt, then look' }])),
    ).toEqual([])
  })
})
