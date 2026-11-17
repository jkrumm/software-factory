#!/usr/bin/env bun
/**
 * The README against the code (`make docs-check`, a declared hygiene probe of this repo and a step of `make check`).
 * The README states counts and lists a visitor takes at their word: how many event kinds there are, who a caller can be,
 * which tokens the server reads, which screens the Console has, which domains the server owns, which states an Issue has,
 * the Console's port and how many writes its listener forwards. Each is read from the code and compared; a README that
 * disagrees fails with the statement to fix. A statement the README no longer makes fails too, so the check cannot
 * go quiet by deleting the sentence.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { CALLERS } from '../apps/server/src/api/policy.ts'
import { STATES } from '../apps/server/src/domains/work/issue.ts'
import { PAYLOADS } from '../apps/server/src/domains/work/events.ts'

/** What the code says: every list and count the README states. */
export interface Facts {
  eventKinds: readonly string[]
  callers: readonly string[]
  tokens: readonly string[]
  screens: readonly string[]
  domains: readonly string[]
  states: readonly string[]
  consolePort: number
  consoleWrites: number
}

const WORDS = [
  'zero',
  'one',
  'two',
  'three',
  'four',
  'five',
  'six',
  'seven',
  'eight',
  'nine',
  'ten',
  'eleven',
  'twelve',
  'thirteen',
  'fourteen',
  'fifteen',
  'sixteen',
  'seventeen',
  'eighteen',
  'nineteen',
  'twenty',
]

/** A count the README writes as digits or an English number word (`23`, `Eight`); undefined for anything else. */
export function countOf(word: string): number | undefined {
  if (/^\d+$/.test(word)) return Number(word)
  const at = WORDS.indexOf(word.toLowerCase())
  return at === -1 ? undefined : at
}

/** A number as the README writes it: digits or an English number word. */
const NUMBER = `\\d+|${WORDS.join('|')}`

const sorted = (values: Iterable<string>): string[] => [...new Set(values)].sort()
const backticked = (line: string): string[] => [...line.matchAll(/`([^`]+)`/g)].map((m) => m[1] ?? '')

/** The first line of the README that matches, or undefined. */
const lineWith = (readme: string, pattern: RegExp): string | undefined =>
  readme.split('\n').find((l) => pattern.test(l))

function sameSet(what: string, stated: string[], actual: readonly string[], fix: string): string[] {
  const a = sorted(stated)
  const b = sorted(actual)
  const missing = b.filter((x) => !a.includes(x))
  const extra = a.filter((x) => !b.includes(x))
  if (!missing.length && !extra.length) return []
  const parts = [
    missing.length ? `missing ${missing.join(', ')}` : '',
    extra.length ? `not in the code: ${extra.join(', ')}` : '',
  ].filter(Boolean)
  return [`README.md: ${what}: ${parts.join('; ')}. ${fix}`]
}

function stated(readme: string, what: string, pattern: RegExp, fix: string): { problem?: string; count?: number } {
  const match = pattern.exec(readme)
  const count = match?.[1] ? countOf(match[1]) : undefined
  if (count === undefined) return { problem: `README.md: no statement of ${what} any more (${pattern}). ${fix}` }
  return { count }
}

/** Every disagreement between the README text and the code's facts, each naming the statement to fix. */
export function checkReadme(
  readme: string,
  facts: Facts,
  imageExists: (path: string) => boolean = () => true,
): string[] {
  const problems: string[] = []
  const compare = (what: string, got: { problem?: string; count?: number }, actual: number) => {
    if (got.problem) problems.push(got.problem)
    else if (got.count !== actual) problems.push(`README.md: ${what} says ${got.count}, the code has ${actual}.`)
  }

  const kinds = stated(
    readme,
    'event kinds',
    new RegExp(`\\*\\*(${NUMBER}) kinds\\*\\*`, 'i'),
    'Write "**N kinds**" in the Event row of the language table.',
  )
  compare('the event kinds', kinds, facts.eventKinds.length)
  const eventRow = lineWith(readme, /\*\*Event\*\*/)
  for (const name of eventRow ? backticked(eventRow) : []) {
    if (!facts.eventKinds.includes(name))
      problems.push(`README.md: the Event row names \`${name}\`, which is not an event kind.`)
  }

  const callerLine = lineWith(readme, /decide the caller/)
  if (!callerLine) problems.push('README.md: no sentence "decide the caller" listing the callers.')
  else
    problems.push(
      ...sameSet(
        'the callers',
        backticked(callerLine),
        facts.callers,
        'List every caller of `api/policy.ts` in the Gates sentence.',
      ),
    )

  const stateLine = lineWith(readme, /\*\*State\*\*/)
  if (!stateLine) problems.push('README.md: no State row in the language table.')
  else
    problems.push(
      ...sameSet(
        'the Issue states',
        backticked(stateLine),
        facts.states,
        'List every state of `domains/work/issue.ts`.',
      ),
    )

  const tokens = [...readme.matchAll(/\bFACTORY_[A-Z_]*TOKEN\b/g)].map((m) => m[0])
  problems.push(...sameSet('the tokens', tokens, facts.tokens, 'Name every token `settings.ts` reads in Run it.'))

  const domains = stated(
    readme,
    'the domains',
    new RegExp(`\\b(${NUMBER})\\s+domains\\b`, 'i'),
    'Write "Eight domains" above the domain table.',
  )
  compare('the domains', domains, facts.domains.length)
  const domainRows = readme
    .split('\n')
    .filter((l) => /^\| `[a-z]+` \|/.test(l))
    .map((l) => backticked(l)[0] ?? '')
  problems.push(
    ...sameSet(
      'the domain table',
      domainRows.filter((d) => !d.includes('/')),
      facts.domains,
      'One row per directory of `apps/server/src/domains`.',
    ),
  )

  const layout = lineWith(readme, /^\| `apps\/console` \|/)
  if (!layout) problems.push('README.md: no `apps/console` row in the Layout table.')
  else
    for (const screen of facts.screens)
      if (!layout.includes(screen))
        problems.push(
          `README.md: the \`apps/console\` row omits the screen ${screen} (apps/console/src/lib/screens.ts).`,
        )
  for (const screen of facts.screens) {
    if (!readme.includes(`**${screen}**`)) problems.push(`README.md: the screen ${screen} has no bold entry in See it.`)
  }

  const port = readme.match(/FACTORY_CONSOLE_PORT[^\n]*?(\d{4,5})/)
  if (!port) problems.push('README.md: Run it names no FACTORY_CONSOLE_PORT with its default port.')
  else if (Number(port[1]) !== facts.consolePort)
    problems.push(`README.md: the Console port default is ${port[1]}, the code has ${facts.consolePort}.`)

  const writes = stated(
    readme,
    'the Console writes',
    new RegExp(`forwards\\s+(${NUMBER})\\s+write\\s+verbs`, 'i'),
    'Write "forwards N write verbs" where the Console is described.',
  )
  compare('the Console writes', writes, facts.consoleWrites)

  for (const image of readme.matchAll(/!\[[^\]]*\]\((docs\/demo\/[^)]+)\)/g)) {
    if (image[1] && !imageExists(image[1])) problems.push(`README.md: the image ${image[1]} does not exist.`)
  }
  return problems
}

/** The facts, read from the code of the checkout at `root` (the code that runs is this checkout's own). */
export function readFacts(root: string): Facts {
  const read = (path: string) => readFileSync(join(root, path), 'utf8')
  const nav = [...read('apps/console/src/lib/screens.ts').matchAll(/label: '([^']+)'/g)].map((m) => m[1] ?? '')
  const tokens = [...read('apps/server/src/settings.ts').matchAll(/^\s+(FACTORY_[A-Z_]*TOKEN): token/gm)].map(
    (m) => m[1] ?? '',
  )
  const port = /FACTORY_CONSOLE_PORT:[^\n]*\.default\((\d+)\)/.exec(read('apps/server/src/console-settings.ts'))
  const writes = read('apps/server/src/api/console.ts').match(/^ {2}\{ method: '[A-Z]+', path: \//gm)
  const domains = readdirSync(join(root, 'apps/server/src/domains'), { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
  return {
    eventKinds: Object.keys(PAYLOADS),
    callers: CALLERS,
    tokens,
    screens: nav,
    domains,
    states: STATES,
    consolePort: Number(port?.[1]),
    consoleWrites: writes?.length ?? 0,
  }
}

export const ROOT = join(import.meta.dir, '..')

if (import.meta.main) {
  const problems = checkReadme(readFileSync(join(ROOT, 'README.md'), 'utf8'), readFacts(ROOT), (p) =>
    existsSync(join(ROOT, p)),
  )
  for (const line of problems) console.error(line)
  if (problems.length) process.exit(1)
  console.log('README agrees with the code')
}
