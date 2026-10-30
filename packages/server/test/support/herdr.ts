import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const FAKE = join(import.meta.dir, 'fake-herdr.ts')

export interface FakeState {
  workspaces: { workspace_id: string; label: string }[]
  tabs: { tab_id: string; workspace_id: string; label: string }[]
  panes: { pane_id: string; tab_id: string; cwd: string; env: string[] }[]
  agents: { name: string; pane_id: string; agent_status: string; interactive_ready: boolean; argv: string[] }[]
  prompts: { pane: string; text: string }[]
  calls: string[]
}

export interface FakeHerdr {
  /** value for `HERDR_BIN` */
  bin: string
  /** a `claude-pretrust.sh` stand-in: logs its arguments, exits `pretrustExit` */
  pretrustBin: string
  /** an account registry with `a` (the default account) and `b` (a config directory) */
  accountsFile: string
  /** faults for the next calls, `"<command>:<fault>"` (`tab list:hang`, `agent prompt:drop`, `agent start:busy`, ...), each used once */
  plan(...faults: string[]): Promise<void>
  state(): Promise<FakeState>
  /** every herdr call so far, as its arguments */
  calls(): Promise<string[]>
  pretrustCalls(): Promise<string[]>
  setPretrustExit(code: number): Promise<void>
  /** forgets everything */
  reset(): Promise<void>
  cleanup(): Promise<void>
}

const EMPTY = {
  seq: 100,
  workspaces: [],
  tabs: [],
  panes: [],
  agents: [],
  prompts: [],
  calls: [],
  plan: [],
}

/** A stand-in for the herdr binary (see fake-herdr.ts): keeps tabs, panes and agents, and fails on demand. */
export async function createFakeHerdr(): Promise<FakeHerdr> {
  const dir = await mkdtemp('/tmp/factory-herdr-')
  const bin = join(dir, 'herdr')
  await writeFile(bin, `#!/bin/sh\nFAKE_HERDR_DIR='${dir}' exec bun '${FAKE}' "$@"\n`)
  await chmod(bin, 0o755)
  const pretrustBin = join(dir, 'pretrust.sh')
  await writeFile(
    pretrustBin,
    `#!/bin/sh\necho "$@" >> '${dir}/pretrust-calls'\nexit "$(cat '${dir}/pretrust-exit')"\n`,
  )
  await chmod(pretrustBin, 0o755)
  const accountsFile = join(dir, 'accounts.json')
  await writeFile(accountsFile, JSON.stringify({ accounts: { a: { dir: null }, b: { dir: '~/.claude-b' } } }))

  const read = async (): Promise<FakeState & { plan: string[] }> =>
    JSON.parse(await readFile(join(dir, 'state.json'), 'utf8'))
  const reset = async () => {
    await writeFile(join(dir, 'state.json'), JSON.stringify(EMPTY))
    await writeFile(join(dir, 'pretrust-calls'), '')
    await writeFile(join(dir, 'pretrust-exit'), '0')
  }
  await reset()

  return {
    bin,
    pretrustBin,
    accountsFile,
    plan: async (...faults) => {
      const state = await read()
      await writeFile(join(dir, 'state.json'), JSON.stringify({ ...state, plan: faults }))
    },
    state: read,
    calls: async () => (await read()).calls,
    pretrustCalls: async () => (await readFile(join(dir, 'pretrust-calls'), 'utf8')).split('\n').filter(Boolean),
    setPretrustExit: (code) => writeFile(join(dir, 'pretrust-exit'), String(code)),
    reset,
    cleanup: () => rm(dir, { recursive: true, force: true }),
  }
}
