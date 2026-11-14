import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { MAX_TEST_RESULTS, type TestResult } from '@software-factory/contract'

/** A tag of the elements this reads, its attributes (a `>` inside a quoted value does not end it) and whether it is self-closing. */
const TAG = /<(\/?)(testsuite|testcase|failure|error|skipped)\b((?:[^>"']|"[^"]*"|'[^']*')*?)(\/?)>/g
const ATTRIBUTE = /([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g
const CDATA = /<!\[CDATA\[[\s\S]*?\]\]>/g

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }

function unescape(text: string): string {
  return text.replace(/&(#x[0-9a-fA-F]+|#\d+|\w+);/g, (whole, body: string) => {
    if (body.startsWith('#')) {
      const code = body[1] === 'x' ? Number.parseInt(body.slice(2), 16) : Number(body.slice(1))
      return Number.isInteger(code) && code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole
    }
    return ENTITIES[body] ?? whole
  })
}

function attributesOf(text: string): Map<string, string> {
  const found = new Map<string, string>()
  for (const [, key, double, single] of text.matchAll(ATTRIBUTE)) {
    if (key !== undefined) found.set(key, unescape(double ?? single ?? ''))
  }
  return found
}

/**
 * The test results of one JUnit XML document, in document order. A `<testcase>` is `fail` when it holds a `<failure>` or an
 * `<error>`, `skip` when it holds a `<skipped>`, else `pass`. Its suite is its `classname` when it has one (pytest), else
 * the enclosing `<testsuite>`'s name (Bun and Playwright name the file there). The scan reads the elements it needs and
 * ignores the rest, so a reporter's extra attributes and elements change nothing; a document that is not JUnit has none.
 */
export function parseJunit(xml: string): TestResult[] {
  const results: TestResult[] = []
  const suites: string[] = []
  let current: { name: string; suite: string; durationMs: number; status: TestResult['status'] } | undefined
  const finish = () => {
    if (current) results.push(current)
    current = undefined
  }
  for (const match of xml.replace(CDATA, '').matchAll(TAG)) {
    const [, closing, tag, rest = '', selfClosing] = match
    if (tag === 'testsuite') {
      if (closing) suites.pop()
      else {
        suites.push(attributesOf(rest).get('name') ?? '')
        if (selfClosing) suites.pop()
      }
    } else if (tag === 'testcase') {
      if (closing) {
        finish()
        continue
      }
      finish()
      const attributes = attributesOf(rest)
      const seconds = Number(attributes.get('time'))
      current = {
        name: attributes.get('name') ?? '',
        suite: attributes.get('classname') || suites.at(-1) || '',
        durationMs: Number.isFinite(seconds) && seconds > 0 ? Math.round(seconds * 1000) : 0,
        status: 'pass',
      }
      if (selfClosing) finish()
    } else if (current && !closing) {
      if (tag === 'skipped') {
        if (current.status === 'pass') current.status = 'skip'
      } else current.status = 'fail'
    }
  }
  finish()
  return results.filter((r) => r.name !== '')
}

/** The results of every `*.xml` file in a directory (a missing or unreadable one has none), cut at what the server takes. */
export async function collectJunit(dir: string): Promise<TestResult[]> {
  let names: string[]
  try {
    names = (await readdir(dir)).filter((name) => name.endsWith('.xml')).sort()
  } catch {
    return []
  }
  const results: TestResult[] = []
  for (const name of names) {
    try {
      results.push(...parseJunit(await readFile(join(dir, name), 'utf8')))
    } catch {
      // a file that cannot be read is no results
    }
    if (results.length >= MAX_TEST_RESULTS) break
  }
  return results.slice(0, MAX_TEST_RESULTS).map((r) => ({
    ...r,
    suite: r.suite.slice(0, 500),
    name: r.name.slice(0, 1000),
  }))
}
