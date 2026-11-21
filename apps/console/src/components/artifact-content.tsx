import { MAX_IMAGE_LABEL, resolveImage, srcHash } from '@software-factory/contract'
import { useRouter } from '@tanstack/react-router'
import { type ComponentProps, type ReactNode, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import Markdown, { defaultUrlTransform } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { remarkDetails } from '@/lib/markdown-details'
import {
  headingPath,
  type ImageTarget,
  linkTarget,
  normalizeQuote,
  type Occurrence,
  type PaintAnchor,
  parseFrameMessage,
  quoteOfImage,
  type SelectionRect,
  type TocItem,
} from '@/lib/artifact'
import type { ImageComment } from '@/lib/review'
import { isPlainClick } from '@/lib/peek'
import { READING_PX, type ReadingSize } from '@/lib/reading'
import { currentTheme, onThemeChange } from '@/lib/theme'
import { cn } from '@/lib/utils'
import {
  clearHighlights,
  clearPending,
  paintActive,
  paintHighlights,
  paintPending,
  quoteAt,
  scrollToQuote,
  selectionIn,
} from '@/lib/highlight'
import { collectHeadings, readingArea, scrollParentOf, scrollToId, sectionIndex } from '@/lib/toc'

/** The part of a focus the frame needs to find its passage: what it paints from, without the page's own bookkeeping. */
const hintOf = (anchor: PaintAnchor): PaintAnchor => ({
  id: anchor.id,
  quote: anchor.quote,
  path: anchor.path,
  occurrence: anchor.occurrence,
  prefix: anchor.prefix,
  suffix: anchor.suffix,
})

export interface Selected extends Occurrence {
  quote: string
  path: string
  /** where the passage is on screen (viewport coordinates) when it was selected */
  rect: SelectionRect
  /** the Markdown passage's range, so its position can follow the page's scroll; an HTML artifact's frame has none */
  range?: Range
  /** a comment on a picture (and a spot on it) instead of a passage: `quote` is then the words that name it */
  image?: ImageTarget
}

export interface ContentProps {
  format: 'markdown' | 'html'
  content: string
  /** the primary revision: its selections can be commented on and its annotations are highlighted */
  primary: boolean
  /** the passages of the anchored annotations to paint */
  quotes: readonly PaintAnchor[]
  /** the passage to paint as the comment in focus; `tick` makes the same passage scroll twice; `scroll: false` paints without scrolling */
  focus: (PaintAnchor & { tick: number; scroll?: boolean; image?: { spot: boolean } }) | null
  /** the comments on pictures to mark: a badge on the picture, pins and a list in the HTML viewer */
  images: readonly ImageComment[]
  onSelect: (selected: Selected) => void
  /** a click on a highlighted passage: its quote, and the id of the comment it was painted for */
  onOpen: (quote: string, id?: string) => void
  /** the document's headings once it is rendered (the primary one only) */
  onHeadings: (items: TocItem[]) => void
  /** the heading of the section the reader is in, null before the first */
  onSection: (id: string | null) => void
  /** a heading to scroll to; `tick` makes the same one scroll twice */
  jump: { id: string; tick: number } | null
  /** rises whenever the composer closes: the frame drops its selection, so the same passage can be chosen again */
  cleared: number
  /** the content sits in a panel that scrolls as one (the peek): the frame takes its own height, not the column's */
  stacked?: boolean
  /** the reader's size for the text: Markdown takes it as a CSS variable, an HTML artifact's frame as a message */
  reading: ReadingSize
}

/** A link in Markdown: an anchor scrolls the document, an external one opens a tab, a Console page opens in place, the rest is text. */
function MarkdownLink({ href, children }: { href?: string; children?: ReactNode }) {
  const router = useRouter()
  const target = linkTarget(href, window.location.origin)
  if (target.kind === 'none')
    return (
      <span className="underline decoration-dotted underline-offset-2" title={href ? `No page for ${href}` : undefined}>
        {children}
      </span>
    )
  if (target.kind === 'anchor')
    return (
      <a
        href={`#${encodeURIComponent(target.id)}`}
        onClick={(event) => {
          event.preventDefault()
          const root = event.currentTarget.closest('.artifact-prose')
          if (root) scrollToId(root, target.id)
        }}
      >
        {children}
      </a>
    )
  if (target.kind === 'route')
    return (
      <a
        href={target.path}
        onClick={(event) => {
          // in a peek the document-level handler has already taken a plain click; elsewhere the router goes there
          if (event.defaultPrevented || !isPlainClick(event.nativeEvent)) return
          event.preventDefault()
          router.history.push(target.path)
        }}
      >
        {children}
      </a>
    )
  return (
    <a href={target.url} target="_blank" rel="noopener noreferrer">
      {children}
    </a>
  )
}

/** The host of an image link, or null where it is not a URL. */
function hostOf(src?: string): string | null {
  try {
    return src ? new URL(src).host : null
  } catch {
    return null
  }
}

/** The alt text, shown where an image is not loaded; its tooltip names the host the page would not load from. */
function ImageAlt({ alt, src }: { alt?: string; src?: string }) {
  const host = hostOf(src)
  const reason = !src?.startsWith('https://')
    ? 'only https images load'
    : `${host} is not in FACTORY_CONSOLE_IMAGE_HOSTS, or the link has expired`
  return (
    <span
      role="img"
      aria-label={alt ? `Picture not shown: ${alt}` : 'Picture not shown'}
      className="my-3 block rounded-md border border-dashed border-border px-3 py-2 text-sm text-muted-foreground"
      title={host ? `Not loaded from ${host}: ${reason}` : undefined}
    >
      <span className="italic">{alt ? `[picture not shown: ${alt}]` : '[picture not shown]'}</span>
      <span className="block text-xs">{reason}</span>
    </span>
  )
}

/**
 * An `https` image. The page's CSP (`img-src`) decides which hosts load: only those the owner lists in
 * `FACTORY_CONSOLE_IMAGE_HOSTS`, none by default. A blocked, expired or broken image fires `error` and shows its alt text
 * instead; no referrer is sent.
 */
function MarkdownImage({ src, alt, annotate }: { src?: string; alt?: string; annotate: boolean }) {
  const [failed, setFailed] = useState(false)
  const loaded = !failed && src?.startsWith('https://')
  return (
    // the picture a comment hangs on: its src hash and label are what the comment records and finds it by
    <span
      data-md-image=""
      data-hash={src ? srcHash(src) : ''}
      data-label={normalizeQuote(alt ?? '').slice(0, MAX_IMAGE_LABEL)}
      className="group/image relative inline-block max-w-full align-top data-[focused]:outline-2 data-[focused]:outline-offset-4 data-[focused]:outline-ring"
    >
      {loaded ? (
        <img
          src={src}
          alt={alt ?? ''}
          loading="lazy"
          referrerPolicy="no-referrer"
          onError={() => setFailed(true)}
          className="my-3 max-w-full rounded-md border border-border"
        />
      ) : (
        <ImageAlt alt={alt} src={src} />
      )}
      {annotate ? (
        <button
          type="button"
          data-md-comment=""
          aria-label="Comment on this image"
          className="absolute top-5 right-2 hidden size-8 items-center justify-center rounded-md border bg-popover text-lg text-popover-foreground shadow-sm group-focus-within/image:flex group-hover/image:flex focus-visible:flex pointer-coarse:flex"
        >
          +
        </button>
      ) : null}
      <span data-md-badge-slot="" className="contents" />
    </span>
  )
}

/**
 * The elements react-markdown renders through our own components. They are module-level and the maps are constants: a
 * component defined in the render is a new type on every render, so React would replace the whole table, link or picture
 * (new DOM nodes) each time the page re-renders, and the passages painted inside them would lose their text nodes and mark
 * nothing. `annotate` (the primary document only) is the one thing the picture needs, so there are two maps.
 */
const MARKDOWN_PARTS = {
  table: ({ node: _node, ...props }: ComponentProps<'table'> & { node?: unknown }) => (
    <div className="my-3 overflow-x-auto">
      <table {...props} />
    </div>
  ),
  a: ({ node: _node, href, children }: ComponentProps<'a'> & { node?: unknown }) => (
    <MarkdownLink href={href}>{children}</MarkdownLink>
  ),
}
const markdownImage =
  (annotate: boolean) =>
  ({ node: _node, src, alt }: ComponentProps<'img'> & { node?: unknown }) => (
    <MarkdownImage
      key={typeof src === 'string' ? src : ''}
      src={typeof src === 'string' ? src : undefined}
      alt={alt}
      annotate={annotate}
    />
  )
const MARKDOWN_COMPONENTS = { ...MARKDOWN_PARTS, img: markdownImage(true) }
const MARKDOWN_COMPONENTS_PLAIN = { ...MARKDOWN_PARTS, img: markdownImage(false) }

/** The pictures of a rendered Markdown document in order, each as the comments name them. */
function markdownPictures(root: HTMLElement): {
  elements: HTMLElement[]
  refs: Array<{ hash: string; label: string }>
} {
  const elements = Array.from(root.querySelectorAll<HTMLElement>('[data-md-image]'))
  return { elements, refs: elements.map((el) => ({ hash: el.dataset.hash ?? '', label: el.dataset.label ?? '' })) }
}

/** A comment's count on a picture; a click brings that comment's card up. */
function ImageBadge({ count, onClick }: { count: number; onClick: () => void }) {
  return (
    <button
      type="button"
      aria-label={`${count} comment${count === 1 ? '' : 's'} on this image`}
      onClick={onClick}
      className="absolute top-5 left-2 flex h-7 min-w-7 cursor-pointer items-center justify-center rounded-full border-2 border-background bg-primary px-1.5 text-xs font-semibold text-primary-foreground shadow-sm tabular-nums"
    >
      {count}
    </button>
  )
}

/**
 * Markdown through react-markdown: raw HTML is dropped, links keep only the protocols `defaultUrlTransform` allows
 * (`javascript:`, `data:` and the like become empty), and an image loads only over `https` from a host the Console's CSP
 * allows (`img-src`, `FACTORY_CONSOLE_IMAGE_HOSTS`); every other image shows its alt text.
 */
function MarkdownContent({
  content,
  primary,
  quotes,
  focus,
  images,
  onSelect,
  cleared,
  onOpen,
  onHeadings,
  onSection,
  jump,
  reading,
}: Omit<ContentProps, 'format'>) {
  const root = useRef<HTMLDivElement>(null)
  const hover = useRef(0)
  /** where a badge goes: the slot of a picture that has comments, and how many */
  const [placed, setPlaced] = useState<Array<{ slot: Element; count: number; id: string }>>([])

  // A selection is committed when the drag ends (mouse up, touch end, key up), or after it has rested for a moment (touch
  // handles end no event); never while the button is still down, so the composer does not take focus mid-drag.
  useEffect(() => {
    if (!primary) return
    let down = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const commit = () => {
      const selected = root.current && selectionIn(root.current)
      if (!selected) return
      // the comment box takes the real selection when it gets the focus, so the passage is painted on its own
      paintPending(selected.range)
      onSelect(selected)
    }
    const soon = (ms: number) => {
      clearTimeout(timer)
      timer = setTimeout(commit, ms)
    }
    const press = () => {
      down = true
    }
    const release = () => {
      down = false
      soon(0)
    }
    const onChange = () => {
      if (!down) soon(300)
    }
    document.addEventListener('mousedown', press)
    document.addEventListener('mouseup', release)
    document.addEventListener('touchend', release)
    document.addEventListener('keyup', release)
    document.addEventListener('selectionchange', onChange)
    return () => {
      clearTimeout(timer)
      document.removeEventListener('mousedown', press)
      document.removeEventListener('mouseup', release)
      document.removeEventListener('touchend', release)
      document.removeEventListener('keyup', release)
      document.removeEventListener('selectionchange', onChange)
    }
  }, [primary, onSelect])

  useEffect(() => clearPending, [])
  useEffect(() => {
    if (cleared > 0) clearPending()
  }, [cleared])

  useEffect(() => {
    if (!primary || !root.current) return
    paintHighlights(root.current, quotes)
    return clearHighlights
  }, [primary, quotes, content])

  useEffect(() => {
    if (!primary || !focus || focus.image || focus.scroll === false || !root.current) return
    // a passage inside a closed details block is opened to, or it could not be shown
    const wanted = normalizeQuote(focus.quote)
    for (const folded of root.current.querySelectorAll<HTMLDetailsElement>('details:not([open])')) {
      if (normalizeQuote(folded.textContent ?? '').includes(wanted)) folded.open = true
    }
    scrollToQuote(root.current, focus)
  }, [primary, focus])
  // the passage in focus is painted again whenever the text or the comments change under it, without scrolling to it
  useEffect(() => {
    if (primary && root.current) paintActive(root.current, focus?.image ? null : focus)
  }, [primary, focus, content, quotes])

  // The pictures that have comments get their badge (in a slot the picture's markup holds); a card's click scrolls to its picture.
  useEffect(() => {
    if (!primary || !root.current) {
      setPlaced([])
      return
    }
    const { elements, refs } = markdownPictures(root.current)
    const byPicture = new Map<number, string[]>()
    for (const image of images) {
      const at = resolveImage(refs, image)
      if (at !== -1) byPicture.set(at, [...(byPicture.get(at) ?? []), image.id])
    }
    setPlaced(
      [...byPicture].flatMap(([at, ids]) => {
        const slot = elements[at]?.querySelector('[data-md-badge-slot]')
        return slot ? [{ slot, count: ids.length, id: ids[0] ?? '' }] : []
      }),
    )
  }, [primary, images, content])
  useEffect(() => {
    if (!primary || !focus?.image || focus.scroll === false || !root.current) return
    const image = images.find((candidate) => candidate.id === focus.id)
    const { elements, refs } = markdownPictures(root.current)
    const picture = image ? elements[resolveImage(refs, image)] : undefined
    if (!picture) return
    picture.scrollIntoView({ block: 'center', behavior: 'smooth' })
    picture.setAttribute('data-focused', '')
    const timer = setTimeout(() => picture.removeAttribute('data-focused'), 2400)
    return () => {
      clearTimeout(timer)
      picture.removeAttribute('data-focused')
    }
  }, [primary, focus])

  /** The comment box for a picture: which one, where its button is, and the headings above it. */
  const commentOnPicture = (button: Element) => {
    const picture = button.closest<HTMLElement>('[data-md-image]')
    if (!picture || !root.current) return
    const { elements } = markdownPictures(root.current)
    const before = Array.from(root.current.querySelectorAll('h1,h2,h3,h4,h5,h6'))
      .filter((h) => h.compareDocumentPosition(picture) & Node.DOCUMENT_POSITION_FOLLOWING)
      .map((h) => ({ level: Number(h.tagName.charAt(1)), text: h.textContent ?? '' }))
    const image: ImageTarget = {
      occurrence: elements.indexOf(picture),
      srcHash: picture.dataset.hash ?? '',
      label: picture.dataset.label ?? '',
    }
    const { top, bottom, left } = button.getBoundingClientRect()
    onSelect({ quote: quoteOfImage(image), path: headingPath(before), image, rect: { top, bottom, left } })
  }
  useEffect(() => () => paintActive(document.body, null), [])

  // The table of contents: the headings get their anchors once the text is in, and the section in view follows the scroll.
  useEffect(() => {
    if (!primary || !root.current) return
    const { items, elements } = collectHeadings(root.current)
    onHeadings(items)
    const area = scrollParentOf(root.current)
    let frame = 0
    let last: string | null | undefined
    const follow = () => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => {
        const at = sectionIndex(elements, readingArea(area))
        const id = items[at]?.id ?? null
        if (id === last) return
        last = id
        onSection(id)
      })
    }
    follow()
    window.addEventListener('scroll', follow, { passive: true, capture: true })
    window.addEventListener('resize', follow)
    return () => {
      cancelAnimationFrame(frame)
      window.removeEventListener('scroll', follow, { capture: true })
      window.removeEventListener('resize', follow)
    }
  }, [primary, content, onHeadings, onSection])

  useEffect(() => {
    if (jump && root.current) scrollToId(root.current, jump.id)
  }, [jump])

  const passageAt = (event: React.MouseEvent) =>
    primary && root.current && !(event.target as Element).closest('a')
      ? quoteAt(root.current, quotes, event.clientX, event.clientY)
      : null

  return (
    <div
      ref={root}
      className="artifact-prose"
      style={{ '--reading-size': `${READING_PX[reading]}px` } as React.CSSProperties}
      onClick={(event) => {
        const add = primary ? (event.target as Element).closest('[data-md-comment]') : null
        if (add) {
          commentOnPicture(add)
          return
        }
        // a drag that ends on a highlight selects text; only a plain click opens the comment
        if (window.getSelection()?.isCollapsed === false) return
        const found = passageAt(event)
        if (found) onOpen(found.quote, found.id)
      }}
      onMouseMove={(event) => {
        const { clientX, clientY, target } = event
        cancelAnimationFrame(hover.current)
        hover.current = requestAnimationFrame(() => {
          if (!root.current) return
          const over =
            primary && !(target as Element).closest('a') && quoteAt(root.current, quotes, clientX, clientY) !== null
          root.current.style.cursor = over ? 'pointer' : ''
        })
      }}
    >
      <Markdown
        remarkPlugins={[remarkGfm, remarkDetails]}
        skipHtml
        urlTransform={defaultUrlTransform}
        components={primary ? MARKDOWN_COMPONENTS : MARKDOWN_COMPONENTS_PLAIN}
      >
        {content}
      </Markdown>
      {placed.map(({ slot, count, id }) =>
        createPortal(<ImageBadge count={count} onClick={() => onOpen('', id)} />, slot, id),
      )}
    </div>
  )
}

/** Scripts only: no same origin, forms, popups or top navigation. The frame's own response policy does the rest. */
const FRAME_SANDBOX = 'allow-scripts'

/**
 * An HTML artifact in a sandboxed frame loaded from `/frame.html`, which the listener serves under its own policy (no
 * request can leave it). The page sends the artifact once the frame has loaded; the frame's messages arrive here, and only
 * those from this frame's own window, in exactly the expected shape, are believed. A message never writes anything: a
 * write follows only the owner's submit in the Console's own UI. The parent keys this component on the revision, so a new
 * revision is a new frame.
 */
function HtmlContent({
  content,
  primary,
  quotes,
  focus,
  images,
  onSelect,
  cleared,
  stacked,
  onOpen,
  onHeadings,
  onSection,
  jump,
  reading,
}: Omit<ContentProps, 'format'>) {
  const frame = useRef<HTMLIFrameElement>(null)
  const size = useRef(reading)
  size.current = reading
  const router = useRouter()
  const ready = useRef(false)
  const latest = useRef(quotes)
  latest.current = quotes
  const latestImages = useRef(images)
  latestImages.current = images
  /** the frame names a heading by its index; the page's table of contents by an id */
  const headings = useRef<TocItem[]>([])
  const handlers = useRef({ onOpen, onHeadings, onSection })
  handlers.current = { onOpen, onHeadings, onSection }

  const send = (message: unknown) => frame.current?.contentWindow?.postMessage(message, '*')

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (event.source === null || event.source !== frame.current?.contentWindow) return
      const message = parseFrameMessage(event.data)
      if (message?.type === 'ready') {
        ready.current = true
        send({ type: 'factory.highlight', quotes: latest.current })
        if (primary) send({ type: 'factory.images', items: latestImages.current })
      }
      if (message?.type === 'image' && primary) {
        // the frame's rect is relative to its own viewport
        const origin = frame.current?.getBoundingClientRect()
        const { top, bottom, left } = message.rect
        onSelect({
          quote: quoteOfImage(message.image),
          path: message.path,
          image: message.image,
          rect: {
            top: top + (origin?.top ?? 0),
            bottom: bottom + (origin?.top ?? 0),
            left: left + (origin?.left ?? 0),
          },
        })
      }
      if (message?.type === 'image-open' && primary) handlers.current.onOpen('', message.id)
      if (message?.type === 'select' && primary) {
        // the frame's rect is relative to its own viewport
        const origin = frame.current?.getBoundingClientRect()
        const { top, bottom, left } = message.rect
        onSelect({
          quote: message.quote,
          path: message.path,
          ...(message.occurrence === undefined
            ? {}
            : { occurrence: message.occurrence, prefix: message.prefix, suffix: message.suffix }),
          rect: {
            top: top + (origin?.top ?? 0),
            bottom: bottom + (origin?.top ?? 0),
            left: left + (origin?.left ?? 0),
          },
        })
      }
      if (message?.type === 'open' && primary) handlers.current.onOpen(message.quote, message.id)
      if (message?.type === 'headings' && primary) {
        headings.current = message.items.map((item, i) => ({ ...item, id: `frame-${i}` }))
        handlers.current.onHeadings(headings.current)
      }
      if (message?.type === 'section' && primary)
        handlers.current.onSection(headings.current[message.index]?.id ?? null)
      if (message?.type === 'link') {
        // The artifact's own script runs in the frame and can post any message: only a link the owner has just clicked is
        // followed. A click in the frame gives this window a transient user activation; a posted message does not.
        if (!navigator.userActivation?.isActive) return
        // the frame has no network and no way out: the page opens what it is asked to, in a tab that cannot reach back
        const target = linkTarget(message.href, window.location.origin)
        if (target.kind === 'external') window.open(target.url, '_blank', 'noopener,noreferrer')
        if (target.kind === 'route') router.history.push(target.path)
      }
    }
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [primary, onSelect, router])

  useEffect(() => {
    if (primary && ready.current) send({ type: 'factory.highlight', quotes })
  }, [primary, quotes])

  useEffect(() => {
    if (primary && ready.current) send({ type: 'factory.images', items: images })
  }, [primary, images])

  useEffect(() => {
    if (!primary || !ready.current) return
    if (focus?.image) {
      // a card's click goes to its picture (into the viewer when the comment marks a spot); a click on the picture's own marker is already there
      if (focus.scroll !== false) send({ type: 'factory.image-focus', id: focus.id, open: focus.image.spot })
      send({ type: 'factory.deactivate' })
      return
    }
    send(
      focus
        ? { type: 'factory.scroll', quote: focus.quote, anchor: hintOf(focus), center: focus.scroll !== false }
        : { type: 'factory.deactivate' },
    )
  }, [primary, focus])

  useEffect(() => {
    if (primary && cleared > 0) send({ type: 'factory.clear' })
  }, [primary, cleared])

  // the Console's theme changes under a frame that is already rendered; the first paint carries it in the render message
  useEffect(() => onThemeChange((theme) => send({ type: 'factory.theme', theme })), [])

  // the reading size changes under a frame that is already rendered; the first paint carries it in the render message
  useEffect(() => {
    send({ type: 'factory.reading', px: READING_PX[reading] })
  }, [reading])

  useEffect(() => {
    const index = jump ? headings.current.findIndex((item) => item.id === jump.id) : -1
    if (index !== -1) send({ type: 'factory.goto', index })
  }, [jump])

  return (
    <iframe
      ref={frame}
      title="Artifact"
      sandbox={FRAME_SANDBOX}
      src="/frame.html"
      onLoad={() =>
        send({
          type: 'factory.render',
          html: content,
          annotate: primary,
          px: READING_PX[size.current],
          theme: currentTheme(),
        })
      }
      className={cn('h-[calc(100dvh-14rem)] min-h-96 w-full bg-background', !stacked && 'lg:h-full lg:min-h-0')}
    />
  )
}

export function ArtifactContent({ format, ...props }: ContentProps) {
  return format === 'html' ? <HtmlContent {...props} /> : <MarkdownContent {...props} />
}
