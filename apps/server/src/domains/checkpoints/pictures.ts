/**
 * Whether the Console can show the pictures of an artifact. A Markdown image loads only over `https` from a host the
 * owner lists (`FACTORY_CONSOLE_IMAGE_HOSTS`, the page's `img-src`); an HTML artifact's frame loads images from `data:`
 * only. Anything else shows its alt text in place of the picture, so a Spec that leans on it is refused at hand-over.
 */

export interface UnloadedPicture {
  /** what the author called it (alt text, or the link's start) */
  label: string
  reason: string
}

const INLINE_CODE = /(`+)[^`\n][^\n]*?\1(?!`)/g
const MD_IMAGE = /!\[([^\]]*)\]\(\s*(<[^>\n]*>|[^\s)]*)/g
const HTML_IMG = /<img\b[^>]*?\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi

/** The text with every fenced code block (and its fences) dropped: a fence closes on its own character, as long, bare. */
export function withoutFences(content: string): string {
  let open: { char: string; length: number } | null = null
  return content
    .split('\n')
    .filter((line) => {
      const run = /^\s{0,3}(`{3,}|~{3,})(.*)$/.exec(line)
      const marker = run?.[1]
      if (!open) {
        if (!run || !marker) return true
        open = { char: marker.charAt(0), length: marker.length }
        return false
      }
      if (run && marker && marker.charAt(0) === open.char && marker.length >= open.length && run[2]?.trim() === '') {
        open = null
      }
      return false
    })
    .join('\n')
}

/** `*.example.com` matches a subdomain, `example.com` itself; the way CSP reads a host source. */
function hostListed(url: URL, hosts: readonly string[]): boolean {
  if (url.port !== '') return false
  const host = url.hostname.toLowerCase()
  return hosts.some((listed) => (listed.startsWith('*.') ? host.endsWith(listed.slice(1)) : host === listed))
}

/** A presigned link's end (`X-Amz-Date` plus `X-Amz-Expires`), or null where the link is not one. */
function presignedEnd(url: URL): number | null {
  const date = url.searchParams.get('X-Amz-Date')?.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/)
  const seconds = Number(url.searchParams.get('X-Amz-Expires'))
  if (!date || !Number.isFinite(seconds) || seconds <= 0) return null
  const [, y, mo, d, h, mi, s] = date.map(Number)
  return Date.UTC(y ?? 0, (mo ?? 1) - 1, d, h, mi, s) + seconds * 1000
}

function markdownProblem(src: string, hosts: readonly string[], now: Date): string | null {
  let url: URL
  try {
    url = new URL(src)
  } catch {
    return 'not an absolute link'
  }
  if (url.protocol !== 'https:') return 'only https pictures load'
  if (!hostListed(url, hosts)) {
    return hosts.length === 0
      ? `${url.host} is not a host the Console loads pictures from (none is listed)`
      : `${url.host} is not a host the Console loads pictures from (it loads ${hosts.join(', ')})`
  }
  const end = presignedEnd(url)
  if (end !== null && end <= now.getTime()) return 'the presigned link has already expired'
  return null
}

/** The pictures of `content` the Console would show as alt text, each with why; empty when all load. */
export function unloadedPictures(
  content: string,
  format: 'markdown' | 'html',
  hosts: readonly string[],
  now: Date,
): UnloadedPicture[] {
  const found: UnloadedPicture[] = []
  if (format === 'html') {
    for (const match of content.matchAll(HTML_IMG)) {
      const src = (match[1] ?? match[2] ?? match[3] ?? '').trim()
      if (src.toLowerCase().startsWith('data:')) continue
      found.push({
        label: src.slice(0, 80),
        reason: 'an HTML artifact shows only data: pictures (inline the image as a data: URL)',
      })
    }
    return found
  }
  const prose = withoutFences(content.replace(/\r\n?/g, '\n')).replace(INLINE_CODE, ' ')
  for (const match of prose.matchAll(MD_IMAGE)) {
    const src = (match[2] ?? '').replace(/^<|>$/g, '')
    const reason = markdownProblem(src, hosts, now)
    if (reason) found.push({ label: (match[1] ?? '').trim() || src.slice(0, 80), reason })
  }
  return found
}

/** The refusal a lead reads, or null where every picture loads. */
export function picturesRefusal(
  content: string,
  format: 'markdown' | 'html',
  hosts: readonly string[],
  now: Date,
): string | null {
  const unloaded = unloadedPictures(content, format, hosts, now)
  if (unloaded.length === 0) return null
  const lines = unloaded.slice(0, 10).map((p) => `- "${p.label}": ${p.reason}`)
  const more = unloaded.length > 10 ? [`- and ${unloaded.length - 10} more`] : []
  return [
    `${unloaded.length} picture${unloaded.length === 1 ? '' : 's'} would not show for the owner (the Console shows its alt text instead):`,
    ...lines,
    ...more,
    'Upload a shot with `imgcli private <file> --json` (a presigned link from a listed host) and link its url, or use an HTML artifact with data: pictures; a diagram is a figure drawn by apps/console/scripts/diagram.ts.',
  ].join('\n')
}
