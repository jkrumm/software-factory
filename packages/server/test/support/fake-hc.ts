// A stand-in for herdr-core's `hc` (0.1.15): `hc connect` only, line-delimited JSON-RPC 2.0 on stdin and stdout, with the
// methods the runner and the witness use answering with the shapes the real core sent (taken from a scratch core: a
// terminal record, the error bodies with their `kind`, `{removed}`, the `{value, version}` of a document, the
// `events.subscribe` snapshot and its `event` notifications). State lives in $FAKE_HC_DIR/state.json; requests are
// serialised by a lock directory. `events.subscribe` keeps the process alive and copies every line appended to
// $FAKE_HC_DIR/events.jsonl to stdout until stdin closes or $FAKE_HC_DIR/epoch changes (a core restart).
// Faults come from the plan, one entry per request, consumed in order: "<method>:<fault>".
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'

interface Terminal {
  address: string
  argv: string[]
  cols: number
  created_ms: number
  cwd: string
  die_with_parent: boolean
  exit_code: number | null
  finished_ms: number | null
  identity: string
  keep: boolean
  labels: Record<string, string>
  name: string | null
  notify: boolean
  parent: string | null
  pid: number | null
  reason: string | null
  reported: boolean
  rm: boolean
  rows: number
  screen: string
  signal: number | null
  state: 'live' | 'finished'
  status: { app: string; state: string } | null
  status_ms: number | null
  template: string | null
  title: string
  turn: number
  foreground: { argv: string[]; cwd: string; name: string; pid: number } | null
}

interface State {
  seq: number
  evseq: number
  core: { id: string; pid: number }
  terminals: Terminal[]
  /** what each terminal.run was asked for */
  runs: { address: string; params: Record<string, unknown> }[]
  sent: { terminal: string; text: string; if?: string }[]
  docs: Record<string, { value: unknown; version: number }>
  calls: string[]
  plan: string[]
}

const dir = process.env.FAKE_HC_DIR as string
const file = join(dir, 'state.json')
const lock = join(dir, 'lock')
const eventsFile = join(dir, 'events.jsonl')
const epochFile = join(dir, 'epoch')

function acquire(): void {
  for (;;) {
    try {
      mkdirSync(lock)
      return
    } catch {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5)
    }
  }
}
const release = () => rmSync(lock, { recursive: true, force: true })

if (process.argv[2] !== 'connect') {
  process.stderr.write(`fake hc: unsupported ${process.argv.slice(2).join(' ')}\n`)
  process.exit(64)
}

class Refusal extends Error {
  constructor(
    readonly kind: string,
    message: string,
    readonly hint = '',
    readonly code = -32000,
  ) {
    super(message)
  }
}

const matches = (t: Terminal, labels: Record<string, string>) =>
  Object.entries(labels).every(([k, v]) => t.labels[k] === v)

/** Appends a notification for the subscribers, with the next sequence number. */
function announce(state: State, type: string, terminal: string | undefined, data: unknown): void {
  const seq = ++state.evseq
  appendFileSync(
    eventsFile,
    `${JSON.stringify({ jsonrpc: '2.0', method: 'event', params: { data, seq, ...(terminal ? { terminal } : {}), type } })}\n`,
  )
}

function handle(state: State, method: string, params: Record<string, unknown>, fault: string): unknown {
  const find = (target: string): Terminal => {
    const found = state.terminals.find(
      (t) => t.address === target || (t.name !== null && t.name === target && t.state === 'live'),
    )
    if (!found) throw new Refusal('not_found', `no terminal "${target}"`, 'see `hc ls --all`')
    return found
  }

  switch (method) {
    case 'terminal.run': {
      const name = (params.name as string | null | undefined) ?? null
      if (name !== null) {
        if (!/^[a-z0-9][a-z0-9._-]{0,31}$/.test(name) || /^t\d/.test(name)) {
          throw new Refusal('invalid_params', `bad name "${name}"`, 'see `hc schema`', -32602)
        }
        if (state.terminals.some((t) => t.state === 'live' && t.name === name)) {
          throw new Refusal('name_taken', `name "${name}" is taken`)
        }
      }
      const parent = (params.parent as string | null | undefined) ?? null
      if (parent) find(parent)
      const argv = (params.argv as string[] | undefined) ?? []
      const address = `t${++state.seq}`
      const reports = fault !== 'silent'
      const cwd = (params.cwd as string | null | undefined) ?? '/'
      const terminal: Terminal = {
        address,
        argv,
        cols: 200,
        created_ms: 1_793_452_436_435 + state.seq,
        cwd,
        die_with_parent: false,
        exit_code: null,
        finished_ms: null,
        identity: 'ghostty',
        keep: params.keep === true,
        labels: (params.labels as Record<string, string> | undefined) ?? {},
        name,
        notify: params.no_notify !== true,
        parent,
        pid: 3000 + state.seq,
        reason: null,
        reported: reports,
        rm: false,
        rows: 120,
        screen: 'exact',
        signal: null,
        state: 'live',
        // Claude Code given a prompt in argv starts its first turn on its own.
        status: reports ? { app: 'claude-code', state: 'working' } : null,
        status_ms: reports ? 1_793_452_437_000 : null,
        template: null,
        title: '',
        turn: 0,
        foreground: { argv, cwd, name: basename(argv[0] ?? 'sh'), pid: 3000 + state.seq },
      }
      state.terminals.push(terminal)
      state.runs.push({ address, params })
      announce(state, 'created', address, terminal)
      if (reports) announce(state, 'status', address, { records: {}, reported: true, status: terminal.status })
      return terminal
    }
    case 'terminal.list': {
      const labels = (params.labels as Record<string, string> | undefined) ?? {}
      const all = params.all === true
      const visible = state.terminals.filter((t) => matches(t, labels))
      return {
        hidden_finished: all ? 0 : visible.filter((t) => t.state === 'finished').length,
        // `malformed`: one record without an address, among the good ones.
        terminals: [
          ...visible.filter((t) => all || t.state === 'live'),
          ...(fault === 'malformed' ? [{ state: 'live' }] : []),
        ],
      }
    }
    case 'terminal.get':
      return find(params.terminal as string)
    case 'terminal.kill': {
      const terminal = find(params.terminal as string)
      if (terminal.state === 'finished') throw new Refusal('finished', `${terminal.address} has finished`)
      Object.assign(terminal, { state: 'finished', status: null, reason: 'killed', signal: 1, foreground: null })
      announce(state, 'finished', terminal.address, { exit_code: null, finished_ms: 1, reason: 'killed', signal: 1 })
      return terminal
    }
    case 'terminal.rm': {
      const terminal = find(params.terminal as string)
      if (terminal.state === 'live') {
        throw new Refusal('live', `${terminal.address} is still running`, `kill it first: hc kill ${terminal.address}`)
      }
      state.terminals = state.terminals.filter((t) => t !== terminal)
      announce(state, 'removed', terminal.address, {})
      return { removed: terminal.address }
    }
    case 'terminal.send': {
      const terminal = find(params.terminal as string)
      if (terminal.state === 'finished') throw new Refusal('finished', `${terminal.address} has finished`)
      const word = terminal.status?.state
      if (params.if !== undefined && params.if !== null && word !== params.if) {
        throw new Refusal(
          'status_mismatch',
          `${terminal.address} is ${word ?? 'silent'}, not ${String(params.if)}`,
          'nothing was typed',
        )
      }
      if (word === 'blocked' && params.force !== true) {
        throw new Refusal('blocked', `${terminal.address} is blocked`, 'a person is needed')
      }
      state.sent.push({
        terminal: terminal.address,
        text: params.text as string,
        ...(params.if ? { if: params.if as string } : {}),
      })
      if (terminal.status) {
        terminal.status = { ...terminal.status, state: 'working' }
        announce(state, 'status', terminal.address, { records: {}, reported: true, status: terminal.status })
      }
      return { started: true, status: word ?? null, turn: terminal.turn }
    }
    case 'server.status':
      return {
        core: { id: state.core.id, name: 'fake' },
        finished: state.terminals.filter((t) => t.state === 'finished').length,
        holder: null,
        holders: [],
        installed_by: null,
        live: state.terminals.filter((t) => t.state === 'live').length,
        pid: state.core.pid,
        uptime_ms: 1000,
        version: '0.1.15',
      }
    case 'doc.get':
      return state.docs[params.name as string] ?? { value: null, version: 0 }
    case 'doc.set': {
      const name = params.name as string
      const current = state.docs[name]?.version ?? 0
      if (fault === 'conflict' || params.version !== current) {
        throw new Refusal(
          'conflict',
          `document "${name}" is at version ${current}, not ${String(params.version)}`,
          'read doc.get and retry with its version',
        )
      }
      state.docs[name] = { value: params.value, version: current + 1 }
      announce(state, 'doc', undefined, { name, version: current + 1 })
      return { version: current + 1 }
    }
    default:
      throw new Refusal('invalid_params', `fake hc: unsupported ${method}`, '', -32601)
  }
}

const write = (message: unknown) => process.stdout.write(`${JSON.stringify(message)}\n`)

/** Streams the events file to stdout until stdin closes or the core "restarts" (the epoch file changes). */
async function tail(epoch: string, stdinClosed: () => boolean, from: number): Promise<never> {
  let offset = from
  for (;;) {
    if (stdinClosed()) process.exit(0)
    if (readFileSync(epochFile, 'utf8') !== epoch) process.exit(1)
    if (existsSync(eventsFile) && statSync(eventsFile).size > offset) {
      const text = readFileSync(eventsFile, 'utf8')
      process.stdout.write(text.slice(offset))
      offset = text.length
    }
    await Bun.sleep(10)
  }
}

let closed = false
let buffered = ''
let subscribed: Promise<never> | undefined

async function request(line: string): Promise<void> {
  const req = JSON.parse(line) as { id: number; method: string; params?: Record<string, unknown> }
  if (req.method === 'hello') {
    write({
      id: req.id,
      jsonrpc: '2.0',
      result: {
        core: { id: 'fake', name: 'fake' },
        features: ['events'],
        framed: false,
        generation: 1,
        methods: [],
        version: '0.1.15',
      },
    })
    return
  }

  acquire()
  let reply: unknown
  let exit: number | undefined
  let hang = false
  let epoch = ''
  let from = 0
  let slow = false
  try {
    const state: State = JSON.parse(readFileSync(file, 'utf8'))
    state.calls.push(`${req.method} ${JSON.stringify(req.params ?? {})}`)
    const planned = state.plan.findIndex((entry) => entry.startsWith(`${req.method}:`))
    const fault = planned >= 0 ? (state.plan.splice(planned, 1)[0] as string).slice(req.method.length + 1) : ''
    const save = () => writeFileSync(file, JSON.stringify(state))
    save()

    if (fault === 'hang') hang = true
    else if (fault === 'exit1') exit = 1
    else if (fault === 'notfound') {
      reply = {
        id: req.id,
        jsonrpc: '2.0',
        error: { code: -32000, data: { hint: '', kind: 'not_found' }, message: 'not found' },
      }
    } else if (fault === 'garbage') {
      process.stdout.write('hc 0.1.15 (banner, not json)\n')
      exit = 0
    } else if (fault === 'error') {
      reply = {
        id: req.id,
        jsonrpc: '2.0',
        error: { code: -32000, data: { hint: '', kind: 'unavailable' }, message: 'unavailable' },
      }
    } else if (req.method === 'events.subscribe') {
      epoch = readFileSync(epochFile, 'utf8')
      // Where the stream starts is fixed before the snapshot is answered: a line appended after that is the stream's.
      from = existsSync(eventsFile) ? statSync(eventsFile).size : 0
      reply = {
        id: req.id,
        jsonrpc: '2.0',
        result: {
          channel: null,
          seq: state.evseq,
          terminals: [
            ...state.terminals.filter((t) => t.state === 'live'),
            ...(fault === 'malformed' ? [{ state: 'live' }] : []),
          ],
        },
      }
    } else {
      try {
        const result = handle(state, req.method, req.params ?? {}, fault)
        save()
        // `drop`: the request took effect, the reply never reached the caller.
        if (fault === 'drop') exit = 1
        else reply = { id: req.id, jsonrpc: '2.0', result }
        // `slow`: the answer is a picture of this moment, delivered late.
        slow = fault === 'slow'
      } catch (error) {
        if (!(error instanceof Refusal)) throw error
        reply = {
          id: req.id,
          jsonrpc: '2.0',
          error: { code: error.code, data: { hint: error.hint, kind: error.kind }, message: error.message },
        }
      }
    }
  } finally {
    release()
  }

  if (hang) {
    Bun.sleepSync(60_000)
    process.exit(0)
  }
  if (slow) await Bun.sleep(400)
  if (reply) write(reply)
  if (exit !== undefined) process.exit(exit)
  if (req.method === 'events.subscribe' && epoch) subscribed = tail(epoch, () => closed, from)
}

const queue: Promise<void> = (async () => {
  for await (const chunk of Bun.stdin.stream()) {
    buffered += new TextDecoder().decode(chunk)
    for (let at = buffered.indexOf('\n'); at >= 0; at = buffered.indexOf('\n')) {
      const line = buffered.slice(0, at)
      buffered = buffered.slice(at + 1)
      if (line.trim()) await request(line)
    }
  }
  closed = true
})()
await queue
if (subscribed) await subscribed
