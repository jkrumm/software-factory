import { format } from 'node:util'
import { isQuiet, logEvent, quietly } from '../../kernel/telemetry.ts'

export { quietly }

/**
 * Puts an ISO time in front of every line of what the process writes. A chunk need not end in a newline, so the stamper
 * remembers whether the next character starts a line. An empty line gets a time too: every line of the log has one.
 */
export function lineStamper(now: () => Date = () => new Date()): (text: string) => string {
  let atStart = true
  return (text) => {
    const parts = text.split('\n')
    let out = ''
    parts.forEach((part, index) => {
      if (part !== '') {
        if (atStart) out += `${now().toISOString()} `
        out += part
        atStart = false
      }
      if (index === parts.length - 1) return
      if (atStart) out += `${now().toISOString()} `
      out += '\n'
      atStart = true
    })
    return out
  }
}

const CONSOLE_METHODS = ['log', 'info', 'debug', 'warn', 'error'] as const

type Write = (chunk: string | Uint8Array, ...rest: unknown[]) => boolean

interface Streams {
  stdout: { write: Write }
  stderr: { write: Write }
}

/**
 * Stamps what the process writes to stdout and stderr (`console.*` and direct writes alike: Bun's console does not go through
 * `process.stdout.write`, so the console methods are routed there). A `console.warn` or `console.error` that nothing
 * structured has reported also becomes one log record with the loop it happened in and the length of the line, no text:
 * every error line the server writes has a counterpart in ClickStack. Returns what puts everything back.
 */
export function installStampedConsole(
  options: { now?: () => Date; streams?: Streams; target?: Console } = {},
): () => void {
  const streams = options.streams ?? process
  const target = options.target ?? console
  const originalWrites = { stdout: streams.stdout.write, stderr: streams.stderr.write }
  const originalConsole = CONSOLE_METHODS.map((method) => [method, Reflect.get(target, method) as unknown] as const)
  const wrap = (stream: 'stdout' | 'stderr') => {
    const stamp = lineStamper(options.now)
    const original = originalWrites[stream] as Write
    streams[stream].write = function (this: unknown, chunk: string | Uint8Array, ...rest: unknown[]) {
      const text = typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk)
      return original.call(streams[stream], stamp(text), ...rest)
    }
  }
  wrap('stdout')
  wrap('stderr')
  const through =
    (stream: 'stdout' | 'stderr', level: 'warn' | 'error' | null) =>
    (...args: unknown[]) => {
      const line = format(...args)
      streams[stream].write(`${line}\n`)
      if (level && !isQuiet()) logEvent(level, `console.${level}`, { chars: line.length })
    }
  target.log = through('stdout', null)
  target.info = through('stdout', null)
  target.debug = through('stdout', null)
  target.warn = through('stderr', 'warn')
  target.error = through('stderr', 'error')
  return () => {
    streams.stdout.write = originalWrites.stdout
    streams.stderr.write = originalWrites.stderr
    for (const [method, original] of originalConsole) Reflect.set(target, method, original)
  }
}
