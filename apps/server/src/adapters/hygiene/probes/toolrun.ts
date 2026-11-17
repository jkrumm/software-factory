import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { childEnv, type ProcessResult } from '../../hc/process.ts'
import { exec } from '../git.ts'

/** Whether `tool` (a PATH name or a path) names an executable in the PATH the probes' children get (`childEnv`). */
export function installed(tool: string): boolean {
  return Bun.which(tool, { PATH: childEnv().PATH ?? '' }) !== null
}

/** `exec`, with the tool's stderr kept apart from its stdout (a JSON document) and returned whole. */
export async function execKeepingStderr(
  cmd: string[],
  timeoutMs: number,
  cwd: string,
): Promise<ProcessResult & { stderr: string }> {
  const dir = mkdtempSync(join(tmpdir(), 'hygiene-tool-'))
  const errFile = join(dir, 'stderr')
  try {
    const result = await exec(
      ['/bin/sh', '-c', 'err=$1; shift; exec "$@" 2>"$err"', 'sh', errFile, ...cmd],
      timeoutMs,
      cwd,
    )
    return { ...result, stderr: readFileSync(errFile, 'utf8') }
  } catch {
    return { exitCode: 126, stdout: '', stderr: '' }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

/** The first non-empty line of a tool's stderr, for a `failed` reason. */
export const firstLine = (text: string): string =>
  text
    .split('\n')
    .find((line) => line.trim())
    ?.trim() ?? ''
