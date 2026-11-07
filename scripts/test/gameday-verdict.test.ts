import { afterAll, beforeAll, expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const VERDICT = join(import.meta.dir, '..', 'gameday', 'verdict.sh')

let dir = ''
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'verdict-'))
})
afterAll(async () => {
  await rm(dir, { recursive: true, force: true })
})

const card = (state: string, outcome: string | null, kinds: string[]) => ({
  state,
  outcome,
  timeline: kinds.map((kind) => ({ kind })),
})

async function run(script: string): Promise<{ code: number; out: string }> {
  const proc = Bun.spawn(['bash', '-c', `set -euo pipefail; source ${VERDICT}; ${script}`], {
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [out, err, code] = await Promise.all([proc.stdout.text(), proc.stderr.text(), proc.exited])
  return { code, out: out.trim(), err }
}

async function verdictOf(name: string, body: object, landed: 'yes' | 'no') {
  const path = join(dir, `${name}.json`)
  await writeFile(path, JSON.stringify(body))
  return run(`verdict ${path} ${landed}`)
}

const CLOSED_BY_CLOSE = ['filed', 'noted', 'settled', 'admitted', 'lead_started', 'closed']

test('closed by close, no deploy, the commit on the remote: green without ship, watch or verify', async () => {
  const result = await verdictOf('close', card('closed', 'done', CLOSED_BY_CLOSE), 'yes')
  expect(result).toMatchObject({ code: 0 })
  expect(result.out).toStartWith('GREEN: closed done by the lead')
})

test('closed after a ship: green only when the watch passed too', async () => {
  const shipped = [...CLOSED_BY_CLOSE.slice(0, -1), 'shipped', 'watch_passed', 'closed']
  const green = await verdictOf('shipped', card('closed', 'done', shipped), 'yes')
  expect(green).toMatchObject({ code: 0 })
  expect(green.out).toStartWith('GREEN: shipped, watched, verified')
  const unwatched = await verdictOf('unwatched', card('closed', 'done', ['filed', 'shipped', 'closed']), 'yes')
  expect(unwatched).toMatchObject({ code: 1 })
  expect(unwatched.out).toContain('watch (and verify) never passed')
})

test('the commit missing from the remote, or an Issue not closed done, is not green', async () => {
  expect((await verdictOf('nolanding', card('closed', 'done', CLOSED_BY_CLOSE), 'no')).code).toBe(1)
  for (const [state, outcome] of [
    ['closed', 'dropped'],
    ['closed', 'cancelled'],
    ['working', null],
    ['waiting', null],
  ] as const) {
    const result = await verdictOf(`${state}-${outcome}`, card(state, outcome, CLOSED_BY_CLOSE), 'yes')
    expect({ state, outcome, code: result.code }).toEqual({ state, outcome, code: 1 })
  }
  expect((await run(`verdict ${join(dir, 'missing.json')} yes`)).code).toBe(1)
})

/** The lookup that missed 8ea8d58: `git log | grep -q` under pipefail is 141 when grep stops early. */
test('commit_on_remote finds a commit that is on the remote, (the live remote had two commits), and says no otherwise', async () => {
  const remote = join(dir, 'remote.git')
  const lines = [
    `git init -q --bare --initial-branch=master ${remote}`,
    `work=${join(dir, 'work')}; git init -q --initial-branch=master "$work"`,
    'cd "$work"',
    'export GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@example.com GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@example.com',
    'git commit -q --allow-empty -m "chore: gameday gd-1"',
    'for i in $(seq 1 3); do git commit -q --allow-empty -m "chore: filler $i"; done',
    `git push -q ${remote} master`,
    `for _ in $(seq 1 20); do [[ $(commit_on_remote ${remote} "gameday gd-1") == yes ]] || { echo missed; exit 1; }; done`,
    `commit_on_remote ${remote} "gameday gd-2"`,
    `commit_on_remote ${join(dir, 'nowhere.git')} "gameday gd-1"`,
  ]
  const result = await run(lines.join('\n'))
  expect(result.out).toBe('no\nno')
  expect(result.code).toBe(0)
})
