import type { Review, ReviewRead } from '../../src/issues/review.ts'

/** Review v4 as a test says it is: nothing to review until a test sets an answer. */
export class FakeReview implements Review {
  answer: ReviewRead = { tier: 'none', covered: true, uncovered: [] }
  /** one answer per call, in order, before `answer` */
  answers: ReviewRead[] = []
  failure?: Error
  asked: { repo: string; base: string; head: string }[] = []
  async read(input: { repo: string; base: string; head: string }): Promise<ReviewRead> {
    this.asked.push(input)
    if (this.failure) throw this.failure
    return this.answers.shift() ?? this.answer
  }
}
