#!/usr/bin/env bun
/**
 * The public-hygiene scan: no tracked file names a host, a secret, an account or a work repo (NL7, AGENTS.md "Public
 * repo"). Reads `git ls-files`, so a file that is not tracked is not the repo's. An exception is a line in
 * `public-scan.allow` with its reason; a stale line fails too. Run by `make check`; exits 1 on a finding.
 * `--files <paths…>` scans exactly those files (an exception left unused is not reported).
 *
 * What it does not judge: `op://vault/item/field` references (a reference, resolved at runtime), the owner's public
 * GitHub login and the role names `mini`, `macbook`, `homelab`, `vps` (a machine's job, not an address).
 */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

export interface Rule {
  /** the key an exception names */
  rule: string
  regex: RegExp
  /** what to say instead */
  use: string
  /** a match this returns true for is let through (a documentation address, a placeholder) */
  ok?: (match: string) => boolean
}

const DOC_IPV4 = /^(192\.0\.2|198\.51\.100|203\.0\.113)\./
const PLACEHOLDER_USERS = new Set(['x', 'me', 'someone', 'example', 'user', 'you', 'runner', 'name', 'owner'])
const PLACEHOLDER_MAIL =
  /@(example\.(com|org|net)|[a-z0-9.-]*\.example\.(com|org|net)|users\.noreply\.github\.com|github\.com)$/i

export const RULES: Rule[] = [
  {
    rule: 'ipv4',
    regex: /\b(?:25[0-5]|2[0-4]\d|1?\d?\d)(?:\.(?:25[0-5]|2[0-4]\d|1?\d?\d)){3}\b/g,
    use: 'an address from the documentation range (192.0.2.x) or a placeholder',
    ok: (m) => m === '127.0.0.1' || m === '0.0.0.0' || m === '1.1.1.1' || DOC_IPV4.test(m),
  },
  {
    rule: 'tailnet',
    regex:
      /\b[a-z0-9-]+\.ts\.net\b|\btail[0-9a-f]{5,}\b|\b100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d{1,3}\.\d{1,3}\b/gi,
    use: '<tailnet> or <tailscale-ip>',
  },
  {
    rule: 'email',
    regex: /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g,
    use: 'an @example.com address',
    ok: (m) => PLACEHOLDER_MAIL.test(m),
  },
  {
    rule: 'secret',
    regex:
      /\bgh[pousr]_[A-Za-z0-9]{20,}|\bgithub_pat_[A-Za-z0-9_]{20,}|\bsk-(?:ant-)?[A-Za-z0-9_-]{20,}|\bxox[abprs]-[A-Za-z0-9-]{10,}|\bAKIA[0-9A-Z]{16}\b|\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|\bBearer [A-Za-z0-9._~+/-]{24,}/g,
    use: '<see-1password>',
  },
  {
    rule: 'home-path',
    regex: /(?:\/Users|\/home)\/([A-Za-z0-9_][A-Za-z0-9._-]*)/g,
    use: '`~` or __HOME__',
    ok: (m) => PLACEHOLDER_USERS.has(m.split('/')[2] ?? ''),
  },
  {
    rule: 'host',
    regex:
      /\bssh\s+(?:-[A-Za-z]+\s+)*(?:iumac|homelab|vps|mini)\b|\biumac\b|\b[a-z0-9-]+\.(?:local|lan|internal|home\.arpa)\b/gi,
    use: 'a role (`the mini`) or <host>',
    ok: (m) => /^(host|env|self|window|document)\.local$/i.test(m),
  },
  {
    rule: 'account',
    regex: /\b(?:tkrumm|careerpartner|iu\.org|iu-study\.[a-z.]+)\b|\bop:\/\/(?:private|careerpartner|tkrumm)\//gi,
    use: '<see-1password>',
  },
  {
    rule: 'work-repo',
    regex:
      /\biuroot\b|\bgitlab(?:\.[a-z.]+)?\b|\bepos(?:[._-][a-z][\w.-]*)|\bathena(?:-[a-z-]+)?\b|\bcare-knowledge\b|\bcfn-kafka\b|\bcrm-bridge[\w-]*|\binfra-(?:pilot|github-access)\b|\bterraform-monitoring\b|\bprometheus-(?:scripts|stack|epx|feuer)[\w-]*|\bgithub-migration-handover\b|\bteammate-switch[\w-]*/gi,
    use: '<work-root> or <work-repo>',
  },
]

export interface Finding {
  file: string
  line: number
  rule: string
  found: string
  use: string
}

export interface Exception {
  file: string
  /** a rule's key, or `*` for every rule */
  rule: string
  reason: string
  /** the line in the allow file */
  at: number
}

/** `op://vault/item/field` refs are references, not values: blanked before the rules run. */
function withoutRefs(line: string): string {
  return line.replace(/op:\/\/[A-Za-z0-9_./-]+/g, (ref) =>
    /^op:\/\/(private|careerpartner|tkrumm)\//.test(ref) ? ref : '<ref>',
  )
}

export function findingsIn(file: string, text: string): Finding[] {
  const findings: Finding[] = []
  text.split('\n').forEach((raw, i) => {
    const line = withoutRefs(raw)
    for (const r of RULES) {
      for (const match of line.matchAll(r.regex)) {
        if (r.ok?.(match[0])) continue
        findings.push({ file, line: i + 1, rule: r.rule, found: match[0], use: r.use })
      }
    }
  })
  return findings
}

/** `<path> <rule or *>  # <reason>`; a line without a reason is returned as a problem. */
export function parseExceptions(text: string): { exceptions: Exception[]; problems: string[] } {
  const exceptions: Exception[] = []
  const problems: string[] = []
  const rules = new Set(RULES.map((r) => r.rule))
  text.split('\n').forEach((raw, i) => {
    const line = raw.trim()
    if (!line || line.startsWith('#')) return
    const [spec = '', ...rest] = line.split('#')
    const reason = rest.join('#').trim()
    const match = /^(\S+)\s+(\S+)\s*$/.exec(spec.trim())
    if (!match?.[1] || !match[2] || !reason) {
      problems.push(`public-scan.allow:${i + 1}: needs "<path> <rule or *>  # <reason>"`)
      return
    }
    if (match[2] !== '*' && !rules.has(match[2])) {
      problems.push(`public-scan.allow:${i + 1}: "${match[2]}" is not a rule`)
      return
    }
    exceptions.push({ file: match[1], rule: match[2], reason, at: i + 1 })
  })
  return { exceptions, problems }
}

const BINARY = /\.(png|jpe?g|gif|webp|ico|woff2?|ttf|lock|lockb|mp4|webm|pdf)$/i

/** The findings in `files` that no exception covers, marking the exceptions used. */
async function scan(root: string, files: string[], exceptions: Exception[], used: Set<Exception>): Promise<string[]> {
  const out: string[] = []
  for (const file of files) {
    if (BINARY.test(file)) continue
    const text = await readFile(join(root, file), 'utf8').catch(() => null)
    if (text === null || text.includes('\u0000')) continue
    for (const f of findingsIn(file, text)) {
      const exception = exceptions.find((e) => e.file === f.file && (e.rule === '*' || e.rule === f.rule))
      if (exception) {
        used.add(exception)
        continue
      }
      out.push(`${f.file}:${f.line}: ${f.rule} "${f.found}"; use ${f.use}`)
    }
  }
  return out
}

async function trackedFiles(root: string): Promise<string[]> {
  const proc = Bun.spawn(['git', 'ls-files', '-z'], { cwd: root, stdout: 'pipe', stderr: 'inherit' })
  const text = await new Response(proc.stdout).text()
  if ((await proc.exited) !== 0) throw new Error('git ls-files failed')
  return text.split('\0').filter(Boolean).sort()
}

/** Every finding not covered by an exception, and every problem with the exceptions themselves. */
export async function checkPublicScan(root: string, allowText: string, only?: string[]): Promise<string[]> {
  const { exceptions, problems } = parseExceptions(allowText)
  const used = new Set<Exception>()
  const out = [...problems, ...(await scan(root, only ?? (await trackedFiles(root)), exceptions, used))]
  if (!only) {
    for (const e of exceptions) {
      if (!used.has(e)) out.push(`public-scan.allow:${e.at}: ${e.file} ${e.rule} matches nothing any more; delete it`)
    }
  }
  return out
}

export const ROOT = join(import.meta.dir, '..')
export const ALLOW_FILE = join(import.meta.dir, 'public-scan.allow')

if (import.meta.main) {
  const args = process.argv.slice(2)
  const allowText = await readFile(ALLOW_FILE, 'utf8').catch(() => '')
  const problems = await checkPublicScan(ROOT, allowText, args[0] === '--files' ? args.slice(1) : undefined)
  for (const line of problems) console.error(line)
  if (problems.length) process.exit(1)
  console.log('public scan clean')
}
