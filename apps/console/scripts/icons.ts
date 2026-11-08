#!/usr/bin/env bun
/**
 * Renders the PWA icons (PNG) from the SVG marks in `public/icons/`. The PNGs are committed, so a build needs none of
 * this; run it after the marks change. macOS only: it uses Quick Look (`qlmanage`) and `sips`.
 */
import { mkdtemp, rename, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const dir = resolve(import.meta.dir, '../public/icons')
const targets = [
  { svg: 'mark.svg', size: 192, out: 'icon-192.png' },
  { svg: 'mark.svg', size: 512, out: 'icon-512.png' },
  { svg: 'mark-maskable.svg', size: 512, out: 'icon-maskable-512.png' },
] as const

async function run(command: string[]): Promise<void> {
  const proc = Bun.spawn(command, { stdout: 'ignore', stderr: 'pipe' })
  const [code, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()])
  if (code !== 0) throw new Error(`${command.join(' ')} exited ${code}: ${stderr}`)
}

const work = await mkdtemp(join(tmpdir(), 'console-icons-'))
try {
  for (const { svg, size, out } of targets) {
    // Quick Look renders the SVG at 512 on its long side; sips scales that to the target size.
    await run(['qlmanage', '-t', '-s', '512', '-o', work, join(dir, svg)])
    const rendered = join(work, `${svg}.png`)
    await run(['sips', '-z', String(size), String(size), rendered, '--out', join(work, out)])
    await rename(join(work, out), join(dir, out))
    await rm(rendered, { force: true })
    console.log(`public/icons/${out}`)
  }
} finally {
  await rm(work, { recursive: true, force: true })
}
