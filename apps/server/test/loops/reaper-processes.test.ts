import { expect, test } from 'bun:test'
import { parseEtime, parseSessionPs } from '../../src/adapters/planning/reaper-processes.ts'

test.each([
  ['05:09', 309],
  ['01:02:03', 3723],
  ['4-00:00:10', 345_610],
  ['nonsense', null],
])('etime %s', (text, seconds) => expect(parseEtime(text)).toBe(seconds))

test('ps rows keep the pid, parent, age, program and only a lead session from the environment', () => {
  const out = [
    '  412     1 4-01:02:03 /Applications/Google Chrome.app/Contents/MacOS/Google Chrome --headless TERM=x FACTORY_SESSION=lead-12-3 SECRET=hunter2',
    '  413   412       00:09 /usr/bin/ssh FACTORY_SESSION=lead-12-3',
    '  414     1       10:00 /bin/zsh XFACTORY_SESSION=lead-1-1 FACTORY_SESSION=other',
    '  415     1       10:00 /bin/zsh FACTORY_SESSION=lead-7-2x',
    'garbage line',
    '',
  ].join('\n')
  const rows = parseSessionPs(out)
  expect(rows).toEqual([
    { pid: 412, ppid: 1, ageS: 349_323, comm: 'Google', session: 'lead-12-3' },
    { pid: 413, ppid: 412, ageS: 9, comm: 'ssh', session: 'lead-12-3' },
    { pid: 414, ppid: 1, ageS: 600, comm: 'zsh', session: null },
    { pid: 415, ppid: 1, ageS: 600, comm: 'zsh', session: null },
  ])
  expect(JSON.stringify(rows)).not.toContain('hunter2')
})
