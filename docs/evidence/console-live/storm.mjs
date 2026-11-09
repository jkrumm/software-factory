import { createRequire } from 'node:module'
import fs from 'node:fs'
const require = createRequire('~/SourceRoot/software-factory/node_modules/.bun/playwright-core@1.64.1/node_modules/playwright-core/package.json')
const { chromium } = require('playwright-core')
const BASE = process.env.BASE ?? 'http://127.0.0.1:7795'
const OUT = process.env.OUT ?? '/tmp/console-perf/before'
const cpu = Number(process.env.CPU ?? 1)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const INIT = () => {
  const Orig = window.EventSource
  window.__es = []
  window.EventSource = class extends Orig { constructor(...a) { super(...a); window.__es.push(this) } }
}
const browser = await chromium.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true })
const results = {}
for (const [name, path] of [['needs-you', '/needs-you'], ['flow', '/flow'], ['improve', '/improve'], ['issue', '/issues/528']]) {
  for (const hz of [1, 4]) {
    const ctx = await browser.newContext({ viewport: { width: 1800, height: 1200 } })
    await ctx.addInitScript(INIT)
    const page = await ctx.newPage()
    const cdp = await ctx.newCDPSession(page)
    await cdp.send('Network.enable'); await cdp.send('Performance.enable')
    if (cpu > 1) await cdp.send('Emulation.setCPUThrottlingRate', { rate: cpu })
    const reqs = []
    cdp.on('Network.requestWillBeSent', (e) => { if (e.request.url.includes('/v1/') && !e.request.url.includes('stream')) reqs.push({ t: Date.now(), url: e.request.url.replace(BASE, '').split('?')[0] }) })
    await page.goto(BASE + path, { waitUntil: 'load' })
    await sleep(3500)
    await page.evaluate(() => {
      window.__mut = 0; window.__lt = []
      new MutationObserver((r) => (window.__mut += r.length)).observe(document, { subtree: true, childList: true, attributes: true, characterData: true })
      new PerformanceObserver((l) => l.getEntries().forEach((e) => window.__lt.push(Math.round(e.duration)))).observe({ type: 'longtask' })
    })
    const metrics = async () => Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map((m) => [m.name, m.value]))
    const m0 = await metrics(); const q0 = reqs.length; const t0 = Date.now()
    // fire hz events per second for 10 s as the stream would: one change event, a debounced invalidate follows
    const total = 10 * hz
    for (let i = 0; i < total; i++) {
      await page.evaluate(([kind, ref]) => { const es = window.__es.at(-1); const cursor = '1.' + Math.floor(Math.random() * 1e9); es.dispatchEvent(new MessageEvent(kind, { data: JSON.stringify({ kind, issue: Number(ref.slice(6)), ref, subject: 'applied', detail: {}, at: new Date().toISOString() }), lastEventId: cursor })) }, [process.env.EVENT_KIND ?? 'issue', name === 'issue' ? 'issue_528' : 'issue_999'])
      await sleep(1000 / hz)
    }
    await sleep(1500)
    const m1 = await metrics(); const win = (Date.now() - t0) / 1000
    const o = await page.evaluate(() => ({ mut: window.__mut, lt: window.__lt, dom: document.getElementsByTagName('*').length }))
    const rq = reqs.slice(q0)
    const byUrl = rq.reduce((a, x) => ((a[x.url] = (a[x.url] ?? 0) + 1), a), {})
    const d = (k) => +((m1[k] - m0[k]) * 1000).toFixed(0)
    const r = { eventsPerSec: hz, events: total, winSecs: +win.toFixed(1), requests: rq.length, byUrl, mutations: o.mut, mutPerSec: +(o.mut / win).toFixed(2), longtasks: o.lt, msTask: d('TaskDuration'), msScript: d('ScriptDuration'), msLayout: d('LayoutDuration'), msStyle: d('RecalcStyleDuration'), layoutCount: m1.LayoutCount - m0.LayoutCount, styleRecalc: m1.RecalcStyleCount - m0.RecalcStyleCount, jsHeapMB: +(m1.JSHeapUsedSize / 1e6).toFixed(1), domAfter: o.dom }
    results[`${name}@${hz}Hz`] = r
    console.log(name, hz, JSON.stringify(r))
    await ctx.close()
  }
}
fs.writeFileSync(`${OUT}/storm-injected${process.env.EVENT_KIND ? '-' + process.env.EVENT_KIND : ''}${cpu > 1 ? `-cpu${cpu}x` : ''}.json`, JSON.stringify(results, null, 1))
await browser.close()
