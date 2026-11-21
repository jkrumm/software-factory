import { describe, expect, test } from 'bun:test'
import {
  anchorOf,
  imageAnchorOf,
  imageRefs,
  readableText,
  readAnnotation,
  readComment,
  readSubmission,
  renderDecisionForm,
} from '../../src/domains/checkpoints/artifact.ts'
import { srcHash } from '@software-factory/contract'
import {
  defaultAt,
  defaultDue,
  type DecisionForm,
  guardVerdict,
  judgeInputOf,
  precedentTerms,
  readDecisionForm,
  refuseNoOpDefault,
  scrub,
} from '../../src/domains/checkpoints/decision.ts'
import {
  checkErrandScreen,
  readErrand,
  refuseHostClass,
  refuseUndialogable,
  screenByRule,
  screenByNeed,
} from '../../src/domains/errands/errand.ts'
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
    expect(!read.ok && read.error.detail).toContain('--recommendation "<label>"')
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

describe('the default', () => {
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
    expect(readAnnotation({ quote: 'a', comment: 'b' })).toMatchObject({
      ok: true,
      value: { path: null, occurrence: null, prefix: null, suffix: null, image: null },
    })
  })

  test('an annotation may name its occurrence and the text around the quote; all three are optional', () => {
    expect(readAnnotation({ quote: 'a', comment: 'b', occurrence: 2, prefix: 'before ', suffix: ' after' })).toEqual({
      ok: true,
      value: { quote: 'a', path: null, occurrence: 2, prefix: 'before ', suffix: ' after', image: null, comment: 'b' },
    })
    // a space at the edge is part of the context, an empty one is none
    expect(readAnnotation({ quote: 'a', comment: 'b', occurrence: 0, prefix: '', suffix: ' x' })).toMatchObject({
      value: { occurrence: 0, prefix: null, suffix: ' x' },
    })
    for (const bad of [
      { occurrence: -1 },
      { occurrence: 1.5 },
      { occurrence: 2_147_483_648 },
      { occurrence: '1' },
      { prefix: 3 },
      { suffix: 'x'.repeat(500) },
    ]) {
      const read = readAnnotation({ quote: 'a', comment: 'b', ...bad })
      expect(read.ok).toBe(false)
    }
  })

  test('an annotation may hang on a picture: the quote is derived, a spot is both coordinates, the text fields are not kept', () => {
    expect(
      readAnnotation({
        quote: 'ignored',
        occurrence: 4,
        prefix: 'x',
        path: ' Screens ',
        comment: ' b ',
        image: { occurrence: 1, srcHash: 'a1b2c3d4', label: '  Overview \n page ' },
      }),
    ).toEqual({
      ok: true,
      value: {
        quote: 'Image 2: Overview page',
        path: 'Screens',
        occurrence: null,
        prefix: null,
        suffix: null,
        image: { occurrence: 1, srcHash: 'a1b2c3d4', label: 'Overview page', x: null, y: null },
        comment: 'b',
      },
    })
    expect(readAnnotation({ comment: 'b', image: { occurrence: 0, srcHash: '', x: 0.25, y: 1 } })).toMatchObject({
      ok: true,
      value: { quote: 'Image 1 · spot 25% / 100%', image: { label: '', x: 0.25, y: 1 } },
    })
    // a null x and y are none
    expect(readAnnotation({ comment: 'b', image: { occurrence: 0, srcHash: '', x: null, y: null } })).toMatchObject({
      value: { image: { x: null, y: null } },
    })
  })

  test('a picture annotation names each wrong field of its image, and still needs its comment', () => {
    const fields = (raw: Record<string, unknown>) => {
      const read = readAnnotation({ comment: 'b', ...raw })
      return read.ok ? [] : read.error.fields
    }
    expect(fields({ image: {} })).toEqual([
      'image.occurrence (a whole number from 0)',
      "image.srcHash ('' or up to 8 lowercase hex characters)",
    ])
    expect(fields({ image: 'first' })).toEqual(['image (an object: occurrence, srcHash, label, x, y)'])
    expect(fields({ comment: ' ', image: { occurrence: 0, srcHash: '' } })).toEqual(['comment'])
    const good = { occurrence: 0, srcHash: 'abcdef12' }
    for (const [image, field] of [
      [{ ...good, occurrence: -1 }, 'image.occurrence'],
      [{ ...good, occurrence: 1.5 }, 'image.occurrence'],
      [{ ...good, occurrence: 2_147_483_648 }, 'image.occurrence'],
      [{ ...good, occurrence: '1' }, 'image.occurrence'],
      [{ ...good, srcHash: 'ABCDEF12' }, 'image.srcHash'],
      [{ ...good, srcHash: 'abcdef123' }, 'image.srcHash'],
      [{ ...good, srcHash: 7 }, 'image.srcHash'],
      [{ ...good, label: 3 }, 'image.label'],
      [{ ...good, label: 'x'.repeat(301) }, 'image.label'],
      [{ ...good, x: 0.5 }, 'image.x and image.y'],
      [{ ...good, y: 0.5 }, 'image.x and image.y'],
      [{ ...good, x: 1.1, y: 0.5 }, 'image.x and image.y'],
      [{ ...good, x: 0.5, y: -0.1 }, 'image.x and image.y'],
      [{ ...good, x: '0.5', y: 0.5 }, 'image.x and image.y'],
    ] as const) {
      expect(fields({ image }).map((f) => f.split(' (')[0])).toEqual([field])
    }
    // a label of exactly the cap is fine once its whitespace is folded
    expect(readAnnotation({ comment: 'b', image: { ...good, label: ` ${'x'.repeat(300)} ` } }).ok).toBe(true)
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

  test('a Markdown quote is found across table cells, raw tags, escapes and entities, as the page shows them', () => {
    const md = [
      '| Option | Cost |',
      '|:-|-:|',
      '| Fair queue | low \\| cost |',
      '',
      'Alpha<br>beta &amp; gamma \\*not bold\\* caf&eacute; &check;',
    ].join('\n')
    expect(readableText(md, 'markdown')).toBe('Option Cost Fair queue low cost Alphabeta & gamma not bold café ✓')
    // a quote taken from the rendered page: cells come apart with a tab, which folds to a space
    for (const quote of [
      'Option Cost',
      'Fair queue low | cost',
      'Fair queue\tlow | cost',
      'Alphabeta & gamma *not bold* café ✓',
    ])
      expect(anchorOf(md, 'markdown', quote)).toBe('anchored')
    expect(anchorOf(md, 'markdown', 'Option Redis')).toBe('unanchored')
  })

  test('a rule row of a table shows nothing, and a plain rule or list marker is not one', () => {
    expect(readableText('| a | b |\n|-|-|\n| c | d |', 'markdown')).toBe('a b c d')
    expect(readableText('above\n\n---\n\n- item - with a dash', 'markdown')).toBe('above --- item - with a dash')
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
    // the accented letters of Latin-1 and a check mark, written by name, as a page shows them
    expect(readableText('<p>caf&eacute; na&iuml;ve&nbsp;&check; &Uuml;ber</p>', 'html')).toBe('café naïve ✓ Über')
  })

  test('numeric entities out of range or unknown named ones stay as written', () => {
    expect(readableText('<p>&#0; &#x110000; &bogus; &lt;b&gt;</p>', 'html')).toBe('&#0; &#x110000; &bogus; <b>')
  })

  test('a Markdown quote keeps its own marks stripped, as its source (regression)', () => {
    const md = 'Run `make_check` and keep the *queue*.'
    expect(anchorOf(md, 'markdown', 'make_check and keep the queue')).toBe('anchored')
    expect(anchorOf(md, 'markdown', 'keep the *queue*')).toBe('anchored')
  })

  test('the pictures of an HTML document: a figure is one, a bare img or svg is one, one inside an svg is not', () => {
    const html = [
      '<figure><img src="/a.png" alt="alt a"><figcaption>The <b>first</b>\n shot</figcaption></figure>',
      '<img src="/b.png" alt="  Shot  b ">',
      '<svg aria-label="Diagram"><svg aria-label="inner"><circle/></svg><img src="/in.png" alt="inside"></svg>',
      '<figure><figcaption>Late caption</figcaption><svg aria-label="chart"></svg><img src="/skipped.png"></figure>',
      '<figure><p>no picture</p></figure>',
      '<figure><div><figure><img src="/n.png" alt="nested"></figure></div></figure>',
      "<IMG SRC='/c.png' ALT=Upper>",
      '<img data-src="/lazy.png" alt="no src">',
    ].join('\n')
    expect(imageRefs(html, 'html')).toEqual([
      { hash: srcHash('/a.png'), label: 'The first shot' },
      { hash: srcHash('/b.png'), label: 'Shot b' },
      { hash: '', label: 'Diagram' },
      { hash: '', label: 'Late caption' },
      { hash: srcHash('/n.png'), label: 'nested' },
      { hash: srcHash('/c.png'), label: 'Upper' },
      { hash: '', label: 'no src' },
    ])
  })

  test('an image src is read as written: entities decoded, quotes stripped; comments, scripts and styles hide pictures', () => {
    const html = [
      '<img src="/x.png?a=1&amp;b=2" alt="Fish &amp; chips">',
      '<!-- <img src="/commented.png"> -->',
      '<script>document.write(\'<img src="/script.png">\')</script>',
      '<style>img[src="/style.png"] { color: red }</style>',
    ].join('')
    expect(imageRefs(html, 'html')).toEqual([{ hash: srcHash('/x.png?a=1&b=2'), label: 'Fish & chips' }])
  })

  test('an inline svg is labelled as the frame labels it: aria-label, else its <title> (an alt, a caption or none otherwise)', () => {
    const html = [
      '<svg><title>Queue &amp; flow</title><rect/></svg>',
      '<svg aria-label="Named"><title>Ignored</title></svg>',
      '<svg><g/></svg><svg><title>Second title</title></svg>',
      '<figure><svg><title>In a figure</title></svg><figcaption>Caption wins</figcaption></figure>',
      '<svg/><svg><title>After a self-closed one</title></svg>',
      '<svg><svg><circle/></svg><title>After a nested one</title></svg>',
    ].join('')
    expect(imageRefs(html, 'html')).toEqual([
      { hash: '', label: 'Queue & flow' },
      { hash: '', label: 'Named' },
      { hash: '', label: '' },
      { hash: '', label: 'Second title' },
      { hash: '', label: 'Caption wins' },
      { hash: '', label: '' },
      { hash: '', label: 'After a self-closed one' },
      { hash: '', label: 'After a nested one' },
    ])
  })

  test('the pictures of a Markdown document: every image in order, with its title cut off, none in fenced code', () => {
    const md = [
      '# Shots',
      '![First  shot](https://x.test/1.png)',
      'text ![](https://x.test/2.png "A title") and [a link](https://x.test/3.png)',
      '```md',
      '![in code](https://x.test/code.png)',
      '```',
      '~~~',
      '![in tilde](https://x.test/tilde.png)',
      '~~~',
      '![last](./4.png)',
    ].join('\n')
    expect(imageRefs(md, 'markdown')).toEqual([
      { hash: srcHash('https://x.test/1.png'), label: 'First shot' },
      { hash: srcHash('https://x.test/2.png'), label: '' },
      { hash: srcHash('./4.png'), label: 'last' },
    ])
  })

  test('a picture comment is anchored while a picture of the revision resolves from it', () => {
    const image = { occurrence: 1, srcHash: srcHash('/b.png'), label: 'b', x: null, y: null }
    const two = '<img src="/a.png" alt="a"><img src="/b.png" alt="b">'
    expect(imageAnchorOf(two, 'html', image)).toBe('anchored')
    expect(imageAnchorOf('<img src="/b.png" alt="b"><img src="/a.png" alt="a">', 'html', image)).toBe('anchored')
    expect(imageAnchorOf('<img src="/a.png" alt="a"><img src="/c.png" alt="c">', 'html', image)).toBe('unanchored')
    expect(imageAnchorOf('<p>no pictures</p>', 'html', image)).toBe('unanchored')
    expect(imageAnchorOf('![b](/b.png)', 'markdown', image)).toBe('anchored')
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
    expect(readErrand({ detail: 'x', tried: 'y', need: 'hands' }).ok).toBe(false)
    expect(readErrand({ summary: ' Approve the portal ', tried: ' looked for a token ', need: 'hands' })).toMatchObject(
      {
        ok: true,
        value: { summary: 'Approve the portal', tried: 'looked for a token' },
      },
    )
  })

  test('an Errand names what was tried, and the refusal says so', () => {
    const read = readErrand({ summary: 'Approve the portal', need: 'hands' })
    expect(read.ok).toBe(false)
    expect(!read.ok && read.error.fields[0]).toStartWith('tried')
  })

  test('an Errand for what the host does is refused with the route to take', () => {
    const refusal = (summary: string, tried = 'looked around', detail: string | null = null) =>
      refuseHostClass({ summary, detail, tried, check: null, command: null, host: null, needKey: null, need: 'hands' })
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
    // Issue 1114: a sudo step that is the owner's MacBook command passes, whatever the words say.
    expect(
      refuseHostClass({
        summary: 'Run sudo launchctl bootstrap for the agent',
        detail: null,
        tried: 'looked around',
        check: null,
        command: 'sudo launchctl bootstrap system /Library/LaunchDaemons/x.plist',
        host: 'macbook',
        needKey: null,
        need: 'secret',
      }),
    ).toBeNull()
    expect(refusal('Run sudo launchctl bootstrap for the agent')).toContain('MacBook-only')
    // Issues 379 and 443: a verdict pointer for a Report.
    expect(refusal('Point the owner at the verdict: the Report does not show in Needs you')).toContain(
      '--repo software-factory',
    )
    // A person's hands pass.
    expect(refusal('Approve the App Store build in the portal')).toBeNull()
    expect(refusal('Plug the cable into the device')).toBeNull()
  })
})

describe('a command the dialog can run', () => {
  const refusal = (command: string | null) =>
    refuseUndialogable({
      summary: 's',
      detail: null,
      tried: 't',
      check: null,
      command,
      host: 'macbook',
      needKey: null,
      need: 'hands',
    })

  test('ssh -t and a sudo that asks on a terminal are refused with the sudo -S route', () => {
    for (const command of [
      'ssh -t homelab sudo systemctl restart x',
      'ssh -tt homelab "sudo -S true"',
      'ssh -o RequestTTY=yes homelab true',
      'ssh -i ~/.ssh/k -t homelab uptime',
      'sudo launchctl bootstrap system /Library/LaunchDaemons/x.plist',
      'ssh homelab sudo sysctl -w kern.maxvnodes=1',
      "ssh homelab 'sudo -u root restic unlock'",
      'cd /tmp && sudo make install',
    ]) {
      expect({ command, refusal: refusal(command) }).toEqual({
        command,
        refusal: expect.stringContaining('sudo -S'),
      })
    }
  })

  test('sudo -S piped from op, sudo -n, a plain command and a remote -t flag pass', () => {
    for (const command of [
      null,
      'make keys',
      'op read "op://Private/homelab-server/password" --account <account> | ssh homelab \'sudo -S restic unlock\'',
      'ssh homelab sudo -n true',
      'sudo -u root -S true',
      'ssh homelab ls -t /var/log',
      'ssh-keygen -t ed25519 -f /tmp/k',
      'ssh -o BatchMode=yes homelab true',
      'echo pseudo-sudoers',
    ])
      expect({ command, refusal: refusal(command) }).toEqual({ command, refusal: null })
  })
})

describe('the Errand screen', () => {
  test('a root step with a MacBook command reaches the owner by rule, and a rule turn-away never names the password', () => {
    expect(
      screenByNeed({ summary: 'Install the daemon', detail: null, command: 'sudo make install', host: 'macbook' }),
    ).toMatchObject({ need: 'secret', note: expect.stringContaining('sudo password') })
    expect(screenByNeed({ summary: 'Install the daemon', detail: null, command: null, host: null })).toBeNull()
    expect(
      screenByNeed({ summary: 'Click the button', detail: null, command: 'make deploy', host: 'macbook' }),
    ).toBeNull()
    expect(screenByNeed({ summary: 'Install', detail: null, command: 'sudo make install', host: 'iphone' })).toBeNull()
    expect(screenByRule({ summary: 'Bootstrap', detail: 'Run `launchctl bootstrap` with sudo' })).toBeNull()
  })

  test('a release for the mini reaches the owner by rule as an approval, a reseal as a secret, and neither asks the model', () => {
    expect(
      screenByNeed({
        summary: "Release the colleague's commit",
        detail: null,
        command: "ssh mini 'make -C ~/gate deploy-release SHA=78088f16'",
        host: 'macbook',
      }),
    ).toMatchObject({ need: 'approval' })
    expect(
      screenByNeed({
        summary: 'Reseal the mini secrets',
        detail: null,
        command: "cd ~/SourceRoot/dotfiles && hc run --timeout 900 'make secrets-seed'",
        host: 'macbook',
      }),
    ).toMatchObject({ need: 'secret' })
    // a command that names a secret is never an approval, whatever it is addressed to
    expect(
      screenByNeed({ summary: 'Install', detail: null, command: "ssh mini 'sudo make install'", host: 'macbook' }),
    ).toMatchObject({ need: 'secret' })
  })

  test('a MacBook command that runs op reaches the owner by rule, whatever the verb, flags or pipe (issue 1664)', () => {
    const command = "op item get shutterflow-masters-b2 --account acct --fields label=key --reveal | ssh box 'b2 ls'"
    expect(
      screenByNeed({ summary: 'Read-only B2 listing probe', detail: null, command, host: 'macbook' }),
    ).toMatchObject({ need: 'secret' })
    for (const line of [
      'op --account acct item get x',
      'op document get x > f',
      'op inject -i a.tpl',
      'echo 1 | op whoami',
    ])
      expect(screenByNeed({ summary: 'List it', detail: null, command: line, host: 'macbook' })).toMatchObject({
        need: 'secret',
      })
    // an unrelated word that starts with op, and an op command addressed to no MacBook, are left to the screen
    expect(screenByNeed({ summary: 'List it', detail: null, command: 'ops item get x', host: 'macbook' })).toBeNull()
    expect(screenByNeed({ summary: 'List it', detail: null, command: command, host: 'portal' })).toBeNull()
  })

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
    expect(screenByRule({ summary: 'Deploy it', detail: 'Run `make deploy` on the MacBook' })).toBeNull()
    for (const words of [
      'Approve the prompt',
      'Press OK',
      'Answer the dialog',
      'Watch the screen',
      'On the laptop',
      'The sim card',
      'Grant the permission prompt',
    ])
      expect(screenByRule({ summary: words, detail: 'then run `make deploy`' })).toBeNull()
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
