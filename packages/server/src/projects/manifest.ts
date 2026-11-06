import { createHash } from 'node:crypto'
import { MAX_MANIFEST_BYTES, ProjectManifest } from '@software-factory/contract'
import { z } from 'zod'
import { parse, YAMLParseError } from 'yaml'

export const contentSha = (text: string): string => createHash('sha256').update(text).digest('hex')

export type ManifestParse = { ok: true; manifest: ProjectManifest } | { ok: false; message: string }

/**
 * The content of a `project.yaml` as a manifest. YAML 1.2 core, one document, no merge keys, duplicate keys refused, at most 100
 * aliases (`yaml`'s defaults, pinned here so a new default cannot change what parses); then the contract's schema. Whatever is
 * wrong comes back as one message with a position where the parser has one, never as a throw.
 */
export function parseManifest(text: string): ManifestParse {
  if (Buffer.byteLength(text) > MAX_MANIFEST_BYTES) {
    return { ok: false, message: `project.yaml is larger than ${MAX_MANIFEST_BYTES} bytes` }
  }
  const raw = parseYaml(text)
  if (!raw.ok) return raw
  const parsed = ProjectManifest.safeParse(raw.value)
  if (!parsed.success) return { ok: false, message: schemaMessage(parsed.error) }
  return { ok: true, manifest: parsed.data }
}

/** The one hardened YAML read (`project.yaml` and `docs/plan.yaml`): a document, or why it is none. */
export function parseYaml(text: string): { ok: true; value: unknown } | { ok: false; message: string } {
  try {
    const value: unknown = parse(text, {
      version: '1.2',
      schema: 'core',
      merge: false,
      uniqueKeys: true,
      maxAliasCount: 100,
      logLevel: 'error',
    })
    return { ok: true, value }
  } catch (error) {
    if (error instanceof YAMLParseError) {
      const at = error.linePos?.[0]
      return {
        ok: false,
        message: `${error.code}${at ? ` at line ${at.line}, column ${at.col}` : ''}: ${firstLine(error.message)}`,
      }
    }
    return { ok: false, message: `YAML: ${firstLine(error instanceof Error ? error.message : String(error))}` }
  }
}

export const schemaMessage = (error: z.ZodError): string =>
  clip(z.prettifyError(error).split('\n').filter(Boolean).join('; '), 600)

/** The parser's messages carry a source excerpt on later lines; the first line says what is wrong. */
const firstLine = (message: string): string =>
  clip(
    message
      .split('\n')
      .find((l) => l.trim() !== '')
      ?.trim() ?? message,
    300,
  )

const clip = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max)}…` : text)
