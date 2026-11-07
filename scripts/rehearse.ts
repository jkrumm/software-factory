#!/usr/bin/env bun
/**
 * The cutover rehearsal (`make rehearse`, `docs/rewrite/cutover-runbook.md`): everything a window does, on a copy of the
 * live data in a private Postgres cluster, with nothing live touched except one read-only `pg_dump`.
 *
 *   1. dump the live schema `factory` (read only) and restore it as the `factory` role would own it
 *   2. the admin's step: rename it `factory_legacy`, a new empty `factory` (and prove the role itself cannot)
 *   3. boot the new server on it (loops off, as in a window's paused start); migrations apply
 *   4. import, import again (nothing changes), compare (zero unexplained)
 *   5. the scenarios on the imported data (tests/scenarios/cutover)
 *   6. the way back: the new schema aside, the old one back, the old core's release boots on it and answers
 *   7. the next window: the new core's own schema forward again, the import carries on from where it was
 *
 * Prints one summary and exits 1 on any failed step. The copy holds the live data: it is deleted at the end unless --keep.
 *
 *   bun scripts/rehearse.ts [--dump <file>] [--old-ref master] [--skip-old] [--keep] [--json]
 */
import { randomBytes } from 'node:crypto'
import { chmod, mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { join } from 'node:path'
import { SQL } from 'bun'
import { startWorldOn, TOKENS } from '../tests/scenarios/harness.ts'
import type { TestCluster } from '../tests/support/pg.ts'
import { hostEnv, installHost } from '../tests/scenarios/host.ts'

const ROOT = join(import.meta.dir, '..')
const args = process.argv.slice(2)
const flag = (name: string): boolean => args.includes(name)
const option = (name: string): string | undefined => {
  const at = args.indexOf(name)
  return at >= 0 ? args[at + 1] : undefined
}

interface Step {
  name: string
  ok: boolean
  seconds: number
  detail: string
}
const steps: Step[] = []
const say = (text: string): void => console.error(`[rehearse] ${text}`)

async function step(name: string, run: () => Promise<string>): Promise<boolean> {
  const started = Date.now()
  say(`${name} …`)
  try {
    const detail = await run()
    steps.push({ name, ok: true, seconds: (Date.now() - started) / 1000, detail })
    say(`${name}: ok (${detail.split('\n')[0]})`)
    return true
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    steps.push({ name, ok: false, seconds: (Date.now() - started) / 1000, detail })
    say(`${name}: FAILED: ${detail.split('\n')[0]}`)
    return false
  }
}

async function run(
  cmd: string[],
  options: { env?: Record<string, string>; input?: string; cwd?: string } = {},
): Promise<{ code: number; out: string; err: string }> {
  const proc = Bun.spawn(cmd, {
    cwd: options.cwd ?? ROOT,
    env: { ...process.env, LC_ALL: 'C', ...options.env },
    stdin: options.input === undefined ? 'ignore' : new Blob([options.input]),
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [out, err, code] = await Promise.all([proc.stdout.text(), proc.stderr.text(), proc.exited])
  return { code, out, err }
}

async function mustRun(cmd: string[], options: Parameters<typeof run>[1] = {}): Promise<string> {
  const result = await run(cmd, options)
  if (result.code !== 0) throw new Error(`${cmd[0]} exited ${result.code}: ${(result.err || result.out).slice(-1500)}`)
  return result.out
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

const pgBin = (): string => {
  const initdb = Bun.which('initdb')
  if (process.env.PG_BIN_DIR) return process.env.PG_BIN_DIR
  if (!initdb) throw new Error('initdb is not on PATH (set PG_BIN_DIR)')
  return join(initdb, '..')
}

/** A private cluster with the production shape: an admin superuser, the `factory` role (no CREATE on the database) and the database `shared`. */
async function startCluster(work: string) {
  const bin = pgBin()
  const data = join(work, 'pg')
  const pwfile = join(work, 'pw')
  const adminPw = randomBytes(18).toString('hex')
  const factoryPw = randomBytes(18).toString('hex')
  await writeFile(pwfile, adminPw, { mode: 0o600 })
  await mustRun([
    join(bin, 'initdb'),
    '-U',
    'admin',
    '--locale=C',
    '-E',
    'UTF8',
    '--auth=scram-sha-256',
    `--pwfile=${pwfile}`,
    '-D',
    data,
  ])
  const port = await freePort()
  await mustRun([
    join(bin, 'pg_ctl'),
    '-D',
    data,
    '-w',
    '-l',
    join(work, 'pg.log'),
    '-o',
    `-c listen_addresses=127.0.0.1 -c unix_socket_directories=${work} -c fsync=off -c port=${port}`,
    'start',
  ])
  const adminUrl = (db: string) => `postgres://admin:${adminPw}@127.0.0.1:${port}/${db}`
  const factoryUrl = `postgres://factory:${factoryPw}@127.0.0.1:${port}/shared`
  const admin = new SQL(adminUrl('postgres'), { max: 2 })
  await admin.unsafe(`CREATE ROLE factory LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD '${factoryPw}'`)
  await admin.unsafe('CREATE DATABASE shared')
  await admin.unsafe('REVOKE CONNECT ON DATABASE shared FROM PUBLIC')
  await admin.unsafe('GRANT CONNECT ON DATABASE shared TO factory')
  await admin.close()
  return {
    bin,
    port,
    adminPw,
    factoryPw,
    factoryUrl,
    adminSql: () => new SQL(adminUrl('shared'), { max: 2 }),
    adminUrl: adminUrl('shared'),
    stop: () => run([join(bin, 'pg_ctl'), '-D', data, '-m', 'immediate', '-w', 'stop']),
  }
}

/** Runs one of the admin's SQL files exactly as the runbook does: psql, ON_ERROR_STOP, the file on stdin. */
async function adminFile(cluster: Awaited<ReturnType<typeof startCluster>>, file: string): Promise<void> {
  await mustRun([
    join(cluster.bin, 'psql'),
    '-X',
    '-q',
    cluster.adminUrl,
    '-v',
    'ON_ERROR_STOP=1',
    '-f',
    join(ROOT, 'scripts', 'cutover', file),
  ])
}

async function asFactory(cluster: Awaited<ReturnType<typeof startCluster>>, file: string): Promise<string> {
  return mustRun([
    join(cluster.bin, 'psql'),
    '-X',
    '-q',
    '-A',
    '-t',
    cluster.factoryUrl,
    '-v',
    'ON_ERROR_STOP=1',
    '-f',
    join(ROOT, 'scripts', 'cutover', file),
  ])
}

/** Row counts and a content hash of the old core's schema: proves nothing in it changed. */
async function fingerprint(sql: SQL, schemaName: string): Promise<string> {
  const tables = (await sql`SELECT tablename FROM pg_tables WHERE schemaname = ${schemaName} ORDER BY 1`) as {
    tablename: string
  }[]
  const parts: string[] = []
  for (const { tablename } of tables) {
    const [row] = (await sql.unsafe(
      `SELECT count(*)::int AS n, md5(coalesce(string_agg(t::text, '|' ORDER BY t::text), '')) AS h FROM ${schemaName}.${tablename} t`,
    )) as { n: number; h: string }[]
    parts.push(`${tablename}:${row?.n}:${row?.h}`)
  }
  return (
    `${Bun.hash(parts.join('\n')).toString(16)}` +
    ` (${tables.length} tables, ${parts.map((p) => p.split(':')[1]).reduce((a, b) => a + Number(b), 0)} rows)`
  )
}

async function healthy(
  url: string,
  expect?: (body: Record<string, unknown>) => boolean,
  ms = 60_000,
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + ms
  let last = ''
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${url}/health`)
      const body = (await response.json()) as Record<string, unknown>
      last = JSON.stringify(body)
      if (response.status === 200 && (!expect || expect(body))) return body
    } catch (error) {
      last = error instanceof Error ? error.message : String(error)
    }
    await Bun.sleep(300)
  }
  throw new Error(`no healthy answer from ${url} within ${ms / 1000} s (last: ${last.slice(0, 300)})`)
}

async function main(): Promise<number> {
  const work = await mkdtemp('/tmp/factory-rehearsal-')
  await chmod(work, 0o700)
  say(`working in ${work}`)
  const keep = flag('--keep')
  let cluster: Awaited<ReturnType<typeof startCluster>> | null = null
  let server: { stop(): Promise<number | void> } | null = null
  let fingerprintBefore = ''
  let imported = ''
  const home = join(work, 'home')
  await mkdir(home, { recursive: true })
  const dataDir = join(work, 'data')
  const importEnv = (): Record<string, string> => ({
    DATABASE_URL: cluster?.factoryUrl ?? '',
    FACTORY_DATA_DIR: dataDir,
    HOME: home,
  })
  const importer = (...extra: string[]) =>
    run([process.execPath, 'apps/server/scripts/import-legacy.ts', ...extra], { env: importEnv() })

  const stopServer = async () => {
    if (server) await server.stop()
    server = null
  }

  try {
    // 1. the copy
    const dump = option('--dump') ?? join(work, 'live.dump')
    if (!option('--dump')) {
      const ok = await step('dump the live schema (read only)', async () => {
        const password = (await mustRun(['secrets-run', 'read', 'op://mini/vps-dev/SHARED_FACTORY_DB_PASSWORD'])).trim()
        await mustRun(
          [
            'pg_dump',
            '-h',
            '127.0.0.1',
            '-U',
            'factory',
            '-d',
            'shared',
            '-n',
            'factory',
            '-Fc',
            '--no-privileges',
            '-f',
            dump,
          ],
          {
            env: { PGPASSWORD: password, PGCONNECT_TIMEOUT: '10' },
          },
        )
        return `${(Bun.file(dump).size / 1024 / 1024).toFixed(1)} MB`
      })
      if (!ok) return 1
    }
    cluster = await startCluster(work)
    const ready = await step('restore into a private cluster (role factory, no CREATE on the database)', async () => {
      if (!cluster) throw new Error('no cluster')
      const prepare = cluster.adminSql()
      // pg_restore -n restores a schema's contents, not the schema: live has it, owned by the role.
      await prepare.unsafe('CREATE SCHEMA factory AUTHORIZATION factory')
      await prepare.close()
      await mustRun([
        join(cluster.bin, 'pg_restore'),
        '-d',
        cluster.adminUrl,
        '--no-privileges',
        '-n',
        'factory',
        '--exit-on-error',
        dump,
      ])
      const admin = cluster.adminSql()
      const [row] =
        (await admin`SELECT (SELECT count(*)::int FROM factory.issues) AS issues, (SELECT count(*)::int FROM factory.issue_events) AS events`) as {
          issues: number
          events: number
        }[]
      const [owner] =
        (await admin`SELECT pg_get_userbyid(nspowner) AS owner FROM pg_namespace WHERE nspname = 'factory'`) as {
          owner: string
        }[]
      await admin.close()
      return `${row?.issues} Issues, ${row?.events} events, schema owned by ${owner?.owner}`
    })
    if (!ready || !cluster) return 1

    // 2. the admin's step
    const swapped = await step(
      'admin: rename to factory_legacy, new empty factory (the role itself may not)',
      async () => {
        if (!cluster) throw new Error('no cluster')
        const own = new SQL(cluster.factoryUrl, { max: 1 })
        const refusal = await own.unsafe('ALTER SCHEMA factory RENAME TO factory_probe').then(
          () => 'ALLOWED',
          (error: unknown) => (error instanceof Error ? error.message : String(error)),
        )
        const create = await own.unsafe('CREATE SCHEMA factory_probe').then(
          () => 'ALLOWED',
          (error: unknown) => (error instanceof Error ? error.message : String(error)),
        )
        await own.close()
        if (refusal === 'ALLOWED' || create === 'ALLOWED')
          throw new Error('the factory role can rename or create a schema: the permissions differ from live')
        const admin = cluster.adminSql()
        fingerprintBefore = await fingerprint(admin, 'factory')
        await admin.close()
        await adminFile(cluster, 'schema-swap.sql')
        const check = cluster.adminSql()
        const after = await fingerprint(check, 'factory_legacy')
        await check.close()
        if (after !== fingerprintBefore)
          throw new Error(`the old schema changed by being renamed: ${fingerprintBefore} vs ${after}`)
        return `role refused rename ("${refusal.slice(0, 60)}") and create; old schema ${fingerprintBefore}`
      },
    )
    if (!swapped) return 1

    // 3. the new core boots on it (loops off: a window's paused start)
    const world = await startWorldOn({
      url: cluster.factoryUrl,
      sql: new SQL(cluster.factoryUrl, { max: 1 }),
      stop: async () => {},
    } satisfies TestCluster)
    const booted = await step('boot the new core through scripts/launch.sh (paused by the settings file)', async () => {
      if (!cluster) throw new Error('no cluster')
      const launched = await launchViaScript(
        work,
        home,
        { port: cluster.port, password: cluster.factoryPw },
        { FACTORY_DATA_DIR: dataDir },
      )
      server = {
        stop: async () => {
          launched.proc.kill('SIGTERM')
          return launched.proc.exited
        },
      }
      const body = await healthy(launched.url, undefined, 60_000).catch((error: unknown) => {
        throw new Error(
          `${error instanceof Error ? error.message : String(error)}\nlauncher output:\n${launched.output().slice(-2000)}`,
        )
      })
      const sql = new SQL(cluster.factoryUrl, { max: 1 })
      const [row] = (await sql`SELECT count(*)::int AS n FROM factory.schema_migrations`) as { n: number }[]
      await sql.close()
      const loops = JSON.stringify(body.loops ?? '').slice(0, 80)
      return `/health ${String(body.status)}, ${row?.n} migrations applied, loops ${loops}`
    })
    if (!booted) return 1

    // 4. import, again, compare
    const first = await step('import', async () => {
      const result = await importer()
      if (result.code !== 0) throw new Error(`exit ${result.code}\n${result.out}\n${result.err}`.slice(-3000))
      imported = result.out
      return result.out.split('\n')[0] ?? ''
    })
    const snapshot = async () => {
      const sql = new SQL(cluster?.factoryUrl ?? '', { max: 1 })
      const tables = [
        'issues',
        'issue_events',
        'decisions',
        'quality_ships',
        'quality_evidence',
        'quality_watches',
        'quality_checks',
        'planning_prios',
        'planning_edges',
        'planning_filed_rows',
        'capacity_claims',
        'import_events',
        'import_issues',
        'artifacts',
        'intake_door_routes',
      ]
      const out: string[] = []
      for (const t of tables) {
        const [r] = (await sql.unsafe(`SELECT count(*)::int AS n FROM factory.${t}`)) as { n: number }[]
        out.push(`${t}=${r?.n}`)
      }
      await sql.close()
      return out.join(' ')
    }
    if (first) {
      const before = await snapshot()
      await step('import again: nothing changes', async () => {
        const result = await importer()
        if (result.code !== 0) throw new Error(`exit ${result.code}\n${result.out}\n${result.err}`.slice(-2000))
        const after = await snapshot()
        if (after !== before) throw new Error(`the second run changed the data:\n${before}\n${after}`)
        return `${result.out.split('\n')[0]}; ${after.split(' ').slice(0, 3).join(' ')}`
      })
    }
    await step('compare every Issue, old against new (zero unexplained)', async () => {
      const result = await importer('--compare')
      if (result.code !== 0) throw new Error(`${result.out}\n${result.err}`.slice(-4000))
      return result.out.split('\n')[0] ?? ''
    })
    await step('the old schema is untouched by the import', async () => {
      const admin = cluster?.adminSql()
      if (!admin) throw new Error('no cluster')
      const after = await fingerprint(admin, 'factory_legacy')
      await admin.close()
      if (after !== fingerprintBefore) throw new Error(`factory_legacy changed: ${fingerprintBefore} vs ${after}`)
      return after
    })
    await stopServer()
    await world.stop().catch(() => {})

    // 5. the scenarios on the imported data
    await step('scenarios on the imported data (tests/scenarios/cutover)', async () => {
      const result = await run([process.execPath, 'test', './tests/scenarios/cutover'], {
        env: { REHEARSAL_DATABASE_URL: cluster?.factoryUrl ?? '', REHEARSAL_DATA_DIR: dataDir, HOME: home },
      })
      const tail = `${result.out}\n${result.err}`
      if (result.code !== 0) throw new Error(tail.slice(-4000))
      const pass = /(\d+) pass/.exec(tail)?.[1] ?? '?'
      const fail = /(\d+) fail/.exec(tail)?.[1] ?? '?'
      return `${pass} pass, ${fail} fail`
    })

    // 6. the way back
    if (cluster) {
      const back = await step('the way back: new schema aside, old schema back, its release boots on it', async () => {
        if (!cluster) throw new Error('no cluster')
        await adminFile(cluster, 'schema-back.sql')
        const bump = (await asFactory(cluster, 'old-sequence.sql')).trim()
        const admin = cluster.adminSql()
        const after = await fingerprint(admin, 'factory')
        await admin.close()
        if (after !== fingerprintBefore) throw new Error(`the old schema changed: ${fingerprintBefore} vs ${after}`)
        if (flag('--skip-old'))
          return `old schema back untouched (${after}); old core not booted (--skip-old); numbers continue at ${bump}`
        return `${await bootOld(work, cluster.factoryUrl, home, option('--old-ref') ?? 'master')}; numbers continue at ${bump}`
      })
      // 7. the next window
      if (back) {
        await step('the next window: forward again, the import carries on', async () => {
          if (!cluster) throw new Error('no cluster')
          await adminFile(cluster, 'schema-forward.sql')
          // The old core has run since (it prunes and records on its own): only the import must leave it as it found it.
          const check = cluster.adminSql()
          const found = await fingerprint(check, 'factory_legacy')
          const result = await importer()
          const left = await fingerprint(check, 'factory_legacy')
          await check.close()
          if (left !== found) throw new Error(`the import changed the old schema: ${found} vs ${left}`)
          if (result.code !== 0) throw new Error(`exit ${result.code}\n${result.out}\n${result.err}`.slice(-3000))
          const sql = new SQL(cluster.factoryUrl, { max: 1 })
          const [row] =
            (await sql`SELECT count(*)::int AS n FROM factory.issues WHERE id NOT IN (SELECT issue_id FROM factory.import_issues)`) as {
              n: number
            }[]
          await sql.close()
          if (!/ 0 imported, 0 appended/.test(result.out))
            throw new Error(`the second window's import changed Issues:\n${result.out.split('\n')[0]}`)
          return `${result.out.split('\n')[0]}; ${row?.n} Issues the new core made are still there`
        })
      }
    }
  } finally {
    await stopServer().catch(() => {})
    await cluster?.stop().catch(() => {})
    if (!keep) await rm(work, { recursive: true, force: true })
    else say(`kept ${work} (it holds the live data: delete it)`)
  }

  const failed = steps.filter((s) => !s.ok)
  if (flag('--json')) console.log(JSON.stringify({ steps, import: imported }, null, 2))
  else {
    console.log('\nrehearsal summary')
    console.log('|step|result|seconds|detail|')
    console.log('|-|-|-|-|')
    for (const s of steps)
      console.log(
        `|${s.name}|${s.ok ? 'ok' : 'FAILED'}|${s.seconds.toFixed(1)}|${s.detail.split('\n')[0]?.replaceAll('|', '/')}|`,
      )
    for (const s of failed) console.log(`\n${s.name}: FAILED\n${s.detail}`)
    if (imported) console.log(`\nimport output:\n${imported}`)
    console.log(failed.length === 0 ? '\nthe rehearsal held' : `\n${failed.length} step(s) failed`)
  }
  return failed.length === 0 ? 0 : 1
}

/**
 * The window's own start: `scripts/launch.sh` in this tree, under a fake `secrets-run` that resolves every ref of the template from a
 * directory of files, with the settings file `~/.config/factory/env` of a paused start. Returns the process (stop it with SIGTERM).
 */
async function launchViaScript(
  work: string,
  home: string,
  cluster: { port: number; password: string },
  env: Record<string, string>,
) {
  const secrets = join(work, 'secrets')
  await mkdir(secrets, { recursive: true })
  const values: Record<string, string> = {
    FACTORY_DB_PASSWORD: cluster.password,
    FACTORY_TOKEN: TOKENS.owner,
    FACTORY_READ_TOKEN: TOKENS.read,
    FACTORY_AGENT_TOKEN: TOKENS.agent,
    FACTORY_DOOR_TOKEN: TOKENS.machine,
    FACTORY_SIGNAL_TOKEN: TOKENS.signal,
    FACTORY_GITHUB_TOKEN: 'rehearsal-not-a-token',
    NTFY_TOKEN: 'rehearsal-not-a-token',
  }
  for (const [name, value] of Object.entries(values)) await writeFile(join(secrets, name), value)
  const bin = join(home, '.local', 'bin')
  await mkdir(bin, { recursive: true })
  await writeFile(
    join(bin, 'secrets-run'),
    `#!/bin/bash
# the rehearsal's secrets-run: export | run | read, every ref resolved from a file named after its key
dir="${secrets}"
cmd=$1; shift
tpl=""; ref=""
while [ "$#" -gt 0 ]; do
  case "$1" in --env-file=*) tpl=\${1#--env-file=}; shift ;; --) shift; break ;; *) ref=$1; shift ;; esac
done
keys=$(grep -hoE '^[A-Za-z_][A-Za-z0-9_]*=' "$tpl" 2>/dev/null | tr -d =)
case "$cmd" in
  read) cat "$dir/\${ref##*/}" ;;
  export) for k in $keys; do printf "export %s='%s'\n" "$k" "$(cat "$dir/$k")"; done ;;
  run) for k in $keys; do export "$k=$(cat "$dir/$k")"; done; exec "$@" ;;
esac
`,
    { mode: 0o755 },
  )
  const file = join(home, '.config', 'factory', 'env')
  await mkdir(join(file, '..'), { recursive: true })
  await writeFile(file, 'FACTORY_TICK_MS=0\n', { mode: 0o600 })
  const port = await freePort()
  const proc = Bun.spawn(['/bin/bash', join(ROOT, 'scripts', 'launch.sh')], {
    cwd: ROOT,
    env: {
      PATH: process.env.PATH ?? '',
      HOME: home,
      LC_ALL: 'C',
      PORT: String(port),
      FACTORY_VERSION: 'rehearsal',
      HC_BIN: join(work, 'no-hc'),
      FACTORY_DB_ADDR: `127.0.0.1:${cluster.port}`,
      ...env,
    },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  let output = ''
  void (async () => {
    for await (const chunk of proc.stderr) output += new TextDecoder().decode(chunk)
  })()
  void (async () => {
    for await (const chunk of proc.stdout) output += new TextDecoder().decode(chunk)
  })()
  return { url: `http://127.0.0.1:${port}`, proc, output: () => output }
}

/** Exports master's release (what `make rollback` would boot), installs it, boots it on the old schema and reads it. */
async function bootOld(work: string, databaseUrl: string, home: string, ref: string): Promise<string> {
  const sha = (await mustRun(['git', 'rev-parse', ref])).trim()
  const dir = join(work, 'old-release')
  await mkdir(dir, { recursive: true })
  await mustRun(['bash', '-c', `git archive --format=tar ${sha} | tar -x -C ${dir}`])
  await mustRun(['bun', 'install', '--frozen-lockfile'], { cwd: dir })
  const bin = join(work, 'old-bin')
  await mkdir(bin, { recursive: true })
  for (const tool of ['hc', 'agw']) {
    const shim = join(bin, tool)
    await writeFile(
      shim,
      `#!/bin/sh\nexec "${process.execPath}" "${join(ROOT, 'tests', 'scenarios', 'fakes', `${tool}.ts`)}" "$@"\n`,
    )
    await chmod(shim, 0o755)
  }
  await writeFile(join(bin, 'calls.jsonl'), '')
  await installHost(bin)
  const port = await freePort()
  const proc = Bun.spawn([process.execPath, 'packages/server/src/main.ts'], {
    cwd: dir,
    env: {
      PATH: `${bin}:${process.env.PATH ?? ''}`,
      HOME: home,
      LC_ALL: 'C',
      DATABASE_URL: databaseUrl,
      PORT: String(port),
      FACTORY_VERSION: sha,
      FACTORY_TOKEN: TOKENS.owner,
      FACTORY_READ_TOKEN: TOKENS.read,
      HC_BIN: join(bin, 'hc'),
      FACTORY_AGW_BIN: join(bin, 'agw'),
      FACTORY_FAKE_LOG: join(bin, 'calls.jsonl'),
      ...hostEnv(bin),
      FACTORY_PRETRUST_BIN: '/usr/bin/true',
      FACTORY_ASK_HUMAN: '/usr/bin/true',
      FACTORY_SPACES_FILE: join(work, 'spaces.json'),
      FACTORY_SOCKET: join(work, 'old-hook.sock'),
      FACTORY_SPOOL_DIR: join(work, 'old-spool'),
      FACTORY_ARCHIVE_DIR: join(work, 'old-archive'),
      FACTORY_GITHUB_POLL: 'off',
      FACTORY_LAUNCHD_POLL: 'off',
      FACTORY_BESZEL_POLL: 'off',
      FACTORY_DIGEST_EVERY: 'off',
      FACTORY_DIGEST_AT: 'off',
      FACTORY_NOTIFY_TARGET: 'off',
      FACTORY_ALERT_PAGE_AFTER: 'off',
      FACTORY_ALERT_LEADS: '0',
      FACTORY_ASK_JUDGE: 'off',
    },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  let output = ''
  void (async () => {
    for await (const chunk of proc.stderr) output += new TextDecoder().decode(chunk)
  })()
  void (async () => {
    for await (const chunk of proc.stdout) output += new TextDecoder().decode(chunk)
  })()
  try {
    const url = `http://127.0.0.1:${port}`
    const body = await healthy(url, undefined, 90_000).catch((error: unknown) => {
      throw new Error(
        `${error instanceof Error ? error.message : String(error)}\nserver output:\n${output.slice(-2000)}`,
      )
    })
    const overview = await fetch(`${url}/v1/overview`, { headers: { authorization: `Bearer ${TOKENS.owner}` } })
    if (overview.status !== 200) throw new Error(`the old core answered /v1/overview ${overview.status}`)
    const issues = await fetch(`${url}/v1/issues?state=all&limit=500`, {
      headers: { authorization: `Bearer ${TOKENS.owner}` },
    })
    const list = (await issues.json()) as { issues?: unknown[] }
    return `old core ${sha.slice(0, 12)} healthy (${String(body.status)}), /v1/overview 200, ${list.issues?.length ?? '?'} Issues readable`
  } finally {
    proc.kill('SIGTERM')
    await proc.exited
    await readdir(work).catch(() => [])
  }
}

process.exit(await main())
