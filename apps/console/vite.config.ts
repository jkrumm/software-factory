import { readFileSync } from 'node:fs'
import tailwindcss from '@tailwindcss/vite'
import { tanstackRouter } from '@tanstack/router-plugin/vite'
import react from '@vitejs/plugin-react'
import { fileURLToPath } from 'node:url'
import { defineConfig, type Plugin } from 'vite'
import { VitePWA } from 'vite-plugin-pwa'

const tokensCss = readFileSync(new URL('./src/styles/tokens.css', import.meta.url), 'utf8')

/** The value of a `--vx-*` token inside the generated block of one theme; the dark block is the one with the `:root` default. */
function tokenValue(theme: 'dark' | 'light', name: string): string {
  const selector = theme === 'dark' ? ":root,\n:root[data-theme='dark']" : ":root[data-theme='light']"
  const start = tokensCss.indexOf(`${selector} {`)
  if (start === -1) throw new Error(`tokens.css has no ${theme} block: run \`bun run tokens\``)
  const end = tokensCss.indexOf('\n}', start)
  const match = new RegExp(`${name}:\\s*([^;]+);`).exec(tokensCss.slice(start, end))
  if (!match?.[1]) throw new Error(`tokens.css has no ${name} in its ${theme} block`)
  return match[1].trim()
}

const darkSurface = tokenValue('dark', '--vx-surface-bg')
const lightSurface = tokenValue('light', '--vx-surface-bg')

/** `<meta name="theme-color">` for each colour scheme, from the tokens. */
const themeColorMeta = (): Plugin => ({
  name: 'console-theme-color',
  transformIndexHtml: () => [
    {
      tag: 'meta',
      attrs: { name: 'theme-color', content: darkSurface, media: '(prefers-color-scheme: dark)' },
      injectTo: 'head',
    },
    {
      tag: 'meta',
      attrs: { name: 'theme-color', content: lightSurface, media: '(prefers-color-scheme: light)' },
      injectTo: 'head',
    },
  ],
})

export default defineConfig({
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  // The server's CSP is `font-src 'self'`: a font inlined as a data: URL would be blocked.
  build: { assetsInlineLimit: 0 },
  define: { __BUILD_ID__: JSON.stringify(Date.now().toString(36)) },
  plugins: [
    tanstackRouter({ target: 'react', autoCodeSplitting: true }),
    react(),
    tailwindcss(),
    themeColorMeta(),
    VitePWA({
      registerType: 'autoUpdate',
      strategies: 'generateSW',
      injectRegister: false,
      includeAssets: ['icons/mark.svg', 'icons/icon-192.png'],
      manifest: {
        name: 'Software Factory',
        short_name: 'Factory',
        display: 'standalone',
        start_url: '/',
        scope: '/',
        theme_color: darkSurface,
        background_color: darkSurface,
        icons: [
          { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: '/icons/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        navigateFallback: '/index.html',
        navigateFallbackDenylist: [/^\/v1\//, /^\/health/],
        cleanupOutdatedCaches: true,
        globPatterns: ['**/*.{js,css,html,svg,png,woff2,webmanifest}'],
      },
      devOptions: { enabled: false },
    }),
  ],
})
