import { createRequire } from 'node:module'
import fs from 'node:fs'
import { spawn } from 'node:child_process'
const require = createRequire('~/SourceRoot/software-factory/node_modules/.bun/playwright-core@1.64.1/node_modules/playwright-core/package.json')
const { chromium } = require('playwright-core')
const BASE = process.env.BASE ?? 'http://127.0.0.1:7795'
const OUT = process.env.OUT ?? '/tmp/console-perf/before'
const cpu = Number(process.env.CPU ?? 1)
const phase = process.env.PHASE ?? 'ix'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const ART = 'artifact_01a1bece-b8fe-7792-963f-249b5b1d8187'
const routes = [
  ['needs-you', '/needs-you', 'article h3 button'],
  ['flow', '/flow', 'select'],
  ['chain', '/chain', null],
  ['improve', '/improve', 'summary'],
  ['issue', '/issues/528', 'details > summary'],
  ['issue-523', '/issues/523', 'details > summary'],
  ['artifact', `/artifacts/${ART}`, null],
].filter(([n]) => !process.env.ONLY || process.env.ONLY.split(',').includes(n))

const INIT = () => {
  window.__ix = []
  const t = (name) => (e) => { const t0 = performance.now(); const k = name; requestAnimationFrame(() => requestAnimationFrame(() => window.__ix.push({ k, d: performance.now() - t0 }))) }
  addEventListener('click', t('click'), true)
  addEventListener('keydown', t('keydown'), true)
  window.__lt = []
  try { new PerformanceObserver((l) => l.getEntries().forEach((e) => window.__lt.push([Math.round(e.startTime), Math.round(e.duration)]))).observe({ type: 'longtask', buffered: true }) } catch {}
}
const stat = (a) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); return { n: a.length, med: +s[Math.floor(s.length / 2)].toFixed(1), max: +s[s.length - 1].toFixed(1), min: +s[0].toFixed(1) } }

const browser = await chromium.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true })
const results = {}
for (const [name, path, sel] of routes) {
  const ctx = await browser.newContext({ viewport: { width: 1800, height: 1200 } })
  await ctx.addInitScript(INIT)
  const page = await ctx.newPage()
  const cdp = await ctx.newCDPSession(page)
  await cdp.send('Network.enable')
  if (cpu > 1) await cdp.send('Emulation.setCPUThrottlingRate', { rate: cpu })
  const reqs = []
  cdp.on('Network.requestWillBeSent', (e) => { if (e.request.url.includes('/v1/')) reqs.push({ t: Date.now(), url: e.request.url.replace(BASE, '') }) })
  await page.goto(BASE + path, { waitUntil: 'load' })
  await sleep(3000)
  const r = {}
  if (phase === 'ix') {
    // palette
    const pal = []
    for (let i = 0; i < 10; i++) {
      await page.evaluate(() => (window.__ix = []))
      await page.keyboard.press('Meta+k')
      await sleep(400)
      const open = await page.evaluate(() => !!document.querySelector('[cmdk-root], [role=dialog]'))
      const ix = await page.evaluate(() => window.__ix.filter((x) => x.k === 'keydown').map((x) => x.d))
      if (open) pal.push(ix[0]); else r.paletteNotOpen = (r.paletteNotOpen ?? 0) + 1
      await page.keyboard.press('Escape'); await sleep(250)
    }
    r.palette = stat(pal)
    // route specific click
    if (sel) {
      const act = []
      for (let i = 0; i < 10; i++) {
        const els = await page.$$(sel)
        r.targets = els.length
        if (!els.length) break
        await page.evaluate(() => (window.__ix = []))
        const el = sel === 'select' ? null : els[i % Math.min(els.length, 2)]
        if (sel === 'select') {
          const opts = await page.$$eval('select:first-of-type option', (o) => o.map((x) => x.value))
          await page.selectOption('select >> nth=0', opts[(i % (opts.length - 1)) + 1] ?? opts[0])
          await page.evaluate(() => new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(res))))
          const ix = await page.evaluate(() => window.__ix.map((x) => x.d)); // change not click: time via event timing fallback
          act.push(ix[0] ?? NaN)
        } else {
          await el.scrollIntoViewIfNeeded()
          await el.click()
          await sleep(300)
          const ix = await page.evaluate(() => window.__ix.filter((x) => x.k === 'click').map((x) => x.d))
          act.push(ix[0])
        }
        await sleep(150)
      }
      r.action = stat(act.filter((x) => Number.isFinite(x)))
    }
    // scroll: find largest scrollable
    const sc = await page.evaluate(async () => {
      const cands = [...document.querySelectorAll('*')].filter((e) => e.scrollHeight > e.clientHeight + 4 && /auto|scroll/.test(getComputedStyle(e).overflowY))
      cands.sort((a, b) => b.scrollHeight - a.scrollHeight)
      const el = cands[0]
      if (!el) return { scrollable: false, docH: document.documentElement.scrollHeight }
      const frames = []
      const max = el.scrollHeight - el.clientHeight
      for (let i = 1; i <= 30; i++) {
        const t0 = performance.now(); el.scrollTop = (max * i) / 30
        await new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(res)))
        frames.push(performance.now() - t0)
      }
      el.scrollTop = 0
      return { scrollable: true, tag: el.tagName + '.' + String(el.className).slice(0, 30), scrollH: el.scrollHeight, clientH: el.clientHeight, medFrame: frames.sort((a, b) => a - b)[15], maxFrame: frames[29] }
    })
    r.scroll = sc
    r.longtasksInInteraction = await page.evaluate(() => window.__lt.filter((x) => x[0] > 3000))
    // simulate cost of one refetch of the stale active queries (focus refetch) once live
    results[name] = r
    console.log(name, JSON.stringify(r))
  } else {
    // storm
    const stream = spawn('curl', ['-sN', `${BASE}/v1/stream`])
    let sse = []
    stream.stdout.on('data', (d) => { for (const l of d.toString().split('\n')) if (l.startsWith('event:')) sse.push({ t: Date.now(), k: l.slice(6).trim() }) })
    await page.evaluate(() => {
      window.__mut = []; window.__lt2 = []
      new MutationObserver((recs) => window.__mut.push({ t: performance.now(), n: recs.length, types: recs.reduce((a, x) => ((a[x.type] = (a[x.type] ?? 0) + 1), a), {}) })).observe(document, { subtree: true, childList: true, attributes: true, characterData: true })
      new PerformanceObserver((l) => l.getEntries().forEach((e) => window.__lt2.push(Math.round(e.duration)))).observe({ type: 'longtask' })
    })
    const w0 = Date.now(); const reqStart = reqs.length
    const report = async (secs) => {
      const m = await page.evaluate(() => ({ mut: window.__mut, lt: window.__lt2 }))
      const rq = reqs.slice(reqStart).filter((x) => x.t - w0 <= secs * 1000 && !x.url.includes('/v1/stream'))
      // bursts: gap > 150 ms
      const bursts = []; for (const q of rq) { const b = bursts[bursts.length - 1]; if (b && q.t - b.last < 150) { b.n++; b.last = q.t; b.urls.push(q.url) } else bursts.push({ first: q.t, last: q.t, n: 1, urls: [q.url] }) }
      const mut = m.mut.filter((x) => x.t - m.mut[0]?.t >= 0)
      const totalMut = m.mut.reduce((s, x) => s + x.n, 0)
      return { secs, mutationRecords: totalMut, mutationBatches: m.mut.length, mutPerSec: +(totalMut / secs).toFixed(2), longtasks: m.lt, v1Requests: rq.length, bursts: bursts.map((b) => ({ at: ((b.first - w0) / 1000).toFixed(1), n: b.n, urls: b.urls.map((u) => u.split('?')[0]).join(' ') })), sseEvents: sse.filter((x) => x.t - w0 <= secs * 1000).map((x) => x.k) }
    }
    await sleep(10000)
    r.w10 = await report(10)
    await sleep(50000)
    r.w60 = await report(60)
    // synthetic: focus-style refetch of stale active queries, 5 reps
    const reps = []
    for (let i = 0; i < 5; i++) {
      await page.evaluate(() => { window.__mut = []; window.__lt2 = [] })
      const q0 = reqs.length
      await page.evaluate(() => window.dispatchEvent(new Event('visibilitychange')))
      await sleep(1500)
      const m = await page.evaluate(() => ({ mut: window.__mut.reduce((s, x) => s + x.n, 0), lt: window.__lt2 }))
      reps.push({ req: reqs.slice(q0).filter((x) => !x.url.includes('stream')).map((x) => x.url.split('?')[0]).join(' '), mut: m.mut, lt: m.lt })
      await sleep(5000)
    }
    r.synthetic = reps
    stream.kill()
    results[name] = r
    console.log(name, JSON.stringify(r, null, 1))
  }
  await ctx.close()
}
fs.writeFileSync(`${OUT}/${phase}${cpu > 1 ? `-cpu${cpu}x` : ''}.json`, JSON.stringify(results, null, 1))
await browser.close()
