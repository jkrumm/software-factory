import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// The policy decides over a snapshot handed in: nothing in these files may reach a file, a process, the network or the clock.
const PURE = ['policy.ts', 'health.ts']
const FORBIDDEN: [string, RegExp][] = [
  ['a node: or bun import', /from\s+["'](node:|bun)/],
  ['a process or Bun global', /\b(process|Bun)\./],
  ['the clock', /\bDate\.now\(|new Date\(\)/],
  ['a random source', /\bMath\.random\(/],
  ['the network', /\bfetch\(/],
]

for (const f of PURE) {
  test(`src/${f} is pure: ${FORBIDDEN.map(([n]) => n).join(', ')} stay out`, () => {
    const src = readFileSync(join(import.meta.dir, '..', 'src', f), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '')
    for (const [what, re] of FORBIDDEN) expect(re.test(src), `${f} reaches ${what}`).toBe(false)
  })
}
