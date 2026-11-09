/*
 * The annotator, loaded into an HTML artifact's frame after the artifact is written. Plain JavaScript, no dependencies.
 * It posts the owner's selection out ({type:'factory.select', quote, path, rect:{top,bottom,left}} with the rect relative to the frame's viewport, to `parent`, target origin '*' because the
 * frame's origin is opaque), tells the parent it is ready ({type:'factory.ready'}), and paints what the page sends in
 * ({type:'factory.highlight', quotes:[...]} with the CSS Custom Highlight API; {type:'factory.scroll', quote} brings one
 * into view; {type:'factory.clear'} drops the selection, so the same passage can be chosen again), from `parent` only. It writes nothing and starts nothing: the Console writes only after the owner submits a
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
    '::highlight(factory),::highlight(factory-pending){background-color:var(--factory-highlight,Mark);color:var(--factory-highlight-ink,MarkText)}'
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

  function paint(quotes) {
    if (!window.CSS || !CSS.highlights || typeof Highlight === 'undefined') return
    const idx = index()
    const ranges = quotes.flatMap((quote) => {
      const range = typeof quote === 'string' ? rangeOf(idx, quote) : null
      return range ? [range] : []
    })
    CSS.highlights.set('factory', new Highlight(...ranges))
  }

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
    if (data.type === 'factory.scroll' && typeof data.quote === 'string') {
      const range = rangeOf(index(), data.quote)
      range?.startContainer.parentElement?.scrollIntoView({ block: 'center', behavior: 'smooth' })
    }
  })

  parent.postMessage({ type: 'factory.ready' }, '*')
})()
