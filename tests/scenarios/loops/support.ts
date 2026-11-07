import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { LoopList, LoopRunReply } from '@software-factory/contract'
import { admitted, block, fileIssue, tick } from '../flow.ts'
import { type Lab } from '../planning/lab.ts'

/** A call the fake agw saw: the workflow, and the input it was given. */
export interface AgwCall {
  workflow: string
  args: string[]
  input: Record<string, unknown>
}

export const callsOf = async (lab: Lab, workflow: string): Promise<AgwCall[]> => {
  const lines = (await readFile(join(lab.world.bin, 'calls.jsonl'), 'utf8')).split('\n').filter(Boolean)
  return lines
    .map((line) => JSON.parse(line) as { tool: string; args: string[]; stdin?: string })
    .filter((call) => call.args[0] === workflow)
    .map((call) => ({ workflow, args: call.args, input: JSON.parse(call.stdin ?? '{}') as Record<string, unknown> }))
}

export const state = async (
  lab: Lab,
  issue: string,
): Promise<{ state: string; wait: string | null; version: number }> => {
  const [row] = await lab.world.db.sql`SELECT state, wait_reason, version FROM factory.issues WHERE id = ${issue}`
  return {
    state: row.state as string,
    wait: (row.wait_reason as string | null) ?? null,
    version: row.version as number,
  }
}

/** The kinds and actors of an Issue's applied events, oldest first. */
export const eventsOf = async (lab: Lab, issue: string): Promise<{ kind: string; actor: string }[]> => {
  const rows = await lab.world.db
    .sql`SELECT kind, actor FROM factory.issue_events WHERE issue_id = ${issue} AND result = 'applied' ORDER BY version`
  return rows.map((row: { kind: string; actor: string }) => ({ kind: row.kind, actor: row.actor }))
}

/** An Issue with its lead working on attempt 1: filed, settled, admitted and started the way the factory does it. */
export async function working(lab: Lab, repo: string, title: string): Promise<string> {
  const issue = await fileIssue(lab, { repo, title })
  await admitted(lab, issue)
  await tick(lab)
  return issue
}

/** The lead reports it is blocked: a stall the steward's rules cannot read. */
export async function blocked(lab: Lab, repo: string, title: string, detail: string): Promise<string> {
  const issue = await working(lab, repo, title)
  await block(lab, issue, detail)
  return issue
}

export const runLoop = async (lab: Lab, name: string) => {
  const result = await lab.cli(['loop', 'run', name])
  if (result.code !== 0) throw new Error(`loop run ${name} exited ${result.code}: ${result.err}${result.out}`)
  return LoopRunReply.parse(result.json)
}

export const loops = async (lab: Lab) => {
  const result = await lab.cli(['loop', 'list'])
  if (result.code !== 0) throw new Error(`loop list exited ${result.code}: ${result.err}`)
  return LoopList.parse(result.json).loops
}

/** Replaces a fake's script file; the fake reads it at every call. */
export const script = (path: string, entries: unknown[]) => writeFile(path, JSON.stringify(entries))
