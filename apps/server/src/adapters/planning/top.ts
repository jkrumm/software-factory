const UNIT_KIB: Record<string, number> = { B: 1 / 1024, K: 1, M: 1024, G: 1024 ** 2, T: 1024 ** 3 }

const LINE = /^\s*(\d+)\s+(\d+(?:[.,]\d+)?)([BKMGT])[+-]?\s*$/

/**
 * The physical footprint of every process, in KiB, from `top -l 1 -n <count> -stats pid,mem`. top's MEM column is the
 * kernel's `phys_footprint` (dirty, compressed and swapped pages, shared clean pages left out), printed to three digits
 * in K, M or G; the header lines and any line that does not parse are skipped. A pid listed twice keeps its first row.
 */
export function parseTopFootprints(output: string): Map<number, number> {
  const footprints = new Map<number, number>()
  for (const line of output.split('\n')) {
    const match = LINE.exec(line)
    if (!match) continue
    const pid = Number(match[1])
    const kib = Number((match[2] ?? '0').replace(',', '.')) * (UNIT_KIB[match[3] ?? 'K'] ?? 1)
    if (!footprints.has(pid)) footprints.set(pid, Math.round(kib))
  }
  return footprints
}
