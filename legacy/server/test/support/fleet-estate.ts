import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { HcTerminal } from '../../src/fleet/sources.ts'

/** A recorded estate (2026-11-02, the mini): the repos of two roots, and the terminals hc listed. The paths are moved under temp roots. */

const DAY = 86_400_000

export interface Estate {
  /** `SourceRoot`: a repo root of the factory */
  src: string
  /** `IuRoot`: a visible-only root */
  iu: string
  /** the clock of the scene: commits are dated relative to it */
  now: Date
  cleanup(): void
}

const env = (extra: Record<string, string> = {}): Record<string, string | undefined> => ({
  ...process.env,
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
  ...extra,
})

function git(cwd: string, args: string[], at?: Date): string {
  const when: Record<string, string> = at
    ? { GIT_AUTHOR_DATE: at.toISOString(), GIT_COMMITTER_DATE: at.toISOString() }
    : {}
  const run = Bun.spawnSync(
    ['git', '-c', 'user.name=test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false', ...args],
    { cwd, env: env(when), stderr: 'pipe', stdout: 'pipe' },
  )
  if (run.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${run.stderr.toString()}`)
  return run.stdout.toString().trim()
}

/** A repo on `master` with these files committed `daysAgo` before `now`. */
export function makeRepo(
  root: string,
  name: string,
  files: Record<string, string>,
  daysAgo: number,
  now: Date,
): string {
  const path = join(root, name)
  mkdirSync(path, { recursive: true })
  git(path, ['init', '-q', '-b', 'master'])
  const at = new Date(now.getTime() - daysAgo * DAY)
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(dirname(join(path, file)), { recursive: true })
    writeFileSync(join(path, file), text)
  }
  git(path, ['add', '-A'])
  git(path, ['commit', '-q', '--allow-empty', '-m', `${name}: the state of the plan`], at)
  return path
}

/** Builds the estate on disk: git repos under a repo root and a visible-only root. */
export function buildEstate(now: Date): Estate {
  const base = realpathSync(mkdtempSync('/tmp/factory-fleet-'))
  const src = join(base, 'SourceRoot')
  const iu = join(base, 'IuRoot')
  mkdirSync(src)
  mkdirSync(iu)
  for (const name of ['software-factory', 'agent-workflows', 'homelab', 'modelpick', 'linewatch', 'rb', 'dotfiles']) {
    makeRepo(src, name, { 'README.md': `${name}\n` }, 1, now)
  }
  for (const name of ['prometheus-scripts', 'prometheus-epx']) makeRepo(iu, name, { 'README.md': `${name}\n` }, 1, now)
  return { src, iu, now, cleanup: () => rmSync(base, { recursive: true, force: true }) }
}

const ago = (now: Date, minutes: number): string => new Date(now.getTime() - minutes * 60_000).toISOString()

/** What `hc` listed (`terminal.list`, shaped as the real records are, Claude Code ones and a shell), under the estate's roots. */
export function estateTerminals(estate: Estate): HcTerminal[] {
  const { src, iu, now } = estate
  const claude = {
    claude: true,
    factoryKey: null,
    statusMessage: null,
    parent: null,
    role: null,
    account: null,
  }
  return [
    // the program lead: the factory knows it as a session of the same name
    {
      ...claude,
      address: 't4h',
      name: 'software-factory-w6',
      cwd: `${src}/software-factory`,
      title: 'Software-factory Wave 6 night run',
      status: 'working',
      statusAt: ago(now, 1),
      role: 'lead',
      account: 'me2',
    },
    // the worker the lead started: only hc knows it, its start text names the plan
    {
      ...claude,
      address: 't7d',
      name: 'software-factor-fv-w1-read-model',
      cwd: `${src}/software-factory/.claude/worktrees/fv-w1-read-model`,
      title: 'Fleet read model, FV Wave 1',
      status: 'working',
      statusAt: ago(now, 0),
      parent: 't4h',
    },
    // IuRoot: visible, read-only. The teamchat orchestrator sits in a plan's directory inside a repo.
    {
      ...claude,
      address: 't1r',
      name: 'athena-orchestrator',
      cwd: `${iu}/prometheus-scripts/wip/waves-teamchat`,
      title: 'Teamchat Wave 62',
      status: 'working',
      statusAt: ago(now, 90),
    },
    {
      ...claude,
      address: 't6n',
      name: 'prometheus-epx-w1',
      cwd: `${iu}/prometheus-epx`,
      title: 'EPX Wave 1',
      status: 'blocked',
      statusMessage: 'Allow Bash(rm -rf node_modules)?',
      statusAt: ago(now, 30),
      parent: 't1r',
    },
    // an idle tab in a repo with a pending plan: it does not make the plan `running`
    {
      ...claude,
      address: 't8m',
      name: 'modelpick-idle',
      cwd: `${src}/modelpick`,
      title: 'Modelpick, done',
      status: 'done',
      statusAt: ago(now, 600),
    },
    // a shell, and a Claude Code outside every root: neither is in the model
    {
      ...claude,
      claude: false,
      address: 't4',
      name: null,
      cwd: `${src}/homelab`,
      title: null,
      status: null,
      statusAt: null,
    },
    {
      ...claude,
      address: 't9x',
      name: 'elsewhere',
      cwd: '/tmp/not-a-root',
      title: null,
      status: 'working',
      statusAt: ago(now, 1),
    },
  ]
}
