import { expect, test } from 'bun:test'
import { matchKeyOf, normalizeAsk, normalizeCommand } from '../../src/domains/checkpoints/match.ts'
import { readErrand } from '../../src/domains/checkpoints/errand.ts'

test('a command is the same through whitespace and a trailing separator', () => {
  expect(normalizeCommand('  make   -C ~/x  keys ;\n')).toBe('make -C ~/x keys')
  expect(normalizeCommand('make keys &&')).toBe('make keys')
})

test('an ask is the same through case and punctuation', () => {
  expect(normalizeAsk('Reseal the secrets cache!')).toBe(normalizeAsk('  reseal the SECRETS cache '))
  expect(normalizeAsk('Reseal the secrets cache')).not.toBe(normalizeAsk('Reseal the keys cache'))
})

test('the need key wins, then the command, then the ask; a command is repo-free, the rest are the repo own', () => {
  const base = { repo: 'a', needKey: null, command: null, summary: 'Set the contact' }
  expect(matchKeyOf({ ...base, needKey: 'k', command: 'make x' })).toBe('need:a:k')
  expect(matchKeyOf({ ...base, command: 'make  x' })).toBe(matchKeyOf({ ...base, repo: 'b', command: 'make x;' }))
  expect(matchKeyOf(base)).toBe(matchKeyOf({ ...base, summary: 'set the contact.' }))
  expect(matchKeyOf(base)).not.toBe(matchKeyOf({ ...base, repo: 'b' }))
  expect(matchKeyOf({ ...base, summary: '!!!' })).toBeNull()
})

test('a need key a lead states is a short lowercase name, else the Errand is refused with it named', () => {
  const raw = { summary: 's', need: 'hands', tried: 't' }
  expect(readErrand({ ...raw, needKey: 'census-ua-contact' })).toMatchObject({
    ok: true,
    value: { needKey: 'census-ua-contact' },
  })
  expect(readErrand(raw)).toMatchObject({ ok: true, value: { needKey: null } })
  const refused = readErrand({ ...raw, needKey: 'Census Contact' })
  expect(refused).toMatchObject({ ok: false })
  expect(JSON.stringify(refused)).toContain('needKey')
})
