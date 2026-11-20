import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { EXIT_TIMEOUT, withStderr } from '../../process.ts'
import type { Checkout, FixEntry, Landing } from '../../../domains/hygiene/hygiene-model.ts'
import { MAX_EVIDENCE_LINES } from '../../../domains/hygiene/hygiene-model.ts'
import type { UpgradeRow } from '../../../domains/hygiene/upgrades.ts'
import { originDefault } from '../checkout.ts'
import { exec, gitOut, type Tools } from '../git.ts'
import { type Released, bunPlan } from '../probes/deps.ts'
import { installed } from '../probes/toolrun.ts'
import { type CiWait, landByPullRequest, mergeMethod } from './landing.ts'

const KEY = 'deps'
const ADD_TIMEOUT_MS = 10 * 60_000
const GIT_TIMEOUT_MS = 90_000
/** The gate waits for a slot (up to `factory slot run`'s own limit) and then runs: a CLI helper's limit, not an agent's. */
const CHECK_TIMEOUT_MS = 100 * 60_000
/** `factory slot run` ends with this when no slot came in time (sysexits `EX_TEMPFAIL`): the check did not run. */
const EX_TEMPFAIL = 75
const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;?]*[A-Za-z]`, 'g')

const SECTIONS = ['dependencies', 'devDependencies', 'optionalDependencies'] as const
type Section = (typeof SECTIONS)[number]
const FLAG: Record<Section, string[]> = {
  dependencies: [],
  devDependencies: ['--dev'],
  optionalDependencies: ['--optional'],
}

const tailOf = (text: string, lines = MAX_EVIDENCE_LINES): string[] =>
  text
    .replace(ANSI, '')
    .split('\n')
    .map((line) => line.trim().slice(0, 240))
    .filter(Boolean)
    .slice(-lines)

interface Bump {
  row: UpgradeRow
  section: Section
  /** the repo writes this dependency as an exact version (no range): the bump keeps it so */
  exact: boolean
}

/** Where the root `package.json` declares a package and how: an exact version or a caret range. A tilde, a tag or a URL is not ours to rewrite. */
function declaredAs(pkg: Record<string, unknown>, row: UpgradeRow): Bump | undefined {
  for (const section of SECTIONS) {
    const spec = (pkg[section] as Record<string, unknown> | undefined)?.[row.name]
    if (typeof spec !== 'string') continue
    if (/^\d/.test(spec)) return { row, section, exact: true }
    if (spec.startsWith('^')) return { row, section, exact: false }
    return undefined
  }
  return undefined
}

const checkTarget = (makefile: string): 'check-fast' | 'check' | undefined =>
  /^check-fast:/m.test(makefile) ? 'check-fast' : /^check:/m.test(makefile) ? 'check' : undefined

const skip = (detail: string): FixEntry[] => [{ key: KEY, outcome: 'skipped', detail }]
const fail = (detail: string, output?: string[]): FixEntry[] => [
  { key: KEY, outcome: 'failed', detail, ...(output?.length ? { output } : {}) },
]

/**
 * The scripted fix of the `deps` probe, for `bun`: every patch or minor of the root `package.json` that is past its cooldown
 * (the probe's own plan: 7 days, release date known, not held back by bun's own age gate) is set with `bun add [--exact]
 * name@version`, the repo's check runs in a test slot, and on green the commit is pushed to the default branch. Nothing is
 * pushed on red. A major, a held version, a workspace package and any range style but exact and caret stay with a lead. A repo
 * that ships by push gets the commit on its default branch; one that ships by pull request gets it through `landByPullRequest`
 * (the merge window, the pull request, its CI, the guard, the merge). The probe, run again, says whether the finding is still
 * past its bar.
 */
export async function fixDeps(
  tools: Tools,
  checkout: Checkout,
  input: { landing: Landing; released: Released; now: Date; project?: string; wait?: CiWait },
): Promise<FixEntry[]> {
  const { path } = checkout
  const locks = (await gitOut(tools, path, ['ls-files', '--', 'bun.lock', 'bun.lockb']).catch(() => '')).trim()
  // The `deps` probe reads any package.json as bun's; a script that rewrites it must be sure bun owns the lockfile.
  if (!locks) return skip('no bun.lock is tracked: this is not a bun repo, a lead bumps it')
  const slot = tools.slot[0]
  if (!slot || !installed(slot))
    return skip(`no \`${slot ?? 'slot command'}\` on the PATH: the check needs a test slot`)
  let pkg: Record<string, unknown>
  let target: ReturnType<typeof checkTarget>
  try {
    pkg = JSON.parse(readFileSync(join(path, 'package.json'), 'utf8')) as Record<string, unknown>
    target = checkTarget(readFileSync(join(path, 'Makefile'), 'utf8'))
  } catch {
    return skip('no readable package.json or Makefile in the checkout')
  }
  if (!target) return skip('no check or check-fast target in the Makefile')
  // Asked before any work: a repo gh cannot read (not signed in, not GitHub) or that allows no merge method is a lead's.
  const method = input.landing === 'pr' ? await mergeMethod(tools, path) : undefined
  if (input.landing === 'pr' && !method)
    return skip('gh cannot read this repo or it allows no merge method: a lead lands the bump')
  if (input.landing === 'pr' && !input.project)
    return skip('no project name for the merge window: a lead lands the bump')

  const read = await bunPlan(tools, path, input.released, input.now)
  if (typeof read === 'string') return fail(read)
  const ready = read.plan.batches.flatMap((batch) => (batch.kind === 'major' ? [] : batch.rows))
  const bumps = ready.flatMap((row) => (row.releasedAt ? (declaredAs(pkg, row) ?? []) : []))
  if (!bumps.length) return []

  const groups = new Map<string, Bump[]>()
  for (const bump of bumps) {
    const id = `${bump.section}:${bump.exact}`
    groups.set(id, [...(groups.get(id) ?? []), bump])
  }
  for (const group of groups.values()) {
    const [first] = group
    if (!first) continue
    const add = await exec(
      withStderr([
        tools.bun,
        'add',
        ...FLAG[first.section],
        ...(first.exact ? ['--exact'] : []),
        ...group.map((bump) => `${bump.row.name}@${bump.row.latest}`),
      ]),
      ADD_TIMEOUT_MS,
      path,
    )
    if (add.exitCode !== 0) {
      return fail(
        add.exitCode === EXIT_TIMEOUT ? 'bun add did not finish' : `bun add failed (exit ${add.exitCode})`,
        tailOf(add.stdout),
      )
    }
  }
  // Staged before the check: a check that rewrites files (a formatter) must not put its changes into the commit.
  await gitOut(tools, path, ['add', '-u'])
  const staged = await exec(withStderr([tools.git, 'diff', '--cached', '--name-only']), GIT_TIMEOUT_MS, path)
  if (staged.exitCode !== 0 || !staged.stdout.trim()) {
    return fail('bun add changed no file: the versions were refused (the release-age gate) or are in already')
  }

  const started = Date.now()
  const check = await exec(withStderr([...tools.slot, tools.make, target]), CHECK_TIMEOUT_MS, path)
  const seconds = Math.round((Date.now() - started) / 1000)
  if (check.exitCode === EX_TEMPFAIL) {
    return [{ key: KEY, outcome: 'deferred', detail: 'no test slot came in time: asked again at the next pass' }]
  }
  if (check.exitCode !== 0) {
    return fail(
      check.exitCode === EXIT_TIMEOUT
        ? `make ${target} with the bumps did not finish in ${CHECK_TIMEOUT_MS / 60_000} min`
        : `make ${target} is red with the bumps (exit ${check.exitCode}, ${seconds}s): ${bumps.map((b) => b.row.name).join(', ')}`,
      tailOf(check.stdout),
    )
  }

  const names = bumps.map((bump) => bump.row.name)
  const message = [
    `chore(deps): bump ${bumps.length} patch and minor package${bumps.length === 1 ? '' : 's'}`,
    '',
    ...bumps.map((bump) => `- ${bump.row.name} ${bump.row.current} -> ${bump.row.latest} (${bump.row.size})`),
    '',
    `Checked with make ${target} in a test slot; released at least 7 days ago.`,
  ].join('\n')
  const commit = await exec(withStderr([tools.git, 'commit', '-q', '--no-verify', '-m', message]), GIT_TIMEOUT_MS, path)
  if (commit.exitCode !== 0) return fail(`git commit failed (exit ${commit.exitCode})`, tailOf(commit.stdout))
  const branch = (await originDefault(tools, path))?.replace(/^origin\//, '')
  if (!branch) return fail('no origin default branch to push to')
  const shortNames = `${names.length} package${names.length === 1 ? '' : 's'} (${names.slice(0, 6).join(', ')}${names.length > 6 ? ', …' : ''})`

  if (input.landing === 'pr' && method && input.project) {
    const [title = '', ...rest] = message.split('\n')
    const landed = await landByPullRequest({
      tools,
      cwd: path,
      project: input.project,
      base: branch,
      method,
      title,
      body: rest.join('\n').trim(),
      ...(input.wait ? { wait: input.wait } : {}),
    })
    if (landed.kind === 'merged') {
      return [
        {
          key: KEY,
          outcome: 'fixed',
          detail: `bumped ${shortNames}, make ${target} green in ${seconds}s, CI green, merged pull request #${landed.number} (${landed.method}) into ${branch}; the repo's next ship deploys it`,
        },
      ]
    }
    return [
      {
        key: KEY,
        outcome: landed.kind,
        detail: landed.detail,
        ...('output' in landed && landed.output?.length ? { output: landed.output } : {}),
      },
    ]
  }

  const push = await exec(
    withStderr([tools.git, 'push', '-q', 'origin', `HEAD:refs/heads/${branch}`]),
    GIT_TIMEOUT_MS,
    path,
  )
  if (push.exitCode !== 0) {
    return fail(
      push.exitCode === EXIT_TIMEOUT
        ? 'git push did not finish'
        : `git push to ${branch} was refused (exit ${push.exitCode})`,
      tailOf(push.stdout),
    )
  }
  const sha = (await gitOut(tools, path, ['rev-parse', '--short', 'HEAD'])).trim()
  return [
    {
      key: KEY,
      outcome: 'fixed',
      detail: `bumped ${shortNames}, make ${target} green in ${seconds}s, pushed ${sha} to ${branch}`,
    },
  ]
}
