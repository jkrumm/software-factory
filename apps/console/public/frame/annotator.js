/*
 * The annotator, loaded into an HTML artifact's frame after the artifact is written. Plain JavaScript, no dependencies.
 * It posts the owner's selection out ({type:'factory.select', quote, path, rect:{top,bottom,left}} with the rect relative to the frame's viewport, to `parent`, target origin '*' because the
 * frame's origin is opaque), tells the parent it is ready ({type:'factory.ready'}), and paints what the page sends in
 * ({type:'factory.highlight', quotes:[...]} with the CSS Custom Highlight API; {type:'factory.scroll', quote} brings one
 * into view (unless `center` is false) and paints it as the active one; {type:'factory.deactivate'} drops that; {type:'factory.clear'} drops the selection, so the same passage can be chosen again; {type:'factory.goto', index} scrolls to the index-th heading), from `parent` only. It also posts a click on a painted passage ({type:'factory.open', quote}), a click on a link that
 * leaves the frame ({type:'factory.link', href}: the frame has no network and no way out, the page opens it), the headings in
 * order ({type:'factory.headings', items:[{level,text}]}) and the one the reader is in ({type:'factory.section', index}).
 * A `#anchor` link scrolls here. It writes nothing and starts nothing: the Console writes only after the owner submits a
 * comment in its own UI.
 *
 * The text index and the heading path mirror src/lib/artifact.ts (indexText, locateQuote, headingPath); keep them alike.
 */

;(() => {
  const MAX_QUOTE = 2000
  const MAX_PATH = 500
  const BLOCK =
    /^(P|LI|H[1-6]|TD|TH|PRE|BLOCKQUOTE|DIV|SECTION|ARTICLE|FIGCAPTION|FIGURE|DD|DT|TR|UL|OL|TABLE|HEADER|FOOTER|MAIN|ASIDE|DETAILS|SUMMARY|BODY)$/
  const SKIP = /^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE)$/

  const style = document.createElement('style')
  style.textContent =
    '::highlight(factory){background-color:var(--factory-highlight,Mark);color:var(--factory-highlight-ink,MarkText)}' +
    '::highlight(factory-pending){background-color:var(--factory-highlight-active,color-mix(in srgb,var(--vx-accent,Mark) 40%,transparent));color:var(--factory-highlight-ink,MarkText)}' +
    '::highlight(factory-active){background-color:var(--factory-highlight-active,color-mix(in srgb,var(--vx-accent,Mark) 48%,transparent));color:var(--factory-highlight-ink,MarkText);text-decoration:underline;text-decoration-thickness:2px;text-underline-offset:3px}'
  document.head.appendChild(style)

  const norm = (s) => String(s).replace(/\s+/g, ' ').trim()
  const elementOf = (node) => (node.nodeType === 1 ? node : node.parentElement)

  function blockOf(node) {
    let e = elementOf(node)
    while (e && !BLOCK.test(e.tagName)) e = e.parentElement
    return e
  }

  function headingPath(node) {
    const stack = []
    for (const h of document.querySelectorAll('h1,h2,h3,h4,h5,h6')) {
      if (!(h === node || h.contains(node) || h.compareDocumentPosition(node) & 4)) continue
      const level = Number(h.tagName.charAt(1))
      while (stack.length && stack[stack.length - 1].level >= level) stack.pop()
      stack.push({ level, text: norm(h.textContent || '') })
    }
    const path = stack
      .map((h) => h.text)
      .filter(Boolean)
      .join(' > ')
    if (path) return path.slice(0, MAX_PATH)
    for (let e = elementOf(node); e; e = e.parentElement) {
      if (e.id) return `#${e.id}`.slice(0, MAX_PATH)
    }
    return ''
  }

  function index() {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
      acceptNode: (n) =>
        n.parentElement && !SKIP.test(n.parentElement.tagName) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT,
    })
    let flat = ''
    const at = []
    let previous = null
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const block = blockOf(n)
      if (block !== previous && flat !== '' && !flat.endsWith(' ')) {
        flat += ' '
        at.push([n, 0])
      }
      previous = block
      for (let i = 0; i < n.data.length; i++) {
        const char = n.data.charAt(i)
        if (/\s/.test(char)) {
          if (flat === '' || flat.endsWith(' ')) continue
          flat += ' '
        } else {
          flat += char
        }
        at.push([n, i])
      }
    }
    return { flat, at }
  }

  function rangeOf(idx, quote) {
    const wanted = norm(quote).slice(0, MAX_QUOTE)
    if (!wanted) return null
    const from = idx.flat.indexOf(wanted)
    if (from === -1) return null
    const first = idx.at[from]
    const last = idx.at[from + wanted.length - 1]
    if (!first || !last) return null
    const range = document.createRange()
    range.setStart(first[0], first[1])
    range.setEnd(last[0], last[1] + 1)
    return range
  }

  /** the passages that are painted, to tell which one a click is on */
  let painted = []
  function paint(quotes) {
    if (!window.CSS || !CSS.highlights || typeof Highlight === 'undefined') return
    const idx = index()
    painted = quotes.flatMap((quote) => {
      const range = typeof quote === 'string' ? rangeOf(idx, quote) : null
      return range ? [{ quote: norm(quote).slice(0, MAX_QUOTE), range }] : []
    })
    CSS.highlights.set('factory', new Highlight(...painted.map((found) => found.range)))
  }

  function caretAt(x, y) {
    if (document.caretPositionFromPoint) {
      const at = document.caretPositionFromPoint(x, y)
      return at ? { node: at.offsetNode, offset: at.offset } : null
    }
    const range = document.caretRangeFromPoint ? document.caretRangeFromPoint(x, y) : null
    return range ? { node: range.startContainer, offset: range.startOffset } : null
  }

  /** the narrowest painted passage under a point: the caret snaps to the nearest character, so the point must be on the text */
  function quoteAt(x, y) {
    const caret = painted.length ? caretAt(x, y) : null
    if (!caret) return null
    let best = null
    for (const found of painted) {
      const on = Array.from(found.range.getClientRects()).some(
        (r) => x >= r.left && x <= r.right && y >= r.top && y <= r.bottom,
      )
      if (!on || !found.range.isPointInRange(caret.node, caret.offset)) continue
      const size = found.range.toString().length
      if (!best || size < best.size) best = { quote: found.quote, size }
    }
    return best ? best.quote : null
  }

  const headingElements = () => Array.from(document.querySelectorAll('h1,h2,h3,h4,h5,h6'))
  const SECTION_OFFSET = 48
  let lastSection = -2
  function section() {
    let at = -1
    // at the very end of the document the last headings can never reach the top: the last one on screen is the section
    const atEnd = window.scrollY > 0 && window.scrollY + window.innerHeight >= document.documentElement.scrollHeight - 2
    headingElements().forEach((h, i) => {
      const top = h.getBoundingClientRect().top
      if (top <= SECTION_OFFSET || (atEnd && top < window.innerHeight)) at = i
    })
    if (at === lastSection) return
    lastSection = at
    parent.postMessage({ type: 'factory.section', index: at }, '*')
  }
  let sectionFrame = 0
  window.addEventListener(
    'scroll',
    () => {
      cancelAnimationFrame(sectionFrame)
      sectionFrame = requestAnimationFrame(section)
    },
    { passive: true },
  )

  document.addEventListener('click', (event) => {
    const link = event.target instanceof Element ? event.target.closest('a[href]') : null
    if (link) {
      // nothing navigates inside the frame: an anchor scrolls, a web link is the page's to open
      event.preventDefault()
      const raw = link.getAttribute('href') || ''
      if (raw.startsWith('#')) {
        let id = raw.slice(1)
        try {
          id = decodeURIComponent(id)
        } catch {
          // an id that is not valid percent-encoding is used as written
        }
        const target = id ? document.getElementById(id) || document.getElementsByName(id)[0] : null
        if (target) target.scrollIntoView({ block: 'start', behavior: 'smooth' })
        else if (!id) window.scrollTo({ top: 0, behavior: 'smooth' })
      } else if (/^https?:\/\//i.test(link.href)) {
        parent.postMessage({ type: 'factory.link', href: link.href.slice(0, 2048) }, '*')
      }
      return
    }
    const sel = window.getSelection()
    if (sel && !sel.isCollapsed) return
    const quote = quoteAt(event.clientX, event.clientY)
    if (quote) parent.postMessage({ type: 'factory.open', quote }, '*')
  })

  let hoverFrame = 0
  document.addEventListener('mousemove', (event) => {
    const { clientX, clientY, target } = event
    cancelAnimationFrame(hoverFrame)
    hoverFrame = requestAnimationFrame(() => {
      const over = !(target instanceof Element && target.closest('a[href]')) && quoteAt(clientX, clientY) !== null
      document.documentElement.style.cursor = over ? 'pointer' : ''
    })
  })

  let lastKey = ''
  function post() {
    const sel = window.getSelection()
    const quote = sel && sel.rangeCount > 0 && !sel.isCollapsed ? norm(sel.toString()).slice(0, MAX_QUOTE) : ''
    if (!quote) {
      lastKey = ''
      return
    }
    const range = sel.getRangeAt(0)
    const path = headingPath(range.startContainer)
    const key = `${quote}\n${path}`
    if (key === lastKey) return
    lastKey = key
    // the comment box is open in the parent and has the focus: keep the passage painted without the real selection
    if (window.CSS && CSS.highlights && typeof Highlight !== 'undefined')
      CSS.highlights.set('factory-pending', new Highlight(range.cloneRange()))
    const { top, bottom, left } = range.getBoundingClientRect()
    parent.postMessage({ type: 'factory.select', quote, path, rect: { top, bottom, left } }, '*')
  }
  let timer
  const soon = () => {
    clearTimeout(timer)
    timer = setTimeout(post, 150)
  }
  document.addEventListener('mouseup', soon)
  document.addEventListener('touchend', soon)
  document.addEventListener('selectionchange', soon)

  window.addEventListener('message', (event) => {
    if (event.source !== parent) return
    const data = event.data
    if (!data || typeof data !== 'object') return
    if (data.type === 'factory.highlight' && Array.isArray(data.quotes)) paint(data.quotes)
    if (data.type === 'factory.clear') {
      window.getSelection()?.removeAllRanges()
      if (window.CSS && CSS.highlights) CSS.highlights.delete('factory-pending')
      lastKey = ''
    }
    if (data.type === 'factory.deactivate' && window.CSS && CSS.highlights) CSS.highlights.delete('factory-active')
    if (data.type === 'factory.scroll' && typeof data.quote === 'string') {
      const range = rangeOf(index(), data.quote)
      if (data.center !== false)
        range?.startContainer.parentElement?.scrollIntoView({ block: 'center', behavior: 'smooth' })
      if (window.CSS && CSS.highlights && typeof Highlight !== 'undefined') {
        if (range) CSS.highlights.set('factory-active', new Highlight(range))
        else CSS.highlights.delete('factory-active')
      }
    }
  })

  window.addEventListener('message', (event) => {
    if (event.source !== parent) return
    const data = event.data
    if (data?.type !== 'factory.goto' || !Number.isInteger(data.index)) return
    const heading = headingElements()[data.index]
    if (heading) heading.scrollIntoView({ block: 'start', behavior: 'smooth' })
  })

  parent.postMessage({ type: 'factory.ready' }, '*')
  parent.postMessage(
    {
      type: 'factory.headings',
      items: headingElements()
        .slice(0, 500)
        .map((h) => ({ level: Number(h.tagName.charAt(1)), text: norm(h.textContent || '').slice(0, 300) })),
    },
    '*',
  )
  section()
})()
