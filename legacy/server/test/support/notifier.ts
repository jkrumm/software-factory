import type { Notifier, SendResult } from '../../src/notify/port.ts'

/** The port's fake: what it was asked to send, and what it answers (a list is used in turn, the last one stays). */
export class FakeNotifier implements Notifier {
  sent: string[] = []
  /** each call takes the next answer; empty means it arrives */
  answers: SendResult[] = []
  calls = 0

  async send(message: string): Promise<SendResult> {
    this.calls++
    const answer = this.answers.length > 1 ? this.answers.shift() : this.answers[0]
    if (answer && !answer.ok) return answer
    this.sent.push(message)
    return { ok: true }
  }

  failWith(error: string): void {
    this.answers = [{ ok: false, error }]
  }

  recover(): void {
    this.answers = []
  }
}
