import type { Classifier, ClassifyInput } from '../../src/issues/classify.ts'

/** A classifier the test drives: it answers `answer` (or what `answer` returns), or fails with `failure`, once `gate` opens. */
export class FakeClassifier implements Classifier {
  calls: ClassifyInput[] = []
  answer: unknown | ((input: ClassifyInput) => unknown) = {
    project: null,
    kind: 'bug',
    class: 'routine',
    size: 's',
    tier: 'sonnet',
    effort: 'medium',
    reason: 'a test',
  }
  failure?: Error
  gate?: Promise<void>

  async classify(input: ClassifyInput): Promise<unknown> {
    this.calls.push(input)
    await this.gate
    if (this.failure) throw this.failure
    return typeof this.answer === 'function' ? (this.answer as (i: ClassifyInput) => unknown)(input) : this.answer
  }
}
