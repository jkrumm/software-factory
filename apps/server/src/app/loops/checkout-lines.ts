import type { MainCheckoutLine } from '../../domains/loops/checkout.ts'

/**
 * The main-checkout findings of the last steward pass, held in memory for the health lines. `since` is when a repo's
 * finding with this fingerprint was first seen; a changed fingerprint starts over.
 */
export class MainCheckoutLines {
  private lines: MainCheckoutLine[] = []

  /** Replaces the whole set. */
  report(found: MainCheckoutLine[]): void {
    const before = new Map(this.lines.map((line) => [line.repo, line]))
    this.lines = found.map((line) => {
      const earlier = before.get(line.repo)
      return earlier && earlier.fingerprint === line.fingerprint ? { ...line, since: earlier.since } : line
    })
  }

  current(): MainCheckoutLine[] {
    return this.lines
  }
}
