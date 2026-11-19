/*
 * The artifact frame's loader. The Console frames /frame.html (sandbox="allow-scripts", no same origin), whose own response
 * policy closes every network channel. The page sends the artifact as {type:'factory.render', html, annotate, px, theme};
 * only the parent window is believed, and only once. document.open() drops the window's listeners, so the annotator and
 * the lightbox are added after the write and register their own.
 *
 * After the artifact's own styles the loader appends the Console's reading stylesheet: the body size ('px', the reader's
 * choice, 16 / 18 / 20), one centred text column that holds the running text and every heading wherever they sit, and a
 * wide track where a picture, a figure or a data-wide table may leave the column for the pane. Its rules are !important,
 * so they hold against any selector the artifact uses; templates/artifact.html lists them in its head. The page changes
 * the size later with {type:'factory.reading', px}. A table is wrapped in a div that scrolls sideways, so a wide one never
 * leaves the column unless it asks for the track with data-wide.
 *
 * The theme is the Console's, not the system's: 'theme' ('light' | 'dark') is set as data-theme and color-scheme on the
 * artifact's <html> and changes later with {type:'factory.theme', theme}. An artifact that declares no scheme of its own
 * (no color-scheme, no prefers-color-scheme, no data-theme in its CSS) gets a Basalt dark base in dark: the page and text
 * colours from the dark tokens, and the pure light greys and whites it paints with swapped for the dark surfaces. Nothing
 * is inverted and an img is never recoloured; an artifact that declares a scheme is left to its own CSS.
 */
;(() => {
  let rendered = false
  let px = 18
  /** the dark base of an artifact that declares no scheme; null when it declares one */
  let darkBase = null
  let schemeMeta = null
  /** the artifact pins its own single colour scheme: the Console's theme keeps off color-scheme */
  let pinned = false
  let reading = null
  let probe = null

  const READING_CSS = `
@property --factory-measure { syntax: '<length>'; inherits: true; initial-value: 720px; }
html { font-size: var(--factory-size, 18px) !important; }
body { --factory-measure: 76ch; font-size: 1rem !important; line-height: 1.65 !important; overflow-wrap: break-word; padding-inline: clamp(16px, 4vw, 40px) !important; }
:is(p, ul, ol, dl, blockquote, h1, h2, h3, h4, h5, h6):not(:is(li, dd, dt, td, th, blockquote, figure, figcaption, pre, summary) *) {
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
.factory-table > table { width: 100% !important; max-width: none !important; margin: 0 !important; }
pre { max-width: 100% !important; overflow-x: auto !important; }
:not(pre) > code { overflow-wrap: anywhere; }
figure { max-width: 100% !important; margin-inline: auto !important; }
img, figure svg { max-width: 100% !important; height: auto; }
[data-factory-centre] { margin-inline: auto !important; }
[data-factory-wide]:not([data-measure]) {
  --factory-w: min(var(--factory-natural, 100%), var(--factory-room, 100%));
  box-sizing: border-box !important;
  display: block !important;
  width: var(--factory-w) !important;
  max-width: none !important;
  margin-left: calc(50% - var(--factory-w) / 2 + var(--factory-shift, 0px)) !important;
  margin-right: 0 !important;
}
img[data-factory-wide], svg[data-factory-wide], video[data-factory-wide] { height: auto !important; }
:is(img, video, canvas, svg, figure):is([data-measure], [data-measure] *) {
  max-width: min(100%, var(--factory-measure)) !important;
  margin-inline: auto !important;
}
:is(img, video, canvas, svg):is([data-measure], [data-measure] *) { display: block; }
`

  /** The dark values of src/styles/tokens.css (test/frame.test.ts keeps them equal). */
  const DARK_BASE_CSS = `
:root {
  --fd-bg: #27272a; --fd-panel: #2b2b2e; --fd-subtle: #323235; --fd-border: #444447;
  --fd-ink: #e5e5e9; --fd-faint: #a7a7aa; --fd-accent: #a2c3f0;
}
html, body { background-color: var(--fd-bg) !important; color: var(--fd-ink) !important; }
a { color: var(--fd-accent); }
hr { border-color: var(--fd-border) !important; }
[data-factory-dark~="panel"] { background-color: var(--fd-panel) !important; }
[data-factory-dark~="subtle"] { background-color: var(--fd-subtle) !important; }
[data-factory-dark~="ink"] { color: var(--fd-ink) !important; }
[data-factory-dark~="faint"] { color: var(--fd-faint) !important; }
[data-factory-dark~="tint"] { color: var(--factory-tint) !important; }
[data-factory-dark~="bt"] { border-top-color: var(--fd-border) !important; }
[data-factory-dark~="br"] { border-right-color: var(--fd-border) !important; }
[data-factory-dark~="bb"] { border-bottom-color: var(--fd-border) !important; }
[data-factory-dark~="paper"] { background-color: #fafafd !important; border-radius: 6px; }
`

  /** CSS that names a scheme: the artifact handles the theme itself. */
  const SCHEME_DECLARED = /color-scheme|prefers-color-scheme|data-theme/i

  /** True when the artifact's CSS (comments ignored) declares a colour scheme of its own. */
  function declaresScheme(css) {
    return SCHEME_DECLARED.test(String(css).replace(/\/\*[\s\S]*?\*\//g, ''))
  }

  /** A scheme the artifact pins to one value (color-scheme: light): the Console's theme does not override it. */
  const SINGLE_SCHEME = /color-scheme\s*:\s*(?:only\s+)?(?:light|dark)\s*(?:[;}!"']|$)/i
  const pinsScheme = (css) => SINGLE_SCHEME.test(String(css).replace(/\/\*[\s\S]*?\*\//g, ''))

  const COLOR = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:\s*[,/]\s*([\d.]+)(%?))?\s*\)$/
  /** A computed sRGB colour; null for anything else (a computed oklch() stays oklch): such a colour is left alone. */
  function parseColor(value) {
    const found = COLOR.exec(String(value).trim())
    if (!found) return null
    const alpha = found[4] === undefined ? 1 : found[5] ? Number(found[4]) / 100 : Number(found[4])
    return { r: Number(found[1]), g: Number(found[2]), b: Number(found[3]), a: alpha }
  }
  const lightness = (c) => (0.299 * c.r + 0.587 * c.g + 0.114 * c.b) / 255
  const NEUTRAL = 24
  const isNeutral = (c) => Math.max(c.r, c.g, c.b) - Math.min(c.r, c.g, c.b) <= NEUTRAL

  /** What an element's own background is, and which dark surface replaces it: only a pure light grey or white is swapped. */
  function surfaceOf(c) {
    if (!c || c.a < 0.05) return { state: 'none', mark: '' }
    const l = lightness(c)
    // a translucent dark wash on a light page (rgba(0,0,0,.05)) stays a wash, on the dark surface
    if (c.a < 0.5) return { state: 'none', mark: isNeutral(c) && l < 0.25 ? 'subtle' : '' }
    if (isNeutral(c) && l >= 0.8) return { state: 'light', mark: l >= 0.97 ? 'panel' : 'subtle' }
    return { state: l < 0.35 ? 'dark' : 'colored', mark: '' }
  }

  /** How dark text on a light surface is lifted: neutral dark to the ink, neutral mid to the faint ink, dark colours mixed with it. */
  function inkOf(c) {
    if (!c || c.a < 0.5) return ''
    const l = lightness(c)
    if (isNeutral(c)) return l <= 0.22 ? 'ink' : l <= 0.45 ? 'faint' : ''
    return l <= 0.3 ? 'tint' : ''
  }

  /** A light neutral line (a table rule, a card outline) becomes the dark border. */
  const isLightLine = (c) => !!c && c.a >= 0.3 && isNeutral(c) && lightness(c) >= 0.6

  const NOT_WALKED = /^(script|style|noscript|template|link|meta|img|canvas|video|picture|iframe|object|embed)$/
  const SIDES = [
    ['Top', 'bt'],
    ['Right', 'br'],
    ['Bottom', 'bb'],
  ]

  /**
   * Marks, once and before the dark base exists, the elements the base must repaint. What an element looks like by its own
   * CSS decides, so the marks hold in both themes and the base only switches them on: a light surface gives its dark text
   * and its light lines to the base; a colour or a dark surface is the artifact's own and stays.
   */
  function markForDark() {
    let budget = 6000
    const body = document.body
    const bodyBackground = surfaceOf(parseColor(getComputedStyle(body).backgroundColor))
    const pageBackground = surfaceOf(parseColor(getComputedStyle(document.documentElement).backgroundColor))
    const own = bodyBackground.state !== 'none' ? bodyBackground : pageBackground
    // the base paints the page dark whatever it was: a pale colour under dark text is lifted like white
    const page = own.state === 'dark' ? 'dark' : 'light'
    const visit = (el, parent) => {
      if (budget-- <= 0 || NOT_WALKED.test(el.localName)) return
      const style = getComputedStyle(el)
      const background = surfaceOf(parseColor(style.backgroundColor))
      let state = background.state === 'none' ? parent : background.state
      if (style.backgroundImage !== 'none') state = 'colored'
      if (el.localName === 'svg') {
        // a diagram drawn on the page is kept as a light plate, like a screenshot
        if (state === 'light') el.setAttribute('data-factory-dark', 'paper')
        return
      }
      const marks = []
      if (state === 'light') {
        if (background.mark) marks.push(background.mark)
        const color = parseColor(style.color)
        const ink = inkOf(color)
        if (ink) marks.push(ink)
        if (ink === 'tint' && color) {
          el.style.setProperty(
            '--factory-tint',
            `color-mix(in srgb, rgb(${color.r} ${color.g} ${color.b}) 45%, var(--fd-ink, #e5e5e9))`,
          )
        }
        for (const [side, mark] of SIDES) {
          const width = parseFloat(style[`border${side}Width`])
          const line = parseColor(style[`border${side}Color`])
          if (width > 0 && style[`border${side}Style`] !== 'none' && isLightLine(line)) marks.push(mark)
        }
      }
      if (marks.length > 0) el.setAttribute('data-factory-dark', marks.join(' '))
      for (const child of el.children) visit(child, state)
    }
    for (const child of body.children) visit(child, page)
  }

  function collectCss() {
    const parts = Array.from(document.querySelectorAll('style'), (style) => style.textContent || '')
    for (const el of document.querySelectorAll('[style*="color-scheme" i]')) parts.push(el.getAttribute('style') || '')
    if (document.querySelector('meta[name="color-scheme" i]')) parts.push('color-scheme')
    return parts.join('\n')
  }

  /** A media query on the system scheme, rewritten to hold or not hold for the Console's theme. */
  const SYSTEM_SCHEME = /\(\s*prefers-color-scheme\s*:\s*(dark|light)\s*\)/gi
  const ALWAYS = '(min-width: 0px)'
  const NEVER = '((min-width: 1px) and (max-width: 0px))'
  const followConsole = (css, theme) =>
    css.replace(SYSTEM_SCHEME, (_, scheme) => (scheme.toLowerCase() === theme ? ALWAYS : NEVER))

  /** The artifact's own system-scheme rules answer to the Console's theme, which wins over the system's. */
  function followTheme(theme) {
    for (const style of document.querySelectorAll('style')) {
      if (style === darkBase || style === reading) continue
      if (style.dataset.factorySource === undefined) {
        const source = style.textContent || ''
        if (!/prefers-color-scheme/i.test(source)) continue
        style.dataset.factorySource = source
      }
      style.textContent = followConsole(style.dataset.factorySource, theme)
    }
  }

  function applyTheme(theme) {
    if (theme !== 'light' && theme !== 'dark') return
    followTheme(theme)
    const root = document.documentElement
    root.dataset.theme = theme
    if (!pinned) root.style.colorScheme = theme
    if (schemeMeta && !pinned) schemeMeta.content = theme
    if (darkBase) darkBase.disabled = theme !== 'dark'
  }

  const setSize = (value) => {
    if (value !== 16 && value !== 18 && value !== 20) return
    px = value
    document.documentElement.style.setProperty('--factory-size', `${px}px`)
    scheduleMedia()
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

  /* The wide track. A picture, a figure or a data-wide table whose own width is more than the text column's leaves it, up to
     the pane minus the body's padding and never past its own width; data-measure keeps one in the column. A smaller one
     (an icon, a figure that fits) is not touched. Widths are read from the document, so they are measured again when a
     picture loads, the reader's size changes or the frame is resized. */
  const attributeWidth = (el) => {
    const value = el.getAttribute('width') || ''
    return /^\d+(\.\d+)?(px)?$/.test(value) ? parseFloat(value) : 0
  }

  function naturalWidth(el) {
    const name = el.localName
    if (name === 'img') return attributeWidth(el) || el.naturalWidth || 0
    if (name === 'svg') return attributeWidth(el) || el.viewBox?.baseVal?.width || 0
    if (name === 'video') return attributeWidth(el) || el.videoWidth || 0
    if (name === 'canvas' || name === 'embed' || name === 'object') return attributeWidth(el)
    if (name === 'figure') {
      const media = Array.from(el.querySelectorAll('img, svg, video, canvas')).filter(
        (m) => !m.parentElement?.closest('svg'),
      )
      const widest = Math.max(0, ...media.map(naturalWidth))
      if (widest === 0) return 0
      const style = getComputedStyle(el)
      const edges = ['paddingLeft', 'paddingRight', 'borderLeftWidth', 'borderRightWidth']
      return widest + edges.reduce((sum, key) => sum + (parseFloat(style[key]) || 0), 0)
    }
    if (el.classList.contains('factory-table')) {
      const table = el.firstElementChild
      if (!table) return 0
      table.style.setProperty('width', 'max-content', 'important')
      const width = table.offsetWidth
      table.style.removeProperty('width')
      return width
    }
    return 0
  }

  const BOXED = /^(flex|inline-flex|grid|inline-grid|table|table-row|table-row-group|table-cell|list-item)$/

  function layoutMedia() {
    const root = document.documentElement
    if (!probe) {
      probe = document.createElement('div')
      probe.setAttribute('aria-hidden', 'true')
      probe.style.cssText =
        'position:absolute;visibility:hidden;pointer-events:none;height:0;width:var(--factory-measure)'
      document.body.appendChild(probe)
    }
    const column = probe.offsetWidth
    const pad = Math.max(16, parseFloat(getComputedStyle(document.body).paddingLeft) || 0)
    const room = root.clientWidth - 2 * pad
    root.style.setProperty('--factory-room', `${room}px`)
    const candidates = Array.from(
      document.querySelectorAll('img, video, canvas, embed, object, svg, figure, .factory-table.factory-wide'),
    ).filter((el) => {
      // inside a figure the figure is the unit; an svg's own parts are not pictures
      const inside =
        el.localName === 'figure' ? el.parentElement?.closest('figure') : el.parentElement?.closest('figure, svg')
      return !inside
    })
    centreWrappers()
    // measured as it is laid out in the column, so each one is taken out of the track first
    for (const el of candidates) el.removeAttribute('data-factory-wide')
    const measured = candidates.map((el) => {
      const natural = naturalWidth(el)
      const fits = natural > column + 1 && room > column + 1 && !el.closest('[data-measure]')
      return { el, natural, wide: fits && fillsColumn(el) }
    })
    for (const { el, natural, wide } of measured) {
      if (!wide) {
        el.style.removeProperty('--factory-natural')
        el.style.removeProperty('--factory-shift')
        continue
      }
      el.style.setProperty('--factory-natural', `${Math.round(natural)}px`)
      // the track is centred on the pane, whatever the wrapper that holds the column does
      el.style.setProperty('--factory-shift', `${Math.round(root.clientWidth / 2 - containerBox(el).centre)}px`)
      el.setAttribute('data-factory-wide', '')
    }
  }

  /** A wrapper the artifact gave a width and left to the start of the page (article { max-width: 1100px }) is centred in the pane. */
  function centreWrappers() {
    const body = document.body
    const host = getComputedStyle(body)
    for (const child of body.children) {
      child.removeAttribute('data-factory-centre')
      if (child === probe || host.display !== 'block') continue
      const style = getComputedStyle(child)
      const block =
        style.display === 'block' &&
        (style.position === 'static' || style.position === 'relative') &&
        style.float === 'none'
      if (block && child.getBoundingClientRect().width < body.clientWidth - 2)
        child.setAttribute('data-factory-centre', '')
    }
  }

  /** The box a block has to itself where el sits: the nearest ancestor with a box, less its padding (width and centre in the viewport). */
  function containerBox(el) {
    for (let node = el.parentElement; node; node = node.parentElement) {
      if (node.clientWidth <= 0) continue
      const style = getComputedStyle(node)
      const left = parseFloat(style.paddingLeft) || 0
      const width = node.clientWidth - left - (parseFloat(style.paddingRight) || 0)
      return { width, centre: node.getBoundingClientRect().left + node.clientLeft + left + width / 2 }
    }
    return { width: 0, centre: 0 }
  }

  /** In a row, a grid, a table cell or a list item a picture belongs to its container; a sized one stays the size it was given. */
  function fillsColumn(el) {
    let parent = el.parentElement
    while (parent && getComputedStyle(parent).display === 'inline') parent = parent.parentElement
    if (!parent || BOXED.test(getComputedStyle(parent).display)) return false
    if (el.localName === 'figure' || el.classList.contains('factory-table')) return true
    return el.getBoundingClientRect().width >= Math.min(containerBox(el).width, naturalWidth(el)) - 2
  }

  let mediaFrame = 0
  function scheduleMedia() {
    if (!rendered) return
    cancelAnimationFrame(mediaFrame)
    mediaFrame = requestAnimationFrame(layoutMedia)
  }

  function render(data) {
    const script = (name) => `<script src="/frame/${name}.js"></${'script'}>`
    document.open()
    document.write(data.html + script('lightbox') + (data.annotate === false ? '' : script('annotator')))
    document.close()
    // document.open() dropped frame.html's head, so the lock is added again for the artifact's own document.
    const lock = document.createElement('meta')
    lock.name = 'darkreader-lock'
    document.head.appendChild(lock)
    const css = collectCss()
    const declared = declaresScheme(css)
    pinned = pinsScheme(css)
    reading = document.createElement('style')
    reading.textContent = READING_CSS
    document.head.appendChild(reading)
    wrapTables()
    if (!declared) {
      // read what the artifact looks like by its own CSS before the base or the theme change anything
      markForDark()
      darkBase = document.createElement('style')
      darkBase.textContent = DARK_BASE_CSS
      document.head.appendChild(darkBase)
      darkBase.disabled = true
    }
    schemeMeta = document.createElement('meta')
    schemeMeta.name = 'color-scheme'
    document.head.appendChild(schemeMeta)
    applyTheme(data.theme === 'dark' ? 'dark' : 'light')
    setSize(data.px)
    layoutMedia()
    document.addEventListener('load', scheduleMedia, true)
    window.addEventListener('resize', scheduleMedia)
    // document.open() dropped this listener too
    window.addEventListener('message', (next) => {
      if (next.source !== parent) return
      if (next.data?.type === 'factory.reading') setSize(next.data.px)
      if (next.data?.type === 'factory.theme') applyTheme(next.data.theme)
    })
  }

  window.addEventListener('message', (event) => {
    if (event.source !== parent || rendered) return
    const data = event.data
    if (data?.type !== 'factory.render' || typeof data.html !== 'string') return
    rendered = true
    render(data)
  })

  // a seam for test/frame.test.ts, which runs the pure parts without a browser
  if (typeof module === 'object' && module?.exports) {
    module.exports = {
      followConsole,
      declaresScheme,
      pinsScheme,
      parseColor,
      surfaceOf,
      inkOf,
      isLightLine,
      DARK_BASE_CSS,
    }
  }
})()
