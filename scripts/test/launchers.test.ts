import { expect, test } from 'bun:test'
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const ROOT = join(import.meta.dir, '..', '..')

/** A release is an export of the tree (`git archive`): a template a launcher reads must be tracked, or no release holds it. */
test('every .env template a script or a plist names is tracked in git', async () => {
  const scripts = (await readdir(join(ROOT, 'scripts')))
    .filter((name) => name.endsWith('.sh'))
    .map((name) => join(ROOT, 'scripts', name))
  const deploy = (await readdir(join(ROOT, 'deploy'))).map((name) => join(ROOT, 'deploy', name))
  const named = new Set<string>()
  for (const file of [...scripts, ...deploy]) {
    for (const match of (await readFile(file, 'utf8')).matchAll(/\.env(?:\.[a-z]+)?\.tpl/g)) named.add(match[0])
  }
  expect([...named].sort()).toContain('.env.door.tpl')
  const tracked = Bun.spawn(['git', 'ls-files', '--', ...named], { cwd: ROOT, stdout: 'pipe' })
  const listed = (await new Response(tracked.stdout).text()).split('\n').filter(Boolean)
  expect([...named].filter((name) => !listed.includes(name))).toEqual([])
})

/** A server-only ref never sits in the template the clients share, so an unseeded one can never block them. */
test('.env.tpl holds no server-only ref; .env.server.tpl holds the signal token', async () => {
  expect(await readFile(join(ROOT, '.env.tpl'), 'utf8')).not.toContain('FACTORY_SIGNAL_TOKEN')
  expect(await readFile(join(ROOT, '.env.server.tpl'), 'utf8')).toContain('FACTORY_SIGNAL_TOKEN=')
})

/** The launcher against a fake `secrets-run` (resolves every ref except the ones named in UNRESOLVED) and a fake `bun`. */
async function launch(unresolved: string[]): Promise<{ code: number; err: string; out: string }> {
  const home = await mkdtemp(join(tmpdir(), 'launch-'))
  try {
    const bin = join(home, '.local', 'bin')
    await mkdir(bin, { recursive: true })
    await writeFile(
      join(bin, 'secrets-run'),
      `#!/bin/bash
mode=$1; shift
refs_ok() { # <tpl>: prints KEY=value for each resolvable line
  while IFS='=' read -r key ref; do
    [[ "$key" =~ ^[A-Z_]+$ ]] || continue
    case " $UNRESOLVED " in *" $key "*) continue ;; esac
    case $key in FACTORY_DB_PASSWORD) echo "$key=abc123" ;; *) echo "$key=value-of-$key" ;; esac
  done < "$1"
}
case $mode in
  read) case " $UNRESOLVED " in *" \${1##*/} "*) exit 1 ;; esac; echo value ;;
  export) tpl=\${1#--env-file=}; refs_ok "$tpl" | sed 's/^/export /' ;;
  run) tpl=\${1#--env-file=}; shift; shift; while IFS='=' read -r k v; do export "$k=$v"; done < <(refs_ok "$tpl"); exec "$@" ;;
esac
`,
      { mode: 0o755 },
    )
    await writeFile(join(bin, 'bun'), '#!/bin/bash\nenv | grep ^FACTORY_ | sed "s/=.*//" | sort\n', { mode: 0o755 })
    const proc = Bun.spawn(['bash', join(ROOT, 'scripts', 'launch.sh')], {
      env: { PATH: '/usr/bin:/bin', HOME: home, UNRESOLVED: unresolved.join(' ') },
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const [out, err, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ])
    return { code, err, out }
  } finally {
    await rm(home, { recursive: true, force: true })
  }
}

test('the server launches without the optional signal token when its ref does not resolve', async () => {
  const run = await launch(['FACTORY_SIGNAL_TOKEN'])
  expect(run.err).toContain('optional FACTORY_SIGNAL_TOKEN')
  expect({ code: run.code, err: run.err }).toMatchObject({ code: 0 })
  expect(run.out).toContain('FACTORY_TOKEN')
  expect(run.out).not.toContain('FACTORY_SIGNAL_TOKEN')
})

test('the server launches with the signal token when it resolves', async () => {
  const run = await launch([])
  expect(run.code).toBe(0)
  expect(run.out).toContain('FACTORY_SIGNAL_TOKEN')
})

test('a required ref that does not resolve still refuses the start', async () => {
  const run = await launch(['FACTORY_AGENT_TOKEN'])
  expect(run.code).toBe(78)
  expect(run.err).toContain('unresolved: FACTORY_AGENT_TOKEN')
})
