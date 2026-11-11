import { describe, expect, test } from 'bun:test'
import { launchdPoller, parseJob } from '../../src/adapters/intake/launchd.ts'
import type { ProcessResult } from '../../src/adapters/intake/process.ts'
import type { Received, RepoSignals } from '../../src/domains/intake/model.ts'
import type { IntakeSink, ProjectSignals, SubjectState } from '../../src/domains/intake/ports.ts'
import { err, ok, portError } from '../../src/kernel/result.ts'

const UID = 501
const JOB = 'com.example.job'

const project = (launchd: string[] = [JOB], extra: Partial<RepoSignals> = {}): RepoSignals => ({
  repo: 'r',
  work: false,
  host: null,
  sources: ['launchd'],
  github: null,
  launchd,
  heal: [],
  ...extra,
})

/** What `launchctl print` prints for a job, as far as the intake reads it. */
const printed = (state: string, exit: string, runs: number): string =>
  [
    'gui/501/com.example.job = {',
    '\tactive count = 0',
    `\tstate = ${state}`,
    '\tprogram = /bin/bash',
    `\truns = ${runs}`,
    `\tlast exit code = ${exit}`,
    '\tproperties = {',
    '\t\tstate = active',
    '\t}',
    '}',
  ].join('\n')

const FAILED = (runs = 3) => printed('not running', '1', runs)
const FINE = (runs = 3) => printed('not running', '0', runs)

const openJob = (subject: string): SubjectState => ({ subject, open: true, since: new Date('2026-11-06T00:00:00Z') })

function setup(options: { projects?: RepoSignals[]; open?: string[]; receive?: 'fail'; throwFor?: string } = {}) {
  const asked: string[][] = []
  const logged: string[] = []
  const received: Received[] = []
  const jobs = new Map<string, ProcessResult>()
  const run = (command: readonly string[]): Promise<ProcessResult> => {
    asked.push([...command])
    const label = (command[2] ?? '').split('/')[2] ?? ''
    if (label === options.throwFor) return Promise.reject(new Error('cannot execute launchctl'))
    return Promise.resolve(jobs.get(label) ?? { exit: 113, stdout: '' })
  }
  const sink: IntakeSink = {
    receive(value) {
      received.push(value)
      if (options.receive === 'fail') return Promise.resolve(err(portError('unreadable', 'store down')))
      return Promise.resolve(ok({ outcome: 'filed', detail: 'new', issue: null, signal: null, reason: null }))
    },
    subjects: (source) => Promise.resolve(ok(source === 'launchd' ? (options.open ?? []).map(openJob) : [])),
    pendingWritebacks: () => Promise.resolve(ok([])),
    noteRedBranch: () => Promise.resolve(ok(0)),
    wroteBack: () => Promise.resolve(ok(undefined)),
  }
  const projects: ProjectSignals = {
    find: () => Promise.resolve(ok(null)),
    polled: () => Promise.resolve(ok(options.projects ?? [project()])),
  }
  const poller = launchdPoller({ sink, projects, uid: UID, run, log: (line) => logged.push(line) })
  return {
    poller,
    asked,
    logged,
    received,
    say: (label: string, stdout: string) => jobs.set(label, { exit: 0, stdout }),
  }
}

describe('parseJob', () => {
  test('reads the state, the last exit code and the runs; a never-exited job has no code', () => {
    expect(parseJob(printed('not running', '78', 4))).toEqual({ state: 'not running', exitCode: 78, runs: 4 })
    expect(parseJob(printed('running', '(never exited)', 1))).toEqual({
      state: 'running',
      exitCode: undefined,
      runs: 1,
    })
    expect(parseJob('')).toEqual({ state: undefined, exitCode: undefined, runs: 0 })
  })
})

describe('the failed launchd job source', () => {
  test('a job whose last exit is non-zero is one down alert; only the named label is read', async () => {
    const ld = setup()
    ld.say(JOB, FAILED())
    await ld.poller.pass()
    expect(ld.asked).toEqual([['launchctl', 'print', `gui/${UID}/${JOB}`]])
    const [first, ...rest] = ld.received
    expect(rest).toEqual([])
    expect(first?.signal).toEqual({
      source: 'launchd',
      kind: 'alert',
      origin: 'infrastructure',
      trust: 'machine',
      repo: 'r',
      fingerprint: `launchd:${JOB}`,
      title: `Failed launchd job "${JOB}" (exit 1)`,
      text: `Failed launchd job "${JOB}" (exit 1)`,
      link: null,
      madeBy: null,
      probe: false,
    })
    expect(first?.alert).toEqual({
      subject: JOB,
      event: 'down:exit1@runs3',
      status: 'down',
      facts: { label: JOB, exitCode: 1, runs: 3, state: 'not running' },
    })
  })

  test('a new failed run is a new event of the same subject', async () => {
    const ld = setup({ open: [JOB] })
    ld.say(JOB, FAILED(3))
    await ld.poller.pass()
    ld.say(JOB, FAILED(4))
    await ld.poller.pass()
    expect(ld.received.map((r) => r.alert?.event)).toEqual(['down:exit1@runs3', 'down:exit1@runs4'])
  })

  test('a job that exited 0 or never ran, and a job that is not loaded, say nothing', async () => {
    const ld = setup({ projects: [project(['com.example.a', 'com.example.b', 'com.example.c'])] })
    ld.say('com.example.a', FINE())
    ld.say('com.example.b', printed('not running', '(never exited)', 0))
    await ld.poller.pass()
    expect(ld.received).toEqual([])
    expect(ld.asked).toHaveLength(3)
    expect(ld.logged).toEqual(['launchd intake: com.example.c could not be read (exit 113)'])
  })

  test('a healthy job is an up only while its subject is open', async () => {
    const closed = setup()
    closed.say(JOB, FINE())
    await closed.poller.pass()
    expect(closed.received).toEqual([])

    const open = setup({ open: [JOB] })
    open.say(JOB, FINE(5))
    await open.poller.pass()
    expect(open.received).toHaveLength(1)
    expect(open.received[0]?.signal).toMatchObject({ title: `Launchd job "${JOB}" is healthy` })
    expect(open.received[0]?.alert).toEqual({
      subject: JOB,
      event: 'up@runs5',
      status: 'up',
      facts: { label: JOB, runs: 5, exitCode: 0, state: 'not running' },
    })
  })

  test('a job that runs again after a failure is an up for an open subject, with no exit code it still is', async () => {
    const ld = setup({ open: [JOB] })
    ld.say(JOB, printed('running', '1', 4))
    await ld.poller.pass()
    ld.say(JOB, printed('running', '(never exited)', 5))
    await ld.poller.pass()
    expect(ld.received.map((r) => [r.alert?.status, r.alert?.event])).toEqual([
      ['up', 'up@runs4'],
      ['up', 'up@runs5'],
    ])
    expect(ld.received[1]?.alert?.facts).toEqual({ label: JOB, runs: 5, state: 'running' })
  })

  test('a running job that never exited says nothing when no subject is open', async () => {
    const ld = setup()
    ld.say(JOB, printed('running', '(never exited)', 1))
    await ld.poller.pass()
    expect(ld.received).toEqual([])
  })

  test('a work repo is never read, and neither is a project without labels', async () => {
    const ld = setup({ projects: [project([JOB], { work: true }), project([])] })
    ld.say(JOB, FAILED())
    await ld.poller.pass()
    expect(ld.asked).toEqual([])
    expect(ld.received).toEqual([])
  })

  test('a label that is not a plain name is never passed to launchctl', async () => {
    const ld = setup({ projects: [project(['../x', 'a b', JOB, JOB])] })
    await ld.poller.pass()
    expect(ld.asked).toEqual([['launchctl', 'print', `gui/${UID}/${JOB}`]])
    expect(ld.logged).toContain('launchd intake: a label that is not a plain name is skipped')
  })

  test('a runner that throws does not stop the pass', async () => {
    const ld = setup({ projects: [project(['com.example.a', 'com.example.b'])], throwFor: 'com.example.a' })
    ld.say('com.example.b', FAILED())
    await ld.poller.pass()
    expect(ld.asked).toHaveLength(2)
    expect(ld.received.map((r) => r.alert?.subject)).toEqual(['com.example.b'])
    expect(ld.logged).toEqual(['launchd intake: com.example.a could not be read'])
  })

  test('a sink that cannot file is one line and the pass goes on', async () => {
    const ld = setup({ projects: [project(['com.example.a', 'com.example.b'])], receive: 'fail' })
    ld.say('com.example.a', FAILED())
    ld.say('com.example.b', FAILED())
    await ld.poller.pass()
    expect(ld.received).toHaveLength(2)
    expect(ld.logged).toEqual([
      'launchd intake: com.example.a not filed (unreadable)',
      'launchd intake: com.example.b not filed (unreadable)',
    ])
  })
})
