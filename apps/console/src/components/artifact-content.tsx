import { useEffect, useRef } from 'react'
import Markdown, { defaultUrlTransform } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { parseFrameMessage } from '@/lib/artifact'
import { clearHighlights, paintHighlights, scrollToQuote, selectionIn } from '@/lib/highlight'

export interface Selected {
  quote: string
  path: string
}

export interface ContentProps {
  format: 'markdown' | 'html'
  content: string
  /** the primary revision: its selections can be commented on and its annotations are highlighted */
  primary: boolean
  /** the quotes of the anchored annotations to paint */
  quotes: readonly string[]
  /** the quote to bring into view; `tick` makes the same quote scroll twice */
  focus: { quote: string; tick: number } | null
  onSelect: (selected: Selected) => void
  /** rises whenever the composer closes: the frame drops its selection, so the same passage can be chosen again */
  cleared: number
}

/**
 * Markdown through react-markdown: raw HTML is dropped, links keep only the protocols `defaultUrlTransform` allows
 * (`javascript:`, `data:` and the like become empty), and an image is never loaded (the Console's CSP is `img-src 'self'
 * data:`, and a network image would be a request the owner did not make): its alt text shows instead.
 */
function MarkdownContent({ content, primary, quotes, focus, onSelect }: Omit<ContentProps, 'format'>) {
  const root = useRef<HTMLDivElement>(null)

  // A selection is committed when the drag ends (mouse up, touch end, key up), or after it has rested for a moment (touch
  // handles end no event); never while the button is still down, so the composer does not take focus mid-drag.
  useEffect(() => {
    if (!primary) return
    let down = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const commit = () => {
      const selected = root.current && selectionIn(root.current)
      if (selected) onSelect(selected)
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

  useEffect(() => {
    if (!primary || !root.current) return
    paintHighlights(root.current, quotes)
    return clearHighlights
  }, [primary, quotes, content])

  useEffect(() => {
    if (primary && focus && root.current) scrollToQuote(root.current, focus.quote)
  }, [primary, focus])

  return (
    <div ref={root} className="artifact-prose">
      <Markdown
        remarkPlugins={[remarkGfm]}
        skipHtml
        urlTransform={defaultUrlTransform}
        components={{
          a: ({ node: _node, ...props }) => <a {...props} target="_blank" rel="noreferrer noopener" />,
          img: ({ alt }) => <span className="italic text-muted-foreground">{alt ? `[image: ${alt}]` : '[image]'}</span>,
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
function HtmlContent({ content, primary, quotes, focus, onSelect, cleared }: Omit<ContentProps, 'format'>) {
  const frame = useRef<HTMLIFrameElement>(null)
  const ready = useRef(false)
  const latest = useRef(quotes)
  latest.current = quotes

  const send = (message: unknown) => frame.current?.contentWindow?.postMessage(message, '*')

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (event.source === null || event.source !== frame.current?.contentWindow) return
      const message = parseFrameMessage(event.data)
      if (message?.type === 'ready') {
        ready.current = true
        send({ type: 'factory.highlight', quotes: latest.current })
      }
      if (message?.type === 'select' && primary) onSelect({ quote: message.quote, path: message.path })
    }
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [primary, onSelect])

  useEffect(() => {
    if (primary && ready.current) send({ type: 'factory.highlight', quotes })
  }, [primary, quotes])

  useEffect(() => {
    if (primary && focus) send({ type: 'factory.scroll', quote: focus.quote })
  }, [primary, focus])

  useEffect(() => {
    if (primary && cleared > 0) send({ type: 'factory.clear' })
  }, [primary, cleared])

  return (
    <iframe
      ref={frame}
      title="Artifact"
      sandbox={FRAME_SANDBOX}
      src="/frame.html"
      onLoad={() => send({ type: 'factory.render', html: content, annotate: primary })}
      className="h-[70vh] w-full rounded-lg border bg-background"
    />
  )
}

export function ArtifactContent({ format, ...props }: ContentProps) {
  return format === 'html' ? <HtmlContent {...props} /> : <MarkdownContent {...props} />
}
