import { admitted, fileIssue, tick } from '../scenarios/flow.ts'
import type { Lab } from '../scenarios/planning/lab.ts'
import { api } from './seed.ts'

/** one repo per lead these artifacts need: a project takes one lead at a time (the lab is started with them) */
export const ARTIFACT_REPOS = ['ember', 'flint']

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
  return { spec, report, revised }
}
