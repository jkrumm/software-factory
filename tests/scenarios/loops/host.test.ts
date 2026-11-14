import { afterAll, beforeAll, expect, test } from 'bun:test'
import { QueueOrder } from '@software-factory/contract'
import { fileIssue, settle } from '../flow.ts'
import { setProcesses } from '../host.ts'
import { type Lab, startLab } from '../planning/lab.ts'
import { runLoop, working } from './support.ts'

/**
 * The host loop against the real server and Postgres with a fake `ps` and `lsof`: the minute sample carries the capacity
 * facts (read from the same lab's claims and queue), and a started lead's process tree is costed by its worktree.
 */
let lab: Lab

beforeAll(async () => {
  lab = await startLab({
    leads: true,
    repos: { app: { project: 'apiVersion: factory/v2\nname: app\nleads: 8\n' } },
    env: { FACTORY_LEADS_PER_ACCOUNT: '16', FACTORY_LOAD_CEILING: '7' },
  })
  expect((await lab.cli(['project', 'sync'])).code).toBe(0)
})

afterAll(async () => {
  await lab.stop()
})

const sql = () => lab.world.db.sql

test('a lead is costed by its process tree and the minute carries the capacity facts', async () => {
  const lead = await working(lab, 'app', 'the lead whose processes are sampled')
  const waiting = await fileIssue(lab, { repo: 'app', title: 'queued behind the lead' })
  await settle(lab, waiting, [lead])
  const [attempt] = await sql()`SELECT worktree_path FROM factory.lead_attempts WHERE issue_id = ${lead}`
  const worktree = attempt?.worktree_path as string
  expect(worktree).toContain('.claude/worktrees/')
  await setProcesses(lab.world.bin, [
    {
      pid: 5001,
      ppid: 1,
      rssKib: 2 * 1024 * 1024,
      footprintKib: 1024 * 1024,
      cwd: worktree,
      command: '/Applications/Claude Code.app/claude',
    },
    {
      pid: 5002,
      ppid: 5001,
      rssKib: 1024 * 1024,
      footprintKib: 256 * 1024,
      cwd: '/tmp/some-browser-profile',
      command: '/opt/chrome',
    },
    { pid: 5003, ppid: 1, rssKib: 512 * 1024, cwd: '/tmp/not-a-lead' },
  ])

  const ran = await runLoop(lab, 'host')
  expect(ran.error).toBeNull()
  expect(ran.summary).toContain('1 lead row(s)')
  // the class snapshot: top lists the lead's two processes (the third has no footprint), both classed as the lead's
  expect(ran.summary).toContain('1 class row(s)')
  const classes = await sql()`
    SELECT class, repo, issue, footprint_mib, procs FROM factory.host_class_samples
    WHERE at = (SELECT max(at) FROM factory.host_class_samples)`
  expect(classes).toEqual([
    { class: 'lead', repo: 'app', issue: Number(lead.slice('issue_'.length)), footprint_mib: 1280, procs: 2 },
  ])
  const [signals] = await sql()`SELECT processes FROM factory.host_samples ORDER BY at DESC LIMIT 1`
  expect(signals).toEqual({ processes: 10 })

  const rows =
    await sql()`SELECT worktree, repo, issue, attempt, rss_mib, footprint_mib, procs FROM factory.lead_samples`
  expect(rows).toEqual([
    {
      worktree,
      repo: 'app',
      issue: Number(lead.slice('issue_'.length)),
      attempt: 1,
      rss_mib: 3072,
      footprint_mib: 1280,
      procs: 2,
    },
  ])

  const [claims] = await sql()`SELECT count(*)::int AS n FROM factory.capacity_claims`
  const queue = QueueOrder.parse((await lab.cli(['queue', 'order'])).json).queue
  expect(queue.length).toBeGreaterThanOrEqual(1)
  const [sample] =
    await sql()`SELECT leads, queued, seats, load_ceiling FROM factory.host_samples ORDER BY at DESC LIMIT 1`
  expect(sample).toEqual({ leads: claims?.n, queued: queue.length, seats: 16, load_ceiling: 7 })
  expect(claims?.n).toBeGreaterThanOrEqual(1)
})

test('a process table that cannot be read still records the host sample, and the pass says so', async () => {
  await setProcesses(lab.world.bin, [], { lsofFails: true })
  const before = await sql()`SELECT count(*)::int AS n FROM factory.lead_samples`
  const ran = await runLoop(lab, 'host')
  expect(ran.error).toBeNull()
  expect(ran.summary).toContain('no lead rows')
  expect(await sql()`SELECT count(*)::int AS n FROM factory.lead_samples`).toEqual(before)
  const [latest] = await sql()`SELECT seats FROM factory.host_samples ORDER BY at DESC LIMIT 1`
  expect(latest?.seats).toBe(16)
})
