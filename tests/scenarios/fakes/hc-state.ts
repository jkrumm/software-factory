import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

/** One terminal of the fake herdr-core. */
export interface FakeTerminal {
  address: string
  labels: Record<string, string>
  state: 'live' | 'finished'
  status: { state: string } | null
  reported: boolean
  turn: number
  exit_code: number | null
  argv: string[]
  cwd: string
  env: Record<string, string>
  name: string
  /** what `terminal.read` shows */
  screen: string
  /** every text typed into it with `terminal.send`, in order */
  sent: string[]
}

export interface FakeHcState {
  next: number
  terminals: Record<string, FakeTerminal>
  doc: { value: unknown; version: number } | null
  /** `terminal.run` answers this error once, then clears it: a start that fails */
  failRun: { kind: string; message: string } | null
}

const EMPTY: FakeHcState = { next: 1, terminals: {}, doc: null, failRun: null }

/** The state file sits beside the call log, so the fake and the scenario find it from the same world. */
export const statePathOf = (logPath: string): string => join(dirname(logPath), 'hc-state.json')

export function readState(path: string): FakeHcState {
  try {
    return { ...EMPTY, ...(JSON.parse(readFileSync(path, 'utf8')) as Partial<FakeHcState>) }
  } catch {
    return structuredClone(EMPTY)
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/** Runs `change` on the state under a lock: concurrent `hc` processes do not lose each other's writes. */
export async function withState<T>(path: string, change: (state: FakeHcState) => T): Promise<T> {
  const lock = `${path}.lock`
  for (let i = 0; i < 2_000; i++) {
    try {
      mkdirSync(lock)
      break
    } catch {
      await sleep(5)
    }
  }
  try {
    const state = readState(path)
    const result = change(state)
    writeFileSync(`${path}.tmp`, JSON.stringify(state))
    renameSync(`${path}.tmp`, path)
    return result
  } finally {
    rmSync(lock, { recursive: true, force: true })
  }
}
