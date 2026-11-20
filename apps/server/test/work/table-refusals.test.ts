import { expect, test } from 'bun:test'
import type { IssueId } from '../../src/kernel/ids.ts'
import { candidates, filedIssue } from '../../src/domains/work/explore.ts'
import type { Issue } from '../../src/domains/work/issue.ts'
import { apply } from '../../src/domains/work/machine.ts'

const NOW = new Date('2026-01-01T00:00:00Z')
/** Past the 30-day reopen window, so the reopen cell's own refusal is walked too. */
const MUCH_LATER = new Date(NOW.getTime() + 31 * 24 * 60 * 60_000)

/** What a refusal must hold: a backticked command, the way forward for whoever was refused. */
const NAMES_A_COMMAND = /`[^`]+`/

/**
 * Every refusal the table gives, over every Issue it can reach and every event worth sending (the walk the diagram and the
 * model test use): a refusal that names no command leaves its caller to guess the next one.
 */
function refusals(): Map<string, string> {
  const found = new Map<string, string>()
  const seen = new Set<string>()
  const queue: Issue[] = [filedIssue('issue_walk' as IssueId)]
  while (queue.length) {
    const issue = queue.shift()
    if (!issue) break
    const shape = JSON.stringify([
      issue.state,
      issue.wait?.reason,
      issue.wait?.since !== undefined,
      issue.attempt > 0,
      issue.ranOn?.rule,
    ])
    if (seen.has(shape)) continue
    seen.add(shape)
    for (const event of candidates(issue, NOW)) {
      for (const now of [NOW, MUCH_LATER]) {
        const decided = apply(issue, event, { now })
        if (decided.result === 'applied') {
          if (now === NOW) queue.push(decided.issue)
          continue
        }
        // The sender rule is the machine's, before the table: "<kind> is not the <actor>'s to send".
        if (decided.result === 'refused' && !decided.detail.endsWith("'s to send")) {
          found.set(decided.detail, `${issue.state} takes ${event.kind} from ${event.actor}`)
        }
      }
    }
  }
  return found
}

test('every refusal of the transition table names a command', () => {
  const found = refusals()
  // The walk reaches the table's refusals: closed, shipped, waiting, stalled and the attempt rule among them.
  expect(found.size).toBeGreaterThan(30)
  const texts = [...found.keys()]
  expect(texts.some((text) => text.startsWith('it is closed: reopen it with'))).toBe(true)
  expect(texts.some((text) => text.startsWith('it is closed: file the work as a signal'))).toBe(true)
  expect(texts.some((text) => text.startsWith('it shipped: the watch is on'))).toBe(true)
  expect(texts.some((text) => text.startsWith('closed more than 30 days ago'))).toBe(true)
  const bare = [...found].filter(([text]) => !NAMES_A_COMMAND.test(text)).map(([text, where]) => `${where}: ${text}`)
  expect(bare).toEqual([])
})
