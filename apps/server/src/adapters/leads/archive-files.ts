import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { mkdir, readdir, rename, rm, stat, utimes } from 'node:fs/promises'
import { dirname, join, relative, sep } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { constants, createZstdCompress, createZstdDecompress } from 'node:zlib'
import { ARCHIVE_SUFFIX, type ArchiveTidy, attemptArchiveDir } from '../../kernel/transcript-archive.ts'

/** zstd level 6: a 305 MB transcript is 58 MB (5.2x) in 7 s; gzip -6 left it at 165 MB. */
const LEVEL = 6

const PARTIAL = '.partial'

/** A `.partial` untouched this long is a crash's leftover. */
const STALE_PARTIAL_MS = 86_400_000

interface Digest {
  bytes: number
  sha: string
}

async function digestOf(stream: AsyncIterable<Buffer | string>): Promise<Digest> {
  const hash = createHash('sha256')
  let bytes = 0
  for await (const chunk of stream) {
    const buffer = typeof chunk === 'string' ? Buffer.from(chunk) : chunk
    bytes += buffer.length
    hash.update(buffer)
  }
  return { bytes, sha: hash.digest('hex') }
}

/** What compressing one file saved. */
export interface Compressed {
  from: number
  to: number
}

/**
 * `to` is `from` compressed, and only after reading it back (decompressed) gives the same bytes: the temporary file is
 * written beside it and renamed over, so a crash leaves a `.partial` and never a half file under the real name. Throws when
 * the copy does not verify; `from` is never touched.
 */
export async function compressFile(from: string, to: string): Promise<Compressed> {
  await mkdir(dirname(to), { recursive: true })
  const partial = `${to}${PARTIAL}`
  try {
    await pipeline(
      createReadStream(from),
      createZstdCompress({ params: { [constants.ZSTD_c_compressionLevel]: LEVEL } }),
      createWriteStream(partial, { mode: 0o600 }),
    )
    const [plain, packed] = await Promise.all([
      digestOf(createReadStream(from)),
      digestOf(createReadStream(partial).pipe(createZstdDecompress())),
    ])
    if (plain.bytes !== packed.bytes || plain.sha !== packed.sha)
      throw new Error(`the archive copy of ${from} does not read back`)
    await rename(partial, to)
  } catch (cause) {
    await rm(partial, { force: true })
    throw cause
  }
  return { from: (await stat(from)).size, to: (await stat(to)).size }
}

/** Every regular file under `dir`, relative to it; links are not followed. */
async function filesUnder(dir: string): Promise<string[]> {
  const files: string[] = []
  const walk = async (current: string): Promise<void> => {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const path = join(current, entry.name)
      if (entry.isDirectory()) await walk(path)
      else if (entry.isFile()) files.push(relative(dir, path))
    }
  }
  await walk(dir)
  return files
}

/** `from` (a directory) compressed file by file into `to`, each as `<name>.zst`. */
export async function compressTree(from: string, to: string): Promise<Compressed> {
  const sum = { from: 0, to: 0 }
  for (const file of await filesUnder(from)) {
    const done = await compressFile(join(from, file), `${join(to, file)}${ARCHIVE_SUFFIX}`)
    sum.from += done.from
    sum.to += done.to
  }
  return sum
}

export const emptyReport = (): ArchiveTidy => ({
  expired: 0,
  converted: { files: 0, from: 0, to: 0 },
  projectsRemoved: 0,
})

const numeric = (name: string): boolean => /^\d+$/.test(name)

const dirsOf = async (path: string): Promise<string[]> =>
  (await readdir(path, { withFileTypes: true }).catch(() => [])).filter((e) => e.isDirectory()).map((e) => e.name)

/** The attempt directories of the archive: `[issue number, attempt]`. */
export async function archivedAttempts(archiveDir: string): Promise<[number, number][]> {
  const found: [number, number][] = []
  for (const issue of (await dirsOf(archiveDir)).filter(numeric))
    for (const attempt of (await dirsOf(join(archiveDir, issue))).filter(numeric))
      found.push([Number(issue), Number(attempt)])
  return found
}

/** Deletes an attempt's directory, and the issue's when that was its last. */
async function removeAttempt(archiveDir: string, issue: number, attempt: number): Promise<void> {
  await rm(attemptArchiveDir(archiveDir, issue, attempt), { recursive: true, force: true })
  const left = await readdir(join(archiveDir, String(issue))).catch(() => ['?'])
  if (left.length === 0) await rm(join(archiveDir, String(issue)), { recursive: true, force: true })
}

/** Attempts whose archive is older than `days` go. 0 keeps everything. */
export async function expire(options: {
  archiveDir: string
  days: number
  now: Date
  attempts: readonly [number, number][]
}): Promise<{ expired: number; kept: [number, number][] }> {
  if (options.days <= 0) return { expired: 0, kept: [...options.attempts] }
  const cutoff = options.now.getTime() - options.days * 86_400_000
  const kept: [number, number][] = []
  let expired = 0
  for (const [issue, attempt] of options.attempts) {
    const info = await stat(attemptArchiveDir(options.archiveDir, issue, attempt)).catch(() => null)
    if (info && info.mtimeMs < cutoff) {
      await removeAttempt(options.archiveDir, issue, attempt)
      expired++
    } else kept.push([issue, attempt])
  }
  return { expired, kept }
}

/**
 * The plain files of an attempt's archive (what the archive held before it was compressed) compressed in place: each is
 * removed only once its compressed copy reads back equal. The directory keeps its time, which is the age retention counts.
 */
export async function convertAttempt(
  archiveDir: string,
  issue: number,
  attempt: number,
): Promise<Compressed & { files: number }> {
  const dir = attemptArchiveDir(archiveDir, issue, attempt)
  const info = await stat(dir)
  const sum = { files: 0, from: 0, to: 0 }
  for (const file of await filesUnder(dir)) {
    if (file.endsWith(PARTIAL)) {
      // one an archive is writing right now is not a leftover: only a day-old one is
      const written = await stat(join(dir, file)).catch(() => null)
      if (written && Date.now() - written.mtimeMs > STALE_PARTIAL_MS) await rm(join(dir, file), { force: true })
      continue
    }
    if (file.endsWith(ARCHIVE_SUFFIX)) continue
    const done = await compressFile(join(dir, file), `${join(dir, file)}${ARCHIVE_SUFFIX}`)
    await rm(join(dir, file))
    sum.files++
    sum.from += done.from
    sum.to += done.to
  }
  if (sum.files > 0) await utimes(dir, info.atime, info.mtime)
  return sum
}

/** A factory lead's worktree is `<repo>/.claude/worktrees/factory-<issue>-<attempt>`; Claude names its project directory after the path. */
const WORKTREE_PROJECT = /--claude-worktrees-factory-(\d+)-(\d+)$/

/**
 * Whether everything a session left in a Claude project directory has its archived copy: each top-level transcript, and
 * every file under a session's own directory (subagents, tool results). What else lies there (memory) is not a transcript.
 * An archive still being written is not full yet, so its project stays.
 */
async function fullyArchived(project: string, attemptDir: string): Promise<boolean> {
  // a project that cannot be read whole is kept: an empty list would read as "nothing left to archive"
  const files = await filesUnder(project)
  const sessions = new Set(
    files.filter((f) => !f.includes(sep) && f.endsWith('.jsonl')).map((f) => f.slice(0, -'.jsonl'.length)),
  )
  for (const file of files) {
    const [top] = file.split(sep)
    const segments = file.split(sep)
    // a session's directory holds its subagents' and tool results' files, whether or not its own transcript is still there
    const owned = file.includes(sep)
      ? sessions.has(top ?? '') || segments.includes('subagents') || segments.includes('tool-results')
      : file.endsWith('.jsonl')
    if (!owned) continue
    if (
      !(await stat(join(attemptDir, `${file}${ARCHIVE_SUFFIX}`)).then(
        (s) => s.isFile(),
        () => false,
      ))
    )
      return false
  }
  return true
}

/**
 * The project directories of finished worktrees: `attempts` is the archive's (the ones that have a copy), and a directory
 * goes only when every transcript in it, subagents' included, has an archived copy. Without `only`, every attempt of `attempts` counts.
 */
export async function removeFinishedProjects(options: {
  projectRoots: readonly string[]
  archiveDir: string
  attempts: readonly [number, number][]
  only?: { issue: number; attempt: number }
}): Promise<number> {
  const archived = new Set(options.attempts.map(([issue, attempt]) => `${issue}-${attempt}`))
  let removed = 0
  for (const root of options.projectRoots) {
    for (const name of await dirsOf(root)) {
      const match = WORKTREE_PROJECT.exec(name)
      if (!match) continue
      const [issue, attempt] = [Number(match[1]), Number(match[2])]
      if (!archived.has(`${issue}-${attempt}`)) continue
      if (options.only && (options.only.issue !== issue || options.only.attempt !== attempt)) continue
      const project = join(root, name)
      // one project that cannot be read does not stop the rest
      const full = await fullyArchived(project, attemptArchiveDir(options.archiveDir, issue, attempt)).catch(
        () => false,
      )
      if (!full) continue
      await rm(project, { recursive: true, force: true })
      removed++
    }
  }
  return removed
}
