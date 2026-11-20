import type { MainCheckoutLine } from '../../domains/leads/checkout.ts'

/**
 * The main-checkout findings of the last steward pass, held in memory for the health lines. `since` is when a repo's
 * finding with this fingerprint was first seen; a changed fingerprint starts over.
 */
export class MainCheckoutLines {
  private lines: MainCheckoutLine[] = []

  /** Replaces the whole set. Called through the `findings` port of the steward pass, not on the class. */
  // fallow-ignore-next-line unused-class-member -- called through a port
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
