import { expect, test } from 'bun:test'
import type { ChainEdge, ChainModel } from '@software-factory/contract'
import {
  chainCounts,
  chainOf,
  dateWords,
  edgeText,
  isBlocked,
  isolatedNote,
  issueNumber,
  lozengeOf,
  projectsOf,
  scheduleOf,
  stateWord,
  reasonOf,
  untilWords,
  waitsForWords,
} from '../src/lib/chain.ts'
import { layoutOf } from '../src/lib/chain-layout.ts'

const node = (id: string, repo: string, title = id, kind: 'issue' | 'row' = 'issue', state = 'queued') => ({
  id,
  kind,
  repo,
  title,
  state,
  issueKind: 'feature' as const,
  since: kind === 'issue' ? '2026-11-08T00:00:00.000Z' : null,
  waitReason: null,
  notBefore: null,
})

// c waits for b waits for a; b also waits for the closed z; "solo" waits for nothing
const model: ChainModel = {
  at: '2026-11-08T00:00:00.000Z',
  nodes: [
    node('issue_1', 'argo', 'A'),
    node('issue_2', 'orion', 'B'),
    node('issue_3', 'argo', 'C'),
    node('issue_9', 'orion', 'Z', 'issue', 'closed'),
    node('issue_5', 'harbor', 'Solo'),
    node('row:harbor:next', 'harbor', 'Next', 'row', 'waiting'),
  ],
  edges: [
    { from: 'issue_2', to: 'issue_1', closed: false },
    { from: 'issue_3', to: 'issue_2', closed: false },
    { from: 'issue_2', to: 'issue_9', closed: true },
  ],
  blocking: {},
}

test('a linear chain lays out left to right, blockers first', () => {
  const view = chainOf(model)
  const at = layoutOf(view.nodes, view.edges)
  const x = (id: string) => at.get(id)?.x ?? Number.NaN
  expect(x('issue_1')).toBeLessThan(x('issue_2'))
  expect(x('issue_2')).toBeLessThan(x('issue_3'))
  expect(x('issue_9')).toBeLessThan(x('issue_2'))
})

test('an edge is blocked until its blocker has closed', () => {
  expect(model.edges.map(isBlocked)).toEqual([true, true, false])
})

test('nodes without an edge are counted, not drawn', () => {
  const view = chainOf(model)
  expect(view.nodes.map((n) => n.id).sort()).toEqual(['issue_1', 'issue_2', 'issue_3', 'issue_9'])
  expect(view.isolated).toBe(2)
  expect(isolatedNote(1)).toBe('1 more item has no dependencies, so it is not drawn')
  expect(isolatedNote(2)).toBe('2 more items have no dependencies, so they are not drawn')
})

test('a project keeps its nodes and the nodes an edge joins them to', () => {
  const view = chainOf(model, { project: 'orion' })
  expect(view.nodes.map((n) => n.id).sort()).toEqual(['issue_1', 'issue_2', 'issue_3', 'issue_9'])
  const harbor = chainOf(model, { project: 'harbor' })
  expect(harbor.nodes).toEqual([])
  expect(harbor.edges).toEqual([])
  expect(harbor.isolated).toBe(2)
  const argo = chainOf(model, { project: 'argo' })
  expect(argo.edges).toHaveLength(2)
  expect(argo.nodes.map((n) => n.id)).not.toContain('issue_9')
  expect(projectsOf(model)).toEqual(['argo', 'harbor', 'orion'])
})

test('words and links: no ids, a number for an Issue only', () => {
  expect(issueNumber(node('issue_12', 'argo'))).toBe('12')
  expect(issueNumber(node('row:argo:x', 'argo', 'X', 'row'))).toBeNull()
  expect(stateWord('filable')).toBe('Ready to file')
  expect(stateWord('settling')).toBe('Settling')
  const byId = new Map(model.nodes.map((n) => [n.id, n]))
  expect(edgeText(model.edges[0] as ChainEdge, byId)).toBe('A blocks B')
  expect(edgeText(model.edges[2] as ChainEdge, byId)).toBe('Z is done, B no longer waits for it')
})

const DAY = 86_400_000
const NOW = Date.parse('2026-11-09T12:00:00.000Z')
const dated = (key: string, days: number, repo = 'quartz') => ({
  ...node(`row:${repo}:${key}`, repo, key, 'row', 'waiting'),
  notBefore: new Date(NOW + days * DAY).toISOString(),
})

test('a row with a date is on the schedule, not isolated', () => {
  const withDates: ChainModel = { ...model, nodes: [...model.nodes, dated('later-report', 3, 'harbor')] }
  expect(chainOf(withDates).isolated).toBe(2)
  expect(chainOf(withDates, { project: 'harbor' }).isolated).toBe(2)
})

test('the schedule is in date order with the axis from now to the last date', () => {
  const schedule = scheduleOf([dated('c', 9), dated('a', 2), dated('b', 40), node('issue_1', 'argo')], NOW)
  expect(schedule.items.map((i) => i.node.title)).toEqual(['a', 'c', 'b'])
  expect(schedule.start).toBe(NOW)
  expect(schedule.end).toBe(NOW + 40 * DAY)
  expect(schedule.items.map((i) => i.position)).toEqual([2 / 40, 9 / 40, 1])
  expect(schedule.unit).toBe('week')
  const days = schedule.ticks.map((t) => t.at)
  expect(days).toEqual([...days].sort((a, b) => a - b))
  expect(days.every((at) => at > NOW && at <= schedule.end)).toBe(true)
  expect(schedule.ticks.every((t) => new Date(t.at).getDay() === 1)).toBe(true)
})

test('the axis is at least 7 days and uses day ticks up to 14 days', () => {
  const one = scheduleOf([dated('a', 1)], NOW)
  expect(one.end).toBe(NOW + 7 * DAY)
  expect(one.unit).toBe('day')
  expect(one.ticks.length).toBeGreaterThanOrEqual(6)
  expect(one.ticks.length).toBeLessThanOrEqual(8)
  const none = scheduleOf([], NOW)
  expect(none.items).toEqual([])
  expect(none.end).toBe(NOW + 7 * DAY)
})

test('a chip that would cover a later dot sits above it, those that fit share a lane', () => {
  const close = scheduleOf([dated('a', 10), dated('b', 11), dated('c', 12), dated('d', 60)], NOW, 0.2)
  // the earlier chip sits above the later ones it would cover, so each dot's stem reaches its own chip
  expect(close.items.map((i) => i.lane)).toEqual([2, 1, 0, 0])
  expect(close.lanes).toBe(3)
  const apart = scheduleOf([dated('a', 10), dated('b', 11), dated('c', 12), dated('d', 60)], NOW, 0.01)
  expect(apart.items.map((i) => i.lane)).toEqual([0, 0, 0, 0])
})

test('a row beyond 120 days goes to Later with its date; a past date is due and pinned at Now', () => {
  const schedule = scheduleOf([dated('far', 400), dated('old', -3), dated('soon', 5)], NOW)
  const by = (title: string) => schedule.items.find((i) => i.node.title === title)
  expect(by('far')?.later).toBe(true)
  expect(by('far')?.lane).toBe(0)
  expect(schedule.end).toBe(NOW + 7 * DAY)
  expect(by('old')).toMatchObject({ due: true, later: false, position: 0 })
  expect(by('soon')?.due).toBe(false)
  expect(schedule.items.map((i) => i.node.title)).toEqual(['old', 'soon', 'far'])
})

test('words for a date, a distance and a state the kit does not know', () => {
  expect(dateWords('2026-11-16T09:00:00.000Z', NOW)).toMatch(/^[A-Z][a-z]{2} \d{1,2} Nov, \d{2}:\d{2}$/)
  expect(untilWords(6.5 * DAY)).toBe('in 6 days')
  expect(untilWords(DAY)).toBe('in 1 day')
  expect(untilWords(5 * 3_600_000)).toBe('in 5 h')
  expect(untilWords(0)).toBe('due')
  expect(untilWords(800 * DAY)).toBe('in 2 years')
  expect(dateWords('2099-01-01T09:00:00.000Z', NOW)).toMatch(/^[A-Z][a-z]{2} 1 Jan 2099, \d{2}:\d{2}$/)
  // the year is named only when it is not `now`'s year
  expect(dateWords('2027-01-05T09:00:00.000Z', NOW)).toMatch(/ Jan 2027, /)
  expect(dateWords('2027-01-05T09:00:00.000Z', Date.parse('2027-02-01T00:00:00.000Z'))).not.toMatch(/2027/)
  expect(lozengeOf({ kind: 'row', state: 'filable' })).toEqual({ state: 'queued', label: 'Ready to file' })
  expect(lozengeOf({ kind: 'row', state: 'waiting' })).toEqual({ state: 'waiting' })
  expect(lozengeOf({ kind: 'issue', state: 'odd' })).toEqual({ state: 'queued', label: 'Odd' })
})

test('a node that waits on open blockers says for whom', () => {
  const byId = new Map(model.nodes.map((n) => [n.id, n]))
  expect(waitsForWords('issue_3', model.edges, byId)).toBe('Waits for B')
  // issue_2 waits for A (open) and Z (closed): one open blocker
  expect(waitsForWords('issue_2', model.edges, byId)).toBe('Waits for A')
  expect(waitsForWords('issue_1', model.edges, byId)).toBeNull()
  const two: ChainEdge[] = [
    { from: 'issue_3', to: 'issue_1', closed: false },
    { from: 'issue_3', to: 'issue_2', closed: false },
  ]
  expect(waitsForWords('issue_3', two, byId)).toBe('Waits for A and 1 more')
})

test('every node has one factual reason line, in the words of docs/language.md', () => {
  const issue = (state: string, waitReason: string | null = null) => ({
    ...node('issue_7', 'argo', 'T', 'issue', state),
    waitReason,
  })
  expect(reasonOf(issue('closed'), null)).toEqual({ text: 'Closed, no longer blocks', icon: 'state' })
  expect(reasonOf(issue('settling'), null)?.text).toBe('Triage is not done')
  expect(reasonOf(issue('queued'), null)?.text).toBe('Ready to start')
  expect(reasonOf(issue('queued'), 'Waits for A')).toEqual({ text: 'Waits for A', icon: 'hourglass' })
  expect(reasonOf(issue('working'), null)?.text).toBe('A lead is working')
  expect(reasonOf(issue('watching'), null)?.text).toBe('Shipped, the watch is on')
  expect(reasonOf(issue('odd'), null)).toBeNull()
  const dated = { ...node('row:q:x', 'quartz', 'X', 'row', 'waiting'), notBefore: '2026-11-16T09:00:00.000Z' }
  expect(reasonOf(dated, 'Waits for A', NOW)).toMatchObject({ icon: 'clock', title: '2026-11-16 09:00 UTC' })
  expect(reasonOf(dated, 'Waits for A', NOW)?.text).toMatch(/^Not before [A-Z][a-z]{2} \d{1,2} Nov, \d{2}:\d{2}$/)
  expect(reasonOf(node('row:q:y', 'quartz', 'Y', 'row', 'waiting'), 'Waits for X')?.text).toBe('Waits for X')
  expect(reasonOf(node('row:q:y', 'quartz', 'Y', 'row', 'waiting'), null)).toBeNull()
})

test('a waiting Issue is worded by its wait reason; a dependency wait names the open blocker', () => {
  const waiting = (waitReason: string) => ({ ...node('issue_7', 'argo', 'T', 'issue', 'waiting'), waitReason })
  // dependency with an open blocker: who it waits for, never the raw enum
  expect(reasonOf(waiting('dependency'), 'Waits for A')).toEqual({ text: 'Waits for A', icon: 'hourglass' })
  expect(reasonOf(waiting('dependency'), 'Waits for A and 1 more')?.text).toBe('Waits for A and 1 more')
  // dependency with no open blocker left: the reason as Flow shows it
  expect(reasonOf(waiting('dependency'), null)).toEqual({ text: 'dependency', icon: 'state' })
  // every other reason of the enum (migration 0002) is shown as Flow shows it, whatever the chain says
  for (const reason of [
    'timer',
    'wall',
    'unreported',
    'blocked',
    'lead_gone',
    'regressed',
    'decision',
    'review',
    'errand',
  ]) {
    expect(reasonOf(waiting(reason), 'Waits for A')).toEqual({ text: reason, icon: 'state' })
  }
})

test('the sidebar count, the drawn nodes and the isolated note come from one function', () => {
  const withSolo: ChainModel = { ...model, nodes: [...model.nodes, node('issue_6', 'argo', 'Alone')] }
  const counts = chainCounts(withSolo)
  for (const repo of projectsOf(withSolo)) {
    const drawn = chainOf(withSolo, { project: repo }).nodes.filter((n) => n.repo === repo).length
    expect(counts.projects[repo]?.drawn).toBe(drawn)
    const total = withSolo.nodes.filter((n) => n.repo === repo && !n.notBefore).length
    expect((counts.projects[repo]?.drawn ?? 0) + (counts.projects[repo]?.isolated ?? 0)).toBe(total)
  }
  expect(counts.projects.argo).toEqual({ drawn: 2, isolated: 1 })
  expect(counts.isolated).toBe(chainOf(withSolo).isolated)
})

test('a scheduled node is neither drawn nor counted as isolated', () => {
  const scheduled: ChainModel = {
    ...model,
    nodes: [...model.nodes, { ...node('issue_7', 'argo', 'Later'), notBefore: '2026-12-01T00:00:00.000Z' }],
  }
  expect(chainCounts(scheduled).projects.argo).toEqual({ drawn: 2, isolated: 0 })
})
