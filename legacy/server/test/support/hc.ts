import { appendFile, chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const FAKE = join(import.meta.dir, 'fake-hc.ts')

export interface FakeTerminal {
  address: string
  argv: string[]
  cwd: string
  keep: boolean
  labels: Record<string, string>
  name: string | null
  notify: boolean
  parent: string | null
  state: 'live' | 'finished'
  status: { app: string; state: string } | null
  reported: boolean
  turn: number
  /** what `terminal.read` answers */
  screen_text?: string
  foreground?: { argv: string[]; cwd: string; name: string; pid: number } | null
}

export interface FakeHcState {
  evseq: number
  core: { id: string; pid: number }
  terminals: FakeTerminal[]
  /** what each `terminal.run` was asked for: `argv`, `cwd`, `env`, `labels`, `parent`, `no_parent`, ... */
  runs: { address: string; params: Record<string, unknown> }[]
  sent: { terminal: string; text: string; if?: string }[]
  docs: Record<string, { value: unknown; version: number }>
  calls: string[]
  /** Enters an `unsent` terminal (`terminal.run:unsent`) swallows before it takes one; default 1 */
  swallow?: number
}

export interface FakeHc {
  /** value for `HC_BIN` */
  bin: string
  /** a `claude-pretrust.sh` stand-in: logs its arguments, exits `pretrustExit` */
  pretrustBin: string
  /** an account registry with `a` (the default account) and `b` (a config directory) */
  accountsFile: string
  /** faults for the next requests, `"<method>:<fault>"` (`terminal.list:hang`, `terminal.run:drop`, `terminal.run:silent`, ...), each used once */
  plan(...faults: string[]): Promise<void>
  state(): Promise<FakeHcState>
  /** every request so far, as `<method> <params as JSON>` */
  calls(): Promise<string[]>
  /** the requests of one method */
  callsOf(method: string): Promise<string[]>
  pretrustCalls(): Promise<string[]>
  /** one line per pretrust call: how many `terminal.run` requests the core had seen by then, and the path */
  pretrustOrder(): Promise<string[]>
  setPretrustExit(code: number): Promise<void>
  /** what the terminal's program says about itself from now on (`idle`, `working`, `blocked`, ...); `null` is silent */
  setStatus(address: string, state: string | null): Promise<void>
  /** the terminal's program has ended */
  finish(address: string, exitCode?: number): Promise<void>
  /** the program was killed (`kill -9`): the core announces `lost`, then `restarted` as the shell it put in its place */
  kill9(address: string): Promise<void>
  /** the terminal is removed: the core announces `removed` */
  remove(address: string): Promise<void>
  /** the core restarted: a new pid, and every open event stream ends */
  restartCore(): Promise<void>
  /** one raw line on every open event stream (a truncated one, for instance) */
  emitRaw(line: string): Promise<void>
  /** a notification on every open event stream, with the next sequence number */
  announce(type: string, terminal: string | undefined, data: unknown): Promise<void>
  /** the app's document, as the core stores it */
  setDoc(name: string, value: unknown): Promise<void>
  /** edit the stored state */
  mutate(change: (state: FakeHcState) => void): Promise<void>
  /** forgets everything */
  reset(): Promise<void>
  cleanup(): Promise<void>
}

const CORE_ID = '0123456789abcdef0123456789abcdef'
const EMPTY = {
  seq: 0,
  evseq: 0,
  core: { id: CORE_ID, pid: 4242 },
  terminals: [],
  runs: [],
  sent: [],
  docs: {},
  calls: [],
  plan: [],
}

/** A stand-in for the `hc` binary (see fake-hc.ts): keeps terminals and documents, and fails on demand. */
export async function createFakeHc(): Promise<FakeHc> {
  const dir = await mkdtemp('/tmp/factory-hc-')
  const bin = join(dir, 'hc')
  await writeFile(bin, `#!/bin/sh\nFAKE_HC_DIR='${dir}' exec bun '${FAKE}' "$@"\n`)
  await chmod(bin, 0o755)
  const pretrustBin = join(dir, 'pretrust.sh')
  await writeFile(
    pretrustBin,
    `#!/bin/sh\necho "$@" >> '${dir}/pretrust-calls'\necho "$(grep -o 'terminal\\.run {' '${dir}/state.json' | wc -l | tr -d ' ') $@" >> '${dir}/pretrust-order'\nexit "$(cat '${dir}/pretrust-exit')"\n`,
  )
  await chmod(pretrustBin, 0o755)
  const accountsFile = join(dir, 'accounts.json')
  await writeFile(
    accountsFile,
    JSON.stringify({
      accounts: {
        a: { dir: null },
        b: { dir: '~/.claude-b' },
        ...Object.fromEntries(['c', 'd', 'e', 'f'].map((id) => [id, { dir: `~/.claude-${id}` }])),
      },
    }),
  )

  const statePath = join(dir, 'state.json')
  // The fake `hc` processes read-modify-write the state file under this lock directory; a helper that touches the file
  // without it loses their writes (or reads half of one).
  const lockPath = join(dir, 'lock')
  const locked = async <T>(work: () => Promise<T>): Promise<T> => {
    for (;;) {
      try {
        await mkdir(lockPath)
        break
      } catch {
        await Bun.sleep(3)
      }
    }
    try {
      return await work()
    } finally {
      await rm(lockPath, { recursive: true, force: true })
    }
  }
  const load = async (): Promise<FakeHcState & { plan: string[] }> => JSON.parse(await readFile(statePath, 'utf8'))
  const read = () => locked(load)
  const write = (state: unknown) => writeFile(statePath, JSON.stringify(state))
  const mutate = (change: (state: FakeHcState) => void) =>
    locked(async () => {
      const state = await load()
      change(state)
      await write(state)
    })
  const reset = async () => {
    await locked(() => write(EMPTY))
    await writeFile(join(dir, 'pretrust-calls'), '')
    await writeFile(join(dir, 'pretrust-order'), '')
    await writeFile(join(dir, 'pretrust-exit'), '0')
    await writeFile(join(dir, 'events.jsonl'), '')
    // Streams from before the reset end: they belong to a core that is gone.
    await writeFile(join(dir, 'epoch'), String(++epoch))
  }
  let epoch = 0
  const announce = (type: string, terminal: string | undefined, data: unknown) =>
    locked(async () => {
      const state = await load()
      const seq = ++state.evseq
      await write(state)
      await appendFile(
        join(dir, 'events.jsonl'),
        `${JSON.stringify({ jsonrpc: '2.0', method: 'event', params: { data, seq, ...(terminal ? { terminal } : {}), type } })}\n`,
      )
    })
  await reset()

  return {
    bin,
    pretrustBin,
    accountsFile,
    plan: async (...faults) => {
      await mutate((state) => {
        ;(state as FakeHcState & { plan: string[] }).plan = faults
      })
    },
    state: read,
    calls: async () => (await read()).calls,
    callsOf: async (method) => (await read()).calls.filter((c) => c.startsWith(`${method} `)),
    pretrustCalls: async () => (await readFile(join(dir, 'pretrust-calls'), 'utf8')).split('\n').filter(Boolean),
    pretrustOrder: async () => (await readFile(join(dir, 'pretrust-order'), 'utf8')).split('\n').filter(Boolean),
    setPretrustExit: (code) => writeFile(join(dir, 'pretrust-exit'), String(code)),
    setStatus: async (address, word) => {
      await mutate((state) => {
        for (const t of state.terminals) {
          if (t.address !== address) continue
          t.status = word === null ? null : { app: 'claude-code', state: word }
          t.reported = t.reported || word !== null
        }
      })
      await announce('status', address, { records: {}, reported: true, status: word === null ? null : { state: word } })
    },
    finish: async (address, exitCode = 0) => {
      await mutate((state) => {
        for (const t of state.terminals) {
          if (t.address !== address) continue
          Object.assign(t, { state: 'finished', status: null, exit_code: exitCode, reason: 'exited', foreground: null })
        }
      })
      await announce('finished', address, {
        exit_code: exitCode,
        finished_ms: 1_793_452_999_000,
        reason: 'exited',
        signal: null,
      })
    },
    kill9: async (address) => {
      await announce('lost', address, { exit_code: null, finished_ms: null, reason: 'signaled', signal: 9 })
      let record: unknown
      await mutate((state) => {
        for (const t of state.terminals) {
          if (t.address !== address) continue
          Object.assign(t, {
            argv: ['/bin/zsh', '-l'],
            status: null,
            reported: false,
            foreground: { argv: ['/bin/zsh', '-l'], cwd: t.cwd, name: 'zsh', pid: 9999 },
          })
          record = t
        }
      })
      await announce('restarted', address, record)
    },
    remove: async (address) => {
      await mutate((state) => {
        state.terminals = state.terminals.filter((t) => t.address !== address)
      })
      await announce('removed', address, {})
    },
    restartCore: async () => {
      await mutate((state) => {
        state.core.pid += 1
      })
      await writeFile(join(dir, 'epoch'), String(++epoch))
    },
    emitRaw: (line) => appendFile(join(dir, 'events.jsonl'), `${line}\n`),
    announce,
    setDoc: (name, value) =>
      mutate((state) => {
        state.docs[name] = { value, version: (state.docs[name]?.version ?? 0) + 1 }
      }),
    mutate,
    reset,
    cleanup: () => rm(dir, { recursive: true, force: true }),
  }
}
