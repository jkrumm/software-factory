// The ports of the library: everything that leaves the process sits behind one of these, and a test hands in a fake.
// The adapters: spawn.ts (processes), oauth.ts (the usage endpoint), keychain.ts (the login item), claude-auth.ts
// (`claude auth status`), integrations.ts (the peer import, the relogin ask and the health peer: commands the user configures).

export interface SpawnResult {
  status: number | null
  stdout: string
  stderr: string
  /** Set when the process could not start (ENOENT) or was killed by the timeout. */
  error?: { code?: string; message: string }
}
export type Spawner = (
  cmd: string,
  args: string[],
  opts: { env: Record<string, string>; timeoutMs: number },
) => SpawnResult

export interface HttpResponse {
  status: number
  json: unknown
}
/** GET with a hard timeout; throws on network errors. */
export type HttpGet = (url: string, headers: Record<string, string>, timeoutMs: number) => Promise<HttpResponse>

/** The peer machine's `usage --json` body, parsed; throws or answers null when unreachable. */
export type PeerUsage = () => unknown | Promise<unknown>
