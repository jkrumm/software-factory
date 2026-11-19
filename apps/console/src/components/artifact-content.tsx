import { useRouter } from '@tanstack/react-router'
import { type ReactNode, useEffect, useRef, useState } from 'react'
import Markdown, { defaultUrlTransform } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { linkTarget, parseFrameMessage, type SelectionRect, type TocItem } from '@/lib/artifact'
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

export interface Selected {
  quote: string
  path: string
  /** where the passage is on screen (viewport coordinates) when it was selected */
  rect: SelectionRect
  /** the Markdown passage's range, so its position can follow the page's scroll; an HTML artifact's frame has none */
  range?: Range
}

export interface ContentProps {
  format: 'markdown' | 'html'
  content: string
  /** the primary revision: its selections can be commented on and its annotations are highlighted */
  primary: boolean
  /** the quotes of the anchored annotations to paint */
  quotes: readonly string[]
  /** the quote to paint as the comment in focus; `tick` makes the same quote scroll twice; `scroll: false` paints without scrolling */
  focus: { quote: string; tick: number; scroll?: boolean } | null
  onSelect: (selected: Selected) => void
  /** a click on a highlighted passage: its quote */
  onOpen: (quote: string) => void
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
    <span className="italic text-muted-foreground" title={host ? `Not loaded from ${host}: ${reason}` : undefined}>
      {alt ? `[image: ${alt}]` : '[image]'}
    </span>
  )
}

/**
 * An `https` image. The page's CSP (`img-src`) decides which hosts load: only those the owner lists in
 * `FACTORY_CONSOLE_IMAGE_HOSTS`, none by default. A blocked, expired or broken image fires `error` and shows its alt text
 * instead; no referrer is sent.
 */
function MarkdownImage({ src, alt }: { src?: string; alt?: string }) {
  const [failed, setFailed] = useState(false)
  if (failed || !src?.startsWith('https://')) return <ImageAlt alt={alt} src={src} />
  return (
    <img
      src={src}
      alt={alt ?? ''}
      loading="lazy"
      referrerPolicy="no-referrer"
      onError={() => setFailed(true)}
      className="my-3 max-w-full rounded-md border border-border"
    />
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
    if (primary && focus && focus.scroll !== false && root.current) scrollToQuote(root.current, focus.quote)
  }, [primary, focus])
  // the passage in focus is painted again whenever the text or the comments change under it, without scrolling to it
  useEffect(() => {
    if (primary && root.current) paintActive(root.current, focus?.quote ?? null)
  }, [primary, focus, content, quotes])
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
        // a drag that ends on a highlight selects text; only a plain click opens the comment
        if (window.getSelection()?.isCollapsed === false) return
        const quote = passageAt(event)
        if (quote) onOpen(quote)
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
        remarkPlugins={[remarkGfm]}
        skipHtml
        urlTransform={defaultUrlTransform}
        components={{
          table: ({ node: _node, ...props }) => (
            <div className="my-3 overflow-x-auto">
              <table {...props} />
            </div>
          ),
          a: ({ node: _node, href, children }) => <MarkdownLink href={href}>{children}</MarkdownLink>,
          img: ({ node: _node, src, alt }) => (
            <MarkdownImage
              key={typeof src === 'string' ? src : ''}
              src={typeof src === 'string' ? src : undefined}
              alt={alt}
            />
          ),
        }}
      >
        {content}
      </Markdown>
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
      }
      if (message?.type === 'select' && primary) {
        // the frame's rect is relative to its own viewport
        const origin = frame.current?.getBoundingClientRect()
        const { top, bottom, left } = message.rect
        onSelect({
          quote: message.quote,
          path: message.path,
          rect: {
            top: top + (origin?.top ?? 0),
            bottom: bottom + (origin?.top ?? 0),
            left: left + (origin?.left ?? 0),
          },
        })
      }
      if (message?.type === 'open' && primary) handlers.current.onOpen(message.quote)
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
    if (!primary || !ready.current) return
    send(
      focus
        ? { type: 'factory.scroll', quote: focus.quote, center: focus.scroll !== false }
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
