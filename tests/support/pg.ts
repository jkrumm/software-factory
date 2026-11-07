import { randomBytes } from 'node:crypto'
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { join } from 'node:path'
import { SQL } from 'bun'

/** A private Postgres cluster for one test file: nothing it does touches a real database. */
export interface TestCluster {
  /** `DATABASE_URL` for a server process: loopback TCP, a random port and a random password */
  url: string
  /** a client of the cluster's `postgres` database, for assertions */
  sql: SQL
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

/**
 * Pinned locale for the cluster's processes: without LANG/LC_* (a launchd-started host) macOS Postgres picks the system
 * locale and its postmaster turns multithreaded at start (FATAL, "set LC_ALL to a valid locale").
 */
const PG_ENV = { ...process.env, LC_ALL: 'C' }

async function run(cmd: string[]): Promise<void> {
  const proc = Bun.spawn(cmd, { stdout: 'ignore', stderr: 'pipe', env: PG_ENV })
  const [stderr, code] = await Promise.all([proc.stderr.text(), proc.exited])
  if (code !== 0) throw new Error(`${cmd.join(' ')} exited ${code}: ${stderr}`)
}

/**
 * The directory holding `initdb` and `pg_ctl`: `PG_BIN_DIR`, else PATH (Homebrew), else the newest
 * /usr/lib/postgresql/<major>/bin (GitHub's Ubuntu runners ship the packages off PATH).
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

/**
 * Starts a cluster in a temp dir. It listens on 127.0.0.1 because Bun's SQL client takes no unix socket from a URL, and
 * a server process gets its database as `DATABASE_URL`; the random password keeps other local users out.
 */
export async function startTestCluster(): Promise<TestCluster> {
  // /tmp, not os.tmpdir(): macOS temp paths can push the socket path past its length limit.
  const root = await mkdtemp('/tmp/factory-pg-')
  const data = join(root, 'data')
  const pwfile = join(root, 'pw')
  const password = randomBytes(18).toString('hex')
  await writeFile(pwfile, password, { mode: 0o600 })
  const bin = await pgBinDir()
  const port = await freePort()
  const serverOptions = `-c listen_addresses=127.0.0.1 -c unix_socket_directories=${root} -c fsync=off -c port=${port}`

  let started = false
  const stopCluster = async () => {
    if (started) await run([join(bin, 'pg_ctl'), '-D', data, '-m', 'immediate', '-w', 'stop']).catch(() => {})
    await rm(root, { recursive: true, force: true })
  }

  try {
    await run([
      join(bin, 'initdb'),
      '-U',
      'factory',
      '--locale=C',
      '-E',
      'UTF8',
      '--auth=scram-sha-256',
      `--pwfile=${pwfile}`,
      '-D',
      data,
    ])
    await run([join(bin, 'pg_ctl'), '-D', data, '-w', '-l', join(root, 'pg.log'), '-o', serverOptions, 'start'])
    started = true
  } catch (error) {
    await stopCluster()
    throw error
  }

  const url = `postgres://factory:${password}@127.0.0.1:${port}/postgres`
  const sql = new SQL(url, { max: 4 })
  return {
    url,
    sql,
    stop: async () => {
      await sql.close()
      await stopCluster()
    },
  }
}
