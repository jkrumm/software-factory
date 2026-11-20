/**
 * The sidebar's logo slot: the mark on its blue tile (`/icons/mark.svg`, also the browser tab's favicon). The SVG fills
 * its box and carries its own corners; the PWA's `icon-192.png` sits on a padded grid, so a ring round it showed as a
 * border. `tests/e2e/frame-sidebar.e2e.ts` finds it by `sidebar-logo`.
 */
export function Logo() {
  return (
    <img src="/icons/mark.svg" alt="" width={28} height={28} data-testid="sidebar-logo" className="size-7 shrink-0" />
  )
}
