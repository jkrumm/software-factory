import { cp, readdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

/** The Console build the other tests serve. */
export const DIST = join(import.meta.dir, '..', '..', 'apps', 'console', 'dist')

const TEXT = /\.(?:js|html|css|webmanifest)$/

async function* files(dir: string): AsyncGenerator<string> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) yield* files(path)
    else yield path
  }
}

/**
 * Serves a copy of the Console build on a port of its own and forwards `/v1` and `/health` to the real Console listener,
 * so a test can replace the build under an open page the way a deploy does. Every file is `no-cache`, as the real listener's.
 */
export async function serveBuild(
  dir: string,
  upstream: string,
): Promise<{ url: string; stop: () => Promise<void>; swap: (oldId: string) => Promise<string> }> {
  await cp(DIST, dir, { recursive: true })
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    // the event stream is idle between frames
    idleTimeout: 0,
    async fetch(request) {
      const { pathname, search } = new URL(request.url)
      if (pathname === '/health' || pathname.startsWith('/v1/')) {
        const headers = new Headers(request.headers)
        headers.delete('host')
        const answer = await fetch(`${upstream}${pathname}${search}`, {
          method: request.method,
          headers,
          body: request.method === 'GET' ? undefined : await request.arrayBuffer(),
        })
        const out = new Headers(answer.headers)
        out.delete('content-encoding')
        out.delete('content-length')
        return new Response(answer.body, { status: answer.status, headers: out })
      }
      const wanted = Bun.file(join(dir, pathname === '/' ? 'index.html' : pathname))
      const file = (await wanted.exists()) && !pathname.endsWith('/') ? wanted : Bun.file(join(dir, 'index.html'))
      return new Response(file, { headers: { 'cache-control': 'no-cache' } })
    },
  })
  return {
    url: `http://127.0.0.1:${server.port}`,
    stop: () => server.stop(true),
    swap: (oldId) => swapBuild(dir, oldId),
  }
}

/**
 * Turns the served build into a new one, the way a rebuild does: a new build id in the entry chunk, every script and
 * stylesheet under a new name (a rebuilt chunk that imports a changed one is itself new, and the worker keeps a cached file
 * for as long as its name stays), and a new revision for `index.html` in the worker's precache list, so the worker's bytes
 * change and it fetches them all. Returns the new build id.
 */
async function swapBuild(dir: string, oldId: string): Promise<string> {
  const newId = Date.now().toString(36)
  if (newId === oldId) throw new Error('the new build id equals the old one')
  const assets = join(dir, 'assets')
  const names = (await readdir(assets))
    .filter((name) => /\.(?:js|css)$/.test(name))
    .map((name) => name.replace(/\.\w+$/, ''))
  if (!names.some((name) => name.startsWith('index-'))) throw new Error('the build has no entry chunk')
  const renamed = new RegExp(
    `(${names.map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})(?=\\.(?:js|css))`,
    'g',
  )
  for await (const path of files(dir)) {
    if (!TEXT.test(path)) continue
    const text = await readFile(path, 'utf8')
    let next = text.replace(renamed, `$1-${newId}`).replaceAll(oldId, newId)
    if (path.endsWith('sw.js')) next = next.replace(/(url:"index\.html",revision:")[^"]+/, `$1${newId}`)
    if (next !== text) await writeFile(path, next)
  }
  for (const name of await readdir(assets)) {
    if (!/\.(?:js|css)$/.test(name)) continue
    const [base, extension] = [name.replace(/\.\w+$/, ''), name.replace(/^.*(\.\w+)$/, '$1')]
    await rename(join(assets, name), join(assets, `${base}-${newId}${extension}`))
  }
  return newId
}
