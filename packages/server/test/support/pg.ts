import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { createServer } from 'node:net'
import { join } from 'node:path'
import { SQL } from 'bun'
import { migrate } from '../../src/db.ts'

export interface TestDb {
  sql: SQL
  /** the unix socket, for a second client */
  path: string
  /** empties every table between tests */
  reset(): Promise<void>
  stop(): Promise<void>
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer()
    probe.once('error', reject)
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address()
      const port = typeof address === 'object' && address ? address.port : 0
      probe.close(() => resolve(port))
    })
  })
}

async function run(cmd: string[]): Promise<void> {
  const proc = Bun.spawn(cmd, { stdout: 'ignore', stderr: 'pipe' })
  const [stderr, code] = await Promise.all([proc.stderr.text(), proc.exited])
  if (code !== 0) throw new Error(`${cmd.join(' ')} exited ${code}: ${stderr}`)
}

/**
 * The directory holding `initdb` and `pg_ctl`: `PG_BIN_DIR`, else PATH (Homebrew), else the newest
 * /usr/lib/postgresql/<major>/bin (the packages preinstalled on GitHub's Ubuntu runners keep them off PATH).
 */
async function pgBinDir(): Promise<string> {
  if (process.env.PG_BIN_DIR) return process.env.PG_BIN_DIR
  const onPath = Bun.which('initdb')
  if (onPath) return join(onPath, '..')
  const majors = await readdir('/usr/lib/postgresql').catch(() => [] as string[])
  const newest = majors.sort((a, b) => Number(b) - Number(a))[0]
  if (!newest) throw new Error('no PostgreSQL binaries: put initdb on PATH or set PG_BIN_DIR')
  return join('/usr/lib/postgresql', newest, 'bin')
}

/** A private Postgres cluster in a temp dir, reachable only through a unix socket inside it. */
export async function startTestDb(options: { migrate?: boolean } = {}): Promise<TestDb> {
  // /tmp, not os.tmpdir(): macOS temp paths can push the socket path past its length limit.
  const root = await mkdtemp('/tmp/factory-pg-')
  const data = join(root, 'data')
  const bin = await pgBinDir()
  const port = await freePort()
  const serverOptions = `-c listen_addresses= -c unix_socket_directories=${root} -c fsync=off -c port=${port}`

  let started = false
  const stop = async () => {
    if (started) await run([join(bin, 'pg_ctl'), '-D', data, '-m', 'immediate', '-w', 'stop']).catch(() => {})
    await rm(root, { recursive: true, force: true })
  }

  try {
    await run([join(bin, 'initdb'), '-U', 'factory', '--auth=trust', '-D', data])
    await run([join(bin, 'pg_ctl'), '-D', data, '-w', '-l', join(root, 'pg.log'), '-o', serverOptions, 'start'])
    started = true
  } catch (error) {
    await stop()
    throw error
  }

  const sql = new SQL({
    adapter: 'postgres',
    path: join(root, `.s.PGSQL.${port}`),
    username: 'factory',
    database: 'postgres',
    max: 8,
  })
  if (options.migrate !== false) await migrate(sql)

  return {
    sql,
    path: join(root, `.s.PGSQL.${port}`),
    reset: async () => {
      await sql`TRUNCATE factory.events, factory.capacity_readings, factory.quota_readings, factory.queue_states, factory.spawns, factory.sessions, factory.witness RESTART IDENTITY`
    },
    stop: async () => {
      await sql.close()
      await stop()
    },
  }
}
