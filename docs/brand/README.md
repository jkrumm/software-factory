# The Factory mark

Two arrows chasing each other round one closed loop: the cycle the factory automates and keeps improving. Flat, one shape twice (a band with a big arrowhead, turned 180°), white on a single soft blue gradient. It reads at 16 px.

| File | Use |
|-|-|
| `mark.svg` | The mark on its rounded tile: the source of every raster below, and the browser tab's favicon |
| `glyph.svg` | The bare mark with no tile. Follows the colour scheme (dark on light, light on dark) |
| `master-1024.png` | The tile rendered at 1024 px, transparent corners |
| `icon-1024.png` | Full bleed, for an iOS app and the App Store (the system rounds it) |
| `AppIcon.icns` | macOS, on Apple's icon grid |

The web icons are in `apps/console/public/icons/`: `mark.svg` and `favicon.ico` for the tab, `icon-192.png` and `icon-512.png` for the PWA and the sidebar, `icon-maskable-512.png` for Android (full bleed, the arrows sit inside the safe circle), `apple-touch-icon.png` for the iPhone home screen, and `og.png` for link previews.

Rebuild the set from `mark.svg`: render it at 1024 px (rounded for `master-1024.png`, without `rx` for the full-bleed copy), then `imgcli icon --from <rounded png> --cutout never --bg '#355d98'` for the favicon, `icon-192`, `icon-512` and `AppIcon.icns`. `imgcli` shrinks an opaque source onto the background for `apple-touch-icon` and the maskable icon, so those two are the full-bleed render resized (`magick … -resize`).

The earlier metal mark was dropped because it did not hold up at 16 px and could not be a vector (chosen 2026-11-17, "Bold" of seven candidates).
