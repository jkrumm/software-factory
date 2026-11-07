const REDACTED = '[redacted]'

/**
 * Credential-looking strings out of text that goes to a model provider: private key blocks, `Bearer` tokens, `key=value`
 * pairs whose key names a secret, well-known token prefixes, `user:password@` in a URL and any long unbroken token. A
 * heuristic on top of the lead's text being data, not a guarantee.
 */
export function scrub(value: string): string {
  return value
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g, REDACTED)
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, `Bearer ${REDACTED}`)
    .replace(
      /\b([A-Za-z0-9_.-]*(?:token|secret|passw(?:or)?d|passwd|api[_-]?key|apikey|auth|credential|private[_-]?key)[A-Za-z0-9_.-]*)(["']?\s*[:=]\s*["']?)[^\s"',}&]{4,}/gi,
      `$1$2${REDACTED}`,
    )
    .replace(/\b(?:sk|pk|rk)-[A-Za-z0-9_-]{10,}/g, REDACTED)
    .replace(/\b(?:gh[pousr]_|github_pat_|glpat-|xox[abprs]-|AKIA|AIza)[A-Za-z0-9_-]{10,}/g, REDACTED)
    .replace(/(:\/\/)[^\s/@:]+:[^\s/@]+@/g, `$1${REDACTED}@`)
    .replace(/\b[A-Za-z0-9_-]{41,}\b/g, REDACTED)
}
