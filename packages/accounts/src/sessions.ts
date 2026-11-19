// Session lookups the launcher uses: which account a session ran on, and the newest transcript of a directory.
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

/** Account a session ran on, from the newest `session_env` line for it in the hook logs (newest file first). */
export function sessionAccount(sessionId: string, logDir: string): string | null {
  if (!/^[A-Za-z0-9_-]+$/.test(sessionId)) return null
  let files: string[]
  try {
    files = readdirSync(logDir)
      .filter((f) => f.endsWith('.jsonl'))
      .sort()
      .reverse()
  } catch {
    return null
  }
  for (const f of files) {
    let lines: string[]
    try {
      lines = readFileSync(join(logDir, f), 'utf8').split('\n')
    } catch {
      continue
    }
    for (let i = lines.length - 1; i >= 0; i--) {
      if (!lines[i].includes(sessionId) || !lines[i].includes('session_env')) continue
      try {
        const e = JSON.parse(lines[i])
        if (e.event === 'session_env' && e.data?.session === sessionId)
          return typeof e.data.account === 'string' ? e.data.account : null
      } catch {
        // a torn line is skipped
      }
    }
  }
  return null
}

/**
 * Id of the newest session transcript Claude Code keeps for a cwd: `<projectsDir>/<cwd with every non-alphanumeric
 * as '-'>/<id>.jsonl`, newest mtime first (what `claude --continue` resumes). `projects/` is shared by every
 * account. null when the dir or a transcript is missing.
 */
export function latestSessionId(projectsDir: string, cwd: string): string | null {
  const dir = join(projectsDir, cwd.replace(/[^A-Za-z0-9]/g, '-'))
  let best: { id: string; mtime: number } | null = null
  try {
    for (const f of readdirSync(dir)) {
      const m = /^([A-Za-z0-9_-]+)\.jsonl$/.exec(f)
      if (!m) continue
      let mtime: number
      try {
        mtime = statSync(join(dir, f)).mtimeMs
      } catch {
        continue // vanished between readdir and stat (a session cleaning up): skip it, keep the others
      }
      if (!best || mtime > best.mtime) best = { id: m[1], mtime }
    }
  } catch {
    return null
  }
  return best?.id ?? null
}
