import { describe, expect, test } from 'bun:test'
import {
  anchorOf,
  readableText,
  readAnnotation,
  readComment,
  readSubmission,
  renderDecisionForm,
} from '../../src/domains/checkpoints/artifact.ts'
import {
  defaultAt,
  defaultDue,
  type DecisionForm,
  guardVerdict,
  judgeInputOf,
  matchPolicy,
  precedentTerms,
  readDecisionForm,
  refuseNoOpDefault,
  scrub,
} from '../../src/domains/checkpoints/decision.ts'
import { checkErrandScreen, readErrand, refuseHostClass, screenByRule } from '../../src/domains/checkpoints/errand.ts'
import {
  decisionPageKey,
  deepLink,
  errandPage,
  issueHead,
  pageBackoffMs,
  quote,
  redact,
  reviewPageKey,
} from '../../src/domains/checkpoints/page.ts'
import type { DecisionId } from '../../src/domains/checkpoints/decision.ts'

const RAW = {
  question: 'Which logging library should the server use?',
  recommendation: 'pino',
  checked: 'Read the package sizes and the Bun support notes.',
  options: [
    { label: 'pino', reversible: true, cost: 'one dependency, fast' },
    { label: 'winston', reversible: true, cost: 'heavier, more transports' },
    { label: 'drop the table', reversible: false, cost: 'the rows are gone' },
  ],
  noAnswer: { consequence: 'The lead logs with console until someone answers.', default: 'pino', waitMinutes: 30 },
}

const form = (): DecisionForm => {
  const read = readDecisionForm(RAW)
  if (!read.ok) throw new Error(read.error.detail)
  return read.value
}

describe('readDecisionForm', () => {
  test('a complete form reads', () => {
    expect(form()).toMatchObject({ recommendation: 'pino', noAnswer: { default: 'pino', waitMinutes: 30 } })
  })

  test('a missing field is refused with the field named', () => {
    const { recommendation: _gone, ...without } = RAW
    const read = readDecisionForm(without)
    expect(read).toMatchObject({ ok: false, error: { kind: 'missing_field' } })
    expect(!read.ok && read.error.fields).toContain('recommendation')
  })

  test('every missing field is named at once, nested ones by their path', () => {
    const read = readDecisionForm({
      question: 'q',
      options: [
        { label: 'a', reversible: true },
        { label: 'b', cost: 'x' },
      ],
    })
    expect(!read.ok && read.error.fields).toEqual(
      expect.arrayContaining([
        'recommendation',
        'checked',
        'options[0].cost',
        'options[1].reversible',
        'noAnswer.consequence',
      ]),
    )
  })

  test('a non-object is refused, not thrown on', () => {
    expect(readDecisionForm(null).ok).toBe(false)
    expect(readDecisionForm('a question').ok).toBe(false)
  })

  test('the recommendation and the default must be options; a default must be reversible and carry its wait', () => {
    const fields = (patch: Record<string, unknown>) => {
      const read = readDecisionForm({ ...RAW, ...patch })
      return read.ok ? [] : read.error.fields
    }
    expect(fields({ recommendation: 'bunyan' })[0]).toContain('recommendation')
    expect(fields({ noAnswer: { consequence: 'c', default: 'bunyan', waitMinutes: 5 } })[0]).toContain(
      'noAnswer.default',
    )
    expect(fields({ noAnswer: { consequence: 'c', default: 'drop the table', waitMinutes: 5 } })[0]).toContain(
      'not reversible',
    )
    expect(fields({ noAnswer: { consequence: 'c', default: 'pino' } })[0]).toContain('noAnswer.waitMinutes')
    expect(fields({ noAnswer: { consequence: 'c', waitMinutes: 5 } })[0]).toContain('noAnswer.default')
  })

  test('a recommendation that is no option lists the options, every violation at once', () => {
    const read = readDecisionForm({
      ...RAW,
      recommendation: 'use pino because it is fast',
      noAnswer: { consequence: 'c', default: 'bunyan', waitMinutes: 5 },
    })
    expect(read.ok).toBe(false)
    const fields = read.ok ? [] : read.error.fields
    expect(fields).toHaveLength(2)
    for (const field of fields) expect(field).toContain('the options are: pino | winston | drop the table')
    expect(!read.ok && read.error.detail).toContain('recommendation (not one of the options')
  })

  test('a Decision without a default needs only its consequence', () => {
    const read = readDecisionForm({ ...RAW, noAnswer: { consequence: 'It waits.' } })
    expect(read).toMatchObject({ ok: true, value: { noAnswer: { default: null, waitMinutes: null } } })
  })

  test('one option is no decision; labels are unique', () => {
    expect(readDecisionForm({ ...RAW, options: [RAW.options[0]] }).ok).toBe(false)
    const twice = readDecisionForm({ ...RAW, options: [RAW.options[0], { ...RAW.options[0], label: 'PINO' }] })
    expect(!twice.ok && twice.error.fields.join()).toContain('same label')
  })
})

describe('standing policy and the default', () => {
  test('the first matching rule whose answer is an option settles it', () => {
    const rules = [
      { when: 'database', answer: 'postgres', reason: 'one store' },
      { when: 'LOGGING library', answer: 'unknown', reason: 'not an option' },
      { when: 'logging library', answer: 'WINSTON', reason: 'owner prefers it' },
    ]
    expect(matchPolicy(rules, form())).toMatchObject({ answer: 'winston', rule: { when: 'logging library' } })
    expect(matchPolicy([{ when: 'cache', answer: 'pino', reason: 'x' }], form())).toBeNull()
    expect(matchPolicy([{ when: '  ', answer: 'pino', reason: 'x' }], form())).toBeNull()
  })

  test('the default is due once the wait has run out, and not before', () => {
    const asked = new Date('2026-03-01T12:00:00Z')
    expect(defaultDue(form(), asked, new Date('2026-03-01T12:29:59Z'))).toBeNull()
    expect(defaultDue(form(), asked, new Date('2026-03-01T12:30:00Z'))).toBe('pino')
    expect(defaultAt(form(), asked)?.toISOString()).toBe('2026-03-01T12:30:00.000Z')
    const noDefault = readDecisionForm({ ...RAW, noAnswer: { consequence: 'It waits.' } })
    expect(noDefault.ok && defaultDue(noDefault.value, asked, new Date('2027-01-01T00:00:00Z'))).toBeNull()
  })
})

describe('guardVerdict', () => {
  const verdict = (patch: Partial<{ answer: string; source: string }> = {}) => ({
    verdict: 'answer' as const,
    answer: 'pino',
    reason: 'the plan says so',
    source: 'plan: docs/decisions.md',
    ...patch,
  })

  test('an answer that is an option with a source stands', () => {
    expect(guardVerdict(form(), verdict({ answer: ' PINO ' }))).toEqual({
      ok: true,
      answer: 'pino',
      source: 'plan: docs/decisions.md',
    })
  })

  test("no source, an answer that is no option, or an irreversible option is the owner's", () => {
    expect(guardVerdict(form(), verdict({ source: ' ' }))).toMatchObject({
      ok: false,
      why: 'the answer names no source',
    })
    expect(guardVerdict(form(), verdict({ answer: 'bunyan' }))).toMatchObject({ ok: false })
    expect(guardVerdict(form(), verdict({ answer: 'drop the table' }))).toMatchObject({
      ok: false,
      why: expect.stringContaining('cannot be taken back'),
    })
  })
})

describe('what goes to the Judge', () => {
  test("precedent terms are the question's words as an OR query, safe for to_tsquery", () => {
    expect(precedentTerms("Which retention for the audit log's rows?")).toBe('retention | audit | log | rows')
    expect(precedentTerms("'; DROP TABLE x; --")).toBe('drop | table')
    expect(precedentTerms('a of to')).toBeNull()
  })

  test('secrets are scrubbed from what leaves for the model', () => {
    expect(scrub('use token=abcd1234efgh and Bearer abcdefghijkl1234 at https://u:p@host/x')).not.toMatch(
      /abcd1234efgh|abcdefghijkl1234|u:p@/,
    )
    const input = judgeInputOf({
      decision: 'decision_1' as DecisionId,
      repo: 'example',
      issue: 'password: hunter2hunter2',
      form: { ...form(), checked: 'sk-abcdefghijklmnop was checked' },
      precedents: [],
    })
    expect(JSON.stringify(input)).not.toMatch(/hunter2hunter2|sk-abcdefghijklmnop/)
  })

  test("the Judge is told the repo's name, never the path it lives at", () => {
    const input = judgeInputOf({
      decision: 'decision_1' as DecisionId,
      repo: '/Users/someone/SourceRoot/software-factory',
      issue: 'the probe fails',
      form: form(),
      precedents: [
        {
          question: 'q',
          answer: 'a',
          settledBy: 'owner',
          worthAsking: true,
          repo: '/Users/someone/SourceRoot/dotfiles',
        },
      ],
    })
    expect(input.repo).toBe('software-factory')
    expect(input.precedents[0]?.repo).toBe('dotfiles')
    expect(JSON.stringify(input)).not.toContain('/Users')
  })
})

describe('artifacts', () => {
  test('a submission names what is missing', () => {
    const read = readSubmission({ kind: 'memo', title: '', content: 'x' })
    expect(!read.ok && read.error.fields.join()).toMatch(/title.*kind/)
    expect(readSubmission({ kind: 'spec', title: 'T', content: '# T' })).toMatchObject({
      ok: true,
      value: { format: 'markdown' },
    })
    expect(readSubmission({ kind: 'decision', title: 'T', content: 'x' }).ok).toBe(false)
  })

  test('an annotation needs its quote and its comment', () => {
    const read = readAnnotation({ path: '' })
    expect(!read.ok && read.error.fields).toEqual(expect.arrayContaining(['quote', 'comment']))
    expect(readAnnotation({ quote: 'a', comment: 'b' })).toMatchObject({ ok: true, value: { path: null } })
  })

  test('an edited comment is trimmed, not empty and not over the cap', () => {
    expect(readComment({ comment: '  fixed  ' })).toEqual({ ok: true, value: 'fixed' })
    for (const raw of [{}, { comment: '   ' }, { comment: 'x'.repeat(100_000) }, null]) {
      expect(readComment(raw).ok).toBe(false)
    }
  })

  test('a Markdown quote is found through the marks that do not show', () => {
    const md = '# Plan\n\nWe **keep** the _queue_ in [Postgres](https://example.com/pg).\n\n- first\n- second'
    expect(readableText(md, 'markdown')).toBe('Plan We keep the queue in Postgres. first second')
    expect(anchorOf(md, 'markdown', 'keep the queue in Postgres')).toBe('anchored')
    expect(anchorOf(md, 'markdown', 'keep the queue in Redis')).toBe('unanchored')
  })

  test('an HTML quote is found in its text, not its tags or scripts', () => {
    const html =
      '<h1>Plan</h1><p>We keep the <b>queue</b> in Postgres &amp; Redis.</p><script>const secret = "hidden"</script>'
    expect(anchorOf(html, 'html', 'keep the queue in Postgres & Redis')).toBe('anchored')
    expect(anchorOf(html, 'html', 'hidden')).toBe('unanchored')
    expect(anchorOf(html, 'html', '<b>')).toBe('unanchored')
  })

  test('an HTML quote matches what the browser shows: marks kept, inline tags glued, entities decoded', () => {
    const html =
      '<p>Run <code>make</code>, then <code>make_check</code> &middot; see &#183; and &#xB7; &mdash; <em>done</em>.</p><!-- hidden --><div>a</div><div>b</div>'
    expect(readableText(html, 'html')).toBe('Run make, then make_check \u00b7 see \u00b7 and \u00b7 \u2014 done. a b')
    for (const quote of ['make,', 'make_check', 'make_check \u00b7 see', 'see \u00b7 and \u00b7 \u2014 done.', 'a b'])
      expect(anchorOf(html, 'html', quote)).toBe('anchored')
    for (const quote of ['make ,', 'makecheck', 'hidden', '&middot;'])
      expect(anchorOf(html, 'html', quote)).toBe('unanchored')
  })

  test('typographic quotes and common symbols decode', () => {
    expect(readableText('<p>don&rsquo;t &ldquo;stop&rdquo; at 5&deg; &ne; 6</p>', 'html')).toBe(
      'don’t “stop” at 5° ≠ 6',
    )
  })

  test('numeric entities out of range or unknown named ones stay as written', () => {
    expect(readableText('<p>&#0; &#x110000; &bogus; &lt;b&gt;</p>', 'html')).toBe('&#0; &#x110000; &bogus; <b>')
  })

  test('a Markdown quote keeps its own marks stripped, as its source (regression)', () => {
    const md = 'Run `make_check` and keep the *queue*.'
    expect(anchorOf(md, 'markdown', 'make_check and keep the queue')).toBe('anchored')
    expect(anchorOf(md, 'markdown', 'keep the *queue*')).toBe('anchored')
  })

  test('an empty quote anchors nowhere', () => {
    expect(anchorOf('text', 'markdown', '  ')).toBe('unanchored')
  })

  test('a Decision renders as its form', () => {
    const text = renderDecisionForm(form())
    expect(text).toContain('# Which logging library should the server use?')
    expect(text).toContain('**drop the table** (not reversible)')
    expect(text).toContain('After 30 minutes the default is taken: **pino**')
  })
})

describe('errands', () => {
  test('an Errand needs its summary', () => {
    expect(readErrand({ detail: 'x', tried: 'y' }).ok).toBe(false)
    expect(readErrand({ summary: ' Approve the portal ', tried: ' looked for a token ' })).toMatchObject({
      ok: true,
      value: { summary: 'Approve the portal', tried: 'looked for a token' },
    })
  })

  test('an Errand names what was tried, and the refusal says so', () => {
    const read = readErrand({ summary: 'Approve the portal' })
    expect(read.ok).toBe(false)
    expect(!read.ok && read.error.fields[0]).toStartWith('tried')
  })

  test('an Errand for what the host does is refused with the route to take', () => {
    const refusal = (summary: string, tried = 'looked around', detail: string | null = null) =>
      refuseHostClass({ summary, detail, tried })
    // Issue 409: a token mint and a door route.
    expect(refusal('Mint a door token for kuma and set its route')).toContain('factory door token new')
    // Issue 412: monitor routes into other repos.
    expect(refusal('Set the 11 HyperDX monitor routes to the other repos')).toContain(
      'factory signal file --from agent:',
    )
    // Issue 425: installs.
    expect(refusal('Install exiftool and magick on the mini')).toContain('Makefile target')
    expect(refusal('Run brew install exiftool')).toContain('Makefile target')
    // Issue 483: a sudo step, unless the lead shows what it ran without.
    expect(refusal('Run sudo launchctl bootstrap for the agent')).toContain('without root')
    expect(
      refusal('Run sudo launchctl bootstrap for the agent', 'tried it without sudo: the plist needs /Library'),
    ).toBeNull()
    // Issues 379 and 443: a verdict pointer for a Report.
    expect(refusal('Point the owner at the verdict: the Report does not show in Needs you')).toContain(
      '--repo software-factory',
    )
    // A person's hands pass.
    expect(refusal('Approve the App Store build in the portal')).toBeNull()
    expect(refusal('Plug the cable into the device')).toBeNull()
  })
})

describe('the Errand screen', () => {
  test('a command a token can run is turned away by rule', () => {
    expect(screenByRule({ summary: 'Run `make deploy`', detail: null })).toMatchObject({ verdict: 'turn_away' })
    expect(screenByRule({ summary: 'Deploy it', detail: 'Use `gh pr merge 12` for this' })).toMatchObject({
      verdict: 'turn_away',
    })
    expect(screenByRule({ summary: 'Deploy it', detail: '```\nmake deploy\n```' })).toMatchObject({
      verdict: 'turn_away',
    })
    expect(screenByRule({ summary: 'Deploy it', detail: '$ git push' })?.reason.length).toBeLessThanOrEqual(300)
  })

  test('a hands word, or no command, keeps the Errand', () => {
    expect(
      screenByRule({ summary: 'Run the deploy', detail: 'Tap the button in the portal after `make deploy`' }),
    ).toBeNull()
    expect(screenByRule({ summary: 'Call the bank to lift the card block', detail: null })).toBeNull()
    expect(screenByRule({ summary: 'Run the deploy', detail: null })).toBeNull()
    expect(screenByRule({ summary: 'Approve the App Store build', detail: null })).toBeNull()
    expect(screenByRule({ summary: 'Plug in the phone', detail: 'It is on the desk' })).toBeNull()
  })

  test('an answer is held to its shape', () => {
    expect(checkErrandScreen({ verdict: 'pass', reason: ' a person ' })).toEqual({ action: 'pass', note: 'a person' })
    expect(checkErrandScreen({ verdict: 'turn_away', reason: ` ${'x'.repeat(400)} ` })).toEqual({
      action: 'turn_away',
      reason: 'x'.repeat(300),
    })
    expect(checkErrandScreen({ verdict: 'turn_away', reason: '   ' }).action).toBe('refused')
  })
})

describe("the owner's line", () => {
  test("a lead's words are quoted, redacted and cut", () => {
    const text = quote('Use op://vault/item/field and 10.0.0.12 at /Users/someone/secret/path/file.txt "now"')
    expect(text).toBe("“Use [secret] and [host] at …/file.txt 'now'”")
    expect(quote('word '.repeat(80))).toHaveLength(202)
    expect(redact('https://example.com/a?token=abc#frag')).toBe('https://example.com/a')
  })

  test('the head names the number and the repo, never a path', () => {
    expect(issueHead({ id: 'issue_12', repo: '/Users/someone/SourceRoot/software-factory' })).toBe(
      'Issue 12 (software-factory)',
    )
  })

  test("a page key is the checkpoint's: a replay finds the page it planned", () => {
    expect(decisionPageKey('decision_1')).toBe(decisionPageKey('decision_1'))
    expect(reviewPageKey('artifact_1', 1)).not.toBe(reviewPageKey('artifact_1', 2))
    const page = errandPage({
      issue: { id: 'issue_3', repo: 'example' },
      link: deepLink('https://console.example.test/', 'errand_1'),
      errand: 'errand_1',
      summary: 'Approve the App Store build',
    })
    expect(page).toMatchObject({ kind: 'errand', link: 'https://console.example.test/checkpoints/errand_1' })
    expect(page.body).toBe('Issue 3 (example) needs your hands: “Approve the App Store build”')
  })

  test('the backoff doubles from 30 s to 5 min', () => {
    expect([1, 2, 3, 4, 5, 6].map(pageBackoffMs)).toEqual([30_000, 60_000, 120_000, 240_000, 300_000, 300_000])
  })
})

describe('refuseNoOpDefault', () => {
  const withLabel = (label: string): DecisionForm => ({
    ...form(),
    recommendation: label,
    noAnswer: { consequence: 'x', default: null, waitMinutes: null },
  })

  test.each(['Keep waiting', 'keep waiting for the review', 'Wait for review', 'Do nothing', 'Hold', 'No-op'])(
    '%s is no choice',
    (label) => {
      expect(refuseNoOpDefault(withLabel(label))).toContain('factory errand raise')
    },
  )

  test.each([
    'pino',
    'Wait for Issue 12 to land, then ship',
    'Wait for Issue 12 to land then ship',
    'Hold the release and ship the hotfix instead',
    'Merge when CI is green',
  ])('%s is a choice', (label) => {
    expect(refuseNoOpDefault(withLabel(label))).toBeNull()
  })

  test('a no-op default is refused even when the recommendation is real', () => {
    const base = form()
    const read = { ...base, noAnswer: { consequence: 'x', default: 'Keep waiting', waitMinutes: 30 } }
    expect(refuseNoOpDefault(read)).toContain('"Keep waiting"')
  })
})
