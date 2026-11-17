import { readFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { gitOut, type Tools } from '../git.ts'
import { type Outcome, clean, finding, found, skipped } from './finding.ts'

const FENCE = /^ {0,3}(`{3,}|~{3,})/
const INLINE_CODE = /(`+)[^`]*?\1/g
/** `@path` after whitespace or at the line start: the token is a file reference (`./x`, `../x`, `~/x`, `/x` or ends in an extension), never `@scope/package` or an e-mail address. */
const IMPORT = /(?:^|\s)@((?:\.{1,2}\/|~\/|\/)[\w./-]*[\w-]|[\w-][\w./-]*\.[A-Za-z0-9]+)(?=$|[\s,;:)!?])/g

export interface Import {
  line: number
  target: string
}

const MANAGED_BEGIN = /^\s*<!--\s*basalt:begin\b/
const MANAGED_END = /^\s*<!--\s*basalt:end\b/

/**
 * The `@path` imports of an AGENTS.md, outside fenced code, inline code spans and the basalt-ui managed block
 * (`<!-- basalt:begin -->` .. `<!-- basalt:end -->`): that block is generated and `basalt-ui sync --check` gates the
 * consumer's CI, so an import in it is not the consumer's to fix.
 */
export function agentsImports(text: string): Import[] {
  const imports: Import[] = []
  let fence: string | undefined
  let managed = false
  text.split('\n').forEach((raw, index) => {
    if (managed) {
      if (MANAGED_END.test(raw)) managed = false
      return
    }
    if (!fence && MANAGED_BEGIN.test(raw)) {
      managed = true
      return
    }
    const opening = FENCE.exec(raw)?.[1]
    if (opening) {
      if (!fence) fence = opening
      else if (opening[0] === fence[0] && opening.length >= fence.length) fence = undefined
      return
    }
    if (fence) return
    const prose = raw.replace(INLINE_CODE, (code) => ' '.repeat(code.length))
    for (const match of prose.matchAll(IMPORT)) {
      const target = (match[1] ?? '').replace(/\.$/, '')
      if (target) imports.push({ line: index + 1, target })
    }
  })
  return imports
}

/** What a checked-in `.claude/settings.json` says about `permissions.ask`: the rules, or a note when the file does not parse. */
export function askRules(text: string): { rules: string[] } | { malformed: true } {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return { malformed: true }
  }
  const permissions = (parsed as { permissions?: { ask?: unknown } } | null)?.permissions
  const ask = permissions?.ask
  return { rules: Array.isArray(ask) ? ask.map(String) : [] }
}

const readText = (root: string, file: string): string | undefined => {
  try {
    return readFileSync(join(root, file), 'utf8')
  } catch {
    return undefined
  }
}

/**
 * The repo contract for agent files: no `CLAUDE.md` or `CLAUDE.local.md`, no `@imports` in an `AGENTS.md`, no `ask` rules in a
 * checked-in `.claude/settings.json`. Skipped when the repo tracks none of AGENTS.md, CLAUDE.md or `.claude/settings.json`.
 */
export async function agentsmdProbe(tools: Tools, path: string): Promise<Outcome> {
  const tracked = (await gitOut(tools, path, ['ls-files', '-z'])).split('\0').filter(Boolean)
  const claude = tracked.filter((f) => ['CLAUDE.md', 'CLAUDE.local.md'].includes(basename(f)))
  const agents = tracked.filter((f) => basename(f) === 'AGENTS.md')
  const settings = tracked.filter((f) => f === '.claude/settings.json' || f.endsWith('/.claude/settings.json'))
  if (!claude.length && !agents.length && !settings.length)
    return skipped('no AGENTS.md, CLAUDE.md or .claude/settings.json')

  const findings = []
  if (claude.length) {
    findings.push(
      finding(
        'agentsmd',
        'agentsmd:claude-md',
        'Hygiene: CLAUDE.md files in the repo',
        claude.map((f) => `${f}: either file suppresses AGENTS.md`),
        claude.length,
      ),
    )
  }

  const imports: string[] = []
  for (const file of agents) {
    const text = readText(path, file)
    if (text === undefined) continue
    for (const found of agentsImports(text)) imports.push(`${file}:${found.line}: @${found.target}`)
  }
  if (imports.length) {
    findings.push(finding('agentsmd', 'agentsmd:imports', 'Hygiene: @imports in AGENTS.md', imports, imports.length))
  }

  const ask: string[] = []
  for (const file of settings) {
    const text = readText(path, file)
    if (text === undefined) continue
    const result = askRules(text)
    if ('malformed' in result) ask.push(`${file}: not valid JSON`)
    else for (const rule of result.rules) ask.push(`${file}: ask rule ${rule}`)
  }
  if (ask.length) {
    findings.push(
      finding('agentsmd', 'agentsmd:ask-rules', 'Hygiene: ask rules in .claude/settings.json', ask, ask.length),
    )
  }

  const detail = `${agents.length} AGENTS.md, ${claude.length} CLAUDE.md, ${settings.length} settings.json`
  return findings.length ? found(detail, findings) : clean(detail)
}
