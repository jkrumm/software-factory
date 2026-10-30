// A stand-in for the herdr 0.9.3 CLI: the subcommands the runner uses, answering with the shapes the real one prints
// (taken from a live session). State lives in $FAKE_HERDR_DIR/state.json; calls are serialised by a lock directory.
// Faults come from the plan, one entry per call, consumed in order: "<command>:<fault>".
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

interface State {
  seq: number
  workspaces: { workspace_id: string; label: string }[]
  tabs: { tab_id: string; workspace_id: string; label: string }[]
  panes: { pane_id: string; tab_id: string; cwd: string; env: string[] }[]
  agents: {
    name: string
    pane_id: string
    agent: 'claude'
    agent_status: string
    state_change_seq: number
    completion_seq?: number
    interactive_ready: boolean
    launch_pending?: boolean
    argv: string[]
  }[]
  prompts: { pane: string; text: string }[]
  calls: string[]
  plan: string[]
}

const dir = process.env.FAKE_HERDR_DIR as string
const file = join(dir, 'state.json')
const lock = join(dir, 'lock')

function acquire(): void {
  for (;;) {
    try {
      mkdirSync(lock)
      return
    } catch {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5)
    }
  }
}

const args = process.argv.slice(2)
acquire()
process.on('exit', () => rmSync(lock, { recursive: true, force: true }))
const state: State = JSON.parse(readFileSync(file, 'utf8'))
const save = () => writeFileSync(file, JSON.stringify(state))

const command = args.slice(0, 2).join(' ')
state.calls.push(args.join(' '))

const planned = state.plan.findIndex((entry) => entry.startsWith(`${command}:`))
const fault = planned >= 0 ? (state.plan.splice(planned, 1)[0] as string).slice(command.length + 1) : ''
save()

const print = (result: unknown) => {
  process.stdout.write(`${JSON.stringify({ id: `cli:${args[0]}:${args[1]}`, result })}\n`)
  process.exit(0)
}
const fail = (code: string, message: string, exit = 1) => {
  process.stdout.write(`${JSON.stringify({ error: { code, message }, id: `cli:${args[0]}:${args[1]}` })}\n`)
  process.exit(exit)
}

if (fault === 'hang') {
  // A killed process never runs its exit handler: give the lock back before hanging.
  rmSync(lock, { recursive: true, force: true })
  Bun.sleepSync(60_000)
  process.exit(0)
}
if (fault === 'exit1') process.exit(1)
if (fault === 'garbage') {
  process.stdout.write('herdr 0.9.3 (banner, not json)\n')
  process.exit(0)
}

const opt = (name: string): string | undefined => {
  const at = args.indexOf(name)
  return at >= 0 ? args[at + 1] : undefined
}
const opts = (name: string): string[] => args.flatMap((a, i) => (a === name ? [args[i + 1] as string] : []))
const next = (prefix: string) => `${prefix}${++state.seq}`

const tabInfo = (t: State['tabs'][number]) => ({
  ...t,
  agent_status: 'unknown',
  focused: false,
  number: 1,
  pane_count: 1,
})
const agentInfo = (a: State['agents'][number]) => {
  const pane = state.panes.find((p) => p.pane_id === a.pane_id)
  const { argv: _argv, ...rest } = a
  return { ...rest, cwd: pane?.cwd, tab_id: pane?.tab_id, workspace_id: pane?.pane_id.split(':')[0] }
}
const findAgent = (target: string) => state.agents.find((a) => a.name === target || a.pane_id === target)

function createPane(workspaceId: string, tabId: string): { pane_id: string; tab_id: string; workspace_id: string } {
  const pane_id = `${workspaceId}:p${++state.seq}`
  state.panes.push({ pane_id, tab_id: tabId, cwd: opt('--cwd') ?? '', env: opts('--env') })
  return { pane_id, tab_id: tabId, workspace_id: workspaceId }
}

switch (command) {
  case 'workspace list':
    print({ type: 'workspace_list', workspaces: state.workspaces })
    break
  case 'workspace create': {
    const workspace_id = next('w')
    state.workspaces.push({ workspace_id, label: opt('--label') ?? '' })
    const tab_id = `${workspace_id}:t1`
    state.tabs.push({ tab_id, workspace_id, label: '1' })
    const root_pane = createPane(workspace_id, tab_id)
    save()
    print({ type: 'workspace_created', root_pane, tab: state.tabs.at(-1), workspace: state.workspaces.at(-1) })
    break
  }
  case 'workspace close': {
    const id = args[2]
    const tabIds = state.tabs.filter((t) => t.workspace_id === id).map((t) => t.tab_id)
    state.workspaces = state.workspaces.filter((w) => w.workspace_id !== id)
    state.tabs = state.tabs.filter((t) => t.workspace_id !== id)
    state.panes = state.panes.filter((p) => !tabIds.includes(p.tab_id))
    state.agents = state.agents.filter((a) => state.panes.some((p) => p.pane_id === a.pane_id))
    save()
    print({ type: 'ok' })
    break
  }
  case 'tab list': {
    const only = opt('--workspace')
    print({ tabs: state.tabs.filter((t) => !only || t.workspace_id === only).map(tabInfo) })
    break
  }
  case 'tab create': {
    const workspace_id = opt('--workspace') as string
    if (!state.workspaces.some((w) => w.workspace_id === workspace_id))
      fail('workspace_not_found', `workspace ${workspace_id} not found`)
    const tab_id = `${workspace_id}:t${++state.seq}`
    state.tabs.push({ tab_id, workspace_id, label: opt('--label') ?? '' })
    const root_pane = createPane(workspace_id, tab_id)
    save()
    print({ type: 'tab_created', root_pane, tab: state.tabs.at(-1) })
    break
  }
  case 'tab rename': {
    const tab = state.tabs.find((t) => t.tab_id === args[2])
    if (!tab) fail('tab_not_found', `tab ${args[2]} not found`)
    else {
      tab.label = args[3] as string
      save()
      print({ type: 'tab_info', tab: tabInfo(tab) })
    }
    break
  }
  case 'tab close': {
    const id = args[2]
    const paneIds = state.panes.filter((p) => p.tab_id === id).map((p) => p.pane_id)
    state.tabs = state.tabs.filter((t) => t.tab_id !== id)
    state.panes = state.panes.filter((p) => p.tab_id !== id)
    state.agents = state.agents.filter((a) => !paneIds.includes(a.pane_id))
    save()
    print({ type: 'ok' })
    break
  }
  case 'pane list':
    print({
      panes: state.panes.map((p) => ({
        pane_id: p.pane_id,
        tab_id: p.tab_id,
        workspace_id: state.tabs.find((t) => t.tab_id === p.tab_id)?.workspace_id,
        cwd: p.cwd,
        agent_status: 'unknown',
      })),
    })
    break
  case 'agent list':
    print({ agents: state.agents.map(agentInfo) })
    break
  case 'agent get': {
    const agent = findAgent(args[2] as string)
    if (!agent || fault === 'unreadable') fail('agent_not_found', `agent target ${args[2]} not found`)
    else print({ type: 'agent_info', agent: agentInfo(agent) })
    break
  }
  case 'agent start': {
    const pane = args[args.indexOf('--pane') + 1] as string
    if (fault === 'busy') fail('agent_pane_busy', `pane ${pane} is busy`)
    if (state.agents.some((a) => a.pane_id === pane)) fail('agent_pane_busy', `pane ${pane} already has an agent`)
    const ready = fault !== 'notready'
    const agent = {
      name: args[2] as string,
      pane_id: pane,
      agent: 'claude' as const,
      agent_status: ready ? 'idle' : 'blocked',
      state_change_seq: ++state.seq,
      interactive_ready: ready,
      ...(ready ? {} : { launch_pending: true }),
      argv: ['claude', ...args.slice(args.indexOf('--') + 1)],
    }
    state.agents.push(agent)
    save()
    if (!ready) fail('agent_not_ready', `agent ${agent.name} is blocked during startup and is not ready for prompts`)
    print({ type: 'agent_started', agent: agentInfo(agent), argv: agent.argv })
    break
  }
  case 'agent prompt': {
    const agent = findAgent(args[2] as string)
    if (!agent) fail('agent_not_found', `agent target ${args[2]} not found`)
    else if (fault === 'error') fail('agent_blocked', 'agent is blocked', 0)
    else {
      state.prompts.push({ pane: agent.pane_id, text: args[3] as string })
      // `drop` is the measured failure: herdr accepts the text and the agent never reacts to it.
      if (fault !== 'drop') {
        agent.agent_status = 'working'
        agent.state_change_seq = ++state.seq
      }
      save()
      print({ type: 'agent_prompted', agent: agentInfo(agent) })
    }
    break
  }
  default:
    process.stderr.write(`fake herdr: unsupported ${args.join(' ')}\n`)
    process.exit(64)
}
