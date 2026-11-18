/**
 * Where the owner was reading when an update reloads the page. The reload keeps the URL but not the scroll position: the
 * Console scrolls inside its own containers (marked `data-scroll-restoration-id`, which the router's restoration reads
 * too) and their content arrives after an async fetch, so the browser's own restoration finds a page too short to scroll.
 * Before an update reload the positions are stored by URL in `sessionStorage`; the next load puts each one back once its
 * container can reach it and no skeleton is left on the page, then forgets them.
 */

const STORE_KEY = 'console-scroll-keep'
/** A stored position older than this belongs to no reload of ours. */
const KEEP_MAX_AGE_MS = 2 * 60_000
/** A page whose data never comes has nothing to put the position back on. */
const GIVE_UP_MS = 30_000
const STEP_MS = 100
const ATTRIBUTE = 'data-scroll-restoration-id'
const PAGE = 'page'
const SKELETON = '[data-skeleton]'

export interface Position {
  top: number
  left: number
}

export interface Kept {
  /** path, search and hash of the page the positions belong to */
  url: string
  at: number
  boxes: Record<string, Position>
}

/** What a scroll container shows of itself: the part of `Element` this reads and writes. */
export interface Box {
  scrollTop: number
  scrollLeft: number
  scrollHeight: number
  clientHeight: number
}

/** The page's containers by id, and whether a skeleton is still on screen. The page itself (the document's scroller) is `page`. */
export interface Surface {
  box: (id: string) => Box | null
  boxes: () => [string, Box][]
  loading: () => boolean
}

export function surfaceOf(doc: Document): Surface {
  const page = (): Box | null => doc.scrollingElement ?? null
  return {
    box: (id) =>
      id === PAGE ? page() : (doc.querySelector<HTMLElement>(`[${ATTRIBUTE}="${CSS.escape(id)}"]`) ?? null),
    boxes: () => {
      const marked = [...doc.querySelectorAll<HTMLElement>(`[${ATTRIBUTE}]`)].map((element): [string, Box] => [
        element.getAttribute(ATTRIBUTE) ?? '',
        element,
      ])
      const scroller = page()
      return scroller ? [[PAGE, scroller], ...marked] : marked
    },
    loading: () => doc.querySelector(SKELETON) !== null,
  }
}

/** The positions of every container that is scrolled; null when nothing is, so a page read from its top stores nothing. */
export function keepOf(surface: Surface, url: string, now: number): Kept | null {
  const boxes: Record<string, Position> = {}
  for (const [id, box] of surface.boxes()) {
    if (id !== '' && (box.scrollTop > 0 || box.scrollLeft > 0)) boxes[id] = { top: box.scrollTop, left: box.scrollLeft }
  }
  return Object.keys(boxes).length === 0 ? null : { url, at: now, boxes }
}

/** Whether a stored position still belongs to this page: the same address and a reload that was just now. */
export const keptFor = (kept: Kept | null, url: string, now: number): kept is Kept =>
  kept?.url === url && now - kept.at >= 0 && now - kept.at <= KEEP_MAX_AGE_MS

/** A container reaches a position only once its content is tall enough; before that, setting it would clamp. */
const reaches = (box: Box, at: Position): boolean => box.scrollHeight - box.clientHeight >= at.top

/**
 * One try at putting positions back: nothing while a skeleton shows, then each container whose content reaches its
 * position. Returns the positions still to place.
 */
export function placeKept(surface: Surface, pending: Record<string, Position>): Record<string, Position> {
  if (surface.loading()) return pending
  const left: Record<string, Position> = {}
  for (const [id, at] of Object.entries(pending)) {
    const box = surface.box(id)
    if (box && reaches(box, at)) {
      box.scrollTop = at.top
      box.scrollLeft = at.left
    } else left[id] = at
  }
  return left
}

function parse(text: string | null): Kept | null {
  if (!text) return null
  try {
    const value = JSON.parse(text) as Kept
    return typeof value.url === 'string' && typeof value.at === 'number' && typeof value.boxes === 'object'
      ? value
      : null
  } catch {
    return null
  }
}

const addressOf = (location: Location): string => location.pathname + location.search + location.hash

/** Stores where every scrolled container is, just before the page reloads for a new bundle. */
export function keepScroll(): void {
  try {
    const kept = keepOf(surfaceOf(document), addressOf(location), Date.now())
    if (kept) sessionStorage.setItem(STORE_KEY, JSON.stringify(kept))
    else sessionStorage.removeItem(STORE_KEY)
  } catch {
    // a full or blocked storage loses the position, never the reload
  }
}

/**
 * At boot: puts stored positions back as the screen's data renders, then forgets them. The owner's own input ends it at
 * once, and so does `GIVE_UP_MS`: a position is never fought for against a hand on the page.
 */
export function restoreKeptScroll(): void {
  let kept: Kept | null = null
  try {
    kept = parse(sessionStorage.getItem(STORE_KEY))
    sessionStorage.removeItem(STORE_KEY)
  } catch {
    return
  }
  if (!keptFor(kept, addressOf(location), Date.now())) return
  const surface = surfaceOf(document)
  let pending = kept.boxes
  const stop = () => {
    clearInterval(timer)
    clearTimeout(giveUp)
    for (const type of INPUTS) document.removeEventListener(type, stop, { capture: true })
  }
  const timer = setInterval(() => {
    pending = placeKept(surface, pending)
    if (Object.keys(pending).length === 0) stop()
  }, STEP_MS)
  const giveUp = setTimeout(stop, GIVE_UP_MS)
  for (const type of INPUTS) document.addEventListener(type, stop, { capture: true, passive: true })
}

const INPUTS = ['pointerdown', 'keydown', 'wheel', 'touchstart'] as const
