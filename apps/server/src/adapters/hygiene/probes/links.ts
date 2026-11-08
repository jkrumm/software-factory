import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { dirname, join, relative } from 'node:path'
import { type Outcome, clean, finding, found } from './finding.ts'

const SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:/
const INLINE_CODE = /(`+)[^`]*?\1/g
const LINK = /!?\[[^\]]*\]\(\s*(<[^>]*>|[^)\s]+)(?:\s+(?:"[^"]*"|'[^']*'))?\s*\)/g
const FENCE = /^ {0,3}(`{3,}|~{3,})/

export interface BrokenLink {
  line: number
  target: string
}

/** The relative targets of the inline links in `text`, outside fenced code and inline code spans, with their line. */
export function linkTargets(text: string): BrokenLink[] {
  const targets: BrokenLink[] = []
  let fence: string | undefined
  text.split('\n').forEach((raw, index) => {
    const opening = FENCE.exec(raw)?.[1]
    if (opening) {
      if (!fence) fence = opening
      else if (opening[0] === fence[0] && opening.length >= fence.length) fence = undefined
      return
    }
    if (fence) return
    for (const match of raw.replace(INLINE_CODE, (code) => ' '.repeat(code.length)).matchAll(LINK)) {
      const target = (match[1] ?? '').replace(/^<|>$/g, '')
      if (target) targets.push({ line: index + 1, target })
    }
  })
  return targets
}

function pathOf(target: string): string | undefined {
  if (SCHEME.test(target) || target.startsWith('#') || target.startsWith('/')) return undefined
  const bare = target.split('#')[0]?.split('?')[0] ?? ''
  if (!bare) return undefined
  try {
    return decodeURIComponent(bare)
  } catch {
    return bare
  }
}

/** Links in `text`, the file at `file` (relative to `root`), whose target is not in the checkout. */
export function brokenLinks(root: string, file: string, text: string): BrokenLink[] {
  return linkTargets(text).filter(({ target }) => {
    const path = pathOf(target)
    if (path === undefined) return false
    const resolved = join(root, dirname(file), path)
    return relative(root, resolved).startsWith('..') || !existsSync(resolved)
  })
}

/** Every inline link of the living documents points at something that is in the checkout. */
export async function linksProbe(path: string, docs: string[]): Promise<Outcome> {
  const findings = []
  for (const file of docs) {
    const text = await readFile(join(path, file), 'utf8').catch(() => '')
    const broken = brokenLinks(path, file, text)
    if (!broken.length) continue
    findings.push(
      finding(
        'links',
        `links:${file}`,
        `Hygiene: broken links in ${file}`,
        broken.map((b) => `${b.line}: ${b.target}`),
        broken.length,
      ),
    )
  }
  const detail = `${docs.length} documents`
  return findings.length ? found(detail, findings) : clean(detail)
}
