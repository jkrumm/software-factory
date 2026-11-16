/*
 * The artifact frame's loader. The Console frames /frame.html (sandbox="allow-scripts", no same origin), whose own response
 * policy closes every network channel. The page sends the artifact as {type:'factory.render', html, annotate, px}; only the
 * parent window is believed, and only once. document.open() drops the window's listeners, so the annotator is added after
 * the write and registers its own.
 *
 * After the artifact's own styles the loader appends the Console's reading stylesheet: the body size (`px`, the reader's
 * choice, 16 / 18 / 20), the line length of the text, and where a table, a figure or a code block may sit. Its rules are
 * !important, so they hold against any selector the artifact uses; templates/artifact.html lists them in its head. The
 * page changes the size later with {type:'factory.reading', px}. A table is wrapped in a div that scrolls sideways, so a
 * wide one never leaves the column; the text and the headings in the document are not touched.
 */
;(() => {
  let rendered = false
  let px = 18
  const READING_CSS = `
html { font-size: var(--factory-size, 18px) !important; --factory-measure: 76ch; --factory-wide: 72rem; }
body { font-size: 1rem !important; line-height: 1.65 !important; overflow-wrap: break-word; padding-inline: clamp(16px, 4vw, 40px) !important; }
:where(body, main, article, section, div) > :where(p, ul, ol, dl, blockquote, h1, h2, h3, h4, h5, h6) {
  max-width: min(100%, var(--factory-measure)) !important;
  margin-inline: auto !important;
}
h1, h2, h3, h4, h5, h6 { line-height: 1.3 !important; text-wrap: balance; }
.factory-table {
  display: block !important;
  width: min(100%, var(--factory-measure)) !important;
  max-width: 100% !important;
  margin: 1em auto !important;
  overflow-x: auto !important;
}
.factory-table.factory-wide { width: min(100%, var(--factory-wide)) !important; }
.factory-table > table { width: 100% !important; max-width: none !important; margin: 0 !important; }
pre { max-width: 100% !important; overflow-x: auto !important; }
:not(pre) > code { overflow-wrap: anywhere; }
figure { max-width: 100% !important; margin-inline: auto !important; }
img, figure svg { max-width: 100% !important; height: auto; }
`

  const setSize = (value) => {
    if (value !== 16 && value !== 18 && value !== 20) return
    px = value
    document.documentElement.style.setProperty('--factory-size', `${px}px`)
  }

  function wrapTables() {
    for (const table of document.querySelectorAll('table')) {
      if (table.parentElement?.classList.contains('factory-table')) continue
      const wrap = document.createElement('div')
      wrap.className = table.hasAttribute('data-wide') ? 'factory-table factory-wide' : 'factory-table'
      table.parentNode?.insertBefore(wrap, table)
      wrap.appendChild(table)
    }
  }

  window.addEventListener('message', (event) => {
    if (event.source !== parent || rendered) return
    const data = event.data
    if (data?.type !== 'factory.render' || typeof data.html !== 'string') return
    rendered = true
    const annotator = data.annotate === false ? '' : `<script src="/frame/annotator.js"></${'script'}>`
    document.open()
    document.write(data.html + annotator)
    document.close()
    // document.open() dropped frame.html's head, so the lock is added again for the artifact's own document.
    const lock = document.createElement('meta')
    lock.name = 'darkreader-lock'
    document.head.appendChild(lock)
    const reading = document.createElement('style')
    reading.textContent = READING_CSS
    document.head.appendChild(reading)
    setSize(data.px)
    wrapTables()
    // document.open() dropped this listener too
    window.addEventListener('message', (next) => {
      if (next.source === parent && next.data?.type === 'factory.reading') setSize(next.data.px)
    })
  })
})()
