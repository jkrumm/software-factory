const PAGE_LINE = /^\s*Pages (wired down|occupied by compressor):\s+(\d+)\.?\s*$/

/**
 * Memory in use as Activity Monitor's "Memory Used" counts it: (app memory + wired + compressed) over RAM, where app
 * memory is `vm.page_pageable_internal_count - vm.page_purgeable_count`. `sysctlOut` is `sysctl -n` of
 * `vm.page_pageable_internal_count vm.page_purgeable_count hw.pagesize` (one value per line); `vmStatOut` is `vm_stat`
 * (wired and compressor pages). Percent with one decimal; null when anything is missing or does not parse.
 * (Summed process RSS counts every shared page once per process and reads as full on a host that is not.)
 */
export function memoryUsedPct(sysctlOut: string, vmStatOut: string, ramBytes: number): number | null {
  const [pageable, purgeable, pageSize] = sysctlOut
    .trim()
    .split('\n')
    .map((line) => Number(line.trim()))
  const pages = new Map<string, number>()
  for (const line of vmStatOut.split('\n')) {
    const match = PAGE_LINE.exec(line)
    if (match?.[1] && match[2]) pages.set(match[1], Number(match[2]))
  }
  const wired = pages.get('wired down')
  const compressed = pages.get('occupied by compressor')
  if (pageable === undefined || purgeable === undefined || pageSize === undefined) return null
  if (wired === undefined || compressed === undefined) return null
  if (![pageable, purgeable, pageSize, ramBytes].every((n) => Number.isFinite(n))) return null
  if (pageSize <= 0 || ramBytes <= 0 || pageable < purgeable) return null
  const used = (pageable - purgeable + wired + compressed) * pageSize
  return Math.round((used / ramBytes) * 1000) / 10
}
