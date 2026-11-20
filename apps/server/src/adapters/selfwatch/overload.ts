import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { OverloadHost } from '../../domains/improve/ports.ts'
import type { PsRow } from '../../domains/improve/selfwatch-model.ts'
import { err, ok, portError } from '../../kernel/result.ts'
import { CannotExecute, EXIT_TIMEOUT, type Run, runProcess } from '../process.ts'

/** A host at load 200 answers a `ps` slowly; one that takes longer than this is the finding, not a reason to hold the pass. */
const PS_TIMEOUT_MS = 20_000

/** `ps -axo pid=,pri=,pcpu=,rss=,command=`: pid, scheduling priority, CPU share, resident KiB, then the command. */
const PS_LINE = /^\s*(\d+)\s+(-?\d+)\s+([\d.]+)\s+(\d+)\s+(.*)$/

export function parsePs(output: string): PsRow[] {
  const rows: PsRow[] = []
  for (const line of output.split('\n')) {
    const match = PS_LINE.exec(line)
    if (!match) continue
    const [, pid = '', pri = '', pcpu = '', rss = '', command = ''] = match
    rows.push({
      pid: Number(pid),
      pri: Number(pri),
      pcpu: Number(pcpu),
      rssMib: Math.round(Number(rss) / 1024),
      command,
    })
  }
  return rows
}

/** What the host says for an overload incident's evidence: `ps` with the scheduling priority, and the tail of `deploys.log`. */
export function hostOverload(options: { dataDir: string; run?: Run; ps?: string }): OverloadHost {
  const run = options.run ?? runProcess
  return {
    async processes() {
      try {
        const done = await run([options.ps ?? 'ps', '-axo', 'pid=,pri=,pcpu=,rss=,command='], PS_TIMEOUT_MS)
        if (done.exitCode === EXIT_TIMEOUT)
          return err(portError('timeout', `ps took longer than ${PS_TIMEOUT_MS / 1000} s`))
        if (done.exitCode !== 0) return err(portError('unreadable', `ps exited ${done.exitCode}`))
        return ok(parsePs(done.stdout))
      } catch (error) {
        return err(portError(error instanceof CannotExecute ? 'gone' : 'unreadable', String(error)))
      }
    },
    async deployLines(count) {
      const text = await readFile(join(options.dataDir, 'deploys.log'), 'utf8').catch(() => '')
      return text.split('\n').filter(Boolean).slice(-count)
    },
  }
}
