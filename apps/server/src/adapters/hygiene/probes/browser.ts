import { readFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { gitOut, type Tools } from '../git.ts'
import { type Outcome, clean, finding, found } from './finding.ts'
import type { ProbeFinding } from '../../../domains/loops/hygiene-model.ts'

/**
 * The owner's rule for which browser a suite gets and which agent tooling a repo checks in (dotfiles `rules/browser.md`), read
 * from the files. A suite runs on Playwright's bundled headless shell unless the line that pins installed Chrome states why
 * (`// chrome: <reason>`); a suite never runs headed; a coding agent gets a command-line tool and a skill, never an MCP server.
 * Only test files are judged for the browser: a script that makes screenshots for a person, product code that takes the channel
 * as an argument, evidence and spikes are not suites.
 */

/** One thing a file breaks: where, what and the rule's sentence. */
interface Breach {
  file: string
  line: number
  what: string
  rule: string
}

const CHROME_RULE =
  "installed Chrome, headless, with the reason on the line: `channel: 'chrome', // chrome: <reason>` (rules/browser.md)"
const HEADED_RULE = 'never `headless: false` in a suite (rules/browser.md)'
const MCP_RULE =
  'a new MCP server for a coding agent: an agent with a shell gets a command-line tool and a skill (rules/browser.md)'

const SOURCE = /\.(?:[cm]?[jt]s|[jt]sx)$/
const PLAYWRIGHT_CONFIG = /^playwright[^/]*\.config\.[^/]+$/
const TEST_FILE = /\.(?:e2e|spec|test)\.[^/]+$/
const TEST_DIRS = new Set(['e2e', 'tests'])
/** Not suites: the evidence record and the throwaway spikes. */
const NOT_SUITES = ['docs/evidence/', 'tools/spikes/']

const CHANNEL_CHROME = /\bchannel\s*:\s*(['"`])chrome\1/
const EXECUTABLE_CHROME = /\bexecutablePath\b[^\n]*google[ -]chrome/i
const HEADED = /\bheadless\s*:\s*false\b/
const REASON_ON_LINE = /(?:\/\/|\/\*|#)\s*chrome:\s*\S/
const REASON_LINE = /^\s*(?:\/\/|\/\*|\*|#)\s*chrome:\s*\S/
const COMMENT_LINE = /^\s*(?:\/\/|\/\*|\*)/

/** A file the browser rule judges: a Playwright config, a spec or test file, or anything under an `e2e` or `tests` directory. */
function isSuiteFile(file: string): boolean {
  if (!SOURCE.test(file) || file.split('/').includes('node_modules')) return false
  if (NOT_SUITES.some((prefix) => file.startsWith(prefix))) return false
  const name = basename(file)
  if (PLAYWRIGHT_CONFIG.test(name) || TEST_FILE.test(name)) return true
  return file
    .split('/')
    .slice(0, -1)
    .some((dir) => TEST_DIRS.has(dir))
}

/** The breaches of one suite file: installed Chrome with no `chrome:` reason on its line or the line above, and `headless: false`. */
function browserBreaches(text: string, file: string): Breach[] {
  const lines = text.split('\n')
  const out: Breach[] = []
  lines.forEach((line, index) => {
    if (COMMENT_LINE.test(line)) return
    const at = index + 1
    if (CHANNEL_CHROME.test(line) || EXECUTABLE_CHROME.test(line)) {
      const reasoned = REASON_ON_LINE.test(line) || REASON_LINE.test(lines[index - 1] ?? '')
      if (!reasoned) out.push({ file, line: at, what: `${line.trim()}: no \`// chrome: <reason>\``, rule: CHROME_RULE })
    }
    if (HEADED.test(line)) out.push({ file, line: at, what: line.trim(), rule: HEADED_RULE })
  })
  return out
}

const asRecord = (value: unknown): Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {}

const hasServers = (value: unknown): boolean => Object.keys(asRecord(value)).length > 0

const AGENT_FILE = /^\.claude\/agents\/[^/]+\.md$/

/** The three places a checked-in MCP server configuration lives. */
const isAgentConfig = (file: string): boolean =>
  file === '.mcp.json' || file === '.claude/settings.json' || AGENT_FILE.test(file)

/** A checked-in MCP server configuration a coding-agent session would load: `.mcp.json`, `mcpServers` in settings or an agent file. */
function mcpBreach(file: string, text: string): Breach | undefined {
  if (file === '.mcp.json') return { file, line: 1, what: 'a checked-in .mcp.json', rule: MCP_RULE }
  if (file === '.claude/settings.json') {
    try {
      if (!hasServers(asRecord(JSON.parse(text)).mcpServers)) return undefined
    } catch {
      return undefined
    }
    const line = text.split('\n').findIndex((l) => l.includes('"mcpServers"')) + 1
    return { file, line: line || 1, what: 'an mcpServers block in the settings', rule: MCP_RULE }
  }
  if (AGENT_FILE.test(file)) {
    const lines = text.split('\n')
    if (lines[0]?.trim() !== '---') return undefined
    const end = lines.indexOf('---', 1)
    const head = end === -1 ? [] : lines.slice(1, end)
    const index = head.findIndex((l) => /^mcpServers\s*:/.test(l))
    if (index === -1) return undefined
    return { file, line: index + 2, what: 'an mcpServers entry in the agent file', rule: MCP_RULE }
  }
  return undefined
}

/** One finding per file: the key is the path, so intake's fingerprint is one Issue per file. */
function toFindings(breaches: Breach[]): ProbeFinding[] {
  const groups = new Map<string, Breach[]>()
  for (const breach of breaches) groups.set(breach.file, [...(groups.get(breach.file) ?? []), breach])
  return [...groups].map(([file, list]) =>
    finding(
      'browser',
      `browser:${file}`,
      `Hygiene: browser rule in ${file}`,
      list.map((b) => `${b.file}:${b.line}: ${b.what}: ${b.rule}`),
      list.length,
    ),
  )
}

const read = (path: string, file: string): string => {
  try {
    return readFileSync(join(path, file), 'utf8')
  } catch {
    return ''
  }
}

/** The browser and agent-tooling rules over a checkout: test files for Chrome and headed runs, three paths for MCP configuration. */
export async function browserProbe(tools: Tools, path: string): Promise<Outcome> {
  const tracked = (await gitOut(tools, path, ['ls-files', '-z'])).split('\0').filter(Boolean)
  const suites = tracked.filter(isSuiteFile)
  const configs = tracked.filter(isAgentConfig)
  const breaches = [
    ...suites.flatMap((file) => browserBreaches(read(path, file), file)),
    ...configs.flatMap((file) => mcpBreach(file, read(path, file)) ?? []),
  ]
  const detail = `${suites.length} suite files, ${configs.length} agent configs`
  return breaches.length ? found(detail, toFindings(breaches)) : clean(detail)
}
