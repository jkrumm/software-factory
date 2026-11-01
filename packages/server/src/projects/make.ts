import { readdir, realpath, stat } from 'node:fs/promises'
import { join, relative, resolve, sep } from 'node:path'
import { MAKE_CONTRACT, type MakeTargets } from '@software-factory/contract'

/** A Makefile larger than this is not read; no file of this contract comes near. */
const MAX_MAKEFILE_BYTES = 512 * 1024
const MAX_INCLUDE_DEPTH = 3
const MAX_FILES = 64
const MAKEFILES = ['GNUmakefile', 'makefile', 'Makefile']

const TARGET_LIST = /^[A-Za-z0-9_.][A-Za-z0-9_./-]*(?:[ \t]+[A-Za-z0-9_.][A-Za-z0-9_./-]*)*$/
/** `VAR = x`, `VAR := x`, `VAR ?= x`, `VAR += x`, `VAR != x` after a target's colon: a target-specific variable, not a prerequisite list. */
const ASSIGNMENT = /^[ \t]*[A-Za-z_][\w.-]*[ \t]*(?:[:+?!]|::|:::)?=/

/** The rule targets one makefile's text names, and the files it includes by a literal path or a glob. */
export function readMakefile(text: string): { targets: Set<string>; includes: string[] } {
  const targets = new Set<string>()
  const includes: string[] = []
  // A backslash at the end of a line continues it.
  for (const line of text.replace(/\\\r?\n/g, ' ').split(/\r?\n/)) {
    if (line === '' || line.startsWith('\t') || line.trimStart().startsWith('#')) continue
    const include = /^[ \t]*(?:-include|sinclude|include)[ \t]+(.+)$/.exec(line)
    if (include?.[1]) {
      for (const path of include[1]
        .replace(/#.*$/, '')
        .trim()
        .split(/[ \t]+/)) {
        if (path && !path.includes('$')) includes.push(path)
      }
      continue
    }
    const colon = line.indexOf(':')
    if (colon < 1) continue
    const left = line.slice(0, colon).trim()
    // `:=`, `::=` and `:::=` assign; `::` alone is a double-colon rule.
    const right = line.slice(colon + 1).replace(/^:{1,2}(?==)/, '=')
    if (left.includes('=') || right.startsWith('=') || ASSIGNMENT.test(right)) continue
    if (!TARGET_LIST.test(left)) continue
    for (const target of left.split(/[ \t]+/)) if (!target.startsWith('.')) targets.add(target)
  }
  return { targets, includes }
}

/** The files `pattern` names inside `root`: a literal path, or a glob read lazily so the budget stops the walk. */
async function* expand(root: string, pattern: string): AsyncGenerator<string> {
  if (!/[*?[]/.test(pattern)) {
    yield resolve(root, pattern)
    return
  }
  for await (const file of new Bun.Glob(pattern).scan({ cwd: root, onlyFiles: true })) yield resolve(root, file)
}

const EMPTY: MakeTargets = {
  makefile: false,
  check: false,
  test: false,
  deploy: false,
  verify: false,
  restart: false,
  quality: false,
  logs: false,
  status: false,
}

/**
 * Which targets of the make contract a repo's Makefile defines. A static read, not `make -pn`: a Makefile can run `$(shell …)` while
 * it is parsed, and this runs inside the server. `include` lines with a literal path or a glob are followed (three levels, at
 * most 64 files, inside the repo); anything built from a variable is not.
 */
export async function makeTargetsOf(repo: string): Promise<MakeTargets> {
  const root = await realpath(resolve(repo)).catch(() => undefined)
  if (!root) return { ...EMPTY }
  const entries = await readdir(root).catch(() => [] as string[])
  const main = MAKEFILES.find((name) => entries.includes(name))
  if (!main) return { ...EMPTY }

  const targets = new Set<string>()
  const seen = new Set<string>()
  // A link that leads out of the repo, or to anything but a regular file, is not read.
  const readable = async (file: string): Promise<string | undefined> => {
    const real = await realpath(file).catch(() => undefined)
    if (!real?.startsWith(`${root}${sep}`)) return undefined
    const info = await stat(real).catch(() => undefined)
    return info?.isFile() && info.size <= MAX_MAKEFILE_BYTES ? real : undefined
  }
  const visit = async (file: string, depth: number): Promise<void> => {
    if (seen.size >= MAX_FILES) return
    const real = await readable(file)
    if (!real || seen.has(real)) return
    seen.add(real)
    const read = readMakefile(await Bun.file(real).text())
    for (const target of read.targets) targets.add(target)
    if (depth >= MAX_INCLUDE_DEPTH) return
    for (const pattern of read.includes) {
      if (pattern.startsWith('/') || relative(root, resolve(root, pattern)).startsWith('..')) continue
      for await (const next of expand(root, pattern)) {
        if (seen.size >= MAX_FILES) return
        await visit(next, depth + 1)
      }
    }
  }
  await visit(join(root, main), 0)

  const result: MakeTargets = { ...EMPTY, makefile: true }
  for (const name of MAKE_CONTRACT) result[name] = targets.has(name)
  return result
}
