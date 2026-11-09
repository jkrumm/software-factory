import { createRequire } from 'node:module'
import fs from 'node:fs'
const require = createRequire('~/SourceRoot/software-factory/node_modules/.bun/playwright-core@1.64.1/node_modules/playwright-core/package.json')
const { chromium } = require('playwright-core')
const BASE = process.env.BASE ?? 'http://127.0.0.1:7795'
const OUT = process.env.OUT ?? '/tmp/console-perf/before'
const cpu = Number(process.env.CPU ?? 1)
const only = process.env.ONLY?.split(',')
const routes = [
  ['needs-you', '/needs-you'],
  ['flow', '/flow'],
  ['chain', '/chain'],
  ['improve', '/improve'],
  ['issue', '/issues/528'],
  ['issue-523', '/issues/523'],
  ['artifact', '/artifacts/artifact_01a1bece-b8fe-7792-963f-249b5b1d8187'],
  ['artifact-spec', '/artifacts/artifact_01a1bece-b962-7600-839d-108fddf09864'],
  ['checkpoint', '/checkpoints/artifact_01a1bece-b962-7600-839d-108fddf09864'],
].filter(([n]) => !only || only.includes(n))

const INIT = () => {
  window.__lt = []; window.__lcp = null; window.__fcp = null; window.__ev = []; window.__cls = 0
  const obs = (type, cb, extra = {}) => { try { new PerformanceObserver((l) => l.getEntries().forEach(cb)).observe({ type, buffered: true, ...extra }) } catch {} }
  obs('longtask', (e) => window.__lt.push({ s: e.startTime, d: e.duration }))
  obs('largest-contentful-paint', (e) => { window.__lcp = { t: e.startTime, el: e.element?.tagName + '.' + (e.element?.className || '').toString().slice(0, 40), size: e.size } })
  obs('paint', (e) => { if (e.name === 'first-contentful-paint') window.__fcp = e.startTime })
  obs('layout-shift', (e) => { if (!e.hadRecentInput) window.__cls += e.value })
  obs('event', (e) => window.__ev.push({ n: e.name, s: e.startTime, d: e.duration, proc: e.processingEnd - e.processingStart }), { durationThreshold: 16 })
}

const browser = await chromium.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true })
const results = {}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

for (const [name, path] of routes) {
  const ctx = await browser.newContext({ viewport: { width: 1800, height: 1200 }, deviceScaleFactor: 1 })
  await ctx.addInitScript(INIT)
  const page = await ctx.newPage()
  const cdp = await ctx.newCDPSession(page)
  await cdp.send('Network.enable')
  await cdp.send('Network.setCacheDisabled', { cacheDisabled: false })
  if (cpu > 1) await cdp.send('Emulation.setCPUThrottlingRate', { rate: cpu })
  const reqs = new Map()
  cdp.on('Network.requestWillBeSent', (e) => reqs.set(e.requestId, { url: e.request.url, t: e.timestamp, type: e.type, wall: e.wallTime }))
  cdp.on('Network.responseReceived', (e) => { const r = reqs.get(e.requestId); if (r) { r.status = e.response.status; r.fromSW = e.response.fromServiceWorker; r.mime = e.response.mimeType } })
  cdp.on('Network.loadingFinished', (e) => { const r = reqs.get(e.requestId); if (r) { r.enc = e.encodedDataLength; r.done = e.timestamp } })
  const tracePath = `${OUT}/trace-${name}${cpu > 1 ? `-cpu${cpu}x` : ''}.json`
  await browser.startTracing(page, { path: tracePath, categories: ['devtools.timeline', 'disabled-by-default-devtools.timeline', 'v8.execute', 'blink.user_timing', 'loading', 'latencyInfo'] })
  const t0 = Date.now()
  await page.goto(BASE + path, { waitUntil: 'load' })
  await sleep(4000)
  await browser.stopTracing()
  const r = {}
  r.finalUrl = page.url()
  r.dom = await page.evaluate(() => document.getElementsByTagName('*').length)
  Object.assign(r, await page.evaluate(() => {
    const nav = performance.getEntriesByType('navigation')[0]
    const lt = window.__lt
    const fcp = window.__fcp ?? 0
    return { lcp: window.__lcp, fcp: window.__fcp, cls: window.__cls, ttfb: nav.responseStart, dcl: nav.domContentLoadedEventEnd, load: nav.loadEventEnd,
      longtasks: lt.length, longest: lt.reduce((m, x) => Math.max(m, x.d), 0), tbt: lt.filter((x) => x.s >= fcp).reduce((s, x) => s + Math.max(0, x.d - 50), 0), tasks: lt.map((x) => [Math.round(x.s), Math.round(x.d)]) }
  }))
  const all = [...reqs.values()]
  const js = all.filter((x) => x.type === 'Script' || /\.js(\?|$)/.test(x.url))
  r.jsBytes = js.reduce((s, x) => s + (x.enc ?? 0), 0)
  r.jsFiles = js.map((x) => [x.url.replace(BASE, ''), x.enc])
  r.totalBytes = all.reduce((s, x) => s + (x.enc ?? 0), 0)
  r.requests = all.length
  r.v1 = all.filter((x) => x.url.includes('/v1/')).map((x) => x.url.replace(BASE, ''))
  const dist = {}
  for (const x of all) { const k = x.type; dist[k] = (dist[k] ?? 0) + (x.enc ?? 0) }
  r.bytesByType = dist
  await page.screenshot({ path: `${OUT}/shot-${name}${cpu > 1 ? `-cpu${cpu}x` : ''}.png` })
  results[name] = r
  console.log(name, JSON.stringify({ lcp: r.lcp?.t, fcp: r.fcp, dom: r.dom, js: r.jsBytes, lt: r.longtasks, longest: r.longest, tbt: r.tbt, v1: r.v1.length, url: r.finalUrl }))
  await ctx.close()
}
fs.writeFileSync(`${OUT}/load${cpu > 1 ? `-cpu${cpu}x` : ''}.json`, JSON.stringify(results, null, 1))
await browser.close()
