import { expect, test } from 'bun:test'
import {
  assignClasses,
  classRows,
  cpuSince,
  emptySnapshotMemory,
  notableProcs,
  remember,
  type SnapshotProc,
  stepName,
} from '../../src/domains/capacity/classes.ts'
import {
  exeOf,
  joinSnapshot,
  limaInstance,
  parseCommandPs,
  parseLaunchctl,
  parseLsofInstances,
} from '../../src/adapters/planning/snapshot.ts'
import { parseTop, parseTopTime } from '../../src/adapters/planning/top.ts'

// `top -l 1 -n 5000 -stats pid,ppid,mem,time` of the mini (2026-11-14, trimmed)
const TOP = `Processes: 763 total, 6 running, 757 sleeping, 5325 threads
2026/11/14 00:29:34
Load Avg: 16.33, 16.51, 15.61
CPU usage: 39.40% user, 24.36% sys, 36.22% idle
PhysMem: 31G used (2408M wired, 9492M compressor), 516M unused.

PID    PPID  MEM   TIME
10220  1     6161M 86:11.58
0      0     4512K 66:24.72
3423   776   3135M+ 00:03.41
7079   1     321M  101:02:03
bad    line
`

test('top: the header counts and per pid the parent, footprint and CPU time; the two-column form still parses', () => {
  const snapshot = parseTop(TOP)
  expect(snapshot.processes).toBe(763)
  expect(snapshot.cpuIdlePct).toBe(36.22)
  expect([...snapshot.rows]).toEqual([
    [10220, { ppid: 1, kib: 6161 * 1024, cpuMs: (86 * 60 + 11) * 1000 + 580 }],
    [0, { ppid: 0, kib: 4512, cpuMs: (66 * 60 + 24) * 1000 + 720 }],
    [3423, { ppid: 776, kib: 3135 * 1024, cpuMs: 3410 }],
    [7079, { ppid: 1, kib: 321 * 1024, cpuMs: (101 * 3600 + 2 * 60 + 3) * 1000 }],
  ])
  expect([...parseTop('PID MEM\n5  10M\n').rows]).toEqual([[5, { ppid: null, kib: 10 * 1024, cpuMs: null }]])
  expect(parseTopTime('1:2.3')).toBeNull()
})

const PS = [
  '    1     0 root             /sbin/launchd',
  '  463     1 me               /Applications/Google Chrome.app/Contents/MacOS/Google Chrome --flag',
  '  645   475 me               /Applications/Obsidian.app/Contents/Frameworks/Obsidian Helper (Renderer).app/Contents/MacOS/Obsidian Helper (Renderer) --type=renderer',
  '10220     1 me               /System/Library/Frameworks/Virtualization.framework/Versions/A/XPCServices/com.apple.Virtualization.VirtualMachine.xpc/Contents/MacOS/com.apple.Virtualization.VirtualMachine',
  '12766     1 me               ssh: /home/me/.colima/_lima/colima/ssh.sock [mux]',
  ' 7054     1 me               /opt/homebrew/bin/limactl usernet -p /home/me/.colima/_lima/_networks/user-v2/usernet.pid',
  '20621 84685 me               bun /home/me/.local/bin/factory slot run --name factory-1009-1 layout -- sh -c bun run test:layout FACTORY_SESSION=lead-1009-1 HOME=/home/me',
  '20622 20621 me               sh -c bun run test:layout FACTORY_SLOT_ACTIVE=1 FACTORY_SESSION=lead-1009-1',
  '33013   888 me               claude --model sonnet # inside a slot (`factory slot run -- <command>`) and more FACTORY_SESSION=lead-1044-1',
  '69768 69761 me               /usr/local/bin/factory slot run -- make check',
].join('\n')

test('ps -E: user, executable (a bundle keeps its spaces), session, slot holder and name, slot child, Lima instance', () => {
  const facts = parseCommandPs(PS)
  expect(facts.get(1)).toMatchObject({ user: 'root', exe: '/sbin/launchd', name: 'launchd', session: null, slot: null })
  expect(facts.get(463)?.name).toBe('Google Chrome')
  expect(facts.get(645)?.name).toBe('Obsidian Helper (Renderer)')
  expect(facts.get(10220)?.name).toBe('com.apple.Virtualization.VirtualMachine')
  expect(facts.get(12766)?.vm).toBe('colima')
  expect(facts.get(7054)?.vm).toBe('network')
  expect(facts.get(20621)).toMatchObject({ slot: 'factory-1009-1 layout', session: 'lead-1009-1', slotActive: false })
  expect(facts.get(20622)).toMatchObject({ slot: null, slotActive: true })
  // a prompt that quotes the command is not a holder
  expect(facts.get(33013)).toMatchObject({ name: 'claude', slot: null, session: 'lead-1044-1' })
  expect(facts.get(69768)?.slot).toBe('')
  expect(exeOf('/Applications/X.app/Contents/MacOS/X')).toBe('/Applications/X.app/Contents/MacOS/X')
  expect(limaInstance('/home/me/.colima/_lima/colima-teamchat/diffdisk')).toBe('colima-teamchat')
  expect(limaInstance('/tmp/x')).toBeNull()
})

test('launchctl and lsof: the label of each running job; the Lima instance of each VM process', () => {
  const labels = parseLaunchctl(
    'PID\tStatus\tLabel\n728\t0\tcom.example.dashboard\n-\t0\tcom.example.idle\n463\t0\tapplication.com.google.Chrome.1\n',
  )
  expect([...labels]).toEqual([
    [728, 'com.example.dashboard'],
    [463, 'application.com.google.Chrome.1'],
  ])
  const instances = parseLsofInstances(
    'p10220\nn/home/me/.colima/_lima/colima/vz-efi\nn/home/me/.colima/_lima/_disks/colima/datadisk\np13555\nn/dev/null\nn/home/me/.colima/_lima/colima-teamchat/disk\n',
  )
  expect([...instances]).toEqual([
    [10220, 'colima'],
    [13555, 'colima-teamchat'],
  ])
})

test('joinSnapshot: top decides the process list; ps, labels, directories and VM names join by pid', () => {
  const procs = joinSnapshot({
    top: parseTop(TOP),
    commands: parseCommandPs(PS),
    labels: new Map([[7079, 'com.example.worker']]),
    cwds: new Map([[3423, '/data']]),
    vms: new Map([[10220, 'colima']]),
  })
  expect(procs.map((p) => [p.pid, p.name, p.user, p.label, p.vm, p.cwd])).toEqual([
    [10220, 'com.apple.Virtualization.VirtualMachine', 'me', null, 'colima', null],
    [0, 'kernel_task', null, null, null, null],
    [3423, '?', null, null, null, '/data'],
    [7079, '?', null, 'com.example.worker', null, null],
  ])
  expect(procs[2]?.ppid).toBe(776)
})

const p = (pid: number, ppid: number, extra: Partial<SnapshotProc> = {}): SnapshotProc => ({
  pid,
  ppid,
  footprintKib: 1024,
  cpuMs: 0,
  name: `p${pid}`,
  user: 'me',
  exe: `/opt/bin/p${pid}`,
  label: null,
  session: null,
  slot: null,
  slotActive: false,
  vm: null,
  cwd: null,
  ...extra,
})

test('assignClasses: every class by its first rule', () => {
  const worktree = '/src/app/.claude/worktrees/factory-5-2'
  const procs = [
    p(0, 0, { user: null, exe: null, name: 'kernel_task' }),
    p(1, 0, { user: 'root', exe: '/sbin/launchd' }),
    // the owner's terminals: an unlabelled app bundle; a lead and an owner session under it
    p(10, 1, { exe: '/home/me/Herdr Core.app/Contents/MacOS/herdr-core' }),
    p(11, 10, { cwd: worktree }),
    p(12, 11, { cwd: '/tmp' }),
    p(13, 10, { cwd: '/src/app' }),
    // a browser the lead launched, reparented to launchd, found by its session
    p(14, 1, { session: 'lead-5-2' }),
    p(15, 14),
    // a session of an attempt the list does not know keeps its Issue
    p(16, 1, { session: 'lead-77-1' }),
    // a slot run under the lead; a slot child whose holder is gone
    p(20, 11, { slot: 'factory-5-2 bun test' }),
    p(21, 20, { slotActive: true }),
    p(22, 1, { slotActive: true }),
    // Lima: the VM, its network helper, a child of the helper
    p(30, 1, { vm: 'colima', exe: '/System/Library/Frameworks/Virtualization.framework/x' }),
    p(31, 1, { vm: 'network' }),
    p(32, 31),
    // jobs: a labelled agent and its child, an app, an Apple agent, a user agent under /System, root, an orphan
    p(40, 1, { label: 'com.example.worker' }),
    p(41, 40),
    p(42, 1, {
      label: 'application.com.google.Chrome.1',
      exe: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    }),
    p(43, 1, { label: 'com.apple.cloudphotod' }),
    p(44, 1, { exe: '/System/Library/PrivateFrameworks/x/mdworker_shared' }),
    p(45, 1, { user: '_windowserver' }),
    p(46, 1),
    // the factory: the server's job, and a job working in its release
    p(50, 1, { label: 'com.example.factory' }),
    p(51, 50),
    p(52, 1, { label: 'com.example.door' }),
    p(53, 52, { cwd: '/home/me/.factory/releases/abc' }),
    // a labelled job running an app bundle is still a tenant
    p(60, 1, {
      label: 'com.example.research-chrome',
      exe: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    }),
  ]
  const classed = assignClasses({
    procs,
    worktrees: [{ path: worktree, repo: 'app', issue: 5, attempt: 2 }],
    selfPid: 51,
    factoryDirs: ['/home/me/.factory/releases/abc'],
    cpuSince: new Map(),
  })
  const by = new Map(classed.map((c) => [c.pid, [c.class, c.repo ?? c.tenant, c.issue, c.step]]))
  expect(Object.fromEntries(by)).toEqual({
    0: ['system', null, null, null],
    1: ['system', null, null, null],
    10: ['owner', null, null, null],
    11: ['lead', 'app', 5, null],
    12: ['lead', 'app', 5, null],
    13: ['owner', null, null, null],
    14: ['lead', 'app', 5, null],
    15: ['lead', 'app', 5, null],
    16: ['lead', null, 77, null],
    20: ['step', 'app', 5, 'bun test'],
    21: ['step', 'app', 5, 'bun test'],
    22: ['step', null, null, null],
    30: ['tenant', 'vm:colima', null, null],
    31: ['tenant', 'vm:network', null, null],
    32: ['tenant', 'vm:network', null, null],
    40: ['tenant', 'com.example.worker', null, null],
    41: ['tenant', 'com.example.worker', null, null],
    42: ['owner', null, null, null],
    43: ['system', null, null, null],
    44: ['system', null, null, null],
    45: ['system', null, null, null],
    46: ['other', null, null, null],
    50: ['factory', null, null, null],
    51: ['factory', null, null, null],
    52: ['factory', null, null, null],
    53: ['factory', null, null, null],
    60: ['tenant', 'com.example.research-chrome', null, null],
  })
  // the rows sum every process once
  const rows = classRows(classed)
  expect(rows.reduce((sum, row) => sum + row.procs, 0)).toBe(procs.length)
  expect(rows.find((row) => row.class === 'lead' && row.issue === 5)).toMatchObject({ footprintMib: 4, procs: 4 })
  expect(stepName('factory-12-3 make check')).toBe('make check')
})

test('cpuSince, remember and notableProcs: differences, reused pids, the growth window, the largest fifteen', () => {
  const first = [p(1, 0, { cpuMs: 1000 }), p(2, 1, { cpuMs: 5000 })]
  expect([...cpuSince(first, emptySnapshotMemory())]).toEqual([
    [1, null],
    [2, null],
  ])
  const t0 = 1_000_000
  const memory = remember(first, emptySnapshotMemory(), t0)
  // pid 2 was reused (its time went down), pid 3 is new
  const second = [p(1, 0, { cpuMs: 1600 }), p(2, 1, { cpuMs: 200 }), p(3, 1, { cpuMs: 300 })]
  expect([...cpuSince(second, memory)]).toEqual([
    [1, 600],
    [2, 200],
    [3, 300],
  ])

  const grow = (kib: number) => [p(7, 1, { footprintKib: kib })]
  let m = remember(grow(100 * 1024), emptySnapshotMemory(), t0)
  m = remember(grow(150 * 1024), m, t0 + 5 * 60_000)
  const classed = (kib: number) =>
    assignClasses({ procs: grow(kib), worktrees: [], selfPid: 99, factoryDirs: [], cpuSince: new Map() })
  // 9 min after the first reading: grown by 200 MiB from it
  expect(notableProcs(classed(300 * 1024), m, t0 + 9 * 60_000)[0]).toMatchObject({ why: 'growth', grownMib: 200 })
  // 11 min after: the first reading left the window, the growth from 150 MiB is under 200
  expect(notableProcs(classed(300 * 1024), m, t0 + 11 * 60_000)[0]).toMatchObject({ why: 'top', grownMib: null })
  expect(notableProcs(classed(1024 * 1024), m, t0 + 11 * 60_000)[0]).toMatchObject({ why: 'growth' })
  expect(notableProcs(classed(1100 * 1024), emptySnapshotMemory(), t0)[0]).toMatchObject({ why: 'large' })

  const many = Array.from({ length: 20 }, (_, i) => p(100 + i, 1, { footprintKib: (i + 1) * 1024 }))
  const notable = notableProcs(
    assignClasses({ procs: many, worktrees: [], selfPid: 99, factoryDirs: [], cpuSince: new Map() }),
    emptySnapshotMemory(),
    t0,
  )
  expect(notable).toHaveLength(15)
  expect(notable[0]?.pid).toBe(119)
  // a remembered pid keeps only the readings within ten minutes
  expect(remember(grow(1), m, t0 + 16 * 60_000).sizes.get(7)).toEqual([{ at: t0 + 16 * 60_000, kib: 1 }])
})
