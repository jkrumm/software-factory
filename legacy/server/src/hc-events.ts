import { basename } from 'node:path'
import { z } from 'zod'
import { APP_DOC, nameTab, type Rpc } from './app-doc.ts'
import { DEFAULT_PROCESS_TIMEOUT_MS } from './exec.ts'
import { type HcClient, type HcEvent, ServerStatus, STREAM_IDLE_MS, TerminalRecord } from './hc.ts'
import type { AgentSeen, RunnerChange, RunnerView } from './witness.ts'

export interface HcEventsOptions {
  client: HcClient
  /** one direct call (a list, the status, a document write) */
  timeoutMs?: number
  /** the first wait before a reconnect; it doubles up to `maxBackoffMs` */
  backoffMs?: number
  maxBackoffMs?: number
  /** a stream silent this long is dead (the core's heartbeat is every 15 s) */
  idleMs?: number
}

const TerminalList = z.object({ terminals: z.array(z.unknown()) }).loose()

/** Whether the terminal is Claude Code: it said so (a status), or Claude is what runs in it. A shell the core put back is not. */
function isAgent(record: TerminalRecord): boolean {
  if (record.state !== 'live') return false
  if (record.status !== null) return true
  const argv = record.foreground?.argv ?? record.argv
  return record.foreground?.name === 'claude' || argv.some((arg) => basename(arg) === 'claude')
}

function seen(records: Iterable<TerminalRecord>): AgentSeen[] {
  const out: AgentSeen[] = []
  for (const record of records) {
    if (!isAgent(record)) continue
    out.push({
      paneId: record.address,
      name: record.name ?? undefined,
      factoryKey: record.labels['factory.key'],
      status: record.status?.state ?? null,
      cwd: record.foreground?.cwd ?? record.cwd,
    })
  }
  return out
}

/**
 * What herdr-core says about its terminals, kept in memory from its own event stream: the snapshot, then every change.
 * The witness reads agents from here, so a status or a death shows within a moment, and a core that restarts or a `hc`
 * that dies is a stream that ends: it reconnects with a growing wait and reads everything again. A server whose pid or
 * core id changed since the last connection is announced as a restart.
 *
 * While the stream is down or has not given its snapshot, `agents()` asks the core directly, and a core that does not
 * answer is an error (the witness records nothing).
 */
export class HcEvents implements RunnerView {
  private readonly records = new Map<string, TerminalRecord>()
  private readonly listeners = new Set<(change: RunnerChange) => void>()
  /** the stream has given its snapshot and is up */
  private live = false
  /** the map is whole: a refresh after a line that could not be read failed if this is false */
  private trusted = true
  private lastLogged = ''
  private stopped = false
  private minSeq = 0
  /** the newest event seen, and what a `terminal.list` in flight must not undo (see `read`) */
  private maxSeq = 0
  private generation = 0
  private inFlight = 0
  private readonly touched = new Map<string, number>()
  private lastServer: string | undefined
  private stream: { close(): void } | undefined
  private loop: Promise<void> | undefined
  private wake: (() => void) | undefined
  private naming = false
  private namingAgain = false

  constructor(private readonly options: HcEventsOptions) {}

  start(): void {
    if (this.loop) return
    this.loop = this.run()
  }

  async stop(): Promise<void> {
    this.stopped = true
    this.stream?.close()
    this.wake?.()
    await this.loop
  }

  /** Whether the stream has given its snapshot and is still up: `agents()` answers from memory. */
  get streaming(): boolean {
    return this.warm
  }

  private get warm(): boolean {
    return this.live && this.trusted
  }

  watch(listener: (change: RunnerChange) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  async agents(): Promise<AgentSeen[]> {
    if (this.warm) return seen(this.records.values())
    return seen(await this.list())
  }

  /** `pid@core id`: the pid changes when the core restarts, the id when its state was wiped. Undefined when it cannot be told. */
  async serverId(): Promise<string | undefined> {
    try {
      return await this.status()
    } catch {
      return undefined
    }
  }

  // --- the stream ------------------------------------------------------------------------------------------------

  private async run(): Promise<void> {
    const first = this.options.backoffMs ?? 1_000
    const cap = this.options.maxBackoffMs ?? 30_000
    let delay = first
    while (!this.stopped) {
      const connected = await this.connect().catch((error: unknown) => {
        console.error('runner events', error instanceof Error ? error.message : String(error))
        return false
      })
      this.live = false
      if (this.stopped) return
      // A stream that gave a snapshot starts the wait over; one that never did doubles it.
      delay = connected ? first : Math.min(delay * 2, cap)
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, delay)
        this.wake = () => {
          clearTimeout(timer)
          resolve()
        }
      })
      this.wake = undefined
    }
  }

  /** One connection, until it ends. True if it got as far as the snapshot. */
  private async connect(): Promise<boolean> {
    let snapshot = false
    const stream = this.options.client.subscribe(
      {
        onSnapshot: (seq, terminals) => {
          let parsed: TerminalRecord[]
          try {
            parsed = this.parseAll(terminals)
          } catch (error) {
            // A snapshot with a record that does not parse is no snapshot: end the stream, the loop reconnects with its backoff.
            this.logOnce(error)
            this.stream?.close()
            return
          }
          snapshot = true
          this.minSeq = seq
          this.maxSeq = Math.max(this.maxSeq, seq)
          this.generation++
          this.replace(parsed)
          this.live = true
          this.trusted = true
          void this.afterSnapshot()
        },
        onEvent: (event) => {
          if (event.seq <= this.minSeq) return
          this.maxSeq = Math.max(this.maxSeq, event.seq)
          // A list that is in flight was read before this event: it must not undo it.
          if (this.inFlight > 0 && event.terminal) this.touched.set(event.terminal, event.seq)
          this.apply(event)
        },
        onMissed: (seq, terminals) => {
          let parsed: TerminalRecord[]
          try {
            parsed = this.parseAll(terminals)
          } catch (error) {
            this.logOnce(error)
            this.stream?.close()
            return
          }
          this.minSeq = seq
          this.maxSeq = Math.max(this.maxSeq, seq)
          this.generation++
          this.replace(parsed)
          this.trusted = true
          void this.renameTabs()
        },
        onBadLine: () => void this.refresh(),
      },
      this.options.idleMs ?? STREAM_IDLE_MS,
    )
    this.stream = stream
    await stream.closed
    this.stream = undefined
    return snapshot
  }

  /** Every record or none: one that does not parse makes the whole answer a failure, naming the first issue. */
  private parseAll(terminals: readonly unknown[]): TerminalRecord[] {
    return terminals.map((raw, index) => {
      const record = TerminalRecord.safeParse(raw)
      if (record.success) return record.data
      const issue = record.error.issues[0]
      throw new Error(
        `a terminal record (#${index}) does not parse: ${issue?.path.join('.') || '(record)'}: ${issue?.message ?? 'invalid'}`,
      )
    })
  }

  private replace(records: readonly TerminalRecord[]): void {
    this.records.clear()
    for (const record of records) this.records.set(record.address, record)
  }

  private logOnce(error: unknown): void {
    const message = error instanceof Error ? error.message : String(error)
    if (message === this.lastLogged) return
    this.lastLogged = message
    console.error('runner events', message)
  }

  /** After a (re)connect: the finished terminals the snapshot may leave out, the server's identity, the tab names. */
  private async afterSnapshot(): Promise<void> {
    try {
      const server = await this.status()
      if (this.lastServer !== undefined && server !== this.lastServer) this.emit({ kind: 'restart' })
      this.lastServer = server
      await this.read('merge')
    } catch (error) {
      // the stream is up; the next pass asks again
      this.logOnce(error)
    }
    await this.renameTabs()
  }

  /**
   * A `terminal.list` is a picture of the moment the core answered it, and events keep arriving while it is on its way: a
   * terminal an event removed or finished meanwhile must not come back, and a record must not be overwritten by one that
   * is older than an event already applied. So a terminal touched by an event after the call started keeps what the
   * events made of it; a snapshot (a new stream) in between makes the whole answer stale. `merge` adds the finished
   * terminals the snapshot may leave out; `replace` rebuilds everything from the list.
   */
  private async read(mode: 'merge' | 'replace'): Promise<void> {
    const startSeq = this.maxSeq
    const generation = this.generation
    this.inFlight++
    try {
      const all = await this.list()
      if (generation !== this.generation) return
      const newer = (address: string) => (this.touched.get(address) ?? 0) > startSeq
      if (mode === 'replace') {
        for (const address of [...this.records.keys()]) if (!newer(address)) this.records.delete(address)
      }
      for (const record of all) {
        if (newer(record.address)) continue
        if (mode === 'replace' || (record.state !== 'live' && !this.records.has(record.address))) {
          this.records.set(record.address, record)
        }
      }
    } finally {
      if (--this.inFlight === 0) this.touched.clear()
    }
  }

  /** The state may have a hole (a line that could not be read): read it all again. */
  private async refresh(): Promise<void> {
    try {
      await this.read('replace')
      this.trusted = true
      await this.renameTabs()
    } catch (error) {
      // The map may have a hole and cannot be read whole: `agents()` asks the core directly until a refresh works.
      this.trusted = false
      this.logOnce(error)
    }
  }

  private apply(event: HcEvent): void {
    const data = (event.data ?? {}) as Record<string, unknown>
    const address = event.terminal
    if (event.type === 'doc') {
      if (data.name === APP_DOC) void this.renameTabs()
      return
    }
    if (!address) return
    if (event.type === 'created' || event.type === 'restarted') {
      const record = TerminalRecord.safeParse(data)
      const before = this.records.get(address)
      if (record.success) this.records.set(address, record.data)
      if (event.type === 'restarted')
        this.emit({ kind: 'gone', paneId: address, factoryKey: before?.labels['factory.key'] })
      return
    }
    const record = this.records.get(address)
    if (!record) return
    const key = record.labels['factory.key']
    switch (event.type) {
      case 'status': {
        const status = z.object({ state: z.string() }).loose().nullable().safeParse(data.status)
        record.status = status.success ? status.data : null
        if (typeof data.reported === 'boolean') record.reported = data.reported
        this.emitStatus(record)
        return
      }
      case 'turn': {
        if (typeof data.turn === 'number') record.turn = data.turn
        if (typeof data.state === 'string') record.status = { ...record.status, state: data.state }
        this.emitStatus(record)
        return
      }
      case 'foreground': {
        const foreground = TerminalRecord.shape.foreground.safeParse(data)
        if (foreground.success) record.foreground = foreground.data
        return
      }
      case 'labels': {
        const labels = z.record(z.string(), z.string()).safeParse(data.labels)
        if (labels.success) record.labels = labels.data
        void this.renameTabs()
        return
      }
      case 'lost':
        this.emit({ kind: 'gone', paneId: address, factoryKey: key })
        return
      case 'finished':
        record.state = 'finished'
        record.status = null
        record.exit_code = typeof data.exit_code === 'number' ? data.exit_code : null
        this.emit({ kind: 'gone', paneId: address, factoryKey: key })
        return
      case 'removed':
        this.records.delete(address)
        this.emit({ kind: 'gone', paneId: address, factoryKey: key })
        return
    }
  }

  private emitStatus(record: TerminalRecord): void {
    const [agent] = seen([record])
    if (agent) this.emit({ kind: 'status', agent })
  }

  private emit(change: RunnerChange): void {
    for (const listener of this.listeners) {
      try {
        listener(change)
      } catch (error) {
        console.error('runner events listener', error instanceof Error ? error.message : String(error))
      }
    }
  }

  // --- direct calls ----------------------------------------------------------------------------------------------

  private call<S extends z.ZodType>(method: string, params: object, schema: S): Promise<z.output<S>> {
    return this.options.client.call(method, params, schema, this.options.timeoutMs ?? DEFAULT_PROCESS_TIMEOUT_MS)
  }

  private async list(): Promise<TerminalRecord[]> {
    const list = await this.call('terminal.list', { all: true }, TerminalList)
    return this.parseAll(list.terminals)
  }

  private async status(): Promise<string> {
    const status = await this.call('server.status', {}, ServerStatus)
    return `${status.pid}@${status.core.id}`
  }

  /**
   * A tab's name is the spawn key, but the app writes its entry only once it has seen the terminal: name every live tab
   * that carries `factory.tab_name` whose entry now exists. One run at a time; a change that arrives during one runs it again.
   */
  private async renameTabs(): Promise<void> {
    if (this.naming) {
      this.namingAgain = true
      return
    }
    this.naming = true
    try {
      do {
        this.namingAgain = false
        const rpc: Rpc = (method, params, schema) => this.call(method, params, schema)
        for (const record of [...this.records.values()]) {
          const name = record.labels['factory.tab_name']
          const tab = record.labels['herdr.tab']
          if (record.state === 'live' && name && tab) await nameTab(rpc, tab, name)
        }
      } while (this.namingAgain && !this.stopped)
    } finally {
      this.naming = false
    }
  }
}
