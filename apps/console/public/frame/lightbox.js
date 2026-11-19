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
 *
 * Comments on pictures. Once the page has sent {type:'factory.images', items} (it does only where the owner can comment),
 * a picture shows a comment button on hover, focus (and `C` on a focused picture) and a count badge when it has comments;
 * the viewer's bar gets "Comment" and "Mark a spot" (the next click on the picture drops a pin), its commented pictures
 * show numbered pins and a side list. Each item is {id, occurrence, srcHash, label, x, y, author, text}; a picture is found
 * by resolveImage (between "image:begin" and "image:end": the copy of packages/contract/src/image-anchor.ts, which
 * apps/console/test/image-anchor.test.ts runs on one table). Out go {type:'factory.image', image, path, rect} (a comment is
 * to be written: the page opens its comment box at rect, viewport coordinates of this frame) and {type:'factory.image-open',
 * id} (a badge or a pin was clicked); in comes {type:'factory.image-focus', id, open} (a card in the page was clicked: scroll
 * to that picture, or open it with the pin marked when `open`). Markers and the viewer's additions are built with
 * createElement and textContent, outside <body>.
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
.factory-lightbox-row { flex: 1 1 0; min-height: 0; display: flex; }
.factory-lightbox-stage { flex: 1 1 0; min-width: 0; min-height: 0; display: flex; overflow: auto; }
.factory-lightbox-stage > * { flex: none; margin: auto; }
.factory-lightbox-holder { position: relative; line-height: 0; }
.factory-lightbox-holder > img, .factory-lightbox-holder > svg { max-width: none !important; display: block; margin: 0 !important; }
.factory-lightbox-stage[data-zoomable] .factory-lightbox-holder > :is(img, svg) { cursor: zoom-in; }
.factory-lightbox-stage[data-zoom] .factory-lightbox-holder > :is(img, svg) { cursor: grab; }
.factory-lightbox-stage[data-panning] .factory-lightbox-holder > :is(img, svg) { cursor: grabbing; }
.factory-lightbox-stage[data-spot] .factory-lightbox-holder > :is(img, svg) { cursor: crosshair; }
.factory-lightbox .factory-lightbox-tool { font-size: 14px; }
.factory-lightbox .factory-lightbox-tool[aria-pressed="true"] { background: var(--lb-hover, #323235); border-color: #a2c3f0; }
.factory-lightbox .factory-lightbox-pin { position: absolute; transform: translate(-50%, -50%); min-width: 24px; width: 24px; height: 24px; padding: 0; border-radius: 50%;
  font-size: 12px; font-weight: 600; line-height: 1; background: #3b82f6; border: 2px solid #fff; color: #fff; box-shadow: 0 1px 4px rgb(0 0 0 / 0.5); cursor: pointer; }
.factory-lightbox .factory-lightbox-pin:hover:not(:disabled), .factory-lightbox .factory-lightbox-pin[data-active] { background: #2563eb; outline: 2px solid #a2c3f0; outline-offset: 2px; }
.factory-lightbox-side { flex: none; width: 300px; max-width: 40%; overflow: auto; margin: 0 14px 16px 0; padding: 8px 14px 16px; border: 1px solid var(--lb-line, #444447); border-radius: 8px; box-sizing: border-box; }
.factory-lightbox-side[hidden] { display: none; }
.factory-lightbox-side h2 { margin: 0 0 8px; font-size: 13px; font-weight: 600; color: var(--lb-faint, #a7a7aa); }
.factory-lightbox-side ul { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 8px; }
.factory-lightbox-side li { padding: 8px 10px; border-radius: 8px; border: 1px solid var(--lb-line, #444447); background: var(--lb-control, #2b2b2e); cursor: pointer; }
.factory-lightbox-side li[data-active] { border-color: #a2c3f0; }
.factory-lightbox-side .who { display: block; font-size: 12px; color: var(--lb-faint, #a7a7aa); }
.factory-lightbox-side .text { display: block; white-space: pre-wrap; overflow-wrap: anywhere; }
#factory-image-layer { position: fixed; inset: 0; z-index: 2147483000; pointer-events: none; }
#factory-image-layer button { position: absolute; pointer-events: auto; appearance: none; display: flex; align-items: center; justify-content: center; min-width: 28px; height: 28px; padding: 0 6px;
  border-radius: 14px; border: 2px solid #fff; background: #3b82f6; color: #fff; font: 600 12px/1 system-ui, sans-serif; cursor: pointer; box-shadow: 0 1px 4px rgb(0 0 0 / 0.5); }
#factory-image-layer button:hover { background: #2563eb; }
#factory-image-layer button:focus-visible { outline: 2px solid #a2c3f0; outline-offset: 2px; }
#factory-image-layer button.add { background: rgb(24 24 27 / 0.85); width: 32px; height: 32px; border-radius: 8px; padding: 0; border-width: 1px; font-size: 20px; font-weight: 400; }
[data-factory-comment-focus] { outline: 3px solid #a2c3f0; outline-offset: 4px; }
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
  /** the page's comments on pictures as it sent them; `null` until it does (then nothing here offers a comment) */
  let comments = null
  /** the next click on the shown picture drops a pin */
  let spotting = false
  /** the comment the page last brought into focus */
  let activeId = null
  let commentButton = null
  let spotButton = null
  let holder = null
  let side = null

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
    schedule()
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

  let styled = false
  function ensureStyle() {
    if (styled) return
    styled = true
    const style = document.createElement('style')
    style.textContent = CSS
    document.head.appendChild(style)
  }

  // image:begin
  /** FNV-1a over the UTF-16 code units, eight hex digits (packages/contract/src/image-anchor.ts). */
  function srcHash(src) {
    let hash = 0x811c9dc5
    for (let i = 0; i < src.length; i++) {
      hash ^= src.charCodeAt(i)
      hash = Math.imul(hash, 0x01000193)
    }
    return (hash >>> 0).toString(16).padStart(8, '0')
  }

  /** The index of the picture a comment hangs on among refs ({hash, label} in document order), or -1. */
  function resolveImage(refs, hint) {
    const nearest = (found) =>
      found.reduce((best, at) => (Math.abs(at - hint.occurrence) < Math.abs(best - hint.occurrence) ? at : best))
    const where = (test) => refs.flatMap((ref, at) => (test(ref) ? [at] : []))
    if (hint.srcHash !== '') {
      const same = where((ref) => ref.hash === hint.srcHash)
      if (same.length > 0) {
        const named = hint.label === '' ? [] : same.filter((at) => refs[at].label === hint.label)
        return nearest(named.length > 0 ? named : same)
      }
    }
    if (hint.label !== '') {
      const same = where((ref) => ref.label === hint.label)
      return same.length > 0 ? nearest(same) : -1
    }
    if (hint.srcHash !== '') return -1
    const there = refs[hint.occurrence]
    return there?.hash === '' && there.label === '' ? hint.occurrence : -1
  }
  // image:end

  const fold = (text) => String(text).replace(/\s+/g, ' ').trim()
  const MAX_LABEL = 300
  const labelOf = (picture) => fold(captionOf(picture)).slice(0, MAX_LABEL)
  const hashOf = (picture) => {
    const src = picture.media.localName === 'img' ? picture.media.getAttribute('src') : ''
    return src ? srcHash(src) : ''
  }
  const refsOf = (list) => list.map((picture) => ({ hash: hashOf(picture), label: labelOf(picture) }))
  const anchorOf = (list, index) => ({ occurrence: index, srcHash: hashOf(list[index]), label: labelOf(list[index]) })

  /** The headings above a node, joined as the annotator joins them (public/frame/annotator.js headingPath); keep them alike. */
  function headingPathOf(node) {
    const stack = []
    for (const h of document.querySelectorAll('h1,h2,h3,h4,h5,h6')) {
      if (!(h === node || h.contains(node) || h.compareDocumentPosition(node) & 4)) continue
      const level = Number(h.tagName.charAt(1))
      while (stack.length && stack[stack.length - 1].level >= level) stack.pop()
      stack.push({ level, text: fold(h.textContent || '') })
    }
    const path = stack
      .map((h) => h.text)
      .filter(Boolean)
      .join(' > ')
    if (path) return path.slice(0, 500)
    for (let e = node instanceof Element ? node : node.parentElement; e; e = e.parentElement) {
      if (e.id) return `#${e.id}`.slice(0, 500)
    }
    return ''
  }

  const post = (message) => parent.postMessage(message, '*')

  /** The page's comments that found their picture now: each with the picture's index and element. */
  function placed() {
    if (!comments) return []
    const list = pictures()
    const refs = refsOf(list)
    return comments.flatMap((comment) => {
      const index = resolveImage(refs, comment)
      return index === -1 ? [] : [{ ...comment, index, el: list[index].el }]
    })
  }

  const fraction = (value) => (typeof value === 'number' && value >= 0 && value <= 1 ? value : null)

  /** One item of the page's message, or nothing. */
  function readComment(item) {
    if (!item || typeof item !== 'object') return []
    const { id, occurrence, srcHash: hash, label, author, text } = item
    if (typeof id !== 'string' || id === '' || id.length > 200) return []
    if (!Number.isInteger(occurrence) || occurrence < 0) return []
    if (typeof hash !== 'string' || hash.length > 8 || typeof label !== 'string') return []
    if (typeof text !== 'string') return []
    const x = fraction(item.x)
    const y = fraction(item.y)
    return [
      {
        id,
        occurrence,
        srcHash: hash,
        label: label.slice(0, MAX_LABEL),
        x: x !== null && y !== null ? x : null,
        y: x !== null && y !== null ? y : null,
        author: author === 'lead' ? 'lead' : 'owner',
        text: text.slice(0, 500),
      },
    ]
  }

  const rectOf = (el) => {
    const { top, bottom, left } = el.getBoundingClientRect()
    return { top, bottom, left }
  }

  /** The page is to open its comment box for a picture (and a spot on it): where, in this frame's viewport. */
  function compose(index, spot, rect) {
    const list = items.length > 0 && dialog?.open ? items : pictures()
    if (!list[index]) return
    post({
      type: 'factory.image',
      image: { ...anchorOf(list, index), ...spot },
      path: headingPathOf(list[index].el),
      rect,
    })
  }

  // Inline markers: a count badge on a commented picture, a comment button on the one the pointer or the focus is on.
  let layer = null
  let hovered = null
  let focused = null
  const markers = new Map()
  let markerFrame = 0
  const schedule = () => {
    cancelAnimationFrame(markerFrame)
    markerFrame = requestAnimationFrame(paintMarkers)
  }

  function paintMarkers() {
    if (comments === null) return
    ensureStyle()
    if (!layer) {
      layer = document.createElement('div')
      layer.id = 'factory-image-layer'
      document.documentElement.appendChild(layer)
      // nothing in the layer reaches the annotator, which would read a click as one on the passage beneath it
      for (const type of ['click', 'mousemove', 'mouseup', 'touchend'])
        layer.addEventListener(type, (event) => event.stopPropagation())
    }
    const want = new Map()
    if (!dialog?.open) {
      const list = pictures()
      const found = placed()
      const touch = window.matchMedia('(hover: none)').matches
      const hot = hovered || focused
      list.forEach((picture, index) => {
        const rect = picture.el.getBoundingClientRect()
        if (rect.width === 0 || rect.bottom < 0 || rect.top > window.innerHeight) return
        const top = Math.max(rect.top, 0) + 8
        const mine = found.filter((comment) => comment.index === index)
        if (mine.length > 0)
          want.set(`badge:${index}`, { kind: 'badge', index, mine, top, left: Math.max(rect.left, 0) + 8 })
        if (hot === picture.el || touch)
          want.set(`add:${index}`, {
            kind: 'add',
            index,
            mine,
            top,
            left: Math.min(rect.right, window.innerWidth) - 40,
          })
      })
    }
    for (const [key, el] of markers) {
      if (want.has(key)) continue
      el.remove()
      markers.delete(key)
    }
    for (const [key, spec] of want) {
      let el = markers.get(key)
      if (!el) {
        el = document.createElement('button')
        el.type = 'button'
        if (spec.kind === 'add') {
          el.className = 'add'
          el.setAttribute('aria-label', 'Comment on this picture')
          el.textContent = '+'
        }
        markers.set(key, el)
        layer.appendChild(el)
      }
      el.style.top = `${spec.top}px`
      el.style.left = `${spec.left}px`
      const index = spec.index
      if (spec.kind === 'badge') {
        el.textContent = String(spec.mine.length)
        el.setAttribute(
          'aria-label',
          `${spec.mine.length} comment${spec.mine.length === 1 ? '' : 's'} on picture ${index + 1}`,
        )
        el.onclick = () => post({ type: 'factory.image-open', id: spec.mine[0].id })
      } else {
        el.onclick = () => compose(index, {}, rectOf(el))
      }
    }
  }

  document.addEventListener('mouseover', (event) => {
    if (comments === null || !(event.target instanceof Element)) return
    if (layer?.contains(event.target)) return
    const el = event.target.closest('[data-factory-zoomable]')
    if (el === hovered) return
    hovered = el
    schedule()
  })
  document.documentElement.addEventListener('mouseleave', () => {
    hovered = null
    schedule()
  })
  document.addEventListener('focusin', (event) => {
    if (comments === null || !(event.target instanceof Element) || layer?.contains(event.target)) return
    focused = event.target.closest('[data-factory-zoomable]')
    schedule()
  })
  document.addEventListener('focusout', (event) => {
    if (event.relatedTarget instanceof Element && layer?.contains(event.relatedTarget)) return
    focused = null
    schedule()
  })
  document.addEventListener('scroll', schedule, { capture: true, passive: true })
  window.addEventListener('resize', schedule)

  // C on a focused picture opens its comment box; the viewer's bar has the button for the keyboard too
  document.addEventListener('keydown', (event) => {
    if (comments === null || dialog?.open || event.key.toLowerCase() !== 'c') return
    if (event.ctrlKey || event.metaKey || event.altKey || !(event.target instanceof Element)) return
    if (!event.target.hasAttribute('data-factory-zoomable')) return
    const list = pictures()
    const index = list.findIndex((picture) => picture.el === event.target)
    if (index === -1) return
    event.preventDefault()
    compose(index, {}, rectOf(event.target))
  })

  let pulse = 0
  /** A card in the page was clicked: bring that comment's picture into view, or into the viewer with its pin marked. */
  function focusComment(id, openIt) {
    for (const el of document.querySelectorAll('[data-factory-comment-focus]'))
      el.removeAttribute('data-factory-comment-focus')
    clearTimeout(pulse)
    activeId = typeof id === 'string' ? id : null
    const found = placed().find((comment) => comment.id === activeId)
    if (!found) {
      if (dialog?.open) renderExtras()
      return
    }
    if (dialog?.open) {
      if (found.index === at) renderExtras()
      else show(found.index)
      return
    }
    if (openIt && found.x !== null) {
      open(pictures()[found.index])
      return
    }
    found.el.scrollIntoView({ block: 'center', behavior: 'smooth' })
    found.el.setAttribute('data-factory-comment-focus', '')
    pulse = setTimeout(() => found.el.removeAttribute('data-factory-comment-focus'), 2400)
  }

  window.addEventListener('message', (event) => {
    if (event.source !== parent) return
    const data = event.data
    if (!data || typeof data !== 'object') return
    if (data.type === 'factory.images' && Array.isArray(data.items)) {
      comments = data.items.slice(0, 500).flatMap(readComment)
      schedule()
      if (dialog?.open) renderExtras()
    }
    if (data.type === 'factory.image-focus') focusComment(data.id, data.open === true)
  })

  function setSpotting(on) {
    spotting = on
    if (spotButton) spotButton.setAttribute('aria-pressed', String(on))
    if (!stage) return
    if (on) stage.setAttribute('data-spot', '')
    else stage.removeAttribute('data-spot')
  }

  function activate(id) {
    activeId = id
    renderExtras()
    post({ type: 'factory.image-open', id })
  }

  /** The shown picture's pins and its comments beside it. */
  function renderExtras() {
    if (!dialog || !holder) return
    const on = comments !== null
    commentButton.hidden = spotButton.hidden = !on
    for (const pin of holder.querySelectorAll('.factory-lightbox-pin')) pin.remove()
    if (!on) {
      side.hidden = true
      fit()
      return
    }
    const mine = placed().filter((comment) => comment.index === at)
    commentButton.textContent = mine.length > 0 ? `Comment (${mine.length})` : 'Comment'
    const list = document.createElement('ul')
    let number = 0
    for (const comment of mine) {
      const spot = comment.x !== null
      const n = spot ? ++number : 0
      const active = comment.id === activeId
      if (spot) {
        const pin = document.createElement('button')
        pin.type = 'button'
        pin.className = 'factory-lightbox-pin'
        pin.textContent = String(n)
        pin.setAttribute('aria-label', `Comment ${n} on this picture`)
        pin.style.left = `${comment.x * 100}%`
        pin.style.top = `${comment.y * 100}%`
        if (active) pin.setAttribute('data-active', '')
        // a click on a pin is not a click on the picture, and the zoomed stage must not take the pointer from it
        pin.addEventListener('pointerdown', (event) => event.stopPropagation())
        pin.addEventListener('click', (event) => {
          event.stopPropagation()
          activate(comment.id)
        })
        holder.appendChild(pin)
      }
      const li = document.createElement('li')
      if (active) li.setAttribute('data-active', '')
      const who = document.createElement('span')
      who.className = 'who'
      who.textContent = `${spot ? `${n} · ` : ''}${comment.author === 'lead' ? 'The lead' : 'You'}`
      const text = document.createElement('span')
      text.className = 'text'
      text.textContent = comment.text
      li.append(who, text)
      li.addEventListener('click', () => activate(comment.id))
      list.appendChild(li)
    }
    const heading = document.createElement('h2')
    heading.textContent = `Comments (${mine.length})`
    side.replaceChildren(heading, list)
    side.hidden = mine.length === 0
    fit()
  }

  function build() {
    ensureStyle()
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
    commentButton = button('Comment on this picture', 'Comment', () => compose(at, {}, rectOf(commentButton)))
    spotButton = button('Mark a spot on this picture', 'Mark a spot', () => setSpotting(!spotting))
    for (const tool of [commentButton, spotButton]) {
      tool.className = 'factory-lightbox-tool'
      tool.hidden = true
    }
    spotButton.setAttribute('aria-pressed', 'false')
    bar.append(
      counter,
      commentButton,
      spotButton,
      previous,
      following,
      button('Close', '×', () => dialog.close()),
    )
    stage = document.createElement('div')
    stage.className = 'factory-lightbox-stage'
    caption = document.createElement('div')
    caption.className = 'factory-lightbox-caption'
    side = document.createElement('aside')
    side.className = 'factory-lightbox-side'
    side.setAttribute('aria-label', 'Comments on this picture')
    side.hidden = true
    const row = document.createElement('div')
    row.className = 'factory-lightbox-row'
    row.append(stage, side)
    dialog.append(bar, row, caption)
    // outside <body>: the annotator indexes the body's text only
    document.documentElement.appendChild(dialog)

    dialog.addEventListener('click', onDialogClick)
    // nothing inside the dialog reaches the annotator, which would read a click as one on the passage beneath it
    for (const type of ['mousemove', 'mouseup', 'touchend'])
      dialog.addEventListener(type, (event) => event.stopPropagation())
    dialog.addEventListener('close', () => {
      stage.replaceChildren()
      holder = null
      setSpotting(false)
      activeId = null
      schedule()
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
    if (onPicture && spotting) {
      const x = Math.min(1, Math.max(0, (event.clientX - box.left) / (box.width || 1)))
      const y = Math.min(1, Math.max(0, (event.clientY - box.top) / (box.height || 1)))
      setSpotting(false)
      compose(
        at,
        { x: Math.round(x * 10000) / 10000, y: Math.round(y * 10000) / 10000 },
        {
          top: event.clientY,
          bottom: event.clientY,
          left: event.clientX,
        },
      )
      return
    }
    if (onPicture) toggleZoom(event)
    else if (!event.target.closest('button') && !event.target.closest('aside')) dialog.close()
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
    // the holder takes the picture's size itself: the artifact's own rules for divs must not shrink the box the pins sit in
    // the frame measures every image of the document, this clone too, and gives a wide one a margin of its own: not here
    shown.style.setProperty('margin', '0', 'important')
    for (const el of holder ? [shown, holder] : [shown]) {
      el.style.setProperty('width', `${Math.round(width * scale)}px`, 'important')
      el.style.setProperty('height', `${Math.round(height * scale)}px`, 'important')
    }
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
    holder = document.createElement('div')
    holder.className = 'factory-lightbox-holder'
    holder.appendChild(shown)
    stage.appendChild(holder)
    setSpotting(false)
    counter.textContent = `${at + 1} / ${items.length}`
    caption.textContent = captionOf(picture)
    previous.disabled = at === 0
    following.disabled = at === items.length - 1
    previous.hidden = following.hidden = items.length < 2
    stage.scrollLeft = 0
    stage.scrollTop = 0
    renderExtras()
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
    if (event.target.closest('figcaption, dialog, #factory-image-layer')) return
    const selection = window.getSelection()
    if (selection && !selection.isCollapsed) return
    if (pressed && Math.abs(event.clientX - pressed.x) + Math.abs(event.clientY - pressed.y) > DRAG) return
    const figure = event.target.closest('figure')
    const picture = pictureOf(figure) || pictureOf(event.target.closest('img, svg'))
    if (picture) open(picture)
  })

  // The arrows follow the open dialog, not the focus: a focused Next button that turns disabled on the last picture drops
  // focus to the body, which the dialog's own listener never hears.
  document.addEventListener('keydown', (event) => {
    if (dialog?.open && (event.key === 'ArrowLeft' || event.key === 'ArrowRight')) {
      event.preventDefault()
      step(event.key === 'ArrowLeft' ? -1 : 1)
      return
    }
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
