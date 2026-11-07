#!/usr/bin/env bun
// The fake herdr-core CLI the scenarios put on PATH as `hc`: `hc connect` speaks line-delimited JSON-RPC on stdin and
// stdout, as the runner expects, over a state file the scenario can read and change (`hc-state.ts`). Every request is
// logged to FACTORY_FAKE_LOG as `{tool: 'hc', args: [method, params as JSON]}`.
import { appendFileSync } from 'node:fs'
import { type FakeTerminal, statePathOf, withState } from './hc-state.ts'

const log = process.env.FACTORY_FAKE_LOG ?? ''
const path = statePathOf(log || '/tmp/hc-fake/calls.jsonl')

interface Request {
  id: number
  method: string
  params: Record<string, unknown>
}

class Refusal extends Error {
  constructor(
    readonly kind: string,
    message: string,
  ) {
    super(message)
  }
}

const labelsMatch = (terminal: FakeTerminal, want: unknown): boolean =>
  Object.entries((want ?? {}) as Record<string, string>).every(([k, v]) => terminal.labels[k] === v)

async function handle(request: Request): Promise<unknown> {
  const p = request.params
  const address = String(p.terminal ?? '')
  return withState(path, (state) => {
    const terminal = state.terminals[address]
    switch (request.method) {
      case 'terminal.list': {
        const all = p.all === true
        const found = Object.values(state.terminals).filter(
          (t) => (all || t.state === 'live') && labelsMatch(t, p.labels),
        )
        return { terminals: found }
      }
      case 'terminal.run': {
        if (state.failRun) {
          const failure = state.failRun
          state.failRun = null
          throw new Refusal(failure.kind, failure.message)
        }
        const made: FakeTerminal = {
          address: `t${state.next++}`,
          labels: (p.labels ?? {}) as Record<string, string>,
          state: 'live',
          status: { state: 'idle' },
          reported: true,
          turn: 0,
          exit_code: null,
          argv: (p.argv ?? []) as string[],
          cwd: String(p.cwd ?? ''),
          env: (p.env ?? {}) as Record<string, string>,
          name: String(p.name ?? ''),
          screen: '',
          sent: [],
        }
        state.terminals[made.address] = made
        return made
      }
      case 'terminal.get':
        if (!terminal) throw new Refusal('not_found', `no terminal ${address}`)
        return terminal
      case 'terminal.read':
        if (!terminal) throw new Refusal('not_found', `no terminal ${address}`)
        return { text: terminal.screen }
      case 'terminal.send': {
        if (terminal?.state !== 'live') throw new Refusal('not_found', `no live terminal ${address}`)
        const guard = p.if
        if (typeof guard === 'string' && terminal.status?.state !== guard) {
          throw new Refusal('status_mismatch', `the terminal is ${terminal.status?.state}, not ${guard}`)
        }
        terminal.sent.push(String(p.text ?? ''))
        return {}
      }
      case 'terminal.kill':
        if (!terminal) throw new Refusal('not_found', `no terminal ${address}`)
        terminal.state = 'finished'
        terminal.exit_code = 137
        terminal.status = null
        return {}
      case 'terminal.rm':
        if (!terminal) throw new Refusal('not_found', `no terminal ${address}`)
        delete state.terminals[address]
        return {}
      case 'doc.get':
        if (!state.doc) throw new Refusal('not_found', 'no such document')
        return state.doc
      case 'doc.set': {
        const version = state.doc?.version ?? 0
        if (p.version !== version) throw new Refusal('conflict', 'the document moved')
        state.doc = { value: p.value, version: version + 1 }
        return { version: version + 1 }
      }
      default:
        throw new Refusal('unsupported', `fake hc: nothing scripted for ${request.method}`)
    }
  })
}

const reply = (line: unknown) => process.stdout.write(`${JSON.stringify(line)}\n`)

const input = await Bun.stdin.text()
for (const raw of input.split('\n')) {
  if (!raw.trim()) continue
  const request = JSON.parse(raw) as Request & { jsonrpc: string }
  if (request.method === 'hello') {
    reply({ jsonrpc: '2.0', id: request.id, result: {} })
    continue
  }
  if (log)
    appendFileSync(log, `${JSON.stringify({ tool: 'hc', args: [request.method, JSON.stringify(request.params)] })}\n`)
  try {
    reply({ jsonrpc: '2.0', id: request.id, result: await handle(request) })
  } catch (error) {
    if (!(error instanceof Refusal)) throw error
    reply({
      jsonrpc: '2.0',
      id: request.id,
      error: { code: -32000, message: error.message, data: { kind: error.kind } },
    })
  }
}
