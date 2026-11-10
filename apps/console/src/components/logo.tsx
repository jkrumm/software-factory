/**
 * The sidebar's logo slot: the app icon, the metallic tile the installed PWA shows (`/icons/icon-192.png`; the flat
 * `mark.svg` is the browser tab's favicon only). `tests/e2e/frame-sidebar.e2e.ts` finds it by `sidebar-logo`.
 */
export function Logo() {
  return (
    <img
      src="/icons/icon-192.png"
      alt=""
      width={28}
      height={28}
      data-testid="sidebar-logo"
      className="size-7 shrink-0 rounded-[22%] ring-1 ring-foreground/10"
    />
  )
}
