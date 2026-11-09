# The Factory mark

Two arrows woven into one closed loop: the cycle the factory automates and keeps improving.

| File | Use |
|-|-|
| `master-1024.png` | The mark on its rounded tile, transparent corners |
| `icon-1024.png` | Full bleed, for an iOS app and the App Store (the system rounds it) |
| `AppIcon.icns` | macOS, on Apple's icon grid |
| `glyph.svg` | The flat mark, for small sizes. Follows the colour scheme |

The web icons are in `apps/console/public/icons/`: `mark.svg` and `favicon.ico` for the tab, `icon-192.png` and `icon-512.png` for the PWA, `icon-maskable-512.png` for Android, `apple-touch-icon.png` for the iPhone home screen, and `og.png` for link previews.

The metal does not hold up at 16 px and cannot be a vector, so anything small uses the flat mark.
