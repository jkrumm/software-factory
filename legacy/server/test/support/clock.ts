import type { Clock } from '../../src/clock.ts'

/** Time only moves when told to; `sleep` records the request and advances time without waiting. */
export class FakeClock implements Clock {
  readonly sleeps: number[] = []

  constructor(private current: Date = new Date('2026-10-30T12:00:00.000Z')) {}

  now(): Date {
    return new Date(this.current)
  }

  advance(ms: number): void {
    this.current = new Date(this.current.getTime() + ms)
  }

  async sleep(ms: number): Promise<void> {
    this.sleeps.push(ms)
    this.advance(ms)
  }
}
