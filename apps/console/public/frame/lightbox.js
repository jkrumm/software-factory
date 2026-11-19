/*
 * The lightbox, loaded into an HTML artifact's frame after the artifact is written (and before the annotator). Plain
 * JavaScript, no dependencies, no network. A click, or Enter on focus, on a picture of the document opens it in a fullscreen
 * native <dialog> (the top layer; Esc closes it, so does a click beside the picture or on the close button). The pictures are
 * the images and svgs outside a link and the figures that hold one, in document order; an icon (an image under 200 px
 * wide, an svg under 160 px) is not one. The arrows, the on-screen buttons and the left and right keys step through them
 * with an "n / N" counter and the figure's caption; a second click on the picture shows it at its natural size (an svg at
 * twice its fitted size), where a drag pans. Focus returns to the picture that was last shown.
 *
 * It never takes a text selection: a click opens only with no selection and the pointer within a few pixels of where it
 * went down. The dialog lives outside <body>, so the annotator's text index and its comment flow never see it, and its
 * own clicks stop at the dialog.
 */
;(() => {
  const MIN_IMAGE = 200
  const MIN_SVG = 160
  const DRAG = 5

  const CSS = `
[data-factory-zoomable] { cursor: zoom-in; }
[data-factory-zoomable]:focus-visible { outline: 2px solid #a2c3f0; outline-offset: 3px; }
dialog.factory-lightbox { position: fixed; inset: 0; width: 100%; height: 100%; max-width: none; max-height: none; margin: 0; padding: 0; border: 0;
  background: var(--lb-bg, #0c0c0e); color: var(--lb-fg, #e5e5e9); font: 14px/1.4 system-ui, sans-serif; cursor: default; overflow: hidden; }
dialog.factory-lightbox[open] { display: flex; flex-direction: column; }
.factory-lightbox-bar { flex: none; display: flex; align-items: center; gap: 8px; padding: 10px 14px; }
.factory-lightbox-count { margin-inline-end: auto; font-variant-numeric: tabular-nums; color: var(--lb-faint, #a7a7aa); }
.factory-lightbox button { appearance: none; font: inherit; font-size: 20px; line-height: 1; min-width: 40px; height: 40px; padding: 0 12px; border-radius: 8px;
  border: 1px solid var(--lb-line, #444447); background: var(--lb-control, #2b2b2e); color: var(--lb-fg, #e5e5e9); cursor: pointer; }
.factory-lightbox button:hover:not(:disabled) { background: var(--lb-hover, #323235); }
.factory-lightbox button:focus-visible { outline: 2px solid #a2c3f0; outline-offset: 2px; }
.factory-lightbox button:disabled { opacity: 0.35; cursor: default; }
.factory-lightbox-stage { flex: 1 1 0; min-height: 0; display: flex; overflow: auto; }
.factory-lightbox-stage > * { flex: none; margin: auto; }
.factory-lightbox-stage > img, .factory-lightbox-stage > svg { max-width: none !important; display: block; }
.factory-lightbox-stage[data-zoomable] > * { cursor: zoom-in; }
.factory-lightbox-stage[data-zoom] > * { cursor: grab; }
.factory-lightbox-stage[data-panning] > * { cursor: grabbing; }
.factory-lightbox-caption { flex: none; min-height: 1.4em; padding: 10px 24px 16px; text-align: center; color: var(--lb-fg, #cfcfd4); }
@media (prefers-reduced-motion: no-preference) {
  dialog.factory-lightbox[open] { animation: factory-lightbox-in 0.14s ease-out; }
  @keyframes factory-lightbox-in { from { opacity: 0; } to { opacity: 1; } }
}
`

  let dialog = null
  let stage = null
  let counter = null
  let caption = null
  let previous = null
  let following = null
  let items = []
  let at = 0
  let zoomed = false
  let shown = null
  let down = null

  const rectWidth = (el) => el.getBoundingClientRect().width

  /** The intrinsic size of a picture's drawing: an image's pixels, an svg's viewBox or width and height. */
  function sizeOf(media) {
    if (media.localName === 'img') {
      const rect = media.getBoundingClientRect()
      return { width: media.naturalWidth || rect.width, height: media.naturalHeight || rect.height, vector: false }
    }
    const box = media.viewBox?.baseVal
    const rect = media.getBoundingClientRect()
    const width = box?.width || parseFloat(media.getAttribute('width')) || rect.width
    const height = box?.height || parseFloat(media.getAttribute('height')) || rect.height
    return { width, height, vector: true }
  }

  const isBig = (media) =>
    media.localName === 'img'
      ? (media.naturalWidth || rectWidth(media)) >= MIN_IMAGE
      : media.localName === 'svg' && rectWidth(media) >= MIN_SVG

  /** The picture a figure shows: its first image or svg that is not an icon. */
  const mediaOfFigure = (figure) =>
    Array.from(figure.querySelectorAll('img, svg')).find(
      (media) => !media.parentElement?.closest('svg') && isBig(media),
    )

  /** { el, media } for a figure, an image or an svg that is a picture of the document, else null. */
  function pictureOf(el) {
    if (!el || el.closest('dialog') || el.closest('a[href]')) return null
    if (el.localName === 'figure') {
      if (el.parentElement?.closest('figure')) return null
      const media = mediaOfFigure(el)
      return media ? { el, media } : null
    }
    if (el.parentElement?.closest('figure, svg')) return null
    return (el.localName === 'img' || el.localName === 'svg') && isBig(el) ? { el, media: el } : null
  }

  const pictures = () =>
    Array.from(document.body.querySelectorAll('figure, img, svg'), pictureOf).filter((picture) => picture !== null)

  /** A picture reachable from the keyboard and marked for the pointer. Run again when an image has loaded. */
  function mark() {
    for (const picture of pictures()) {
      picture.el.setAttribute('data-factory-zoomable', '')
      if (!picture.el.hasAttribute('tabindex')) picture.el.setAttribute('tabindex', '0')
    }
  }

  const captionOf = (picture) => {
    const text = picture.el.localName === 'figure' ? picture.el.querySelector('figcaption')?.textContent : ''
    const label =
      picture.media.getAttribute('alt') ||
      picture.media.getAttribute('aria-label') ||
      picture.media.querySelector?.('title')?.textContent
    return (text || label || '').replace(/\s+/g, ' ').trim()
  }

  function button(label, text, onClick) {
    const el = document.createElement('button')
    el.type = 'button'
    el.setAttribute('aria-label', label)
    el.textContent = text
    el.addEventListener('click', onClick)
    return el
  }

  function build() {
    const style = document.createElement('style')
    style.textContent = CSS
    document.head.appendChild(style)
    dialog = document.createElement('dialog')
    dialog.className = 'factory-lightbox'
    dialog.setAttribute('aria-label', 'Picture viewer')
    dialog.tabIndex = -1
    const bar = document.createElement('div')
    bar.className = 'factory-lightbox-bar'
    counter = document.createElement('span')
    counter.className = 'factory-lightbox-count'
    counter.setAttribute('role', 'status')
    previous = button('Previous picture', '‹', () => step(-1))
    following = button('Next picture', '›', () => step(1))
    bar.append(
      counter,
      previous,
      following,
      button('Close', '×', () => dialog.close()),
    )
    stage = document.createElement('div')
    stage.className = 'factory-lightbox-stage'
    caption = document.createElement('div')
    caption.className = 'factory-lightbox-caption'
    dialog.append(bar, stage, caption)
    // outside <body>: the annotator indexes the body's text only
    document.documentElement.appendChild(dialog)

    dialog.addEventListener('click', onDialogClick)
    // nothing inside the dialog reaches the annotator, which would read a click as one on the passage beneath it
    for (const type of ['mousemove', 'mouseup', 'touchend'])
      dialog.addEventListener(type, (event) => event.stopPropagation())
    dialog.addEventListener('keydown', (event) => {
      if (event.key === 'ArrowLeft') step(-1)
      else if (event.key === 'ArrowRight') step(1)
      else return
      event.preventDefault()
    })
    dialog.addEventListener('close', () => {
      stage.replaceChildren()
      const opener = items[at]?.el
      items = []
      opener?.focus({ preventScroll: true })
      opener?.scrollIntoView({ block: 'nearest' })
    })
    stage.addEventListener('pointerdown', (event) => {
      panned = false
      if (!zoomed || event.button !== 0) return
      down = { x: event.clientX, y: event.clientY, left: stage.scrollLeft, top: stage.scrollTop, moved: false }
      stage.setPointerCapture(event.pointerId)
    })
    stage.addEventListener('pointermove', (event) => {
      if (!down) return
      const dx = event.clientX - down.x
      const dy = event.clientY - down.y
      if (Math.abs(dx) + Math.abs(dy) > DRAG) {
        down.moved = true
        stage.setAttribute('data-panning', '')
      }
      stage.scrollLeft = down.left - dx
      stage.scrollTop = down.top - dy
    })
    const release = () => {
      const moved = down?.moved
      down = null
      stage.removeAttribute('data-panning')
      // the click that ends a pan must not toggle the zoom or close the dialog
      if (moved) panned = true
    }
    stage.addEventListener('pointerup', release)
    stage.addEventListener('pointercancel', release)
    window.addEventListener('resize', () => {
      if (dialog.open) fit()
    })
  }

  let panned = false

  function onDialogClick(event) {
    event.stopPropagation()
    if (panned) {
      panned = false
      return
    }
    // a zoomed stage holds the pointer capture, so a click on the picture is retargeted to the stage: the point decides
    const box = shown.getBoundingClientRect()
    const onPicture =
      event.clientX >= box.left && event.clientX <= box.right && event.clientY >= box.top && event.clientY <= box.bottom
    if (onPicture) toggleZoom(event)
    else if (!event.target.closest('button')) dialog.close()
  }

  /** The scale at which the shown picture fits the stage, and the one a second click gives. */
  function scales() {
    const { width, height, vector } = sizeOf(items[at].media)
    const room = { width: Math.max(1, stage.clientWidth - 32), height: Math.max(1, stage.clientHeight - 32) }
    const contain = Math.min(room.width / (width || 1), room.height / (height || 1))
    const fitted = vector ? Math.min(contain, 4) : Math.min(1, contain)
    const zoom = vector ? fitted * 2 : 1
    return { width, height, fitted, zoom, canZoom: zoom > fitted + 0.01 }
  }

  function fit() {
    if (!shown) return
    const { width, height, fitted, zoom, canZoom } = scales()
    if (!canZoom) zoomed = false
    const scale = zoomed ? zoom : fitted
    shown.style.setProperty('width', `${Math.round(width * scale)}px`, 'important')
    shown.style.setProperty('height', `${Math.round(height * scale)}px`, 'important')
    if (canZoom) stage.setAttribute('data-zoomable', '')
    else stage.removeAttribute('data-zoomable')
    if (zoomed) stage.setAttribute('data-zoom', '')
    else stage.removeAttribute('data-zoom')
  }

  /** Switches between the fitted and the natural size, keeping the point that was clicked under the pointer. */
  function toggleZoom(event) {
    if (!shown || !scales().canZoom) return
    const before = shown.getBoundingClientRect()
    const fx = (event.clientX - before.left) / (before.width || 1)
    const fy = (event.clientY - before.top) / (before.height || 1)
    zoomed = !zoomed
    fit()
    if (!zoomed) return
    const after = shown.getBoundingClientRect()
    stage.scrollLeft += after.left + fx * after.width - event.clientX
    stage.scrollTop += after.top + fy * after.height - event.clientY
  }

  const COLOR = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:\s*[,/]\s*([\d.]+)(%?))?\s*\)$/

  /**
   * The surface a picture sits on in the page now (the dark base and the theme included): the nearest ancestor background that
   * is not clear, else the page's. A diagram drawn for a light page stays dark ink on light, one for a dark page the reverse.
   */
  function surfaceOf(el) {
    for (let node = el.parentElement; node; node = node.parentElement) {
      const found = COLOR.exec(getComputedStyle(node).backgroundColor)
      if (!found) continue
      const alpha = found[4] === undefined ? 1 : found[5] ? Number(found[4]) / 100 : Number(found[4])
      if (alpha > 0.5) return [Number(found[1]), Number(found[2]), Number(found[3])]
    }
    return document.documentElement.dataset.theme === 'dark' ? [39, 39, 42] : [255, 255, 255]
  }

  /** The viewer takes the picture's surface, and ink, controls and lines to suit it. */
  function paintDialog(picture) {
    const [r, g, b] = surfaceOf(picture.el)
    const dark = (0.299 * r + 0.587 * g + 0.114 * b) / 255 < 0.5
    const vars = dark
      ? {
          bg: `rgb(${r} ${g} ${b})`,
          fg: '#e5e5e9',
          faint: '#a7a7aa',
          line: '#444447',
          control: '#2b2b2e',
          hover: '#323235',
        }
      : {
          bg: `rgb(${r} ${g} ${b})`,
          fg: '#262629',
          faint: '#69696c',
          line: '#d6d6da',
          control: '#f2f2f5',
          hover: '#e6e6ea',
        }
    for (const [name, value] of Object.entries(vars)) dialog.style.setProperty(`--lb-${name}`, value)
  }

  function cloneOf(media) {
    const clone = media.cloneNode(true)
    for (const name of [
      'data-factory-wide',
      'data-factory-zoomable',
      'tabindex',
      'id',
      'class',
      'style',
      'width',
      'height',
      'loading',
    ]) {
      clone.removeAttribute(name)
    }
    if (media.localName === 'img') {
      clone.src = media.currentSrc || media.src
      clone.removeAttribute('srcset')
      clone.alt = media.alt
      clone.draggable = false
    }
    return clone
  }

  function show(index) {
    at = index
    zoomed = false
    const picture = items[at]
    stage.replaceChildren()
    paintDialog(picture)
    shown = cloneOf(picture.media)
    // an svg takes the artifact's own rules by class; the clone keeps them, only the layout attributes are the viewer's
    if (picture.media.localName === 'svg') {
      for (const name of ['class']) {
        const value = picture.media.getAttribute(name)
        if (value) shown.setAttribute(name, value)
      }
    }
    stage.appendChild(shown)
    counter.textContent = `${at + 1} / ${items.length}`
    caption.textContent = captionOf(picture)
    previous.disabled = at === 0
    following.disabled = at === items.length - 1
    previous.hidden = following.hidden = items.length < 2
    stage.scrollLeft = 0
    stage.scrollTop = 0
    fit()
  }

  function step(by) {
    const next = at + by
    if (next < 0 || next >= items.length) return
    show(next)
  }

  function open(picture) {
    if (!dialog) build()
    items = pictures()
    const index = items.findIndex((candidate) => candidate.el === picture.el)
    if (index === -1) return
    dialog.showModal()
    show(index)
    // showModal focused the first button before the buttons knew their state
    dialog.focus({ preventScroll: true })
  }

  let pressed = null
  document.addEventListener(
    'pointerdown',
    (event) => {
      pressed = { x: event.clientX, y: event.clientY }
    },
    true,
  )

  document.addEventListener('click', (event) => {
    if (event.defaultPrevented || event.button !== 0 || !(event.target instanceof Element)) return
    if (event.target.closest('figcaption, dialog')) return
    const selection = window.getSelection()
    if (selection && !selection.isCollapsed) return
    if (pressed && Math.abs(event.clientX - pressed.x) + Math.abs(event.clientY - pressed.y) > DRAG) return
    const figure = event.target.closest('figure')
    const picture = pictureOf(figure) || pictureOf(event.target.closest('img, svg'))
    if (picture) open(picture)
  })

  document.addEventListener('keydown', (event) => {
    if ((event.key !== 'Enter' && event.key !== ' ') || !(event.target instanceof Element)) return
    if (!event.target.hasAttribute('data-factory-zoomable')) return
    const picture = pictureOf(event.target)
    if (!picture) return
    event.preventDefault()
    open(picture)
  })

  // an image is only a picture once it has a size
  document.addEventListener('load', mark, true)
  window.addEventListener('load', mark)
  mark()
})()
