/**
 * What of a failed check's output is kept. The failing part, never a tail cut at a character: a watchdog's JSON list of
 * checks becomes the checks with `ok: false`, any other output keeps the lines around its first error and its last
 * lines. Every cut falls on a line boundary and is marked; a line is kept whole or not at all.
 */

const ERROR = /\b(?:error|errors|failed|failure|failing|fatal|panic|exception|traceback)\b|\*\*\*|✗|✖/i
/** The share of the budget the last lines get before anything else: where a failing recipe says what stopped it. */
const TAIL_SHARE = 0.4
const CONTEXT = [0, 1, -1, 2, -2, 3, -3]
/** How many places a JSON list may start and end in, in output a recipe printed around it. */
const JSON_TRIES = 5
/** What a `[… N lines cut]` marker may take of a check's share. */
const MARKER_ROOM = 24

interface Listed {
  name: string
  ok: boolean
  detail?: unknown
}

const cutMarker = (lines: number): string => `[… ${lines} ${lines === 1 ? 'line' : 'lines'} cut]`

export function condense(text: string, max: number): string {
  const lines = text.split('\n')
  const listed = failingChecks(lines)
  if (listed) return fromList(listed.failing, listed.total, max)
  return text.length <= max ? text : fromLines(lines, max)
}

const isListed = (value: unknown): value is Listed =>
  typeof value === 'object' &&
  value !== null &&
  typeof (value as Listed).name === 'string' &&
  typeof (value as Listed).ok === 'boolean'

function listOf(value: unknown): unknown[] | undefined {
  if (Array.isArray(value)) return value
  if (typeof value === 'object' && value !== null && Array.isArray((value as { checks?: unknown }).checks))
    return (value as { checks: unknown[] }).checks
  return undefined
}

/** The checks of the first JSON list of `{name, ok, detail}` found in the output that has one with `ok: false`. */
function failingChecks(lines: readonly string[]): { total: number; failing: Listed[] } | undefined {
  const starts: number[] = []
  lines.forEach((line, index) => {
    if (starts.length < JSON_TRIES && /^[[{]\s*(?:$|["[{\]}])/.test(line)) starts.push(index)
  })
  const ends: number[] = []
  for (let index = lines.length - 1; index >= 0 && ends.length < JSON_TRIES; index--)
    if (/[\]}]\s*$/.test(lines[index] ?? '')) ends.push(index)
  for (const start of starts) {
    for (const end of ends) {
      if (end < start) continue
      let parsed: unknown
      try {
        parsed = JSON.parse(lines.slice(start, end + 1).join('\n'))
      } catch {
        continue
      }
      const list = listOf(parsed)
      if (!list || list.length === 0 || !list.every(isListed)) continue
      const failing = list.filter((one) => !one.ok)
      if (failing.length > 0) return { total: list.length, failing }
    }
  }
  return undefined
}

const detailText = (detail: unknown): string =>
  typeof detail === 'string' ? detail.trim() : detail === undefined || detail === null ? '' : JSON.stringify(detail)

/** Each failing check by name and detail, the budget shared between them; a detail too long is cut at its lines. */
function fromList(failing: readonly Listed[], total: number, max: number): string {
  const head = `${failing.length} of ${total} checks failing:`
  const share = Math.max(0, Math.floor((max - head.length) / failing.length))
  const blocks = failing.map((check) => {
    const detail = detailText(check.detail).split('\n')
    if (detail.length === 1) {
      const line = `${check.name}: ${detail[0]}`
      return line.length <= share || !detail[0] ? line : `${check.name}: [detail of ${detail[0].length} chars omitted]`
    }
    const out = [`${check.name}:`]
    let used = out[0]?.length ?? 0
    let kept = 0
    for (const line of detail) {
      const cost = line.length + 3
      if (used + cost > share - MARKER_ROOM) break
      out.push(`  ${line}`)
      used += cost
      kept++
    }
    if (kept < detail.length) out.push(`  ${cutMarker(detail.length - kept)}`)
    return out.join('\n')
  })
  return [head, ...blocks].join('\n')
}

/** The last lines, the lines around the first error and the other error lines, in that order, until `max` is spent. */
function fromLines(lines: readonly string[], max: number): string {
  const order: number[] = []
  const kept = new Set<number>()
  let used = 0
  const take = (index: number, limit: number): boolean => {
    const line = lines[index]
    if (line === undefined || kept.has(index)) return true
    if (used + line.length + 1 > limit) return false
    kept.add(index)
    order.push(index)
    used += line.length + 1
    return true
  }
  const tailLimit = Math.floor(max * TAIL_SHARE)
  for (let index = lines.length - 1; index >= 0 && take(index, tailLimit); index--);
  const first = lines.findIndex((line) => ERROR.test(line))
  if (first >= 0) {
    for (const offset of CONTEXT) take(first + offset, max)
    lines.forEach((line, index) => {
      if (ERROR.test(line)) take(index, max)
    })
  }
  // The markers cost too: drop what was taken last until the whole of it fits.
  let rendered = render(lines, kept)
  while (rendered.length > max && order.length > 0) {
    kept.delete(order.pop() as number)
    rendered = render(lines, kept)
  }
  return rendered
}

function render(lines: readonly string[], kept: ReadonlySet<number>): string {
  const out: string[] = []
  let next = 0
  for (const index of [...kept].sort((a, b) => a - b)) {
    if (index > next) out.push(cutMarker(index - next))
    out.push(lines[index] ?? '')
    next = index + 1
  }
  if (next < lines.length) out.push(cutMarker(lines.length - next))
  return out.join('\n')
}
