import { Link, useRouter, useRouterState } from '@tanstack/react-router'
import { lazy, Suspense, useCallback, useEffect, useRef } from 'react'
import { Peek as PeekPanel } from '@/components/kit/peek'
import { Skeleton } from '@/components/kit/skeleton'
import { isPlainClick, type Peek, peekOf, peekPage, peekSearch, peekTarget } from '@/lib/peek'

// the Issue and artifact views (markdown, the annotation panel) are a chunk of their own, fetched when the first peek opens
const PeekContent = lazy(() => import('./content'))

/** Another popup (a popover, the palette, a menu) is open: Escape is its, not the panel's. */
const OTHER_POPUP = '[role="dialog"][data-open], [role="menu"], [role="listbox"]'

const PAGE_OF_A_THING = /^\/(issues|artifacts)\//

const isField = (target: EventTarget | null): target is HTMLElement =>
  target instanceof HTMLElement &&
  (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName))

const labelOf = (peek: Peek): string => (peek.kind === 'issue' ? `Issue ${peek.id}` : 'Artifact')

/**
 * Opens an Issue or an artifact in a right-side panel (`?peek=`, `lib/peek.ts`) over the page it was clicked on, which stays
 * mounted so its scroll, filters and selection are where they were when the panel closes.
 *
 * One click handler serves every link in the Console: a plain click on any link to `/issues/<n>` or `/artifacts/<id>` opens
 * the peek instead; a modifier click, a middle click, a `target`, or a link marked `data-peek="off"` keeps the full page, and
 * so does every link on the Issue's and the artifact's own page.
 * Opening from a closed panel pushes one history entry and closing it goes back, so Escape and the browser's back are
 * the same step; swapping what the panel shows replaces the entry, so a whole peek session is one step back.
 */
export function PeekHost() {
  const router = useRouter()
  const search = useRouterState({ select: (state) => state.location.search })
  const peek = peekOf(search)
  const latest = useRef(peek)
  latest.current = peek
  /** The panel was opened by a push from this page, so closing it is a step back. */
  const pushed = useRef(false)
  if (peek === null) pushed.current = false

  const go = useCallback(
    (next: Peek | null, replace: boolean) =>
      void router.navigate({
        to: '.',
        search: (prev: Record<string, unknown>) => ({ ...prev, ...peekSearch(next) }),
        replace,
      } as never),
    [router],
  )

  const close = useCallback(() => {
    if (pushed.current) {
      pushed.current = false
      router.history.back()
      return
    }
    go(null, true)
  }, [router, go])

  useEffect(() => {
    const onClick = (event: MouseEvent) => {
      if (!isPlainClick(event)) return
      const anchor = event.target instanceof Element ? event.target.closest('a[href]') : null
      if (!(anchor instanceof HTMLAnchorElement) || anchor.target || anchor.hasAttribute('download')) return
      if (anchor.closest('[data-peek="off"]')) return
      const url = new URL(anchor.href)
      if (url.origin !== window.location.origin) return
      // the Issue's and the artifact's own pages are the full view: a link on them goes there (the peek opens over lists)
      if (latest.current === null && PAGE_OF_A_THING.test(window.location.pathname)) return
      const target = peekTarget(url.pathname, url.searchParams)
      if (!target) return
      event.preventDefault()
      event.stopPropagation()
      const open = latest.current !== null
      if (!open) pushed.current = true
      go(target, open)
    }
    document.addEventListener('click', onClick, true)
    return () => document.removeEventListener('click', onClick, true)
  }, [go])

  useEffect(() => {
    if (peek === null) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return
      // in a field the first Escape leaves the field (a draft is not thrown away with the panel)
      if (isField(event.target)) {
        event.target.blur()
        return
      }
      if (document.querySelector(OTHER_POPUP)) return
      close()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [peek === null, close])

  if (peek === null) return null
  const page = peekPage(peek)
  return (
    <PeekPanel
      label={labelOf(peek)}
      tag={labelOf(peek)}
      onClose={close}
      page={(props) => <Link to={page.to} params={page.params} search={page.search as never} {...props} />}
    >
      <Suspense fallback={<Skeleton height={320} className="m-4" />}>
        <PeekContent peek={peek} onChange={(next) => go(next, true)} />
      </Suspense>
    </PeekPanel>
  )
}
