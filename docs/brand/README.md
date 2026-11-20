# The Factory mark

Two arrows chasing each other round one closed loop: the cycle the factory automates and keeps improving. Flat, one shape twice (a band with a large barbed arrowhead, turned 180°), each tail running under the other arrow's head with a thin even gap, white on a single soft blue gradient. It reads at 16 px.

| File | Use |
|-|-|
| `mark.svg` | The mark on its rounded tile: the source of every raster below, and the browser tab's favicon |
| `glyph.svg` | The bare mark with no tile. Follows the colour scheme (dark on light, light on dark) |
| `full-bleed.svg`, `maskable.svg` | The tile without corners, and the same with the arrows inside Android's safe circle: the sources of the opaque rasters |
| `master-1024.png` | The tile rendered at 1024 px, transparent corners |
| `icon-1024.png` | Full bleed, for an iOS app and the App Store (the system rounds it) |
| `AppIcon.icns` | macOS, on Apple's icon grid |
| `social-1280x640.png` | GitHub's social preview (repository Settings, "Social preview": an upload by hand, GitHub has no API for it) |

The web icons are in `apps/console/public/icons/`: `mark.svg` and `favicon.ico` for the tab, `icon-192.png` and `icon-512.png` for the PWA (the sidebar shows `mark.svg`), `icon-maskable-512.png` for Android (full bleed, the arrows sit inside the safe circle), `apple-touch-icon.png` for the iPhone home screen, and `og.png` for link previews.

## Rebuild the set

The geometry is the parameters at the top of `scripts/brand.ts`; no SVG here is edited by hand.

1. `bun scripts/brand.ts` writes every SVG (`mark`, `glyph`, `full-bleed`, `maskable`, and the copies under `apps/console/public/icons/` and `docs/guide/public/`).
2. Render `mark.svg` at 1024 px to `master-1024.png`, `full-bleed.svg` at 1024 px to `icon-1024.png` and at 180 px to `apple-touch-icon.png`, and `maskable.svg` at 512 px to `icon-maskable-512.png`.
3. `imgcli icon --from master-1024.png --cutout never --bg '#355d98'` gives `favicon.ico`, `icon-192.png`, `icon-512.png` and an `AppIcon.icns` on the macOS grid.
4. Rebuild the `.icns` with Apple's own tool: `iconutil -c iconset AppIcon.icns`, replace `icon_16x16.png` and `icon_32x32.png` with their `@2x` neighbours resized, then `iconutil -c icns`. The 16 and 32 px entries of the generated file decode as noise.
5. Put the tile (360 px, at 90, 135) onto `og.png`, and extend that card to 1280 × 640 for `social-1280x640.png`.
6. Look at every file at its real size, the maskable icon under a circle of 80 % of its width, and the glyph on a light and on a dark ground.

After the deploy, an installed app keeps the icon it was installed with: remove the Dock or home-screen app and add it again. Upload `social-1280x640.png` on GitHub when the card changed.

The earlier metal mark was dropped because it did not hold up at 16 px and could not be a vector (2026-11-17). The first flat mark had two separate arrows with short heads; the interlocked one replaced it on 2026-11-20 (larger, sharper arrows that fill the tile).
