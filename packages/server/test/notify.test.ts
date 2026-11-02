import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Issue } from '@software-factory/contract'
import { createIssue } from '../src/issues/create.ts'
import { enqueue } from '../src/issues/inbox.ts'
import { intakeAlert } from '../src/issues/intake.ts'
import { issuePass } from '../src/issues/worker.ts'
import {
  DIGEST_MAX_CHARS,
  type DigestData,
  digestDue,
  localParts,
  loadDigest,
  renderDigest,
} from '../src/notify/digest.ts'
import { notifyPass } from '../src/notify/index.ts'
import {
  backoffMs,
  claim,
  LEASE_MS,
  listNotifications,
  MAX_ATTEMPTS,
  notificationAttention,
  record,
  sendDue,
  sendNow,
} from '../src/notify/outbox.ts'
import { HermesNotifier, NullNotifier } from '../src/notify/port.ts'
import { notifyDigest, notifyFailures } from '../src/notify/rules.ts'
import { quote, redact } from '../src/notify/text.ts'
import { buildStatus } from '../src/status.ts'
import { TEST_REPO, TEST_ROOT } from './support/app.ts'
import { FakeClock } from './support/clock.ts'
import { FakeNotifier } from './support/notifier.ts'
import { startTestDb, type TestDb } from './support/pg.ts'

let db: TestDb
let clock: FakeClock
let notifier: FakeNotifier
let n = 0

beforeAll(async () => {
  db = await startTestDb()
})
afterAll(() => db.stop())
beforeEach(async () => {
  await db.reset()
  clock = new FakeClock(new Date('2026-11-02T10:00:00.000Z'))
  notifier = new FakeNotifier()
  n = 0
})

const now = () => clock.now()
const deps = () => ({ notifier, target: 'slack:#agents', digestAt: null, digestTz: 'Europe/Berlin' })

async function file(): Promise<Issue> {
  const made = await createIssue(
    db.sql,
    { source: 'request', sourceKey: `k${++n}`, repo: TEST_REPO, title: 'a title', facts: {} },
    { repoRoots: [TEST_ROOT], now: clock.now() },
  )
  return made.issue
}

async function step(issueId: number, kind: string, payload?: Record<string, unknown>) {
  await enqueue(db.sql, { issueId, key: `${issueId}:${kind}:${++n}`, kind, at: clock.now(), payload })
  expect(await issuePass(db.sql, { now, ports: {} })).toEqual([])
}

async function working(): Promise<number> {
  const { id } = await file()
  await step(id, 'admitted')
  return id
}

const rows = () => listNotifications(db.sql)
const keys = async () => (await rows()).map((r) => r.key).sort()

/** What the server finds of a `ship` or a `close` whose commits require nothing: the bar is `evidence.test.ts`'s. */
const MERGED = {
  commits: ['a'.repeat(40)],
  derived: { commits: ['a'.repeat(40)], paths: [], required: [], mergedAt: null, holdMs: 1_800_000, problem: null },
}

describe('what goes out, each kind once', () => {
  test('an ask: one line with the Issue, the repo, the question as a quote and the way back', async () => {
    const id = await working()
    await step(id, 'ask', {
      question: 'Ship the "forecast" fix now?\nOr wait?',
      options: ['now', 'wait'],
      default: 'wait',
    })
    const [row, ...rest] = await rows()
    expect(rest).toEqual([])
    expect(row?.kind).toBe('ask')
    expect(row?.key).toMatch(/^notify:ask:\d+$/)
    expect(row?.text).toBe(
      `Issue ${id} (repo) asks: “Ship the 'forecast' fix now? Or wait?” [options: “now”, “wait”] [default: “wait”] Answer: factory issue answer ${id} "<text>" --decision 1`,
    )
    expect(row?.text).not.toContain('\n')
    expect(row?.text).not.toContain(TEST_ROOT)
  })

  test('an ask that was refused says nothing: the notification is in the transaction that decided it', async () => {
    const { id } = await file()
    await enqueue(db.sql, { issueId: id, key: `${id}:ask:x`, kind: 'ask', at: now(), payload: { question: 'why?' } })
    await issuePass(db.sql, { now, ports: {} })
    expect(await rows()).toEqual([])
    const ok = await working()
    await enqueue(db.sql, { issueId: ok, key: `${ok}:ask:y`, kind: 'ask', at: now(), payload: { question: '' } })
    await issuePass(db.sql, { now, ports: {} })
    expect(await rows()).toEqual([])
  })

  test('parked: a lead that reported nothing, and a lead that is gone', async () => {
    const a = await working()
    await step(a, 'unreported')
    const b = await working()
    await step(b, 'lead_gone', { detail: 'spawn lead-2-1 failed: no account' })
    const texts = Object.fromEntries((await rows()).map((r) => [r.issueId, r.text]))
    expect(texts[a]).toBe(`Issue ${a} (repo) parked: its lead stopped twice with nothing reported`)
    expect(texts[b]).toBe(`Issue ${b} (repo) parked: its lead is gone “spawn lead-2-1 failed: no account”`)
    expect((await keys()).every((k) => /^notify:parked:\d+:\d+$/.test(k))).toBe(true)
  })

  test("a lead's own park or block is its report, not the factory's verdict: nothing goes out", async () => {
    const a = await working()
    await step(a, 'block', { reason: 'stuck' })
    const b = await working()
    await step(b, 'park')
    expect(await rows()).toEqual([])
  })

  test('the hold: a regression sent back to a lead, once per hold', async () => {
    const id = await working()
    await step(id, 'ship', { summary: 'done', ...MERGED })
    await step(id, 'signal', { regression: true, title: 'Forecast is down' })
    const [row, ...rest] = await rows()
    expect(rest).toEqual([])
    expect(row?.key).toBe(`notify:regression:${id}:1`)
    expect(row?.text).toBe(
      `Issue ${id} (repo) regressed after its ship (hold 1) and went back to its lead: “Forecast is down”`,
    )
    await step(id, 'ship', { summary: 'fixed', ...MERGED })
    await step(id, 'signal', { regression: true, title: 'down again' })
    expect(await keys()).toEqual([`notify:regression:${id}:1`, `notify:regression:${id}:2`])
  })

  test('failed: a lead spawn that failed for good, a finalize that keeps failing, a door route refused', async () => {
    const id = await working()
    await db.sql`
      INSERT INTO factory.spawns (key, repo, prompt, role, tier, effort, status, error, created_at, issue_id)
      VALUES ('lead-1-1', ${TEST_REPO}, 'brief', 'lead', 'opus', 'high', 'failed', 'gave up: the 30 min retry budget is spent', ${now()}, ${id}),
             ('worker-1', ${TEST_REPO}, 'work', 'worker', 'sonnet', 'high', 'failed', 'not a lead', ${now()}, ${id})`
    await db.sql`
      INSERT INTO factory.issue_effects (issue_id, key, kind, payload, created_at, attempts, error)
      VALUES (${id}, 'finalize:c1', 'finalize', '{}', ${now()}, 3, 'git: worktree is dirty'),
             (${id}, 'start_lead:c2', 'start_lead', '{}', ${now()}, 2, 'still trying')`
    await notifyFailures(db.sql, now())
    const texts = Object.fromEntries((await rows()).map((r) => [r.key, r.text]))
    expect(texts['notify:failed:spawn:lead-1-1']).toBe(
      `Issue ${id} (repo) failed: its lead spawn failed for good “gave up: the 30 min retry budget is spent”`,
    )
    expect(texts['notify:failed:finalize:finalize:c1']).toBe(
      `Issue ${id} (repo) failed: its finalize failed “git: worktree is dirty”`,
    )
    expect(Object.keys(texts)).toHaveLength(2)

    await db.sql`INSERT INTO factory.door_routes (source, monitor, repo) VALUES ('kuma', 'forecast', ${join(TEST_ROOT, 'IuRoot', 'x')})`
    const refused = await intakeAlert(
      db.sql,
      { source: 'kuma', monitor: 'forecast', event: 'e1', status: 'down', title: 'Forecast down', facts: {} },
      { repoRoots: [TEST_ROOT], now: now() },
    ).catch((error: Error) => error)
    expect(refused).toBeInstanceOf(Error)
    const door = (await rows()).find((r) => r.key.startsWith('notify:failed:door:'))
    expect(door?.key).toBe('notify:failed:door:kuma:forecast:2026-11-02')
    expect(door?.text).toBe(
      'Factory failed: a kuma alert of monitor “forecast” was refused, so it files no Issue: “an alert files no Issue in IuRoot”',
    )
    // a second event of the same monitor the same day is one message
    await intakeAlert(
      db.sql,
      { source: 'kuma', monitor: 'forecast', event: 'e2', status: 'down', title: 'Forecast down', facts: {} },
      { repoRoots: [TEST_ROOT], now: now() },
    ).catch(() => {})
    expect((await rows()).filter((r) => r.key.startsWith('notify:failed:door:'))).toHaveLength(1)
  })

  test('a lead spawn that failed long after it was made is told, unless its Issue is closed', async () => {
    const id = await working()
    const closed = await working()
    await step(closed, 'close', { summary: 'ok', ...MERGED })
    const old = new Date(now().getTime() - 3 * 24 * 3600_000)
    await db.sql`
      INSERT INTO factory.spawns (key, repo, prompt, role, tier, effort, status, error, created_at, issue_id)
      VALUES ('lead-1-1', ${TEST_REPO}, 'brief', 'lead', 'opus', 'high', 'failed', 'x', ${old}, ${id}),
             ('lead-2-1', ${TEST_REPO}, 'brief', 'lead', 'opus', 'high', 'failed', 'x', ${old}, ${closed})`
    await notifyFailures(db.sql, now())
    expect(await keys()).toEqual(['notify:failed:spawn:lead-1-1'])
  })

  test('a replay records nothing', async () => {
    const id = await working()
    await step(id, 'ask', { question: 'q' })
    await db.sql`
      INSERT INTO factory.spawns (key, repo, prompt, role, tier, effort, status, error, created_at, issue_id)
      VALUES ('lead-1-1', ${TEST_REPO}, 'brief', 'lead', 'opus', 'high', 'failed', 'x', ${now()}, ${id})`
    await notifyFailures(db.sql, now())
    const before = await keys()
    expect(before).toHaveLength(2)
    // the same ask again (same inbox key), the same sweep, the same message
    await enqueue(db.sql, { issueId: id, key: `${id}:ask:${n}`, kind: 'ask', at: now(), payload: { question: 'q' } })
    await issuePass(db.sql, { now, ports: {} })
    await notifyFailures(db.sql, now())
    await notifyFailures(db.sql, now())
    expect(await keys()).toEqual(before)
    const [any] = await rows()
    expect(await record(db.sql, { key: any?.key ?? '', kind: 'test', issueId: null, text: 'again' }, now())).toBe(false)
    expect((await rows()).find((r) => r.key === any?.key)?.text).toBe(any?.text ?? '')
  })
})

describe('the text', () => {
  test('agent text is clipped to 200 characters, one line, and fenced', () => {
    const long = quote(`${'word '.repeat(100)}`)
    expect(long.startsWith('“word')).toBe(true)
    expect(long.endsWith('…”')).toBe(true)
    expect(long.length).toBeLessThanOrEqual(200 + 3)
    expect(quote('a\n\nb\tc\u0000d')).toBe('“a b c d”')
    expect(quote('say “hi” and "bye"')).toBe("“say 'hi' and 'bye'”")
  })

  test('a link loses its query and fragment, a path on this machine keeps its last part', () => {
    expect(redact('see https://example.com/pr/1?token=short-secret#frag and https://example.com/x')).toBe(
      'see https://example.com/pr/1 and https://example.com/x',
    )
    expect(redact('outside the roots: /Users/someone/SourceRoot/repo/src, ~/IuRoot/work and /etc, src/a.ts')).toBe(
      'outside the roots: …/src, …/work and /etc, src/a.ts',
    )
  })

  test('file links, unicode paths and links without a scheme are scrubbed too', () => {
    expect(redact('at file:///Users/alice/SourceRoot/repo and /Users/李明/repo/src')).toBe('at file://…/repo and …/src')
    expect(redact('open www.example.com/reset?token=short-secret now')).toBe('open www.example.com/reset now')
    expect(redact('see issue #12 and Fix #3')).toBe('see issue #12 and Fix #3')
  })

  test('no secrets and no hostnames', () => {
    const dirty =
      'Bearer abc123 token ghp_abcdefghijklmnop key sk-abcdefghijklmnop op://vault/item/field https://u:p4ss@example.com/x ' +
      'host box.tail1234.ts.net and 100.64.0.7 hash 0123456789abcdef0123456789abcdef0123'
    const clean = redact(dirty)
    for (const leak of ['abc123', 'ghp_', 'sk-abc', 'op://', 'p4ss', 'ts.net', '100.64', '0123456789abcdef'])
      expect(clean).not.toContain(leak)
  })
})

describe('the outbox', () => {
  const message = { key: 'notify:test:1', kind: 'test' as const, issueId: null, text: 'hello' }

  test('sends what is due, at most five per tick, oldest first, and records it', async () => {
    for (let i = 1; i <= 7; i++) {
      await record(db.sql, { ...message, key: `notify:test:${i}`, text: `m${i}` }, new Date(now().getTime() + i))
    }
    clock.advance(1000)
    const first = await sendDue(db.sql, { notifier, now })
    expect(first.sent).toHaveLength(5)
    expect(notifier.sent).toEqual(['m1', 'm2', 'm3', 'm4', 'm5'])
    expect((await sendDue(db.sql, { notifier, now })).sent).toHaveLength(2)
    expect((await sendDue(db.sql, { notifier, now })).sent).toHaveLength(0)
    expect((await listNotifications(db.sql, { pending: true })).length).toBe(0)
    expect((await rows()).every((r) => r.status === 'sent' && r.attempts === 1 && r.sentAt)).toBe(true)
  })

  test('a failing send is retried after a backoff and fails after five attempts, with a line in factory status', async () => {
    await record(db.sql, message, now())
    notifier.failWith('hermes send exited 1')
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      const result = await sendDue(db.sql, { notifier, now })
      expect(result.errors).toEqual(['notify:test:1: hermes send exited 1'])
      const [row] = await rows()
      expect(row?.attempts).toBe(attempt)
      expect(row?.status).toBe(attempt === MAX_ATTEMPTS ? 'failed' : 'pending')
      // not due again before its backoff
      if (attempt < MAX_ATTEMPTS) {
        expect((await sendDue(db.sql, { notifier, now })).errors).toEqual([])
        expect(notifier.calls).toBe(attempt)
        clock.advance(backoffMs(attempt))
      }
    }
    clock.advance(24 * 3600_000)
    expect((await sendDue(db.sql, { notifier, now })).errors).toEqual([])
    expect(notifier.calls).toBe(MAX_ATTEMPTS)
    expect(await notificationAttention(db.sql, new Date(now().getTime() - 20 * 3600_000))).toEqual([
      'notification notify:test:1 was not delivered: hermes send exited 1',
    ])
    const status = await buildStatus(db.sql, new Date(now().getTime() - 20 * 3600_000))
    expect(status.attention).toContain('notification notify:test:1 was not delivered: hermes send exited 1')
  })

  test('a send that fails and then recovers is sent once', async () => {
    await record(db.sql, message, now())
    notifier.failWith('timeout')
    await sendDue(db.sql, { notifier, now })
    notifier.recover()
    clock.advance(backoffMs(1))
    expect((await sendDue(db.sql, { notifier, now })).sent).toEqual(['notify:test:1'])
    const [row] = await rows()
    expect(row).toMatchObject({ status: 'sent', attempts: 2, error: null })
  })

  test('a notifier that throws is a failed send, not a failed tick', async () => {
    await record(db.sql, message, now())
    const throwing = {
      send: async () => {
        throw new Error('boom')
      },
    }
    const result = await sendDue(db.sql, { notifier: throwing, now })
    expect(result.errors).toEqual(['notify:test:1: boom'])
  })

  test('a crash between claim and record: not sent again while the lease runs, sent again when it ran out (at-least-once)', async () => {
    await record(db.sql, message, now())
    // the process died after the claim, perhaps after the send
    expect(await claim(db.sql, now(), 5)).toHaveLength(1)
    expect((await sendDue(db.sql, { notifier, now })).sent).toEqual([])
    clock.advance(LEASE_MS - 1)
    expect((await sendDue(db.sql, { notifier, now })).sent).toEqual([])
    clock.advance(2)
    expect((await sendDue(db.sql, { notifier, now })).sent).toEqual(['notify:test:1'])
    expect(notifier.sent).toEqual(['hello'])
    expect((await rows())[0]).toMatchObject({ status: 'sent', attempts: 2 })
  })

  test('crashes that spend every attempt end as failed, not as a send forever', async () => {
    await record(db.sql, message, now())
    for (let i = 0; i < MAX_ATTEMPTS; i++) {
      expect(await claim(db.sql, now(), 5)).toHaveLength(1)
      clock.advance(LEASE_MS + 1)
    }
    expect(await claim(db.sql, now(), 5)).toEqual([])
    expect((await rows())[0]).toMatchObject({ status: 'failed', error: 'the send did not report back' })
  })

  test('a delivery that arrives after the row was given up on is recorded as sent', async () => {
    await record(db.sql, message, now())
    const late = {
      send: async () => {
        // the attempts run out while this send hangs
        await db.sql`UPDATE factory.notifications SET failed_at = ${now()}, attempts = ${MAX_ATTEMPTS}`
        return { ok: true as const }
      },
    }
    await sendDue(db.sql, { notifier: late, now })
    expect((await rows())[0]).toMatchObject({ status: 'sent' })
  })

  test('a failure from a send that outlived its lease does not undo the newer attempt', async () => {
    await record(db.sql, message, now())
    const late = {
      send: async () => {
        // while this send hangs, its lease runs out and the next tick claims the row again
        clock.advance(LEASE_MS + 1)
        expect(await claim(db.sql, now(), 5)).toHaveLength(1)
        return { ok: false as const, error: 'late failure' }
      },
    }
    await sendDue(db.sql, { notifier: late, now })
    expect((await rows())[0]).toMatchObject({ status: 'pending', attempts: 2, error: null })
  })

  test('sendNow is claimed from the start: the tick cannot send it beside the caller', async () => {
    const slow = new FakeNotifier()
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const send = slow.send.bind(slow)
    slow.send = async (text) => {
      await gate
      return send(text)
    }
    const pending = sendNow(db.sql, message, { notifier: slow, now })
    await Bun.sleep(50)
    expect((await sendDue(db.sql, { notifier, now })).sent).toEqual([])
    release()
    expect(await pending).toEqual({ created: true, error: null })
    expect(slow.sent).toEqual(['hello'])
    expect(notifier.calls).toBe(0)
    expect((await rows())[0]).toMatchObject({ status: 'sent', attempts: 1 })
    expect((await sendNow(db.sql, message, { notifier: slow, now })).created).toBe(false)
  })

  test('two senders at once send a row once', async () => {
    await record(db.sql, message, now())
    await Promise.all([sendDue(db.sql, { notifier, now }), sendDue(db.sql, { notifier, now })])
    expect(notifier.sent).toEqual(['hello'])
  })

  test('with the target off the rows are counted as sent, with the reason', async () => {
    await record(db.sql, message, now())
    await sendDue(db.sql, { notifier: new NullNotifier(), now, note: 'notifications are off' })
    expect((await rows())[0]).toMatchObject({ status: 'sent', error: 'notifications are off' })
  })

  test('the pass: rules decide, the outbox sends, and a failure is an error line, not a throw', async () => {
    const id = await working()
    await step(id, 'ask', { question: 'q' })
    notifier.failWith('down')
    expect(await notifyPass(db.sql, deps(), now)).toEqual([`notify notify:ask:1: down`])
    notifier.recover()
    clock.advance(backoffMs(1))
    expect(await notifyPass(db.sql, deps(), now)).toEqual([])
    expect(notifier.sent).toHaveLength(1)
  })
})

describe('HermesNotifier', () => {
  let dir: string
  beforeAll(() => {
    dir = mkdtempSync('/tmp/factory-hermes-')
  })
  afterAll(() => rmSync(dir, { recursive: true, force: true }))

  const script = (name: string, body: string) => {
    const path = join(dir, name)
    writeFileSync(path, `#!/bin/sh\n${body}\n`)
    chmodSync(path, 0o755)
    return path
  }

  test('runs `hermes send --to <target> --quiet` with the text on stdin and no secrets in its environment', async () => {
    const out = join(dir, 'out.txt')
    process.env.FACTORY_TOKEN = 'must-not-reach-hermes-0000'
    const bin = script('ok', `echo "$@" > ${out}; cat >> ${out}; echo "token=$FACTORY_TOKEN" >> ${out}`)
    const result = await new HermesNotifier({ bin, target: 'slack:#agents' }).send('Issue 1 (repo) asks: “q”')
    delete process.env.FACTORY_TOKEN
    expect(result).toEqual({ ok: true })
    expect(readFileSync(out, 'utf8')).toBe('send --to slack:#agents --quiet\nIssue 1 (repo) asks: “q”token=\n')
  })

  test('a non-zero exit, a timeout and a missing binary are errors, never throws', async () => {
    const fail = script('fail', 'cat >/dev/null; exit 3')
    expect(await new HermesNotifier({ bin: fail, target: 't' }).send('x')).toEqual({
      ok: false,
      error: 'hermes send exited 3',
    })
    const slow = script('slow', 'sleep 5')
    expect(await new HermesNotifier({ bin: slow, target: 't', timeoutMs: 100 }).send('x')).toEqual({
      ok: false,
      error: 'hermes send timed out after 100 ms',
    })
    const missing = await new HermesNotifier({ bin: join(dir, 'nope'), target: 't' }).send('x')
    expect(missing.ok).toBe(false)
  })
})

describe('the digest', () => {
  const data: DigestData = {
    date: '2026-11-02',
    closed: [
      { id: 12, outcome: 'done', title: 'Fix the forecast' },
      { id: 13, outcome: 'dropped', title: 'Rename the "thing"' },
    ],
    watching: [{ id: 14, title: 'Cache the tiles' }],
    parked: [{ id: 15, reason: 'unreported' }],
    decisions: [{ issueId: 16, question: 'Ship it now or wait for the weekend?' }],
    failedSpawns: [{ key: 'lead-17-1', error: 'gave up: retry budget spent' }],
    quota: [
      { account: 'main', fiveHourUsed: 12.4, weeklyUsed: 40, fresh: true },
      { account: 'second', fiveHourUsed: null, weeklyUsed: 71.6, fresh: false },
    ],
    ran: { spawns: 9, started: 7, failed: 1, events: 230, sessions: 6, issueEvents: 41 },
  }

  test('golden', () => {
    expect(renderDigest(data)).toBe(
      [
        'Factory digest 2026-11-02',
        "Closed in 24 h: 2: #12 done “Fix the forecast”; #13 dropped “Rename the 'thing'”",
        'Shipped and watching: 1: #14 “Cache the tiles”',
        'Parked: 1: #15 unreported',
        'Decisions open: 1: #16 “Ship it now or wait for the weekend?”',
        'Failed spawns: 1: lead-17-1 “gave up: retry budget spent”',
        'Quota: main 5h 12% week 40%; second 5h ? week 72% (stale)',
        'Ran in 24 h: 9 spawns (7 started, 1 failed), 230 session events from 6 sessions, 41 Issue events',
      ].join('\n'),
    )
  })

  test('an empty day says so, and a huge one stays under 3000 characters', () => {
    const empty = renderDigest({
      ...data,
      closed: [],
      watching: [],
      parked: [],
      decisions: [],
      failedSpawns: [],
      quota: [],
      ran: { spawns: 0, started: 0, failed: 0, events: 0, sessions: 0, issueEvents: 0 },
    })
    expect(empty).toContain('Closed in 24 h: none')
    expect(empty).toContain('Quota: no reading')
    const many = Array.from({ length: 500 }, (_, i) => ({ id: i, outcome: 'done', title: 'x'.repeat(300) }))
    const big = renderDigest({ ...data, closed: many, watching: many, parked: [], decisions: [], failedSpawns: [] })
    expect(big.length).toBeLessThan(DIGEST_MAX_CHARS)
    expect(big).toContain('(+494 more)')
    const accounts = Array.from({ length: 12 }, (_, i) => ({
      account: `account-${i}-${'x'.repeat(60)}`,
      fiveHourUsed: 1,
      weeklyUsed: 2,
      fresh: true,
    }))
    const crowded = renderDigest({ ...data, closed: many, watching: many, quota: accounts })
    expect(crowded.length).toBeLessThan(DIGEST_MAX_CHARS)
    expect(crowded).toContain('(+4 more)')
    expect(crowded).toContain('Ran in 24 h:')
    expect(big).toContain('Quota:')
    expect(big).toContain('Ran in 24 h:')
  })

  test('due from 07:30 local until noon, in the zone, across the day and the clock change', () => {
    const due = (iso: string) => digestDue(new Date(iso), { at: '07:30', timeZone: 'Europe/Berlin' })
    expect(due('2026-11-02T06:29:00Z')).toBeNull() // 07:29 CET
    expect(due('2026-11-02T06:30:00Z')).toBe('2026-11-02')
    expect(due('2026-11-02T10:59:00Z')).toBe('2026-11-02') // 11:59
    expect(due('2026-11-02T11:00:00Z')).toBeNull() // 12:00
    expect(due('2026-11-02T22:59:00Z')).toBeNull() // 23:59
    expect(due('2026-11-02T23:00:00Z')).toBeNull() // 00:00 of the 3rd
    expect(due('2026-11-03T06:30:00Z')).toBe('2026-11-03')
    expect(due('2026-07-01T05:30:00Z')).toBe('2026-07-01') // 07:30 CEST
    expect(due('2026-07-01T06:30:00Z')).toBe('2026-07-01') // 08:30 CEST
    expect(localParts(new Date('2026-11-02T23:00:00Z'), 'Europe/Berlin')).toEqual({ date: '2026-11-03', time: '00:00' })
  })

  test('once per day: the boundary, a second tick, a restart, the next day, and a server that was down', async () => {
    const run = () => notifyDigest(db.sql, { now: now(), at: '07:30', timeZone: 'Europe/Berlin' })
    const digests = async () => (await keys()).filter((k) => k.startsWith('notify:digest:'))
    clock = new FakeClock(new Date('2026-11-02T06:29:00.000Z'))
    await run()
    expect(await digests()).toEqual([])
    clock.advance(60_000) // 07:30
    await run()
    expect(await digests()).toEqual(['notify:digest:2026-11-02'])
    clock.advance(5_000)
    await run() // the next tick
    await notifyDigest(db.sql, { now: now(), at: '07:30', timeZone: 'Europe/Berlin' }) // a restart
    expect(await digests()).toEqual(['notify:digest:2026-11-02'])
    clock.advance(24 * 3600_000)
    await run()
    expect(await digests()).toEqual(['notify:digest:2026-11-02', 'notify:digest:2026-11-03'])
    // down at 07:30, up at 11:59: sent at start; up at 12:00: the morning is over
    clock = new FakeClock(new Date('2026-11-04T10:59:00.000Z'))
    await run()
    expect(await digests()).toContain('notify:digest:2026-11-04')
    clock = new FakeClock(new Date('2026-11-05T11:00:00.000Z'))
    await run()
    expect(await digests()).not.toContain('notify:digest:2026-11-05')
    // switched off
    await notifyDigest(db.sql, { now: new Date('2026-11-06T07:00:00Z'), at: null, timeZone: 'Europe/Berlin' })
    expect(await digests()).not.toContain('notify:digest:2026-11-06')
  })

  test('it reads the day from the database', async () => {
    const id = await working()
    await step(id, 'ask', { question: 'ship?' })
    const done = await working()
    await step(done, 'close', { summary: 'ok', ...MERGED })
    await db.sql`INSERT INTO factory.quota_readings (account, read_at, enabled, auth_ok, five_hour_used, weekly_used) VALUES ('main', ${now()}, true, true, 10, 20)`
    const loaded = await loadDigest(db.sql, now(), '2026-11-02')
    expect(loaded.closed).toEqual([{ id: done, outcome: 'done', title: 'a title' }])
    expect(loaded.decisions).toEqual([{ issueId: id, question: 'ship?' }])
    expect(loaded.quota).toEqual([{ account: 'main', fiveHourUsed: 10, weeklyUsed: 20, fresh: true }])
    expect(loaded.ran.issueEvents).toBeGreaterThan(0)
    expect(renderDigest(loaded)).toContain(`Decisions open: 1: #${id} “ship?”`)
  })
})
