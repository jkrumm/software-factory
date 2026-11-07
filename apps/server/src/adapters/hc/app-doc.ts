import { basename } from 'node:path'
import { z } from 'zod'
import { realpathSync } from 'node:fs'
import { HcError } from './client.ts'

/** `path` with links resolved, or as given when it cannot be (a directory that is gone). */
export function real(path: string): string {
  try {
    return realpathSync(path)
  } catch {
    return path
  }
}

/** The document the Herdr app keeps its spaces and tabs in (the product's own name). */
export const APP_DOC = 'herdr-app'
const DOC_RETRIES = 3

/** One call to the core, already inside its time limit. */
export type Rpc = <S extends z.ZodType>(method: string, params: object, schema: S) => Promise<z.output<S>>

const DocGet = z.object({ value: z.unknown(), version: z.number() })
const DocSet = z.object({ version: z.number() }).loose()

/**
 * The app's document, as far as the factory reads it: spaces with the folder they belong to and the tabs in them. Unknown
 * keys are kept (the document is rewritten whole), and a document that does not look like this counts as absent.
 */
const AppDoc = z
  .object({ spaces: z.array(z.object({ id: z.string(), folder: z.string().optional() }).loose()) })
  .loose()

/**
 * The spaces the app has. None only when the absence is confirmed: the core refuses with `not_found`, or the document was
 * never written (value null), or it is not what it was documented to be. A timeout, a dead process or an unreadable answer
 * throws: the caller must not make up a space on the strength of a call that told it nothing.
 */
export async function appSpaces(rpc: Rpc): Promise<{ id: string; folder?: string }[]> {
  let doc: z.output<typeof DocGet>
  try {
    doc = await rpc('doc.get', { name: APP_DOC }, DocGet)
  } catch (error) {
    if (error instanceof HcError && error.refusal?.kind === 'not_found') return []
    throw error
  }
  const parsed = AppDoc.safeParse(doc.value)
  return parsed.success ? parsed.data.spaces : []
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null

/** The tab's entry in the app's document, `spaces[].tabs[]` found by id: the object itself, so a change to it is a change to the document. */
function findTab(value: unknown, id: string): Record<string, unknown> | undefined {
  if (!isRecord(value) || !Array.isArray(value.spaces)) return undefined
  for (const space of value.spaces) {
    if (!isRecord(space) || !Array.isArray(space.tabs)) continue
    const entry = space.tabs.find((tab) => isRecord(tab) && tab.id === id)
    if (isRecord(entry)) return entry
  }
  return undefined
}

/**
 * Name the tab once the app has an entry for it. Best effort, never throwing: the app adopts a tab only after it has seen
 * the terminal, so there is often no entry yet and the label `factory.tab_name` carries the name for whoever names it
 * later (the witness does, on a label or document event). Written against the version just read; a conflict reads again.
 */
export async function nameTab(rpc: Rpc, tab: string, name: string): Promise<void> {
  try {
    for (let attempt = 0; attempt < DOC_RETRIES; attempt++) {
      const doc = await rpc('doc.get', { name: APP_DOC }, DocGet)
      const entry = findTab(doc.value, tab)
      if (!entry || entry.name === name) return
      entry.name = name
      try {
        await rpc('doc.set', { name: APP_DOC, version: doc.version, value: doc.value }, DocSet)
        return
      } catch (error) {
        if (!(error instanceof HcError && error.refusal?.kind === 'conflict')) return
      }
    }
  } catch {
    // the name is a courtesy
  }
}

/**
 * Name a space the app created without a name. A name that is set is the owner's and is never overwritten, and an absent
 * entry is left alone. Best effort, never throwing; written against the version just read, a conflict reads again.
 */
export async function nameSpace(rpc: Rpc, space: { id: string; name: string }): Promise<void> {
  try {
    for (let attempt = 0; attempt < DOC_RETRIES; attempt++) {
      const doc = await rpc('doc.get', { name: APP_DOC }, DocGet)
      const entry =
        isRecord(doc.value) && Array.isArray(doc.value.spaces)
          ? doc.value.spaces.find((candidate) => isRecord(candidate) && candidate.id === space.id)
          : undefined
      if (!isRecord(entry)) return
      if (typeof entry.name === 'string' && entry.name.trim() !== '') return
      entry.name = space.name
      try {
        await rpc('doc.set', { name: APP_DOC, version: doc.version, value: doc.value }, DocSet)
        return
      } catch (error) {
        if (!(error instanceof HcError && error.refusal?.kind === 'conflict')) return
      }
    }
  } catch {
    // the name is a courtesy
  }
}

/**
 * Make sure the app's document has an entry for a space the factory is about to put a terminal in, so the app adopts the
 * terminal into a space named after the repo and rooted at its folder, not one named after the terminal's cwd (a worktree's).
 * `folder` is the space's resolved path (the main checkout of a worktree). The entry is `{ id, name, folder, tabs: [] }`, as
 * the app writes it. A second space for a folder already in the document is named `<basename> <n>` to tell it apart.
 *
 * An entry with the id is never touched, and neither is a document that is not the app's (a value that is not null and has
 * no `spaces` array, or a list with an entry that has no id). Written against the version just read; a conflict reads again. Best effort, never throwing: the id is
 * the one the terminal's label carries, so a later seed, or the app, still lands on the same space.
 */
export async function seedSpace(rpc: Rpc, space: { id: string; folder: string }): Promise<void> {
  try {
    for (let attempt = 0; attempt < DOC_RETRIES; attempt++) {
      let doc: z.output<typeof DocGet>
      try {
        doc = await rpc('doc.get', { name: APP_DOC }, DocGet)
      } catch (error) {
        if (!(error instanceof HcError && error.refusal?.kind === 'not_found')) return
        doc = { value: null, version: 0 }
      }
      const value = doc.value === null ? { spaces: [] } : doc.value
      if (!isRecord(value) || !Array.isArray(value.spaces)) return
      // The same reading as `appSpaces`: a list with an entry that has no id is not the app's, so nothing is added to it.
      const entries = value.spaces.filter((entry) => isRecord(entry) && typeof entry.id === 'string')
      if (entries.length !== value.spaces.length) return
      if (entries.some((entry) => entry.id === space.id)) return
      const siblings = entries.filter(
        (entry) => typeof entry.folder === 'string' && real(entry.folder) === space.folder,
      )
      const taken = new Set(entries.map((entry) => entry.name))
      const base = basename(space.folder)
      let n = siblings.length + 1
      let name = siblings.length === 0 ? base : `${base} ${n}`
      while (siblings.length > 0 && taken.has(name)) name = `${base} ${++n}`
      value.spaces.push({ id: space.id, name, folder: space.folder, tabs: [] })
      try {
        await rpc('doc.set', { name: APP_DOC, version: doc.version, value }, DocSet)
        return
      } catch (error) {
        if (!(error instanceof HcError && error.refusal?.kind === 'conflict')) return
      }
    }
  } catch {
    // the name is a courtesy
  }
}
