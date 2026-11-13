import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { admitted, fileIssue, tick } from '../scenarios/flow.ts'
import type { Lab } from '../scenarios/planning/lab.ts'
import { api } from './seed.ts'

/** one repo per lead these artifacts need: a project takes one lead at a time (the lab is started with them) */
export const ARTIFACT_REPOS = ['ember', 'flint', 'forge', 'gable']

export const SPEC_QUOTE = 'We keep the queue in Postgres because it is already running.'
export const KEPT = 'The lock decides who takes the next row.'
export const DROPPED = 'Retries back off by a minute.'
/** The placeholder the HTML report's probe script targets; the test swaps in its own server's address. */
export const TARGET = '__TARGET__'

export const SPEC_MD = `# Queue storage

## Options

### Cost

${SPEC_QUOTE} The cost is one more table.

### Risk

${KEPT} ${DROPPED}

| Option | Cost |
|-|-|
| Postgres | one table |
| Redis | one more service |
`

const REVISED_MD = `# Queue storage

## Options

### Risk

${KEPT} A failed row is retried at once.
`

export const SHOT_SPEC_MD = `# Queue storage

> **TLDR.** Keep the queue in Postgres: it is already running, it costs one table, and it can move later.

## Decision

Where the queue lives. Without an answer the lead keeps Postgres and files the move as a follow-up.

## Options

| Option | Cost | Reversible |
|-|-|-|
| Postgres | one table, no new service | yes |
| Redis | one more service to run and watch | no |

${SPEC_QUOTE} The cost is one more table, and a failed row is retried by the same worker that took it.

## Risks

- The lock decides who takes the next row; a slow worker holds it longer than a fast one.
- A full table slows every other query on the same disk.

## Proof

The queue ran 2,000 rows through one worker in 11 seconds on the staging copy, with no row taken twice.
`

const FILLER = (topic: string) =>
  [1, 2, 3, 4]
    .map(
      (n) =>
        `Paragraph ${n} on ${topic}: the weather service answers in under a second, the cache holds the last forecast for ten minutes, and a stale answer is shown with its age rather than hidden. The queue behind it retries a failed fetch twice before the lead is told.`,
    )
    .join('\n\n')

export const REVIEW_QUOTE = 'The cache holds the last forecast for ten minutes.'
export const EXTERNAL_URL = 'https://example.com/weatherorb-v2'

/** A long Spec with headings to scroll through and one link of each kind: web, anchor, a Console page, and one with no destination. */
export const reviewMd = (specId: string) => `# Weather rollout

## Context

The tile shows the forecast from [WeatherOrb V2](${EXTERNAL_URL}). ${REVIEW_QUOTE} Read [the risks](#risks) first, or the
[storage spec](/artifacts/${specId}), or the [vault note](weatherorb-v2.md).

${FILLER('context')}

## Options

${FILLER('the options')}

## Risks

${FILLER('the risks')}

## Proof

${FILLER('the proof')}

## Rollout

${FILLER('the rollout')}

## Open questions

${FILLER('the open questions')}
`

export const LINKS_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><title>Links</title><style>body{font-family:system-ui;padding:1rem}section{min-height:900px}</style></head>
<body>
<h1>Link report</h1>
<section><h2 id="intro">Intro</h2>
<p id="web">Read <a id="external" href="${EXTERNAL_URL}">WeatherOrb V2</a>, or jump <a id="anchor" href="#later">to the end</a>, or open <a id="page" href="/issues/1">an Issue</a>.</p>
<p id="claim">The probe ships on Friday and nobody pays for it.</p></section>
<section><h2 id="middle">Middle</h2><p>Nothing happens here.</p></section>
<section><h2 id="later">Later</h2><p>The end of the report.</p></section>
</body></html>
`

export const REPORT_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><title>Probe</title><style>body{font-family:system-ui;padding:1rem}</style></head>
<body>
<h1>Launch report</h1>
<h2>Result</h2>
<p id="claim">The probe ships on Friday and nobody pays for it.</p>
<p id="markup">Run <code>make</code>, then check <code>snake_case_name</code> &middot; see &#183; the <em>notes</em>.</p>
<pre id="probe">pending</pre>
<script>
(async () => {
  const T = '${TARGET}'
  if (!T.startsWith('http')) return
  const out = {}
  const attempt = async (name, fn) => { try { await fn(); out[name] = 'sent' } catch (e) { out[name] = e.name } }
  await attempt('fetch', () => fetch(T + '/fetch'))
  await attempt('xhr', () => new Promise((resolve, reject) => {
    const x = new XMLHttpRequest(); x.open('GET', T + '/xhr'); x.onload = resolve; x.onerror = () => reject(new Error('blocked')); x.send()
  }))
  new Image().src = T + '/img'
  const link = document.createElement('link'); link.rel = 'stylesheet'; link.href = T + '/css'; document.head.appendChild(link)
  await attempt('websocket', () => new Promise((resolve, reject) => {
    const w = new WebSocket(T.replace('http', 'ws') + '/ws'); w.onopen = resolve; w.onerror = () => reject(new Error('blocked'))
  }))
  await attempt('beacon', () => { if (!navigator.sendBeacon(T + '/beacon', 'x')) throw new Error('refused') })
  const form = document.createElement('form'); form.action = T + '/form'; form.method = 'post'; document.body.appendChild(form)
  await attempt('form', () => form.submit())
  out.open = String(window.open(T + '/open'))
  try { parent.document; out.parent = 'READ' } catch (e) { out.parent = e.name }
  document.getElementById('probe').textContent = JSON.stringify(out)
  setTimeout(() => { location = T + '/location' }, 400)
})()
</script>
</body></html>
`

export interface SeededArtifacts {
  spec: string
  report: string
  revised: string
  /** a Spec with no comment yet, for the screenshots (the tests give `spec` its verdict) */
  shotSpec: string
  /** a Report in the shared HTML template with four comments, one of them edited */
  shotReport: string
  /** a long Spec with a link of each kind, to be reviewed (read only: the tests that write use the others) */
  review: string
  /** an HTML Report with an external link, an anchor, a Console link and headings to scroll through */
  links: string
}

/** The shared HTML template, filled in the way a lead would: the result first, a table, a picture, the risks. */
const TEMPLATE = join(import.meta.dir, '..', '..', 'apps', 'console', 'templates', 'artifact.html')
export const SHOT_REPORT_QUOTES = {
  tldr: 'What is proposed, why, and what you are asked to decide, in three sentences at most.',
  decision: 'The one thing that needs a yes, a no or a change.',
  risk: 'What can go wrong and how it would show.',
  proof: 'What was run and what it showed.',
}

/**
 * Artifacts through the lead's own verbs (`artifact submit`, `artifact revise`) on Issues whose leads are real sessions of the
 * fake `hc`: a Markdown Spec awaiting the owner's verdict (its Issue waits on it), an HTML Report, and a Report with two
 * revisions and two comments on the first. Annotations go through the owner's route.
 */
export async function seedArtifacts(lab: Lab): Promise<SeededArtifacts> {
  const url = lab.server.url
  const synced = await lab.cli(['project', 'sync'])
  if (synced.code !== 0) throw new Error(`project sync exited ${synced.code}: ${synced.err}`)
  const lead = async (repo: string, title: string): Promise<string> => {
    const issue = await fileIssue(lab, { repo, title })
    await admitted(lab, issue)
    await tick(lab)
    return issue
  }
  const submit = async (issue: string, body: Record<string, unknown>): Promise<string> =>
    (await api<{ artifact: { id: string } }>(url, `/v1/issues/${issue}/artifacts`, { attempt: 1, ...body })).artifact.id
  const [specIssue, reportIssue] = [
    await lead('ember', 'Write the storage spec'),
    await lead('flint', 'Ship the launch'),
  ]

  const spec = await submit(specIssue, { kind: 'spec', title: 'The storage spec', content: SPEC_MD })
  const report = await submit(reportIssue, {
    kind: 'report',
    title: 'The launch report',
    contentFormat: 'html',
    content: REPORT_HTML,
  })
  const revised = await submit(reportIssue, { kind: 'report', title: 'The queue report', content: SPEC_MD })
  const annotate = (quote: string, comment: string) =>
    api(url, `/v1/artifacts/${revised}/annotations`, {
      revision: 1,
      quote,
      path: 'Queue storage > Options > Risk',
      comment,
    })
  await annotate(KEPT, 'Name the lock.')
  await annotate(DROPPED, 'Why a minute?')
  await api(url, `/v1/artifacts/${revised}/revisions`, { content: REVISED_MD, note: 'Retries are immediate now' })

  const shotSpecIssue = await lead('forge', 'Write the queue options spec')
  const shotSpec = await submit(shotSpecIssue, {
    kind: 'spec',
    title: 'Queue storage, the options',
    content: SHOT_SPEC_MD,
  })
  const onSpec = (quote: string, comment: string, path: string) =>
    api(url, `/v1/artifacts/${shotSpec}/annotations`, { revision: 1, quote, path, comment })
  await onSpec('A full table slows every other query on the same disk.', 'How full is full?', 'Queue storage > Risks')
  await onSpec('with no row taken twice', 'Same run on production data?', 'Queue storage > Proof')
  await onSpec('it can move later', 'Move to what, and when?', 'Queue storage')
  const shotReport = await submit(reportIssue, {
    kind: 'report',
    title: 'The queue report, in the template',
    contentFormat: 'html',
    content: readFileSync(TEMPLATE, 'utf8'),
  })
  const note = (quote: string, comment: string, path: string) =>
    api(url, `/v1/artifacts/${shotReport}/annotations`, { revision: 1, quote, path, comment })
  await note(SHOT_REPORT_QUOTES.tldr, 'Three sentences is enough; keep it.', 'Title of the artifact')
  await note(SHOT_REPORT_QUOTES.decision, 'Who answers this, and by when?', 'Title of the artifact > Decision')
  await note(SHOT_REPORT_QUOTES.risk, 'Which risk would we not take?', 'Title of the artifact > Risks')
  await note(SHOT_REPORT_QUOTES.proof, 'Add the command that was run.', 'Title of the artifact > Proof')
  const stored = await api<{ annotations: { id: string; comment: string }[] }>(url, `/v1/artifacts/${shotReport}`)
  const risky = stored.annotations.find((a) => a.comment === 'Which risk would we not take?')
  if (!risky) throw new Error('the Report comment was not stored')
  const edit = { comment: 'Which risk would we not take, and why?' }
  await api(url, `/v1/artifacts/${shotReport}/annotations/${risky.id}`, edit, 'PATCH')
  const reviewIssue = await lead('gable', 'Roll out the weather tile')
  const review = await submit(reviewIssue, { kind: 'spec', title: 'Weather rollout', content: reviewMd(spec) })
  const links = await submit(reportIssue, {
    kind: 'report',
    title: 'The link report',
    contentFormat: 'html',
    content: LINKS_HTML,
  })
  return { spec, report, revised, shotSpec, shotReport, review, links }
}
