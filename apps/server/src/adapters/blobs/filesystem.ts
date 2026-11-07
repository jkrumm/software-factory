import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join } from 'node:path'
import type { BlobStore } from '../../domains/checkpoints/ports.ts'
import { err, ok, portError } from '../../kernel/result.ts'

/** A blob's name is its content's hash, fanned out by the first two characters: `ab/abcdef…`. */
const BLOB_PATH = /^[0-9a-f]{2}\/[0-9a-f]{64}$/

const sha256Of = (content: Uint8Array): string => new Bun.CryptoHasher('sha256').update(content).digest('hex')

/**
 * Artifact revisions as files under the factory's data directory, never in git. A blob is named by its content, so a put
 * of the same content is the same file and a replayed submit writes nothing twice. A file is written beside its name and
 * renamed into place, so a reader never sees half a blob.
 */
export function fileBlobStore(root: string): BlobStore {
  if (!isAbsolute(root)) throw new Error(`the blob directory must be an absolute path: ${root}`)
  return {
    async put(content) {
      const bytes = new TextEncoder().encode(content)
      const sha256 = sha256Of(bytes)
      const path = `${sha256.slice(0, 2)}/${sha256}`
      const file = join(root, path)
      try {
        const existing = await stat(file).catch(() => null)
        if (!existing) {
          await mkdir(dirname(file), { recursive: true })
          const partial = `${file}.${process.pid}.${Bun.randomUUIDv7()}.partial`
          await writeFile(partial, bytes)
          await rename(partial, file)
        }
        return ok({ path, sha256, bytes: bytes.length })
      } catch (error) {
        return err(
          portError('gone', `the blob could not be written: ${error instanceof Error ? error.message : String(error)}`),
        )
      }
    },

    async get(path) {
      if (!BLOB_PATH.test(path)) return err(portError('refused', `not a blob path: ${path}`))
      try {
        const content = await readFile(join(root, path), 'utf8')
        return ok(content)
      } catch (error) {
        const missing = error instanceof Error && 'code' in error && error.code === 'ENOENT'
        return err(
          portError(
            missing ? 'gone' : 'unreadable',
            `blob ${path}: ${error instanceof Error ? error.message : String(error)}`,
          ),
        )
      }
    },
  }
}
