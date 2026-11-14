import { expect, test } from 'bun:test'
import { createShutdown } from '../src/shutdown.ts'

const forever = () => new Promise<never>(() => {})

test('the steps run in order and a clean stop exits 0', async () => {
  const ran: string[] = []
  const exits: number[] = []
  await createShutdown({
    deadlineMs: 1_000,
    exit: (code) => exits.push(code),
    steps: [
      { name: 'a', run: async () => ran.push('a') },
      { name: 'b', run: async () => ran.push('b') },
    ],
  })('SIGTERM')
  expect(ran).toEqual(['a', 'b'])
  expect(exits).toEqual([0])
})

test('a step that throws is logged, the later steps still run (the lock is let go), and the exit is 1', async () => {
  const ran: string[] = []
  const lines: string[] = []
  const exits: number[] = []
  await createShutdown({
    deadlineMs: 1_000,
    log: (line) => lines.push(line),
    exit: (code) => exits.push(code),
    steps: [
      {
        name: 'loops.stop',
        run: async () => {
          throw new Error('boom')
        },
      },
      { name: 'lock.release', run: async () => ran.push('lock') },
    ],
  })('SIGTERM')
  expect(ran).toEqual(['lock'])
  expect(lines).toEqual(['shutdown: loops.stop failed: boom'])
  expect(exits).toEqual([1])
})

test('a stuck step is cut off by the deadline: the line names it and the exit is 1', async () => {
  const lines: string[] = []
  const exited = new Promise<number>((resolve) => {
    void createShutdown({
      deadlineMs: 30,
      log: (line) => lines.push(line),
      exit: resolve,
      steps: [
        { name: 'draining', run: async () => undefined },
        { name: 'server.stop', run: forever },
      ],
    })('SIGTERM')
  })
  expect(await exited).toBe(1)
  expect(lines).toEqual(['shutdown took too long (still in: server.stop), exiting'])
})

test('a second signal does nothing', async () => {
  const exits: number[] = []
  let runs = 0
  const stop = createShutdown({
    deadlineMs: 1_000,
    exit: (code) => exits.push(code),
    steps: [{ name: 'a', run: async () => runs++ }],
  })
  await Promise.all([stop('SIGTERM'), stop('SIGINT')])
  expect([runs, exits]).toEqual([1, [0]])
})

test('the stop says how long it took and names the steps that took a while', async () => {
  let clock = 0
  const lines: string[] = []
  await createShutdown({
    deadlineMs: 1_000,
    exit: () => undefined,
    report: (line) => lines.push(line),
    now: () => clock,
    steps: [
      { name: 'draining', run: async () => void (clock += 10) },
      { name: 'loops.stop', run: async () => void (clock += 9_800) },
      { name: 'lock.release', run: async () => void (clock += 90) },
    ],
  })('SIGTERM')
  expect(lines).toEqual(['stopped in 9.9s (loops.stop 9.8s)'])
})

test('a stop with no slow step says only the total', async () => {
  let clock = 0
  const lines: string[] = []
  await createShutdown({
    deadlineMs: 1_000,
    exit: () => undefined,
    report: (line) => lines.push(line),
    now: () => clock,
    steps: [{ name: 'a', run: async () => void (clock += 120) }],
  })('SIGTERM')
  expect(lines).toEqual(['stopped in 0.1s'])
})
