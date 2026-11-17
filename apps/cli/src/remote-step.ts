import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { RemoteGrant, StepDisagreement, TestResult } from '@software-factory/contract'

/**
 * A step run off the mini (issue 1793, docs/architecture.md "Steps off the mini"). `factory slot run` was granted a slot
 * on the step host: the worktree travels as a git snapshot (tracked and untracked files as `.gitignore` leaves them, the
 * step's `carry` forced in, unpushed commits with it) into the project's bare repository there, the slot's worktree is
 * checked out at it, and the command runs in a container mounted at the caller's own path, so its output reads as it does
 * on the mini. The install runs first with the network, the step after it with none (unless it `needs: [network]`).
 * Production wins by priority: the steps' own cgroup slice, the lowest CPU weight, the OOM killer's first choice, a memory
 * ceiling of 1.5 times the step's learned peak. The exit code is the step's own; a failure of the host itself
 * (`hostFailed`) is never reported as the step's result: the caller goes back to the mini's line.
 */

/** The factory's step image: Ubuntu 24.04 as the VPS and CI's `ubuntu-latest`, git, make and the pinned bun. */
function stepDockerfile(): string {
  return [
    'FROM ubuntu:24.04',
    'ARG BUN',
    'RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl git make unzip \\',
    ' && rm -rf /var/lib/apt/lists/*',
    // `$BUN` is the Dockerfile's build argument, not a template placeholder
    'RUN curl -fsSL -o /tmp/bun.zip "https://github.com/oven-sh/bun/releases/download/bun-v$BUN/bun-linux-x64.zip" \\',
    ' && unzip -q /tmp/bun.zip -d /tmp && mv /tmp/bun-linux-x64/bun /usr/local/bin/bun && ln -s bun /usr/local/bin/bunx \\',
    ' && rm -rf /tmp/bun.zip /tmp/bun-linux-x64',
    '',
  ].join('\n')
}

/** The image a step runs in: the factory's by bun version, or the repo's own by its Dockerfile's content. */
export function imageOf(input: { bun: string; dockerfile: string | null }): { tag: string; dockerfile: string } {
  if (input.dockerfile === null) return { tag: `factory-step:bun-${input.bun}`, dockerfile: stepDockerfile() }
  const digest = createHash('sha256').update(input.bun).update('\n').update(input.dockerfile).digest('hex')
  return { tag: `factory-step:repo-${digest.slice(0, 16)}`, dockerfile: input.dockerfile }
}

const containerName = (id: string): string => `factory-step-${id}`

/** A slot id as the CLI makes it (`<pid>-<uuid>`): letters, digits and dashes, so it goes into a shell line as it is. */
export const isStepId = (id: string): boolean => /^[A-Za-z0-9-]{1,100}$/.test(id)

/** A path on the step host as the server names it (`factory-steps/<project>/<n>`): no quote, space or `..`. */
export const isHostPath = (path: string): boolean => /^[A-Za-z0-9._/~-]{1,300}$/.test(path) && !path.includes('..')

/** One word for a POSIX shell: single-quoted, a quote inside closed and escaped. */
export const shq = (word: string): string => `'${word.replaceAll("'", `'\\''`)}'`

/** The caller's environment that reaches the step: what changes how tools print, never a token or a secret. */
const PASSED_ENV = ['TERM', 'NO_COLOR', 'FORCE_COLOR', 'LANG', 'LC_ALL', 'TZ'] as const

/** The cgroup slice every step container runs under: the host's own pressure is read without the steps' (`system.slice`). */
const STEP_SLICE = 'factory-steps.slice'

/** The version of `"packageManager": "bun@1.4.3"` in the repo's package.json; null when it names no bun. */
export function bunOfPackage(packageJson: string): string | null {
  try {
    const manager = (JSON.parse(packageJson) as { packageManager?: unknown }).packageManager
    const match = typeof manager === 'string' ? /^bun@(\d+\.\d+\.\d+)/.exec(manager) : null
    return match?.[1] ?? null
  } catch {
    return null
  }
}

/**
 * The shell the step's container runs: a sampler of the cgroup's anonymous memory (the RSS the mini measures, not the page
 * cache `memory.peak` counts), the step, and its CPU time at the end.
 */
function stepWrapper(): string {
  return [
    'cd "$FACTORY_STEP_CWD" || exit 125',
    "( m=0; while :; do a=$(awk '/^anon /{print $2}' /sys/fs/cgroup/memory.stat 2>/dev/null)",
    '  if [ -n "$a" ] && [ "$a" -gt "$m" ]; then m=$a; echo "$m" > /factory/anon; fi; sleep 1; done ) &',
    's=$!',
    '"$@"',
    'rc=$?',
    'kill "$s" 2>/dev/null',
    "awk '/^usage_usec /{print $2}' /sys/fs/cgroup/cpu.stat > /factory/cpu 2>/dev/null",
    'exit "$rc"',
  ].join('\n')
}

/** The install, with the network: a bun lockfile at the root is installed from the host's warm cache; a failure is the host's (125). */
function installWrapper(): string {
  return [
    'if [ -f bun.lock ] || [ -f bun.lockb ]; then',
    '  bun install --frozen-lockfile --ignore-scripts > /factory/install.log 2>&1 || {',
    '    echo "factory: bun install failed on the step host:" >&2; tail -n 20 /factory/install.log >&2; exit 125; }',
    'fi',
  ].join('\n')
}

/**
 * The line the step host runs over ssh: the slot's worktree checked out at the snapshot, the install, then the step's
 * container with its caps and labels (the server's probe removes one whose slot is gone), both removed whatever ends the
 * ssh session.
 */
export function remoteScript(input: {
  id: string
  grant: RemoteGrant
  sha: string
  image: string
  root: string
  cwd: string
  command: readonly string[]
  env: Readonly<Record<string, string | undefined>>
}): string {
  const { id, grant } = input
  const name = containerName(id)
  const dir = shq(grant.dir)
  const passed = PASSED_ENV.flatMap((key) => {
    const value = input.env[key]
    return value === undefined ? [] : ['-e', shq(`${key}=${value}`)]
  })
  const common = [
    '--rm --init',
    `--cgroup-parent ${STEP_SLICE}`,
    `--label factory.step=${shq(id)}`,
    '--label factory.started="$(date +%s)"',
    '--cpu-shares 2 --oom-score-adj 1000',
    `--memory ${grant.memoryMib}m --memory-swap ${grant.memoryMib}m --pids-limit 4096`,
    '--cap-drop ALL --security-opt no-new-privileges',
    '--user "$(id -u):$(id -g)"',
    '-e HOME=/tmp -e CI=true -e BUN_INSTALL_CACHE_DIR=/cache/bun',
    `-v "$HOME"/${dir}:${shq(input.root)}`,
    // the worktree's `.git` names its gitdir in the bare repository by the host's absolute path: mounted there, git works
    `-v "$HOME"/${shq(grant.repo)}:"$HOME"/${shq(grant.repo)}`,
    `-v "$HOME"/${dir}.run:/factory`,
    '-v "$HOME"/factory-steps/.cache:/cache',
    `-w ${shq(input.root)}`,
  ]
  const install = ['docker run', `--name ${name}-install`, ...common, input.image, 'sh -c', shq(installWrapper())].join(
    ' ',
  )
  const step = [
    'docker run',
    `--name ${name}`,
    ...common,
    grant.network ? '' : '--network none',
    `-e FACTORY_SLOT_ACTIVE=1 -e FACTORY_JUNIT_DIR=/factory/junit`,
    `-e FACTORY_STEP_CORES=${grant.cores} -e FACTORY_STEP_MEM_MIB=${grant.memoryMib}`,
    `-e FACTORY_STEP_CWD=${shq(input.cwd)}`,
    ...passed,
    input.image,
    'sh -c',
    shq(stepWrapper()),
    'sh',
    ...input.command.map(shq),
  ]
    .filter((part) => part !== '')
    .join(' ')
  const repo = shq(grant.repo)
  return [
    'cd "$HOME" || exit 125',
    `rm -rf ${dir}.run && mkdir -p ${dir}.run/junit || exit 125`,
    `if [ -e ${dir}/.git ]; then git -C ${dir} checkout -q -f --detach ${input.sha} && git -C ${dir} clean -q -fd`,
    `else git -C ${repo} worktree prune && git -C ${repo} worktree add -q --detach "$HOME"/${dir} ${input.sha}; fi || exit 125`,
    // the slot id is the CLI's own `<pid>-<uuid>` (`isStepId`): safe inside the trap's quotes
    `trap 'docker rm -f ${name}-install ${name} >/dev/null 2>&1; git -C "$HOME"/${grant.repo} update-ref -d refs/steps/${id} 2>/dev/null' EXIT HUP INT TERM`,
    `${install} || exit 125`,
    step,
  ].join('\n')
}

/** Before the snapshot travels: the project's bare repository, the cache directory and the image (built once per tag). */
function prepareScript(input: { repo: string; tag: string; bun: string }): string {
  return [
    'cd "$HOME" || exit 125',
    `mkdir -p factory-steps/.cache && { [ -d ${shq(input.repo)} ] || git init -q --bare ${shq(input.repo)}; } || exit 125`,
    `docker image inspect ${input.tag} >/dev/null 2>&1 && exit 0`,
    `echo "factory: building the step image ${input.tag} on the step host (once)" >&2`,
    // the label is what the host's daily image prune may be told to keep (`docker image prune --filter label!=factory.image`)
    `docker build -q -t ${input.tag} --label factory.image=step --build-arg BUN=${shq(input.bun)} - >/dev/null`,
  ].join('\n')
}

/** Exit codes that are the host's failure, not the step's: ssh's own (255) and docker's or the setup's (125 to 127). */
export const isHostFailure = (code: number): boolean => code === 255 || (code >= 125 && code <= 127)

/** The ssh options of every call: no prompt, a short connect timeout, one shared connection per target. */
const sshOptions = (): string[] => [
  '-o',
  'BatchMode=yes',
  '-o',
  'ConnectTimeout=5',
  '-o',
  'ControlMaster=auto',
  '-o',
  'ControlPath=/tmp/factory-ssh-%C',
  '-o',
  'ControlPersist=120',
]

/** The anonymous-memory peak (bytes) and CPU time (µs) the container left, as MiB and seconds. */
export function parseStats(anon: string, cpu: string): { peakRssMib: number | null; cpuSeconds: number | null } {
  const bytes = Number(anon.trim())
  const usec = Number(cpu.trim())
  return {
    peakRssMib: anon.trim() !== '' && Number.isFinite(bytes) ? Math.round(bytes / 1024 / 1024) : null,
    cpuSeconds: cpu.trim() !== '' && Number.isFinite(usec) ? Math.round(usec / 1000) / 1000 : null,
  }
}

/** A process run to its end with its output collected; never throws. */
async function collect(
  command: string[],
  options: { stdin?: string; timeoutMs: number; cwd?: string; env?: Record<string, string | undefined> },
): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const proc = Bun.spawn(command, {
      stdin: options.stdin === undefined ? 'ignore' : new Blob([options.stdin]),
      stdout: 'pipe',
      stderr: 'pipe',
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
      ...(options.env === undefined ? {} : { env: options.env }),
    })
    const timer = setTimeout(() => proc.kill('SIGKILL'), options.timeoutMs)
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ])
    clearTimeout(timer)
    return { code, stdout, stderr }
  } catch (error) {
    return { code: 127, stdout: '', stderr: error instanceof Error ? error.message : String(error) }
  }
}

const lastLine = (text: string): string => text.trim().split('\n').at(-1) ?? ''

/**
 * The worktree as one commit that touches neither it nor its index: a copy of the index (its stat cache spares the
 * rehash), every change and untracked file added as `.gitignore` leaves them, the `carry` paths forced in, written as a
 * tree and committed on top of HEAD. Null with the reason when git cannot.
 */
export async function snapshot(input: {
  root: string
  carry: readonly string[]
  env: Readonly<Record<string, string | undefined>>
}): Promise<{ sha: string; tree: string } | { failed: string }> {
  const index = join(tmpdir(), `factory-step-index-${process.pid}-${crypto.randomUUID()}`)
  const env = { ...input.env, GIT_INDEX_FILE: index }
  const git = (args: string[]) => collect(['git', '-C', input.root, ...args], { timeoutMs: 120_000, env })
  try {
    const real = await collect(['git', '-C', input.root, 'rev-parse', '--git-path', 'index'], {
      timeoutMs: 10_000,
      env: input.env,
    })
    // relative to the root, or absolute (a linked worktree's index lives in the main repository's `.git/worktrees`)
    const realIndex = real.stdout.trim() === '' ? '' : resolve(input.root, real.stdout.trim())
    const seeded = real.code === 0 && realIndex !== '' && existsSync(realIndex)
    if (seeded) await Bun.write(index, Bun.file(realIndex))
    else if ((await git(['read-tree', 'HEAD'])).code !== 0) return { failed: 'the worktree has no HEAD' }
    const added = await git(['add', '-A'])
    if (added.code !== 0) return { failed: `git add failed: ${lastLine(added.stderr)}` }
    const carried = input.carry.filter((path) => existsSync(join(input.root, path)))
    if (carried.length > 0) {
      const forced = await git(['add', '-f', '--', ...carried])
      if (forced.code !== 0) return { failed: `git add of the carried paths failed: ${lastLine(forced.stderr)}` }
    }
    const tree = await git(['write-tree'])
    if (tree.code !== 0) return { failed: `git write-tree failed: ${lastLine(tree.stderr)}` }
    const commit = await git(['commit-tree', tree.stdout.trim(), '-p', 'HEAD', '-m', 'factory step snapshot'])
    if (commit.code !== 0) return { failed: `git commit-tree failed: ${lastLine(commit.stderr)}` }
    return { sha: commit.stdout.trim(), tree: tree.stdout.trim() }
  } finally {
    await rm(index, { force: true }).catch(() => undefined)
  }
}

/** What a remote run came to. `hostFailed`: the step host, not the step, failed; the step did not finish there. */
export interface RemoteRun {
  exitCode: number
  hostFailed: boolean
  why: string | null
  peakRssMib: number | null
  cpuSeconds: number | null
  tree: string | null
  /** the last lines the step wrote, stdout and stderr in the order they came (`OUTPUT_KEPT_LINES`) */
  output: string[]
}

/** The lines of a run's output kept to read a failure from: more than the tail stored, for the timeout a test names. */
const OUTPUT_KEPT_LINES = 400
/** The lines of a red run's output stored when no failing test name parses. */
const DISAGREEMENT_TAIL_LINES = 40
const DISAGREEMENT_TAIL_CHARS = 8000
const MAX_DISAGREEMENT_TESTS = 200

/** A test as the ledger names it: its suite and name. */
const testNameOf = (test: Pick<TestResult, 'suite' | 'name'>): string =>
  test.suite === '' ? test.name : `${test.suite} > ${test.name}`

/** The timeout a line says a test hit ("timed out after 5000ms", "5 s"), in ms. */
const TIMEOUT = /timed out after (\d+(?:\.\d+)?)\s*(ms|s)\b/i

/** How many lines either side of the one naming a test its timeout may stand on. */
const TIMEOUT_NEAR_LINES = 3

/**
 * What a red run off the mini failed on: the failing tests from its JUnit results, each with its duration there and the
 * timeout an output line naming it gives; the last `DISAGREEMENT_TAIL_LINES` lines of the output when no failing test
 * parses.
 */
export function disagreementOf(input: { tests: readonly TestResult[]; output: readonly string[] }): StepDisagreement {
  const failing = input.tests.filter((test) => test.status === 'fail').slice(0, MAX_DISAGREEMENT_TESTS)
  if (failing.length === 0)
    return { tests: [], tail: input.output.slice(-DISAGREEMENT_TAIL_LINES).join('\n').slice(-DISAGREEMENT_TAIL_CHARS) }
  return {
    tests: failing.map((test) => {
      // a runner may print the timeout on the line above or below the one that names the test
      const at = input.output.findIndex((line) => line.includes(test.name))
      const said =
        at === -1
          ? undefined
          : input.output
              .slice(Math.max(0, at - TIMEOUT_NEAR_LINES), at + TIMEOUT_NEAR_LINES + 1)
              .find((l) => TIMEOUT.test(l))
      const match = said === undefined ? null : TIMEOUT.exec(said)
      const timeoutMs =
        match === null ? null : Math.round(Number(match[1]) * (match[2]?.toLowerCase() === 's' ? 1000 : 1))
      return { name: testNameOf(test).slice(0, 1000), durationMs: test.durationMs, timeoutMs }
    }),
    tail: null,
  }
}

/** Copies a stream to `sink` as it comes and keeps its lines in `lines` (only the last `OUTPUT_KEPT_LINES`). */
async function tee(
  stream: ReadableStream<Uint8Array> | undefined,
  sink: (chunk: Uint8Array) => void,
  lines: string[],
): Promise<void> {
  if (stream === undefined) return
  const decoder = new TextDecoder()
  let pending = ''
  for await (const chunk of stream) {
    sink(chunk)
    pending += decoder.decode(chunk, { stream: true })
    const parts = pending.split('\n')
    pending = parts.pop() ?? ''
    lines.push(...parts)
    if (lines.length > OUTPUT_KEPT_LINES * 2) lines.splice(0, lines.length - OUTPUT_KEPT_LINES)
  }
  if (pending !== '') lines.push(pending)
}

const PREPARE_TIMEOUT_MS = 15 * 60_000
const PUSH_TIMEOUT_MS = 15 * 60_000
const READ_TIMEOUT_MS = 30_000

/**
 * Runs the step on the step host: the image and the bare repository prepared, the snapshot pushed (only the objects the
 * host lacks travel; the default branch goes with it, so a step that diffs against it can), then the install and the
 * step with this process's stdout and stderr. `spawned` gets the ssh process that carries the container, so a signal or
 * the run limit ends it (the remote trap then removes the container). The stats and the JUnit files come back after.
 */
export async function runRemoteStep(input: {
  id: string
  grant: RemoteGrant
  root: string
  cwd: string
  command: readonly string[]
  env: Readonly<Record<string, string | undefined>>
  junitDir: string | undefined
  err: (line: string) => void
  spawned: (proc: ReturnType<typeof Bun.spawn>) => void
}): Promise<RemoteRun> {
  const { grant } = input
  const ssh = ['ssh', ...sshOptions()]
  const failed = (why: string): RemoteRun => ({
    exitCode: 255,
    hostFailed: true,
    why,
    peakRssMib: null,
    cpuSeconds: null,
    tree: null,
    output: [],
  })
  if (!isStepId(input.id) || !isHostPath(grant.repo) || !isHostPath(grant.dir))
    return failed('the grant names a slot or a path this CLI does not take')
  const packageJson = join(input.root, 'package.json')
  const bun = grant.bun ?? (existsSync(packageJson) ? bunOfPackage(readFileSync(packageJson, 'utf8')) : null)
  if (bun === null) return failed('no bun version: the step names none and package.json has no packageManager bun@')
  let dockerfile: string | null = null
  if (grant.dockerfile !== null) {
    const path = join(input.root, grant.dockerfile)
    if (!existsSync(path)) return failed(`the step's dockerfile ${grant.dockerfile} is not in the worktree`)
    dockerfile = readFileSync(path, 'utf8')
  }
  const image = imageOf({ bun, dockerfile })
  const started = Date.now()
  const prepared = await collect([...ssh, grant.target, prepareScript({ repo: grant.repo, tag: image.tag, bun })], {
    stdin: image.dockerfile,
    timeoutMs: PREPARE_TIMEOUT_MS,
  })
  if (prepared.stderr.trim() !== '') input.err(`${prepared.stderr.trim()}\n`)
  if (prepared.code !== 0) return failed(`the step host was not ready (exit ${prepared.code})`)
  const snap = await snapshot({ root: input.root, carry: grant.carry, env: input.env })
  if ('failed' in snap) return failed(snap.failed)
  const base = await collect(['git', '-C', input.root, 'rev-parse', '--abbrev-ref', 'origin/HEAD'], {
    timeoutMs: 10_000,
    env: input.env,
  })
  const defaultRef = base.code === 0 && base.stdout.trim().startsWith('origin/') ? base.stdout.trim() : null
  const refs = [
    `+${snap.sha}:refs/steps/${input.id}`,
    ...(defaultRef === null ? [] : [`+refs/remotes/${defaultRef}:refs/remotes/${defaultRef}`]),
  ]
  const pushed = await collect(
    ['git', '-C', input.root, 'push', '-q', '--no-verify', `${grant.target}:${grant.repo}`, ...refs],
    {
      timeoutMs: PUSH_TIMEOUT_MS,
      env: { ...input.env, GIT_SSH_COMMAND: ssh.map(shq).join(' ') },
    },
  )
  if (pushed.code !== 0) return failed(`the snapshot push failed: ${lastLine(pushed.stderr)}`)
  input.err(`factory: the worktree reached the step host in ${((Date.now() - started) / 1000).toFixed(1)} s\n`)
  let proc: ReturnType<typeof Bun.spawn>
  try {
    const script = remoteScript({
      id: input.id,
      grant,
      sha: snap.sha,
      image: image.tag,
      root: input.root,
      cwd: input.cwd,
      command: input.command,
      env: input.env,
    })
    proc = Bun.spawn([...ssh, '-n', grant.target, script], {
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
      detached: true,
    })
  } catch (error) {
    return failed(`ssh did not start: ${error instanceof Error ? error.message : String(error)}`)
  }
  input.spawned(proc)
  // the output reaches the caller as it comes; the last lines are kept to say what a red run failed on
  const output: string[] = []
  const copied = Promise.all([
    tee(proc.stdout as ReadableStream<Uint8Array> | undefined, (chunk) => process.stdout.write(chunk), output),
    tee(proc.stderr as ReadableStream<Uint8Array> | undefined, (chunk) => process.stderr.write(chunk), output),
  ]).catch(() => undefined)
  const exitCode = await proc.exited
  // a process that outlives ssh and holds its pipe open must not hold the result back
  await Promise.race([copied, new Promise((resolve) => setTimeout(resolve, 2000))])
  const stats = await collect(
    [
      ...ssh,
      grant.target,
      // An ssh session without a terminal gets no hangup when its client ends (a signal, the run limit), so the
      // containers are removed here whatever ended the run; after a normal end they are gone already (`--rm`).
      `docker rm -f ${containerName(input.id)}-install ${containerName(input.id)} >/dev/null 2>&1; ` +
        `git -C "$HOME"/${shq(grant.repo)} update-ref -d refs/steps/${input.id} 2>/dev/null; ` +
        `cd "$HOME"/${shq(grant.dir)}.run 2>/dev/null && printf '%s|%s' "$(cat anon 2>/dev/null)" "$(cat cpu 2>/dev/null)"`,
    ],
    { timeoutMs: READ_TIMEOUT_MS },
  )
  const [anon = '', cpu = ''] = stats.stdout.split('|')
  if (input.junitDir !== undefined)
    await collect(
      ['rsync', '-a', '-e', ssh.map(shq).join(' '), `${grant.target}:${grant.dir}.run/junit/`, `${input.junitDir}/`],
      { timeoutMs: READ_TIMEOUT_MS },
    )
  const measured = { ...parseStats(anon, cpu), tree: snap.tree, output: output.slice(-OUTPUT_KEPT_LINES) }
  if (isHostFailure(exitCode))
    return { ...failed(`the step host answered ${exitCode} (ssh, docker or the install, not the step)`), ...measured }
  return { exitCode, hostFailed: false, why: null, ...measured }
}
