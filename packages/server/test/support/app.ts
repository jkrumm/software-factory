import type { SQL } from 'bun'
import type { Clock } from '../../src/clock.ts'
import { serve } from '../../src/http.ts'

export interface TestApp {
  get(path: string): Promise<Response>
  send(method: 'POST' | 'PUT', path: string, body: unknown): Promise<Response>
  raw(path: string, body: string): Promise<Response>
  request(method: string, path: string): Promise<Response>
  stop(): Promise<void>
}

/** The real server on a loopback port the OS picks. */
export function startApp(deps: { sql: SQL; clock: Clock }): TestApp {
  const server = serve({ ...deps, port: 0, version: 'test' })
  const url = (path: string) => new URL(path, server.url)
  return {
    get: (path) => fetch(url(path)),
    send: (method, path, body) =>
      fetch(url(path), { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
    raw: (path, body) => fetch(url(path), { method: 'POST', body }),
    request: (method, path) => fetch(url(path), { method }),
    stop: async () => {
      await server.stop(true)
    },
  }
}
