import { describe, expect, test } from 'bun:test'
import type { RunProcess } from '../../src/adapters/intake/process.ts'
import { parseProbe, sshProbe } from '../../src/adapters/remote/probe.ts'
import {
  DISK_CEILING_PCT,
  TRIM_EVERY_MS,
  decideRemote,
  expectedMiniWaitMs,
  finishesSooner,
  grantedCores,
  memoryCeilingMib,
  type RemoteReading,
} from '../../src/domains/capacity/remote.ts'
import { pressureThreshold } from '../../src/kernel/remote-pressure.ts'

const AT = new Date('2026-11-17T12:00:00Z')
const GIB = 1024 ** 3
const reading = (over: Partial<RemoteReading> = {}): RemoteReading => ({
  at: AT,
  cores: 12,
  load1: 2,
  ramMib: 24_000,
  availableMib: 18_000,
  diskSizeBytes: 177 * GIB,
  diskUsedBytes: 124 * GIB,
  memoryPressure: 0,
  ioPressure: 0,
  ...over,
})
const step = { peakMib: 2500, cores: 1.4 }
// no baseline yet: the default line of 1 %
const AT_REST = pressureThreshold(null)

describe('the VPS has room for a step', () => {
  test('a calm VPS takes it', () => {
    expect(
      decideRemote({ reading: reading(), now: AT, holders: [], step, copyExists: false, pressure: AT_REST }),
    ).toEqual({ grant: true })
  })

  test('no reading, or one older than 90 s, takes nothing', () => {
    expect(decideRemote({ reading: null, now: AT, holders: [], step, copyExists: true, pressure: AT_REST }).grant).toBe(
      false,
    )
    const old = decideRemote({
      reading: reading({ at: new Date(AT.getTime() - 120_000) }),
      now: AT,
      holders: [],
      step,
      copyExists: true,
      pressure: AT_REST,
    })
    expect(old).toEqual({ grant: false, kind: 'probe', why: 'the VPS has not answered its probe for 120 s' })
  })

  test("a new copy that would push the disk over the alert's line is refused; an existing copy is not counted", () => {
    const near = reading({ diskUsedBytes: Math.floor(177 * GIB * (DISK_CEILING_PCT / 100)) - GIB })
    expect(
      decideRemote({ reading: near, now: AT, holders: [], step, copyExists: false, pressure: AT_REST }).grant,
    ).toBe(false)
    expect(decideRemote({ reading: near, now: AT, holders: [], step, copyExists: true, pressure: AT_REST }).grant).toBe(
      true,
    )
  })

  test("production's own memory or io stall holds every new step", () => {
    const squeezed = decideRemote({
      reading: reading({ memoryPressure: 12.5 }),
      now: AT,
      holders: [],
      step,
      copyExists: true,
      pressure: AT_REST,
    })
    expect(squeezed).toEqual({
      grant: false,
      kind: 'pressure',
      why: 'production on the VPS is stalled on memory (12.5 % of the last 10 s, over 1 %)',
    })
  })

  test('the line moves with the baseline: a calm host refuses a stall the default line lets through', () => {
    const stalled = reading({ ioPressure: 0.7 })
    expect(
      decideRemote({ reading: stalled, now: AT, holders: [], step, copyExists: true, pressure: AT_REST }).grant,
    ).toBe(true)
    const calm = pressureThreshold({ samples: 2000, spanMs: 25 * 3_600_000, memoryP99: 0, ioP99: 0 })
    expect(calm).toEqual({ memory: 0.5, io: 0.5, from: 'baseline' })
    expect(decideRemote({ reading: stalled, now: AT, holders: [], step, copyExists: true, pressure: calm })).toEqual({
      grant: false,
      kind: 'pressure',
      why: 'production on the VPS is stalled on io (0.7 % of the last 10 s, over 0.5 %)',
    })
  })

  test('a VPS whose production pressure cannot be read takes no step (the tripwire fails closed)', () => {
    const blind = decideRemote({
      reading: reading({ ioPressure: null }),
      now: AT,
      holders: [],
      step,
      copyExists: true,
      pressure: AT_REST,
    })
    expect(blind.grant).toBe(false)
  })

  test('the running steps count at their whole peak, beside the headroom', () => {
    const holders = [
      { peakMib: 7000, cores: 2 },
      { peakMib: 7000, cores: 2 },
    ]
    // 18000 available, 2048 headroom, 14000 held: 1952 left, the step needs 2500
    const full = decideRemote({ reading: reading(), now: AT, holders, step, copyExists: true, pressure: AT_REST })
    expect(full.grant).toBe(false)
    expect(full.grant === false && full.why).toContain('the step needs 2.4 GiB')
  })

  test('beside a running step, the step waits for idle cores', () => {
    const busy = decideRemote({
      reading: reading({ load1: 11.5 }),
      now: AT,
      holders: [{ peakMib: 500, cores: 1 }],
      step,
      copyExists: true,
      pressure: AT_REST,
    })
    expect(busy.grant === false && busy.why).toContain('idle cores')
  })
})

describe('the VPS finishes it sooner', () => {
  test('a learned VPS run against the wait plus the mini run', () => {
    expect(finishesSooner({ miniRunMs: 412_000, vpsRunMs: 701_000, expectedWaitMs: 200_000 })).toBe(false)
    expect(finishesSooner({ miniRunMs: 412_000, vpsRunMs: 701_000, expectedWaitMs: 400_000 })).toBe(true)
  })

  test('an unknown VPS run is taken as 1.7 times the mini run', () => {
    expect(finishesSooner({ miniRunMs: 100_000, vpsRunMs: null, expectedWaitMs: 69_000 })).toBe(false)
    expect(finishesSooner({ miniRunMs: 100_000, vpsRunMs: null, expectedWaitMs: 71_000 })).toBe(true)
  })

  test('with nothing learned anywhere, any wait is reason to go', () => {
    expect(finishesSooner({ miniRunMs: null, vpsRunMs: null, expectedWaitMs: 0 })).toBe(false)
    expect(finishesSooner({ miniRunMs: null, vpsRunMs: null, expectedWaitMs: 1 })).toBe(true)
  })

  test('the expected wait is the end of the holder that frees the caller its slot', () => {
    expect(expectedMiniWaitMs({ remainingMs: [300, 100], ahead: 0, medianRunMs: 1000 })).toBe(100)
    expect(expectedMiniWaitMs({ remainingMs: [300, 100], ahead: 1, medianRunMs: 1000 })).toBe(300)
    expect(expectedMiniWaitMs({ remainingMs: [300, 100], ahead: 2, medianRunMs: 1000 })).toBe(1100)
    expect(expectedMiniWaitMs({ remainingMs: [], ahead: 3, medianRunMs: 1000 })).toBe(0)
  })
})

describe('what a step is granted', () => {
  test('a memory ceiling of 1.5 times its peak, at least 1 GiB', () => {
    expect(memoryCeilingMib(2048)).toBe(3072)
    expect(memoryCeilingMib(100)).toBe(1024)
  })

  test('the idle cores, at least one', () => {
    expect(grantedCores(reading())).toBe(10)
    expect(grantedCores(reading({ load1: 14 }))).toBe(1)
  })
})

describe('the probe', () => {
  const out = [
    '12',
    '0.81 1.02 1.20 2/900 12345',
    'MemTotal:       24607744 kB',
    'MemAvailable:   18874368 kB',
    '190052302848 133136662528',
    'psi-memory some avg10=0.00 avg60=0.10 avg300=0.07 total=736923697',
    'psi-io some avg10=3.25 avg60=0.00 avg300=0.01 total=679630926',
    'copies factory-steps/basalt-ui/1 factory-steps/basalt-ui/1.run ',
    'step 123-abc 1763380000',
    'step bad;id 1763380000',
  ].join('\n')

  test('reads the figures, the copies and the step containers', () => {
    const parsed = parseProbe(out, AT)
    expect(parsed?.reading).toEqual({
      at: AT,
      cores: 12,
      load1: 0.81,
      ramMib: 24_031,
      availableMib: 18_432,
      diskSizeBytes: 190_052_302_848,
      diskUsedBytes: 133_136_662_528,
      memoryPressure: 0,
      ioPressure: 3.25,
    })
    expect(parsed?.copies).toEqual(['factory-steps/basalt-ui/1', 'factory-steps/basalt-ui/1.run'])
    // an id that is not the CLI's own form never reaches a shell line
    expect(parsed?.steps).toEqual([{ id: '123-abc', startedMs: 1_763_380_000_000 }])
  })

  test('a missing figure is no reading', () => {
    expect(parseProbe('12\n', AT)).toBeNull()
  })
})

describe('the probe starts the step host trim', () => {
  const PROBE_OUT = [
    '12',
    '0.81 1.02 1.20 2/900 12345',
    'MemTotal:       24607744 kB',
    'MemAvailable:   18874368 kB',
    '190052302848 133136662528',
    'psi-memory some avg10=0.00',
    'psi-io some avg10=0.00',
    'copies ',
  ].join('\n')

  const harness = (probeOut: string) => {
    const calls: string[] = []
    let now = AT.getTime()
    const run: RunProcess = async (command) => {
      const script = command.at(-1) ?? ''
      calls.push(script.startsWith('cd "$HOME"') ? 'trim' : 'probe')
      return {
        exit: 0,
        stdout: script.startsWith('cd "$HOME"') ? 'trim: removed 0 idle slot copies and 0 bun cache entries' : probeOut,
      }
    }
    const probe = sshProbe({ target: 'vps', run, now: () => new Date(now) })
    const tick = async (ms: number): Promise<void> => {
      now += ms
      probe.latest(null)
      await Bun.sleep(5)
    }
    return { calls, tick }
  }

  test('once per interval, after a probe that saw no step container', async () => {
    const { calls, tick } = harness(PROBE_OUT)
    await tick(0)
    await tick(31_000)
    expect(calls.filter((c) => c === 'trim')).toHaveLength(1)
    await tick(TRIM_EVERY_MS)
    expect(calls.filter((c) => c === 'trim')).toHaveLength(2)
  })

  test('sweeps the scratch directories of closed Issues before the idle rules, with the closed ids only', async () => {
    const scripts: string[] = []
    const asked: (readonly number[])[] = []
    let now = AT.getTime()
    const run: RunProcess = async (command) => {
      const script = command.at(-1) ?? ''
      scripts.push(script)
      if (script.includes('echo "scratch $id"')) return { exit: 0, stdout: 'scratch 7\nscratch 9\nscratch 11' }
      if (script.includes('exp-sweep.sh'))
        return { exit: 0, stdout: 'exp-sweep: 2 removed, 0 kept, 0 failed, freed 5 MB' }
      return {
        exit: 0,
        stdout: script.startsWith('cd "$HOME"')
          ? 'trim: removed 0 idle slot copies and 0 bun cache entries'
          : PROBE_OUT,
      }
    }
    const logs: string[] = []
    const probe = sshProbe({
      target: 'vps',
      run,
      now: () => new Date(now),
      log: (line) => logs.push(line),
      closedOf: async (ids) => {
        asked.push(ids)
        return ids.filter((id) => id !== 9)
      },
    })
    now += 1
    probe.latest(null)
    await Bun.sleep(10)
    expect(asked).toEqual([[7, 9, 11]])
    const sweep = scripts.findIndex((s) => s.includes('exp-sweep.sh'))
    expect(scripts[sweep]).toContain('--closed 7 11')
    // the idle rules run after it
    expect(scripts.findIndex((s) => s.includes('removed $exps idle exp dirs'))).toBeGreaterThan(sweep)
    expect(logs).toContain('exp-sweep: 2 removed, 0 kept, 0 failed, freed 5 MB')
  })

  test('no sweep call when no listed Issue is closed, and a failed sweep leaves the idle rules running', async () => {
    const scripts: string[] = []
    let now = AT.getTime()
    let closed: number[] = []
    const run: RunProcess = async (command) => {
      const script = command.at(-1) ?? ''
      scripts.push(script)
      if (script.includes('echo "scratch $id"')) return { exit: 0, stdout: 'scratch 7' }
      if (script.includes('exp-sweep.sh')) return { exit: 1, stdout: 'trim: exp-sweep.sh did not finish cleanly' }
      return { exit: 0, stdout: script.startsWith('cd "$HOME"') ? '' : PROBE_OUT }
    }
    const logs: string[] = []
    const probe = sshProbe({
      target: 'vps',
      run,
      now: () => new Date(now),
      log: (l) => logs.push(l),
      closedOf: async () => closed,
    })
    now += 1
    probe.latest(null)
    await Bun.sleep(10)
    expect(scripts.some((s) => s.includes('exp-sweep.sh'))).toBe(false)
    expect(scripts.some((s) => s.includes('removed $exps idle exp dirs'))).toBe(true)

    closed = [7]
    now += TRIM_EVERY_MS
    probe.latest(null)
    await Bun.sleep(10)
    expect(scripts.some((s) => s.includes('exp-sweep.sh'))).toBe(true)
    expect(logs.some((l) => l.startsWith('step host sweep failed'))).toBe(true)
    expect(scripts.filter((s) => s.includes('removed $exps idle exp dirs'))).toHaveLength(2)
  })

  test('not while a step container runs', async () => {
    const { calls, tick } = harness(`${PROBE_OUT}\nstep 123-abc 1763380000`)
    await tick(0)
    await tick(TRIM_EVERY_MS)
    expect(calls).not.toContain('trim')
  })
})
