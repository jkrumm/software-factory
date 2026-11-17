import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parse } from 'yaml'
import { exec, gitOut, type Tools } from '../git.ts'
import { type Outcome, clean, finding, found, skipped } from './finding.ts'

const WORKFLOW = /^\.github\/workflows\/[^/]+\.ya?ml$/
const LOOKUP_TIMEOUT_MS = 30_000
const HOSTED = /^(?:ubuntu|macos|windows)-/i
/** a version tag (`v4`, `v4.2.1`) or a full commit sha */
const PINNED = /^(?:v?\d+(?:\.\d+){0,2}(?:[-+][\w.]+)?|[0-9a-f]{40})$/

export interface GithubRepo {
  owner: string
  repo: string
}

/** `owner/repo` of a github.com remote (https or ssh), else undefined. */
export function githubRepoOf(remote: string): GithubRepo | undefined {
  const match = /^(?:https?:\/\/(?:[^@/]+@)?|ssh:\/\/git@|git@)github\.com[/:]([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/.exec(
    remote.trim(),
  )
  return match?.[1] && match[2] ? { owner: match[1], repo: match[2] } : undefined
}

/** Whether the repo is private; undefined when it cannot be established. Injected so tests never touch the network. */
export type PrivacyLookup = (query: { tools: Tools; path: string; repo: GithubRepo }) => Promise<boolean | undefined>

/**
 * `gh repo view` when gh is signed in; else the unauthenticated API (200 answers, public) and, for a 404, a private
 * repo only when git itself reaches the remote with its own credentials.
 */
export const githubPrivacy: PrivacyLookup = async ({ tools, path, repo }) => {
  const slug = `${repo.owner}/${repo.repo}`
  const viaGh = await exec([tools.gh, 'repo', 'view', slug, '--json', 'isPrivate'], LOOKUP_TIMEOUT_MS, path).catch(
    () => undefined,
  )
  if (viaGh?.exitCode === 0) {
    try {
      const value = (JSON.parse(viaGh.stdout) as { isPrivate?: unknown }).isPrivate
      if (typeof value === 'boolean') return value
    } catch {
      // not JSON: fall through to the API
    }
  }
  const response = await fetch(`https://api.github.com/repos/${slug}`, {
    headers: { 'user-agent': 'software-factory-hygiene', accept: 'application/vnd.github+json' },
    signal: AbortSignal.timeout(LOOKUP_TIMEOUT_MS),
  }).catch(() => undefined)
  if (response?.status === 200) return false
  if (response?.status !== 404) return undefined
  const reach = await exec([tools.git, 'ls-remote', '--exit-code', 'origin', 'HEAD'], LOOKUP_TIMEOUT_MS, path).catch(
    () => undefined,
  )
  return reach?.exitCode === 0 ? true : undefined
}

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined

const labelsOf = (runsOn: unknown): string[] | undefined => {
  if (typeof runsOn === 'string') return [runsOn]
  if (Array.isArray(runsOn)) return runsOn.filter((label): label is string => typeof label === 'string')
  const labels = asRecord(runsOn)?.labels
  return typeof labels === 'string' ? [labels] : Array.isArray(labels) ? labelsOf(labels) : undefined
}

/** The breach of the runner rule by one `runs-on`, if any; an expression (`${{ ... }}`) or an unknown shape is not judged. */
export function runnerBreach(runsOn: unknown, isPrivate: boolean): string | undefined {
  const labels = labelsOf(runsOn)
  if (!labels?.length || labels.some((label) => label.includes('${{'))) return undefined
  const lower = labels.map((label) => label.toLowerCase())
  const shown = `[${labels.join(', ')}]`
  const selfHosted = lower.includes('self-hosted')
  if (!isPrivate) return selfHosted ? `runs-on ${shown}: a public repo stays on a hosted runner` : undefined
  if (selfHosted && lower.includes('vps')) return undefined
  if (selfHosted || lower.some((label) => HOSTED.test(label))) {
    return `runs-on ${shown}: a private repo runs on [self-hosted, vps]`
  }
  return undefined
}

interface Step {
  job: string
  uses?: string
  run?: string
}

function jobsOf(workflow: unknown): { name: string; runsOn: unknown; uses?: string; steps: Step[] }[] {
  return Object.entries(asRecord(asRecord(workflow)?.jobs) ?? {}).map(([name, value]) => {
    const job = asRecord(value)
    const steps = (Array.isArray(job?.steps) ? job.steps : []).map((raw): Step => {
      const step = asRecord(raw)
      return {
        job: name,
        uses: typeof step?.uses === 'string' ? step.uses : undefined,
        run: typeof step?.run === 'string' ? step.run : undefined,
      }
    })
    return { name, runsOn: job?.['runs-on'], uses: typeof job?.uses === 'string' ? job.uses : undefined, steps }
  })
}

/** The breach of the pin rule by one `uses:` value: a third-party action that is not at a version tag or a sha. */
export function pinBreach(uses: string): string | undefined {
  if (uses.startsWith('./') || uses.startsWith('docker://')) return undefined
  const at = uses.lastIndexOf('@')
  if (at < 0) return `uses ${uses}: no ref, pin a version tag or a sha`
  const ref = uses.slice(at + 1)
  return PINNED.test(ref) ? undefined : `uses ${uses}: pin a version tag or a sha, not a branch`
}

/** The `make <target>` of `checks.full` in a project.yaml that promises CI runs it (`checks.ci: true`). */
function ciTarget(projectYaml: string | undefined): string | undefined {
  if (!projectYaml) return undefined
  try {
    const checks = asRecord(asRecord(parse(projectYaml))?.checks)
    if (checks?.ci !== true) return undefined
    const full = checks.full === undefined ? 'make check' : checks.full
    return typeof full === 'string' ? /^make ([A-Za-z0-9][A-Za-z0-9_.-]*)$/.exec(full)?.[1] : undefined
  } catch {
    return undefined
  }
}

/** Whether a shell script runs `make <target>` (the target as a whole word, so `check` is not `check-fast`). */
export function runsMake(script: string, target: string): boolean {
  const escaped = target.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`(?:^|[\\s;&|(])make(?:\\s+[^\\n;&|]*?)?\\s${escaped}(?=$|[\\s;&|)])`, 'm').test(script)
}

const read = (path: string, file: string): string | undefined => {
  try {
    return readFileSync(join(path, file), 'utf8')
  } catch {
    return undefined
  }
}

/** CI workflows against the repo's rules: the runner, pinned actions, and the gate the project names. */
export async function ciProbe(tools: Tools, path: string, privacy: PrivacyLookup = githubPrivacy): Promise<Outcome> {
  const tracked = (await gitOut(tools, path, ['ls-files', '-z']).catch(() => '')).split('\0')
  const files = tracked.filter((file) => WORKFLOW.test(file)).sort()
  if (!files.length) return skipped('no workflow files')

  const remote = (await gitOut(tools, path, ['remote', 'get-url', 'origin']).catch(() => '')).trim()
  const repo = githubRepoOf(remote)
  const isPrivate = repo ? await privacy({ tools, path, repo }).catch(() => undefined) : undefined
  const notes: string[] = []
  if (isPrivate === undefined)
    notes.push(
      repo ? 'runner rule skipped: GitHub did not say if the repo is private' : 'runner rule skipped: no GitHub origin',
    )

  const findings = []
  const runs: string[] = []
  let unreadable = 0
  for (const file of files) {
    let workflow: unknown
    try {
      workflow = parse(read(path, file) ?? '')
    } catch {
      unreadable++
      continue
    }
    const breaches: string[] = []
    for (const job of jobsOf(workflow)) {
      const runner = isPrivate === undefined ? undefined : runnerBreach(job.runsOn, isPrivate)
      if (runner) breaches.push(`job ${job.name}: ${runner}`)
      for (const uses of [job.uses, ...job.steps.map((step) => step.uses)]) {
        const pin = uses ? pinBreach(uses) : undefined
        if (pin) breaches.push(`job ${job.name}: ${pin}`)
      }
      runs.push(...job.steps.flatMap((step) => step.run ?? []))
    }
    if (!breaches.length) continue
    findings.push(
      finding('ci', `ci:${file}`, `Hygiene: CI workflow ${file} breaks the repo's rules`, breaches, breaches.length),
    )
  }
  if (unreadable) notes.push(`${unreadable} workflow file${unreadable === 1 ? '' : 's'} not valid YAML`)

  const target = ciTarget(read(path, 'project.yaml'))
  // `make ${{ matrix.make }}` names its target at run time: the file cannot say the gate is missing
  const templated = runs.some((script) => /\bmake\s+[^\n]*\$\{\{/.test(script))
  if (target && templated) notes.push('gate rule skipped: a step runs a templated make target')
  if (target && !templated && !runs.some((script) => runsMake(script, target))) {
    findings.push(
      finding(
        'ci',
        'ci:gate',
        "Hygiene: CI does not run the project's full check",
        [`project.yaml says CI runs \`make ${target}\`, but no workflow step does`],
        1,
      ),
    )
  }

  const suffix = notes.length ? ` (${notes.join('; ')})` : ''
  if (findings.length) return found(`${files.length} workflows, ${findings.length} with breaches${suffix}`, findings)
  return clean(`${files.length} workflows follow the rules${suffix}`)
}
