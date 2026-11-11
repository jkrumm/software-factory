import { expect, test } from 'bun:test'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { TimerIcon } from '@phosphor-icons/react'
import { renderToStaticMarkup } from 'react-dom/server'
import { StatCard } from '../src/components/kit/stat-card.tsx'
import { durationWords } from '../src/components/kit/step-rail.tsx'

const root = join(import.meta.dir, '..')
const REASON = 'The factory has not counted tokens for this Issue yet.'

const sourceFiles = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    return statSync(path).isDirectory() ? sourceFiles(path) : [path]
  })

test('the big figure is tabular, never proportional', () => {
  const html = renderToStaticMarkup(<StatCard icon={TimerIcon} title="Turns" subtitle="This attempt" value="27" />)
  const figure = html.match(/<span class="[^"]*">27<\/span>/)?.[0] ?? ''
  expect(figure).toContain('tabular-nums')
  expect(figure).not.toContain('proportional-nums')
})

test('an uncounted figure is a dash with its reason, not a zero or None', () => {
  const html = renderToStaticMarkup(
    <StatCard
      icon={TimerIcon}
      title="Tokens out"
      subtitle="This attempt"
      value={null}
      valueNote={REASON}
      delta={{ value: 3 }}
      footer={[
        { label: 'Tokens in', value: null, note: REASON },
        { label: 'Cache write', value: '4' },
      ]}
    />,
  )
  expect(html).toContain('>–<')
  expect(html).toContain(`title="${REASON}"`)
  expect(html).toContain(
    `<p class="text-[length:var(--vx-text-sm)] [overflow-wrap:anywhere] text-muted-foreground">${REASON}</p>`,
  )
  expect(html).toContain(`<span class="sr-only">${REASON}</span>`)
  expect(html).not.toContain('>0<')
  expect(html).not.toContain('None')
  expect(html).not.toContain('+3')
})

test('body sets tabular figures once and no source uses proportional-nums', () => {
  const css = readFileSync(join(root, 'src/styles/index.css'), 'utf8')
  expect(css).toMatch(/\bbody\s*\{[^}]*font-variant-numeric:\s*tabular-nums/)
  const found = sourceFiles(join(root, 'src')).filter((file) =>
    readFileSync(file, 'utf8').includes('proportional-nums'),
  )
  expect(found).toEqual([])
})

test('working time floors to whole minutes, so every place that shows it reads the same', () => {
  expect(durationWords(23 * 60_000 + 40_000)).toBe('23 min')
  for (const file of ['src/components/issue/header.tsx', 'src/components/issue/overview.tsx']) {
    const source = readFileSync(join(root, file), 'utf8')
    expect(source).toContain('durationWords(')
    expect(source).not.toMatch(/spanWords\([^)]*workingMs/)
  }
})

test('a card with no plot does not stretch to a taller neighbour', () => {
  const bare = renderToStaticMarkup(
    <StatCard icon={TimerIcon} title="Cycle median" subtitle="Last 7 days" value="3 h" />,
  )
  const plotted = renderToStaticMarkup(
    <StatCard icon={TimerIcon} title="Turns" subtitle="Last 7 days" value="3" bars={[1, 2, 3]} />,
  )
  expect(bare.match(/<article class="[^"]*"/)?.[0]).toContain('self-start')
  expect(plotted.match(/<article class="[^"]*"/)?.[0]).not.toContain('self-start')
})
