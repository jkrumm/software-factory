import { afterAll, describe, expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { collectJunit, parseJunit } from '../src/junit.ts'

const bun = `<?xml version="1.0" encoding="UTF-8"?>
<testsuites name="bun test" tests="3">
  <testsuite name="x.test.ts" file="x.test.ts" tests="3">
    <testcase name="a &amp; b" classname="" time="0.031" file="x.test.ts" />
    <testcase name="bad" classname="" time="0.16">
      <failure type="AssertionError" message="Expected: a > b&#10;Received: 1">AssertionError: &lt;x&gt;</failure>
    </testcase>
    <testcase name="sk" classname="" time="0"><skipped /></testcase>
  </testsuite>
</testsuites>`

describe('parseJunit', () => {
  test("Bun's report: names unescaped, the suite is the file, fail and skip are told from pass", () => {
    expect(parseJunit(bun)).toEqual([
      { suite: 'x.test.ts', name: 'a & b', status: 'pass', durationMs: 31 },
      { suite: 'x.test.ts', name: 'bad', status: 'fail', durationMs: 160 },
      { suite: 'x.test.ts', name: 'sk', status: 'skip', durationMs: 0 },
    ])
  })

  test("pytest's report: the suite is the classname, an <error> is a fail, a CDATA body is ignored", () => {
    const xml = `<testsuites><testsuite name="pytest" tests="2">
      <testcase classname="tests.test_x" name="test_ok" time="0.002"></testcase>
      <testcase classname="tests.test_x" name="test_err" time="1.5"><error message="boom"><![CDATA[<testcase name="ghost"/>]]></error></testcase>
    </testsuite></testsuites>`
    expect(parseJunit(xml)).toEqual([
      { suite: 'tests.test_x', name: 'test_ok', status: 'pass', durationMs: 2 },
      { suite: 'tests.test_x', name: 'test_err', status: 'fail', durationMs: 1500 },
    ])
  })

  test('a failure with a > in an attribute value, nested suites and a document that is not JUnit', () => {
    const xml = `<testsuite name="outer"><testsuite name="inner"><testcase name="t" time="x"><failure message="a>b"/></testcase></testsuite><testcase name="u"/></testsuite>`
    expect(parseJunit(xml)).toEqual([
      { suite: 'inner', name: 't', status: 'fail', durationMs: 0 },
      { suite: 'outer', name: 'u', status: 'pass', durationMs: 0 },
    ])
    expect(parseJunit('<html><body>no</body></html>')).toEqual([])
    expect(parseJunit('')).toEqual([])
  })
})

describe('collectJunit', () => {
  const dirs: string[] = []
  afterAll(async () => {
    for (const dir of dirs) await rm(dir, { recursive: true, force: true })
  })

  test('reads every .xml file of the directory in name order and skips the rest; a missing directory has none', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'junit-test-'))
    dirs.push(dir)
    await writeFile(join(dir, 'b.xml'), '<testsuite name="b"><testcase name="two"/></testsuite>')
    await writeFile(join(dir, 'a.xml'), '<testsuite name="a"><testcase name="one"/></testsuite>')
    await writeFile(join(dir, 'notes.txt'), '<testsuite name="c"><testcase name="three"/></testsuite>')
    expect((await collectJunit(dir)).map((r) => r.name)).toEqual(['one', 'two'])
    expect(await collectJunit(join(dir, 'missing'))).toEqual([])
  })
})
